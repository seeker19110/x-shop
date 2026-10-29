import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { dispatchOutbox, OUTBOX_POLICY, type OutboxHandler } from "../../src/lib/checkout/jobs";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { createAdmin, noThrow, type HttpClient } from "../helpers/auth";
import type { Api, Res } from "../helpers/checkout-api";

jest.setTimeout(180 * 1000);

/**
 * T-193 (BE-JOB-004): sự kiện outbox hết lượt → `dead` (DLQ) → redrive đúng câu SQL RUNBOOK §12 bước 3 → dispatcher gửi
 * → `sent`; redrive lần hai không gửi trùng; `dead` không bị dọn; chỉ sự kiện được chọn bị đụng; không có đường HTTP.
 * Câu redrive được ĐỌC từ docs/ops/RUNBOOK.md (không chép lại) nên RUNBOOK lệch mã thì test đỏ.
 */
const RUNBOOK = join(__dirname, "../../../../docs/ops/RUNBOOK.md");

function runbookRedriveSql(): string {
  const md = readFileSync(RUNBOOK, "utf8");
  const section = md.slice(md.indexOf("## 12. Outbox"), md.indexOf("## 13."));
  const blocks = [...section.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!);
  // Chọn theo dấu mốc riêng của bước 3 (không lấy UPDATE đầu tiên).
  const block = blocks.find((b) => b.includes("-- redrive-one"));
  if (!block) throw new Error("RUNBOOK §12 không còn khối redrive (dấu `-- redrive-one`)");
  // Bỏ meta-lệnh psql (`\set k '…'`) và dòng chú thích; `:'k'` (psql tự quote) → tham số bind `?`.
  const sql = block
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("\\") && !l.trimStart().startsWith("--"))
    .join(" ")
    .trim()
    .replace(/;\s*$/, "")
    .replace(/\s+/g, " ");
  if (!/^UPDATE outbox_event /.test(sql) || !sql.includes(":'k'"))
    throw new Error("RUNBOOK §12: câu redrive lạ");
  return sql.replace(":'k'", "?");
}

/** Quét tĩnh src/** (trừ __tests__, migrations): tệp nhắc outbox_event/OutboxEvent mà có thao tác xoá → fail, trừ allowlist. */
const SRC = join(__dirname, "../../src");
const DELETE_ALLOWLIST: Record<string, string> = {};
function walkSrc(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "__tests__" && e.name !== "migrations") walkSrc(p, out);
    } else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}
/** Route API: thêm lời gọi hàm outbox của service (vd `markOutboxSent(`) — mọi đường chạm outbox đều bị chặn. */
const ROUTE_OUTBOX = /outbox_event|OutboxEvent|Outbox\w*\s*\(/;
const MENTIONS_OUTBOX = /outbox_event|OutboxEvent/;
// `DELETE FROM` chỉ tính khi bảng là outbox_event hoặc không lộ tên (biến/hằng/tham số) — các bảng khác xoá hợp lệ.
const DELETES =
  /TRUNCATE|nativeDelete|DELETE\s+FROM\s+(?:ONLY\s+)?(?:(?:\w+|"\w+")\.)?(?:"?outbox_event|\$\{|\?|"?[A-Za-z_]*(?:TABLE|table)\b)|\.del\s*\(|\.delete\s*\(|softDelete|(?:delete|restore)OutboxEvent|SET[^;`]*deleted_at\s*=|deleted_at\s*[:=]\s*(?!null)/i;

const failing503: OutboxHandler = async () => {
  throw Object.assign(new Error("ESP 503"), { status: 503 });
};

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    const checkout = () => getContainer().resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const pg = () => getContainer().resolve(ContainerRegistrationKeys.PG_CONNECTION);
    // Mốc ở tương lai xa → dispatcher nền (giờ thật) không nhận sự kiện lúc còn failed.
    const base = new Date(Date.now() + 30 * 24 * 3600_000);
    const HOUR = 3600_000;
    let seq = 0;

    const row = async (key: string) =>
      (
        await pg().raw(
          `SELECT state, attempts, last_error, payload, next_attempt_at FROM outbox_event WHERE event_key = ?`,
          [key],
        )
      ).rows[0] as {
        state: string;
        attempts: number;
        last_error: string | null;
        payload: Record<string, unknown>;
        next_attempt_at: Date;
      };

    /**
     * Chạy câu redrive của RUNBOOK cho một event_key, trong transaction: kiểm dòng bị đổi rồi dời next_attempt_at về
     * `base` TRƯỚC khi commit — dispatcher nền (giờ thật, 10 s) không thể nhận dòng `pending` vừa redrive.
     */
    const redrive = async (eventKey: string) => {
      const sql = runbookRedriveSql();
      expect(sql).toContain("?");
      return pg().transaction(async (trx: ReturnType<typeof pg>) => {
        const res = await trx.raw(sql, [eventKey]);
        const n = res.rowCount as number;
        if (n > 0) {
          const r = (
            await trx.raw(
              `SELECT state, attempts, next_attempt_at <= now() AS due FROM outbox_event WHERE event_key = ?`,
              [eventKey],
            )
          ).rows[0];
          expect(r).toMatchObject({ state: "pending", attempts: 0, due: true });
          await trx.raw(`UPDATE outbox_event SET next_attempt_at = ? WHERE event_key = ?`, [base, eventKey]);
        }
        return n;
      });
    };

    /** Tạo sự kiện (type riêng) rồi cho hỏng tạm đến hết lượt → dead. */
    async function makeDead(type: string, key: string, handler: OutboxHandler) {
      await checkout().insertOutbox(key, `agg_${type}`, type, { n: seq }, undefined, base);
      for (let i = 0; i < OUTBOX_POLICY.maxAttempts; i++) {
        const r = await dispatchOutbox(getContainer(), {
          now: new Date(base.getTime() + i * 2 * HOUR),
          handlers: { [type]: handler },
          random: () => 0,
        });
        expect(r.sent).toEqual([]);
      }
    }

    it("hết lượt → dead (giữ payload, last_error, attempts) + ops_exception; redrive RUNBOOK → sent; lần 2 không gửi trùng", async () => {
      seq += 1;
      const type = "test.redrive.one";
      const key = `${type}:${seq}`;
      const calls: string[] = [];
      let failing = true;
      const handler: OutboxHandler = async (c, e, o) => {
        calls.push(e.event_key);
        if (failing) await failing503(c, e, o);
      };
      await makeDead(type, key, handler);
      expect(calls).toHaveLength(OUTBOX_POLICY.maxAttempts);

      const dead = await row(key);
      expect(dead).toMatchObject({ state: "dead", attempts: OUTBOX_POLICY.maxAttempts, payload: { n: seq } });
      expect(dead.last_error).toContain("ESP 503");
      const ex = (
        await pg().raw(
          `SELECT priority, detail FROM ops_exception WHERE kind = 'outbox_dead' AND dedupe_key = ?`,
          [`outbox_dead:${key}`],
        )
      ).rows;
      expect(ex).toHaveLength(1);
      expect(ex[0]).toMatchObject({
        priority: "high",
        detail: { event_key: key, dead_reason: "max_attempts", attempts: OUTBOX_POLICY.maxAttempts },
      });

      // Job KHÔNG tự nhặt dead.
      const idle = await dispatchOutbox(getContainer(), {
        now: new Date(base.getTime() + 100 * HOUR),
        handlers: { [type]: handler },
      });
      expect(idle.sent.concat(idle.retried, idle.dead)).toEqual([]);
      expect(calls).toHaveLength(OUTBOX_POLICY.maxAttempts);

      // Nguyên nhân đã sửa → redrive đúng câu SQL của RUNBOOK.
      failing = false;
      expect(await redrive(key)).toBe(1);
      expect(await row(key)).toMatchObject({
        state: "pending",
        attempts: 0,
        last_error: null,
        payload: { n: seq },
      });
      const r = await dispatchOutbox(getContainer(), {
        now: base,
        handlers: { [type]: handler },
      });
      expect(r.sent).toEqual([key]);
      expect(await row(key)).toMatchObject({ state: "sent", attempts: 0 });
      expect(calls).toHaveLength(OUTBOX_POLICY.maxAttempts + 1);

      // Redrive lần 2: dòng không còn dead → 0 dòng đổi, không gửi trùng.
      expect(await redrive(key)).toBe(0);
      const again = await dispatchOutbox(getContainer(), {
        now: base,
        handlers: { [type]: handler },
      });
      expect(again.sent).toEqual([]);
      expect(calls).toHaveLength(OUTBOX_POLICY.maxAttempts + 1);
      expect((await row(key)).state).toBe("sent");
    });

    it("redrive chỉ đúng event_key được chọn: dead khác, pending, sent giữ nguyên; khoá không có/ký tự lạ → 0 dòng", async () => {
      const type = "test.redrive.sel";
      seq += 1;
      const a = `${type}:a${seq}`;
      const b = `${type}:b${seq}`;
      await makeDead(type, a, failing503);
      await makeDead(type, b, failing503);
      const beforeB = await row(b);
      // pending và sent (loại khác) để chắc câu SQL có ràng `state = 'dead'`.
      const pend = `${type}:p${seq}`;
      const sent = `${type}:s${seq}`;
      await checkout().insertOutbox(pend, "agg_p", "test.redrive.other", {}, undefined, base);
      await checkout().insertOutbox(sent, "agg_s", "test.redrive.other", {}, undefined, base);
      await pg().raw(`UPDATE outbox_event SET state = 'sent' WHERE event_key = ?`, [sent]);
      const beforePend = await row(pend);
      const beforeSent = await row(sent);

      expect(await redrive(`${type}:khong-co`)).toBe(0);
      expect(await redrive(pend)).toBe(0);
      expect(await redrive(sent)).toBe(0);
      expect(await redrive(a)).toBe(1);

      expect((await row(a)).state).toBe("pending");
      expect(await row(b)).toEqual(beforeB);
      expect(await row(pend)).toEqual(beforePend);
      expect(await row(sent)).toEqual(beforeSent);
      // Khoá chứa ký tự LIKE/SQL không mở rộng thành nhiều dòng.
      expect(await redrive(`${type}:%`)).toBe(0);
      // Khoá chỉ so bằng `=` (bind): chuỗi trông như SQL cũng chỉ là một khoá không tồn tại.
      expect(await redrive(`' OR state = 'dead' --`)).toBe(0);
      expect((await row(b)).state).toBe("dead");
    });

    it("dead được giữ: không job nào xoá outbox_event; dead còn nguyên sau lượt dispatch rất xa tương lai", async () => {
      // Hiện CHƯA có hạn giữ/dọn riêng cho outbox_event (không có job purge) → dead giữ vô thời hạn, lâu hơn mọi hàng
      // đợi gốc. Khi thêm job dọn outbox thì phải đặt hạn giữ dead > hạn giữ sent và sửa test này.
      const offenders = walkSrc(SRC)
        .map((f) => ({ f: relative(SRC, f), src: readFileSync(f, "utf8") }))
        .filter(({ src }) => MENTIONS_OUTBOX.test(src) && DELETES.test(src))
        .map(({ f }) => f)
        .filter((f) => !(f in DELETE_ALLOWLIST));
      // Phạm vi: chốt này chỉ phủ XOÁ (và xoá mềm). Một job UPDATE dead→sent/đổi trạng thái không bị bắt ở đây.
      expect(offenders).toEqual([]);
      seq += 1;
      const type = "test.redrive.keep";
      const key = `${type}:${seq}`;
      await makeDead(type, key, failing503);
      const before = await row(key);
      for (const days of [1, 90, 400]) {
        await dispatchOutbox(getContainer(), {
          now: new Date(base.getTime() + days * 24 * HOUR),
          handlers: { [type]: failing503 },
        });
      }
      expect(await row(key)).toEqual(before);
      expect(before.state).toBe("dead");
    });

    it("không có đường HTTP để redrive: không route nào chạm outbox_event; admin thật gọi → 403/404 (RBAC đóng mặc định); dead không đổi", async () => {
      // Quét tĩnh: không route API nào nhắc outbox_event/OutboxEvent (redrive chỉ qua SQL vận hành).
      const routes = walkSrc(join(SRC, "api"))
        .filter((f) => ROUTE_OUTBOX.test(readFileSync(f, "utf8")))
        .map((f) => relative(SRC, f));
      expect(routes).toEqual([]);

      seq += 1;
      const type = "test.redrive.http";
      const key = `${type}:${seq}`;
      await makeDead(type, key, failing503);
      const admin = await createAdmin(rawApi as unknown as HttpClient, getContainer());
      const status = async (m: "get" | "post", path: string, headers?: object) => {
        const cfg = { ...noThrow, ...(headers ? { headers } : {}) };
        const r = (await (m === "get" ? api.get(path, cfg) : api.post(path, { event_key: key }, cfg))) as Res;
        return r.status;
      };
      for (const path of ["/admin/x/outbox/redrive", "/admin/outbox/redrive", "/admin/x/outbox"]) {
        // owner thật cũng không có đường: RBAC đóng mặc định cho đường lạ (403) hoặc không có route (404). Không bao giờ 2xx.
        // Quét tĩnh ở trên mới là chốt chặn route mới (RBAC cũng 403 cho route chưa khai quyền).
        expect([403, 404]).toContain(await status("post", path, admin.headers));
        expect([403, 404]).toContain(await status("get", path, admin.headers));
      }
      for (const path of ["/store/x/outbox/redrive", "/x/outbox/redrive", "/outbox/redrive"]) {
        expect([400, 401, 404]).toContain(await status("post", path));
      }
      expect((await row(key)).state).toBe("dead");
    });
  },
});
