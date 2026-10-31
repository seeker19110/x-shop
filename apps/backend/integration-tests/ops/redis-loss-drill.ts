import type { ExecArgs } from "@medusajs/framework/types";
import { writeFileSync } from "node:fs";
import { isNonEmpty } from "@x-shop/domain";
import { dispatchOutbox, reconcileAttempts, type DispatchSummary } from "../../src/lib/checkout/jobs";
import {
  LogNotificationAdapter,
  setNotificationAdapterForTest,
  type NotificationAdapter,
  type OutgoingMessage,
} from "../../src/lib/notify/adapters";

/**
 * Diễn tập mất Redis (đặc tả §13.2, AT28) — chạy bởi scripts/ops/restore-drill.sh qua
 * `medusa exec ./integration-tests/ops/redis-loss-drill.ts` trên database VỪA KHÔI PHỤC, với REDIS_URL trỏ DB index
 * diễn tập đã bị xoá sạch (mọi workflow/job/khóa trong Redis đã mất). `medusa exec` không nạp job định kỳ → chỉ script
 * này chạy logic bù trừ, kết quả tất định.
 *
 * Chứng minh: công việc được TẠO LẠI chỉ từ bản ghi bền vững (checkout_attempt `preparing` quá lease, outbox_event
 * `pending`) bằng đúng hàm của job `reconcile-attempts` và `outbox-dispatch`; hai worker chạy ĐỒNG THỜI sau sự cố vẫn
 * mỗi việc đúng một lần; tác động ngoài (gửi thông báo) dedupe theo message key — sự kiện đã gửi trước sự cố không gửi
 * lại; chạy lại lần nữa không làm gì thêm. Id cố định khớp scripts/ops/drill/seed-before.sql.
 */
const STALE_ATTEMPT = "chk_drill_stale";
const EVENT_ALREADY_SENT = "drill:order.confirmed:order_drill_paid";
const EVENT_NOT_SENT = "drill:order.placed_pending:order_drill_cod";
const KEY_ALREADY_SENT = `notify:${EVENT_ALREADY_SENT}:email`;
const KEY_NOT_SENT = `notify:${EVENT_NOT_SENT}:sms`;

/** Đếm số lần thật sự gọi kênh gửi ngoài theo message key (bọc adapter log mặc định — không gửi thật). */
class CountingAdapter implements NotificationAdapter {
  readonly name = "log";
  readonly live = false;
  readonly sends = new Map<string, number>();
  private readonly inner = new LogNotificationAdapter();
  async send(m: OutgoingMessage, ctx: Parameters<NotificationAdapter["send"]>[1]) {
    this.sends.set(m.messageKey, (this.sends.get(m.messageKey) ?? 0) + 1);
    return this.inner.send(m, ctx);
  }
}

function mergeDispatch(a: DispatchSummary, b: DispatchSummary): DispatchSummary {
  return {
    sent: [...a.sent, ...b.sent],
    retried: [...a.retried, ...b.retried],
    dead: [...a.dead, ...b.dead],
    deferred: [...a.deferred, ...b.deferred],
    stopped: a.stopped ?? b.stopped,
  };
}

const sorted = (xs: string[]) => [...xs].sort();
const same = (a: string[], b: string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

export default async function redisLossDrill({ container }: ExecArgs): Promise<void> {
  const adapter = new CountingAdapter();
  setNotificationAdapterForTest(adapter);
  try {
    // Lượt 1: hai "worker" cùng khởi động lại sau sự cố, chạy song song cả hai job.
    const now1 = new Date();
    const [r1a, r1b, d1a, d1b] = await Promise.all([
      reconcileAttempts(container, { now: now1 }),
      reconcileAttempts(container, { now: now1 }),
      dispatchOutbox(container, { now: now1 }),
      dispatchOutbox(container, { now: now1 }),
    ]);
    const compensated1 = [...r1a.compensated, ...r1b.compensated];
    const outbox1 = mergeDispatch(d1a, d1b);
    const sendsAfterRun1 = Object.fromEntries(adapter.sends);

    // Lượt 2: chạy lại (worker restart lần nữa) — không còn gì để làm, không gửi thêm.
    const now2 = new Date();
    const r2 = await reconcileAttempts(container, { now: now2 });
    const d2 = await dispatchOutbox(container, { now: now2 });
    const sendsTotal = Object.fromEntries(adapter.sends);

    const failures: string[] = [];
    if (!same(compensated1, [STALE_ATTEMPT])) {
      failures.push(
        `lượt 1 phải bù trừ đúng [${STALE_ATTEMPT}] một lần, thực tế ${JSON.stringify(compensated1)}`,
      );
    }
    if (!same(outbox1.sent, [EVENT_ALREADY_SENT, EVENT_NOT_SENT])) {
      failures.push(
        `lượt 1 phải xử lý mỗi sự kiện outbox đúng một lần, thực tế ${JSON.stringify(outbox1.sent)}`,
      );
    }
    if (outbox1.retried.length + outbox1.dead.length > 0) {
      failures.push(
        `lượt 1 không được lỗi: ${JSON.stringify({ retried: outbox1.retried, dead: outbox1.dead })}`,
      );
    }
    if (r2.compensated.length > 0 || d2.sent.length + d2.retried.length + d2.dead.length > 0) {
      failures.push(`lượt 2 phải rỗng: ${JSON.stringify({ reconcile: r2, outbox: d2 })}`);
    }
    if ((sendsTotal[KEY_ALREADY_SENT] ?? 0) !== 0) {
      failures.push(
        `${KEY_ALREADY_SENT} đã gửi trước sự cố — không được gửi lại (gửi ${sendsTotal[KEY_ALREADY_SENT]})`,
      );
    }
    if ((sendsTotal[KEY_NOT_SENT] ?? 0) !== 1) {
      failures.push(`${KEY_NOT_SENT} phải gửi đúng 1 lần (gửi ${sendsTotal[KEY_NOT_SENT] ?? 0})`);
    }
    const totalSends = Object.values(sendsTotal).reduce((n, c) => n + c, 0);
    if (totalSends !== 1) failures.push(`tổng số lần gửi ngoài phải là 1, thực tế ${totalSends}`);

    const result = {
      ok: failures.length === 0,
      run1: { compensated: compensated1, outbox: outbox1, sends: sendsAfterRun1 },
      run2: { compensated: r2.compensated, outbox: d2 },
      sends_total: sendsTotal,
      failures,
    };
    const out = process.env.XS_DRILL_RESULT_FILE;
    if (isNonEmpty(out)) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    if (failures.length > 0) throw new Error(`diễn tập mất Redis FAIL:\n- ${failures.join("\n- ")}`);
  } finally {
    setNotificationAdapterForTest(null);
  }
}
