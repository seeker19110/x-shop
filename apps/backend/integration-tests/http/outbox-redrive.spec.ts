import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { dispatchOutbox, OUTBOX_POLICY, type OutboxHandler } from "../../src/lib/checkout/jobs";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
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
  const sql = blocks.find((b) => /^\s*UPDATE outbox_event/m.test(b));
  if (!sql) throw new Error("RUNBOOK §12 không còn câu UPDATE redrive");
  return sql.trim().replace(/;\s*$/, "").replace(/\s+/g, " ");
}

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

    /** Chạy câu redrive của RUNBOOK cho một event_key; trả số dòng bị đổi. */
    const redrive = async (eventKey: string) => {
      const sql = runbookRedriveSql().replace("'<event_key>'", "?");
      expect(sql).toContain("?");
      return (await pg().raw(sql, [eventKey])).rowCount as number;
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
        now: new Date(Date.now() + 60_000),
        handlers: { [type]: handler },
      });
      expect(r.sent).toEqual([key]);
      expect(await row(key)).toMatchObject({ state: "sent", attempts: 0 });
      expect(calls).toHaveLength(OUTBOX_POLICY.maxAttempts + 1);

      // Redrive lần 2: dòng không còn dead → 0 dòng đổi, không gửi trùng.
      expect(await redrive(key)).toBe(0);
      const again = await dispatchOutbox(getContainer(), {
        now: new Date(Date.now() + 120_000),
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
      expect(await redrive(`' OR state = 'dead' --`)).toBe(0);
      expect((await row(b)).state).toBe("dead");
    });

    it("dead được giữ: không job nào xoá outbox_event; dead còn nguyên sau lượt dispatch rất xa tương lai", async () => {
      // Hiện CHƯA có hạn giữ/dọn riêng cho outbox_event (không có job purge) → dead giữ vô thời hạn, lâu hơn mọi hàng
      // đợi gốc. Khi thêm job dọn outbox thì phải đặt hạn giữ dead > hạn giữ sent và sửa test này.
      const jobsDir = join(__dirname, "../../src/jobs");
      for (const f of readdirSync(jobsDir).filter((n) => n.endsWith(".ts"))) {
        const deletes = /DELETE\s+FROM\s+"?outbox_event/i.test(readFileSync(join(jobsDir, f), "utf8"));
        expect({ f, deletes }).toEqual({ f, deletes: false });
      }
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

    it("không có đường HTTP để redrive: store/admin trả 400/401/404, dead không đổi", async () => {
      seq += 1;
      const type = "test.redrive.http";
      const key = `${type}:${seq}`;
      await makeDead(type, key, failing503);
      const attempt = (m: "get" | "post", path: string) =>
        (m === "get" ? api.get(path) : api.post(path, { event_key: key })).then(
          (r) => r.status,
          (e: { response: Res }) => e.response.status,
        );
      for (const path of ["/store/x/outbox/redrive", "/x/outbox/redrive", "/outbox/redrive"]) {
        expect([400, 401, 404]).toContain(await attempt("post", path));
      }
      for (const path of ["/admin/x/outbox/redrive", "/admin/outbox/redrive"]) {
        expect([401, 404]).toContain(await attempt("post", path));
        expect([401, 404]).toContain(await attempt("get", path));
      }
      expect((await row(key)).state).toBe("dead");
    });
  },
});
