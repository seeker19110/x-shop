import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import Redis from "ioredis";
import { AUTH_RATE_LIMITS } from "../../src/lib/admin-security/config";
import { KEY_PREFIX } from "../../src/lib/admin-security/store";
import { SECURITY_EVENTS } from "../../src/lib/audit/events";
import { outcomeOfStatus } from "../../src/lib/audit/http";
import { hashIdentifier } from "../../src/lib/audit/record";
import { SecurityAuditRecord } from "../../src/lib/audit/schema";
import { AUDIT_MODULE } from "../../src/modules/audit";
import type { AuditEntry, AuditListFilter } from "../../src/modules/audit/service";
import type AuditModuleService from "../../src/modules/audit/service";
import seedCatalog from "../../src/scripts/seed-catalog";
import { createAdmin, createMfaAdmin, enrollTotp, jwtPayload, noThrow, totp } from "../helpers/auth";

jest.setTimeout(300 * 1000);

type Res = { status: number; data: Record<string, unknown>; headers: Record<string, unknown> };
interface Api {
  request(config: Record<string, unknown>): Promise<Res>;
}
type Row = Record<string, unknown>;

/** User-Agent có PII lẫn vào (vài ứng dụng nhúng tài khoản) — phải bị che trước khi ghi. */
const UA_EMAIL = "qa.tester@example.test";
const UA_PHONE = "0912345678";
const UA = `x-shop-test/1.0 (${UA_EMAIL}; ${UA_PHONE})`;
const ORIGIN = "http://localhost:9000";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sự kiện bảo mật đủ trường (T-091, SEC-LOG-001/002, CMP-AUDIT-002): mỗi loại sự kiện có bản ghi đủ trường theo schema,
 * thất bại/bị từ chối cũng ghi, không có PII thô (email/SĐT/IP) trong bản ghi. Ghi theo route chạy SAU khi phản hồi xong
 * → test chờ dòng xuất hiện (`waitRows`).
 */
medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let audit: AuditModuleService;
    let redis: Redis;

    beforeAll(async () => {
      container = getContainer();
      audit = container.resolve<AuditModuleService>(AUDIT_MODULE);
      redis = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: 1 });
      // Bộ đếm rate limit đăng nhập sống 15 phút trong Redis — xoá phần của lần chạy trước (cách ly test).
      const stale = await redis.keys(`${KEY_PREFIX}rl:*`);
      if (stale.length > 0) await redis.del(...stale);
    });
    // Xuất native (`POST /admin/customers/export`) ghi file qua file provider cục bộ vào `static/` — dọn file do suite tạo
    // để test không để lại dữ liệu xuất trong cây làm việc.
    const staticDir = join(process.cwd(), "static");
    const exportFiles = () =>
      existsSync(staticDir) ? readdirSync(staticDir).filter((f) => /^private-.*\.json$/.test(f)) : [];
    const before = new Set(exportFiles());
    afterAll(async () => {
      await redis.quit();
      await sleep(500);
      for (const f of exportFiles()) if (!before.has(f)) rmSync(join(staticDir, f), { force: true });
    });

    const call = (method: string, url: string, headers: Record<string, string> = {}, data?: unknown) =>
      api.request({
        method,
        url,
        headers: { "user-agent": UA, ...headers },
        ...(data === undefined ? {} : { data }),
        ...noThrow,
      });
    const login = (email: string, password: string, headers: Record<string, string> = {}) =>
      call("POST", "/auth/user/emailpass", headers, { email, password });

    const list = async (filter: AuditListFilter) =>
      (await audit.list(filter, { limit: 100, offset: 0 })).entries.map(
        (e) => JSON.parse(JSON.stringify(e)) as Row,
      );

    /**
     * Xoá bộ đếm gộp audit (`audit.rbac_denied:*` — cùng tiền tố cho mọi nhóm gộp) để ca kiểm "lần 1 của nhóm" không phụ
     * thuộc ca trước trong cùng cửa sổ 60 s (mọi request test cùng IP 127.0.0.1).
     */
    const resetAuditThrottle = () =>
      container
        .resolve(ContainerRegistrationKeys.PG_CONNECTION)
        .raw(`DELETE FROM rate_limit_counter WHERE bucket LIKE 'audit.rbac_denied:%'`);

    /** Chờ đủ `n` dòng (ghi sau `finish`), rồi chờ thêm một nhịp để chắc không có dòng thừa. */
    async function waitRows(filter: AuditListFilter, n: number, timeoutMs = 15_000): Promise<Row[]> {
      const until = Date.now() + timeoutMs;
      let rows = await list(filter);
      while (rows.length < n && Date.now() < until) {
        await sleep(100);
        rows = await list(filter);
      }
      await sleep(400);
      return list(filter);
    }

    /** Mọi dòng: đúng schema (UTC, outcome, ip_hash dạng băm, UA ≤ 256) + không chứa PII thô. */
    function expectWellFormed(rows: Row[], pii: string[] = []) {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const parsed = SecurityAuditRecord.safeParse(row);
        expect({ id: row.id, issues: parsed.success ? [] : parsed.error.issues }).toEqual({
          id: row.id,
          issues: [],
        });
        expect(String(row.created_at)).toMatch(/Z$/);
        const json = JSON.stringify(row);
        for (const s of [UA_EMAIL, UA_PHONE, "qa.tester@", ...pii]) expect(json).not.toContain(s);
        expect(json).not.toMatch(/127\.0\.0\.1|::1|::ffff/);
      }
    }

    describe("đăng nhập", () => {
      it("thành công → auth.login success đủ trường (actor, đích bí danh, ip_hash, UA đã che, request_id = trace)", async () => {
        const admin = await createAdmin(rawApi, container, { roles: ["support"] });
        const idh = hashIdentifier(container, admin.email) as string;
        expect(idh).toMatch(/^idh_[0-9a-f]{32}$/);
        const res = await login(admin.email, admin.password, { "x-request-id": "req-t091-login-ok" });
        expect(res.status).toBe(200);
        const rows = await waitRows({ action: SECURITY_EVENTS.LOGIN, request_id: "req-t091-login-ok" }, 1);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          actor_type: "user",
          actor_id: admin.userId,
          resource_type: "login_identifier",
          resource_id: idh,
          outcome: "success",
          request_id: "req-t091-login-ok",
          changes: { stage: "complete", status: 200, actor_type: "user", provider: "emailpass" },
        });
        expect(rows[0]?.ip_hash).toMatch(/^[0-9a-f]{32}$/);
        expect(String(rows[0]?.user_agent)).toContain("x-shop-test/1.0");
        expectWellFormed(rows, [admin.email, admin.password]);
      });

      it("sai mật khẩu và email không tồn tại → failure, actor vô danh, đích là bí danh (không email thô)", async () => {
        const admin = await createAdmin(rawApi, container, { roles: ["support"] });
        // Thất bại vô danh gộp theo IP + sự kiện (mọi request test cùng IP) → xoá bộ đếm để mỗi lần là "lần 1".
        await resetAuditThrottle();
        expect((await login(admin.email, "sai-mat-khau")).status).toBe(401);
        await waitRows(
          { resource_id: hashIdentifier(container, admin.email) as string, outcome: "failure" },
          1,
        );
        await resetAuditThrottle();
        const ghost = `khong-co-${randomUUID()}@x-shop.test`;
        expect((await login(ghost, "bat-ky")).status).toBe(401);

        const wrong = await waitRows({ resource_id: hashIdentifier(container, admin.email) as string }, 2);
        // createAdmin đã đăng nhập thành công một lần → 1 success + 1 failure.
        expect(wrong.map((r) => r.outcome).sort()).toEqual(["failure", "success"]);
        const failed = wrong.find((r) => r.outcome === "failure") as Row;
        expect(failed).toMatchObject({
          action: SECURITY_EVENTS.LOGIN,
          actor_type: "anonymous",
          actor_id: null,
        });
        expect((failed.changes as Row).status).toBe(401);

        const missing = await waitRows({ resource_id: hashIdentifier(container, ghost) as string }, 1);
        expect(missing).toHaveLength(1);
        expect(missing[0]).toMatchObject({ outcome: "failure", actor_id: null });
        expectWellFormed([...wrong, ...missing], [admin.email, ghost, "sai-mat-khau"]);
      });

      it("ĐỒNG THỜI: N lần sai dưới ngưỡng → gộp theo IP (1 dòng, occurrence 1); vượt ngưỡng → 429 + auth.lockout gộp (lần 1, 10)", async () => {
        const victim = await createAdmin(rawApi, container, { roles: ["support"] });
        const idh = hashIdentifier(container, victim.email) as string;
        await resetAuditThrottle();
        const n = AUTH_RATE_LIMITS.login.perIdentityIp;
        const first = await Promise.all(Array.from({ length: n }, () => login(victim.email, "sai")));
        expect(first.map((r) => r.status)).toEqual(Array(n).fill(401));
        const failures = await waitRows({ resource_id: idh, outcome: "failure" }, 1);
        expect(failures.map((r) => ((r.changes as Row).throttle as Row).occurrence)).toEqual([1]);

        const blocked = await Promise.all(Array.from({ length: 12 }, () => login(victim.email, "sai")));
        expect(blocked.map((r) => r.status)).toEqual(Array(12).fill(429));
        const lockouts = await waitRows({ action: SECURITY_EVENTS.LOCKOUT, resource_id: idh }, 2);
        expect(
          lockouts
            .map((r) => ((r.changes as Row).throttle as Row).occurrence)
            .sort((a, b) => Number(a) - Number(b)),
        ).toEqual([1, 10]);
        expect(lockouts[0]).toMatchObject({
          outcome: "denied",
          resource_type: "login_identifier",
          changes: { event: SECURITY_EVENTS.LOGIN, status: 429 },
        });
        expect(Number((lockouts[0]?.changes as Row).retry_after)).toBeGreaterThan(0);
        // 429 không ghi thêm dòng auth.login (chỉ lockout).
        expect(
          await list({ action: SECURITY_EVENTS.LOGIN, resource_id: idh, outcome: "denied" }),
        ).toHaveLength(0);
        expectWellFormed([...failures, ...lockouts], [victim.email]);
      });

      it("thất bại vô danh (thân rỗng) → vẫn ghi, gộp theo IP; đổi email mỗi lần KHÔNG lách được gộp (lần 1, 10)", async () => {
        await resetAuditThrottle();
        const rid = `req-t091-anon-${randomUUID().slice(0, 8)}`;
        const res = await call("POST", "/auth/user/emailpass", { "x-request-id": rid }, {});
        expect(res.status).toBeGreaterThanOrEqual(400);
        const empty = await waitRows({ request_id: rid }, 1);
        expect(empty).toHaveLength(1);
        expect(empty[0]).toMatchObject({ actor_id: null, resource_id: null, outcome: "failure" });

        // Kẻ dò mật khẩu đổi email mỗi lần (định danh do client chọn): nhóm vẫn là (IP, auth.login, failure).
        await resetAuditThrottle();
        const emails = Array.from({ length: 12 }, () => `do-${randomUUID()}@x-shop.test`);
        for (const email of emails) expect((await login(email, "sai")).status).toBe(401);
        await sleep(800);
        const rows = (
          await Promise.all(emails.map((e) => list({ resource_id: hashIdentifier(container, e) as string })))
        ).flat();
        expect(
          rows
            .map((r) => ((r.changes as Row).throttle as Row).occurrence)
            .sort((a, b) => Number(a) - Number(b)),
        ).toEqual([1, 10]);
        expectWellFormed([...empty, ...rows], emails);
      });
    });

    describe("MFA, phiên", () => {
      it("đăng ký TOTP → enroll_started + enrolled; đăng nhập 2 bước: mfa_required, mã sai = failure, mã đúng = success", async () => {
        const owner = await createAdmin(rawApi, container, { roles: ["owner"] });
        const { secret, factorId } = await enrollTotp(rawApi, owner.headers);
        const enrolled = await waitRows({ actor_id: owner.userId, action: SECURITY_EVENTS.MFA_ENROLLED }, 1);
        expect(enrolled[0]).toMatchObject({
          outcome: "success",
          resource_type: "mfa_factor",
          resource_id: factorId,
        });
        const started = await waitRows(
          { actor_id: owner.userId, action: SECURITY_EVENTS.MFA_ENROLL_STARTED },
          1,
        );
        expect(started[0]).toMatchObject({ outcome: "success", resource_type: "auth_identity" });

        const first = await login(owner.email, owner.password);
        expect(first.data).toMatchObject({ mfa_required: true });
        const authIdentityId = jwtPayload(String(first.data.token)).auth_identity_id as string;
        const step1 = await waitRows({ action: SECURITY_EVENTS.LOGIN, actor_id: authIdentityId }, 1);
        expect(step1[0]).toMatchObject({
          actor_type: "auth_identity",
          outcome: "success",
          changes: { stage: "mfa_required" },
        });

        const challengeId = (first.data.mfa_challenge as { id: string }).id;
        const bearer = { authorization: `Bearer ${String(first.data.token)}` };
        const url = `/auth/mfa/challenges/${challengeId}/verify`;
        const bad = await call("POST", url, bearer, {
          method: "totp",
          code: totp(secret, Date.now() + 600_000),
        });
        expect(bad.status).toBeGreaterThanOrEqual(400);
        expect(bad.status).toBeLessThan(500);
        const ok = await call("POST", url, bearer, { method: "totp", code: totp(secret) });
        expect(ok.status).toBe(200);

        const verified = await waitRows(
          { action: SECURITY_EVENTS.MFA_VERIFIED, resource_id: challengeId },
          2,
        );
        expect(verified.map((r) => [r.outcome, r.actor_type, r.actor_id]).sort()).toEqual(
          [
            ["failure", "auth_identity", authIdentityId],
            ["success", "user", owner.userId],
          ].sort(),
        );
        expectWellFormed([...enrolled, ...started, ...step1, ...verified], [owner.email, secret]);
      });

      it("tạo phiên cookie → auth.session_created; đăng xuất → auth.logout", async () => {
        const admin = await createAdmin(rawApi, container, { roles: ["support"] });
        const created = await call("POST", "/auth/session", { ...admin.headers, origin: ORIGIN });
        expect(created.status).toBe(200);
        const sid = ((created.headers["set-cookie"] as string[] | undefined) ?? [])
          .map((c) => c.split(";")[0] ?? "")
          .find((c) => c.startsWith("connect.sid="));
        expect(sid).toBeDefined();
        const out = await call("DELETE", "/auth/session", { cookie: sid as string, origin: ORIGIN });
        expect(out.status).toBe(200);
        const session = await waitRows(
          { actor_id: admin.userId, action: SECURITY_EVENTS.SESSION_CREATED },
          1,
        );
        const logout = await waitRows({ actor_id: admin.userId, action: SECURITY_EVENTS.LOGOUT }, 1);
        expect(session[0]).toMatchObject({ outcome: "success", resource_type: "auth_identity" });
        expect(logout[0]).toMatchObject({ outcome: "success", resource_type: "auth_identity" });
        expectWellFormed([...session, ...logout], [admin.email]);
      });
    });

    describe("đổi quyền", () => {
      it("cấp vai trò (được phép) → success; user không có → failure; vai trò không có quyền → rbac.denied (denied)", async () => {
        const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
        const target = await createAdmin(rawApi, container, { roles: [] });
        const granted = await call("POST", `/admin/x/users/${target.userId}/roles`, owner.headers, {
          role: "support",
          reason: `cấp cho ca trực, liên hệ ${UA_PHONE}`,
        });
        expect(granted.status).toBe(201);
        const missingId = `user_khong_co_${randomUUID().slice(0, 8)}`;
        const missing = await call("POST", `/admin/x/users/${missingId}/roles`, owner.headers, {
          role: "support",
        });
        expect(missing.status).toBe(404);
        const support = await createAdmin(rawApi, container, { roles: ["support"] });
        const denied = await call("POST", `/admin/x/users/${target.userId}/roles`, support.headers, {
          role: "owner",
        });
        expect(denied.status).toBe(403);

        const ok = await waitRows({ action: SECURITY_EVENTS.ROLE_GRANTED, resource_id: target.userId }, 1);
        expect(ok).toHaveLength(1);
        expect(ok[0]).toMatchObject({
          actor_id: owner.userId,
          outcome: "success",
          changes: { role: "support", before: [], after: ["support"] },
        });
        const failed = await waitRows({ action: SECURITY_EVENTS.ROLE_GRANTED, resource_id: missingId }, 1);
        expect(failed[0]).toMatchObject({ outcome: "failure", changes: { error_code: "NOT_FOUND" } });
        const rbac = await waitRows({ action: SECURITY_EVENTS.RBAC_DENIED, actor_id: support.userId }, 1);
        expect(rbac[0]).toMatchObject({ outcome: "denied" });
        expectWellFormed([...ok, ...failed, ...rbac], [owner.email, target.email, support.email]);
      });
    });

    describe("xuất / truy cập dữ liệu", () => {
      it("xuất CSV catalog: lỗi (chưa seed → 500) = failure; được phép = success; vai trò không có quyền → 403, không có data.exported", async () => {
        const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
        // DB test chưa có kênh bán/kho mặc định → route xuất ném lỗi 500: lần xuất thất bại cũng phải có dấu vết.
        const broken = await call("GET", "/admin/x/exports/products.csv", owner.headers);
        expect(broken.status).toBe(500);
        const failed = await waitRows(
          { action: SECURITY_EVENTS.DATA_EXPORTED, actor_id: owner.userId, outcome: "failure" },
          1,
        );
        expect(failed).toHaveLength(1);
        expect(failed[0]).toMatchObject({ resource_id: "products.csv", changes: { status: 500 } });

        await seedCatalog({ container });
        const res = await call("GET", "/admin/x/exports/products.csv", owner.headers);
        expect(res.status).toBe(200);
        const rows = await waitRows(
          { action: SECURITY_EVENTS.DATA_EXPORTED, actor_id: owner.userId, outcome: "success" },
          1,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          resource_type: "export",
          resource_id: "products.csv",
          changes: { dataset: "products", format: "csv", pii: false, status: 200 },
        });
        rows.push(...failed);

        const accountant = await createAdmin(rawApi, container, { roles: ["accountant"] });
        expect((await call("GET", "/admin/x/exports/products.csv", accountant.headers)).status).toBe(403);
        await sleep(600);
        expect(
          await list({ action: SECURITY_EVENTS.DATA_EXPORTED, actor_id: accountant.userId }),
        ).toHaveLength(0);
        const denied = await waitRows(
          { action: SECURITY_EVENTS.RBAC_DENIED, actor_id: accountant.userId },
          1,
        );
        expectWellFormed([...rows, ...denied], [owner.email, accountant.email]);
      });

      it("xuất PII khách (native) → data.exported pii=true, kết quả khớp status; đối soát không có → data.accessed failure", async () => {
        const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
        const exp = await call("POST", "/admin/customers/export", owner.headers, {});
        const exported = await waitRows({ action: SECURITY_EVENTS.DATA_EXPORTED, actor_id: owner.userId }, 1);
        expect(exported).toHaveLength(1);
        expect(exported[0]).toMatchObject({
          outcome: outcomeOfStatus(exp.status),
          resource_id: "customers",
          changes: { dataset: "customers", pii: true, status: exp.status },
        });

        const customers = await call("GET", "/admin/customers?limit=1", owner.headers);
        expect(customers.status).toBe(200);
        const batch = `sb_khong_co_${randomUUID().slice(0, 8)}`;
        expect((await call("GET", `/admin/x/settlements/batches/${batch}`, owner.headers)).status).toBe(404);
        const accessed = await waitRows({ action: SECURITY_EVENTS.DATA_ACCESSED, actor_id: owner.userId }, 2);
        const byType = Object.fromEntries(accessed.map((r) => [r.resource_type, r]));
        expect(byType.customer).toMatchObject({
          outcome: "success",
          resource_id: null,
          changes: { pii: true },
        });
        expect(byType.settlement_batch).toMatchObject({
          outcome: "failure",
          resource_id: batch,
          changes: { status: 404 },
        });
        expectWellFormed([...exported, ...accessed], [owner.email]);
      });
    });

    it("audit chỉ ghi thêm: không sửa/xoá được dòng sự kiện mới (kể cả cột outcome/user_agent); outcome lạ bị CHECK chặn", async () => {
      const admin = await createAdmin(rawApi, container, { roles: ["support"] });
      const [row] = await waitRows({ action: SECURITY_EVENTS.LOGIN, actor_id: admin.userId }, 1);
      const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
      await expect(
        pg.raw(`UPDATE audit_log SET outcome = 'failure' WHERE id = ?`, [row?.id as string]),
      ).rejects.toThrow(/append-only/);
      await expect(pg.raw(`DELETE FROM audit_log WHERE id = ?`, [row?.id as string])).rejects.toThrow(
        /append-only/,
      );
      await expect(
        pg.raw(
          `INSERT INTO audit_log (id, actor_type, action, resource_type, outcome) VALUES ('audit_x', 'system', 'x.y', 'z', 'error')`,
        ),
      ).rejects.toThrow(/audit_log_outcome_check/);
      await expect(
        pg.raw(
          `INSERT INTO audit_log (id, actor_type, action, resource_type, user_agent) VALUES ('audit_y', 'system', 'x.y', 'z', repeat('a', 257))`,
        ),
      ).rejects.toThrow(/audit_log_user_agent_length/);
      // Lọc theo kết quả qua API đọc (owner); giá trị lạ → 422.
      const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
      const res = await call(
        "GET",
        `/admin/x/audit?outcome=failure&action=${SECURITY_EVENTS.LOGIN}`,
        owner.headers,
      );
      expect(res.status).toBe(200);
      expect((res.data.audit_logs as AuditEntry[]).every((r) => r.outcome === "failure")).toBe(true);
      expect((await call("GET", "/admin/x/audit?outcome=error", owner.headers)).status).toBe(422);
    });

    describe("hồi quy review T-091: khớp route như router thấy, ngắt sớm, id mã hoá", () => {
      /** Request thô: URL tuyệt đối, GET kèm thân, ngắt socket ngay sau khi gửi. */
      function raw(
        method: string,
        path: string,
        headers: Record<string, string>,
        body?: string,
        opts: { abort?: boolean } = {},
      ): Promise<{ status: number }> {
        const base = new URL(
          String((rawApi as unknown as { defaults: { baseURL: string } }).defaults.baseURL),
        );
        return new Promise((resolve, reject) => {
          const req = http.request(
            { host: base.hostname, port: base.port, path, method, headers: { "user-agent": UA, ...headers } },
            (res) => {
              res.resume();
              res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
            },
          );
          req.on("error", (e) => (opts.abort === true ? resolve({ status: 0 }) : reject(e)));
          if (body !== undefined) req.write(body);
          req.end();
          if (opts.abort === true) setImmediate(() => req.destroy());
        });
      }
      const jsonHeaders = (body: string) => ({
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      });

      it("🔴1 `POST /auth/%75ser/emailpass` (Express giải mã tham số → vẫn là đăng nhập) sai mật khẩu → auth.login failure", async () => {
        await resetAuditThrottle();
        const admin = await createAdmin(rawApi, container, { roles: ["support"] });
        const idh = hashIdentifier(container, admin.email) as string;
        const res = await call("POST", "/auth/%75ser/emailpass", {}, { email: admin.email, password: "sai" });
        expect(res.status).toBe(401);
        const rows = await waitRows(
          { action: SECURITY_EVENTS.LOGIN, resource_id: idh, outcome: "failure" },
          1,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          changes: { actor_type: "user", provider: "emailpass", status: 401 },
        });
        expectWellFormed(rows, [admin.email]);
      });

      it("🔴1 GET đăng nhập kèm thân (405 từ T-138) → auth.login failure status 405", async () => {
        await resetAuditThrottle();
        const admin = await createAdmin(rawApi, container, { roles: ["support"] });
        const idh = hashIdentifier(container, admin.email) as string;
        const body = JSON.stringify({ email: admin.email, password: admin.password });
        expect((await raw("GET", "/auth/user/emailpass", jsonHeaders(body), body)).status).toBe(405);
        const rows = await waitRows(
          { action: SECURITY_EVENTS.LOGIN, resource_id: idh, outcome: "failure" },
          1,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ changes: { status: 405, route: "GET /auth/:actor_type/:provider" } });
      });

      it("🔴1 request-target URL tuyệt đối (server test không có hook chặn 400 của medusa start) → vẫn audit đăng nhập", async () => {
        await resetAuditThrottle();
        const admin = await createAdmin(rawApi, container, { roles: ["support"] });
        const idh = hashIdentifier(container, admin.email) as string;
        const base = new URL(
          String((rawApi as unknown as { defaults: { baseURL: string } }).defaults.baseURL),
        );
        const body = JSON.stringify({ email: admin.email, password: "sai" });
        const abs = `http://localhost:${base.port}/auth/user/emailpass`;
        expect((await raw("POST", abs, jsonHeaders(body), body)).status).toBe(401);
        const rows = await waitRows(
          { action: SECURITY_EVENTS.LOGIN, resource_id: idh, outcome: "failure" },
          1,
        );
        expect(rows).toHaveLength(1);
      });

      it("🟠3 `GET /admin/customers/cus%5F…` → data.accessed với resource_id đã giải mã", async () => {
        const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
        const [customer] = await container
          .resolve(Modules.CUSTOMER)
          .createCustomers([{ email: `khach-${randomUUID()}@example.test`, first_name: "Khach" }]);
        const id = customer!.id;
        const encoded = id.replace("_", "%5F");
        expect(encoded).not.toBe(id);
        expect((await call("GET", `/admin/customers/${encoded}`, owner.headers)).status).toBe(200);
        const rows = await waitRows({ action: SECURITY_EVENTS.DATA_ACCESSED, actor_id: owner.userId }, 1);
        expect(rows.map((r) => [r.resource_type, r.resource_id])).toEqual([["customer", id]]);
      });

      it("🟠1 client ngắt kết nối trước khi xuất xong → data.exported failure, changes.aborted", async () => {
        const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
        await raw("GET", "/admin/x/exports/products.csv", owner.headers, undefined, { abort: true });
        const rows = await waitRows({ action: SECURITY_EVENTS.DATA_EXPORTED, actor_id: owner.userId }, 1);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          outcome: "failure",
          resource_id: "products.csv",
          changes: { aborted: true },
        });
      });
    });
  },
});
