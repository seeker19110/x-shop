import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, generateJwtToken, Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import Redis from "ioredis";
import { AUTH_RATE_LIMITS } from "../../src/lib/admin-security/config";
import { KEY_PREFIX } from "../../src/lib/admin-security/store";
import { DENY_AUDIT_THROTTLE } from "../../src/lib/audit/deny-throttle";
import { SECURITY_EVENTS } from "../../src/lib/audit/events";
import { anonBucket, INPUT_ANON_GLOBAL_CAP } from "../../src/lib/audit/input";
import { outcomeOfStatus } from "../../src/lib/audit/http";
import { hashIdentifier } from "../../src/lib/audit/record";
import { SecurityAuditRecord } from "../../src/lib/audit/schema";
import { DEV_PRIVATE_UPLOAD_DIRNAME } from "../../src/lib/env";
import { AUDIT_MODULE } from "../../src/modules/audit";
import type { AuditEntry, AuditListFilter } from "../../src/modules/audit/service";
import type AuditModuleService from "../../src/modules/audit/service";
import seedCatalog from "../../src/scripts/seed-catalog";
import {
  createAdmin,
  createMfaAdmin,
  enrollTotp,
  jwtPayload,
  noThrow,
  totp,
  type MfaAdmin,
} from "../helpers/auth";

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
/** PNG 1×1 hợp lệ (cùng mẫu security.spec.ts). */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
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
    // Xuất native (`POST /admin/customers/export`) ghi file private qua file provider cục bộ vào PRIVATE_UPLOAD_DIR (T-141;
    // vắng → `<cwd>/private-uploads`) — dọn file do suite tạo để test không để lại dữ liệu xuất trên máy.
    const privateDir = process.env.PRIVATE_UPLOAD_DIR || join(process.cwd(), DEV_PRIVATE_UPLOAD_DIRNAME);
    const exportFiles = () =>
      existsSync(privateDir) ? readdirSync(privateDir).filter((f) => /^private-.*\.json$/.test(f)) : [];
    const before = new Set(exportFiles());
    afterAll(async () => {
      await redis.quit();
      await sleep(500);
      for (const f of exportFiles()) if (!before.has(f)) rmSync(join(privateDir, f), { force: true });
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
     * Cửa sổ gộp audit là cửa sổ CỐ ĐỊNH canh theo epoch (`windowStartMs`, 60 s): một loạt request vắt qua ranh giới cửa sổ
     * cho occurrence [1, 1] thay vì [1, 10] (flake đã gặp ở ca "đổi email mỗi lần", T-175). Gần ranh giới → chờ sang cửa sổ
     * mới rồi mới bắt đầu loạt request.
     */
    const awayFromWindowEdge = async (marginMs = 10_000) => {
      const windowMs = DENY_AUDIT_THROTTLE.windowMs;
      const left = windowMs - (Date.now() % windowMs);
      if (left < marginMs) await sleep(left + 200);
    };

    /**
     * Xoá bộ đếm gộp audit (`audit.rbac_denied:*` — cùng tiền tố cho mọi nhóm gộp) để ca kiểm "lần 1 của nhóm" không phụ
     * thuộc ca trước trong cùng cửa sổ 60 s (mọi request test cùng IP 127.0.0.1); tránh ranh giới cửa sổ (ở trên).
     */
    const resetAuditThrottle = async () => {
      await awayFromWindowEdge();
      await container
        .resolve(ContainerRegistrationKeys.PG_CONNECTION)
        .raw(`DELETE FROM rate_limit_counter WHERE bucket LIKE 'audit.rbac_denied:%'`);
    };

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
        // Id sai dạng (quá dài) → vẫn 404 và vẫn ghi audit failure NOT_FOUND (hành vi T-091 giữ nguyên sau T-177).
        const malformed = await call("POST", `/admin/x/users/${"u".repeat(200)}/roles`, owner.headers, {
          role: "support",
        });
        expect(malformed.status).toBe(404);
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
        const malformedRows = await waitRows(
          { action: SECURITY_EVENTS.ROLE_GRANTED, resource_id: "(invalid-id)" },
          1,
        );
        expect(malformedRows[0]).toMatchObject({ outcome: "failure", changes: { error_code: "NOT_FOUND" } });
        const rbac = await waitRows({ action: SECURITY_EVENTS.RBAC_DENIED, actor_id: support.userId }, 1);
        expect(rbac[0]).toMatchObject({ outcome: "denied" });
        expectWellFormed(
          [...ok, ...failed, ...malformedRows, ...rbac],
          [owner.email, target.email, support.email],
        );
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
        const encoded = id.replaceAll("_", "%5F");
        expect(encoded).not.toBe(id);
        expect((await call("GET", `/admin/customers/${encoded}`, owner.headers)).status).toBe(200);
        const rows = await waitRows({ action: SECURITY_EVENTS.DATA_ACCESSED, actor_id: owner.userId }, 1);
        expect(rows.map((r) => [r.resource_type, r.resource_id])).toEqual([["customer", id]]);
      });

      it("🟠A client ngắt ngay sau khi gửi `POST /admin/customers/export` → workflow vẫn tạo file → audit success + aborted (status thật 202)", async () => {
        const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
        const filesBefore = new Set(exportFiles());
        const body = JSON.stringify({});
        await raw("POST", "/admin/customers/export", { ...owner.headers, ...jsonHeaders(body) }, body, {
          abort: true,
        });
        const rows = await waitRows({ action: SECURITY_EVENTS.DATA_EXPORTED, actor_id: owner.userId }, 1);
        // Workflow xuất chạy tiếp dù client đã ngắt: file xuất thật sự được tạo.
        const until = Date.now() + 15_000;
        let created = exportFiles().filter((f) => !filesBefore.has(f));
        while (created.length === 0 && Date.now() < until) {
          await sleep(200);
          created = exportFiles().filter((f) => !filesBefore.has(f));
        }
        expect(created.length).toBeGreaterThan(0);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          outcome: "success",
          resource_id: "customers",
          changes: { aborted: true, status: 202, format: "json", pii: true },
        });
      });

      it("🟠A xuất CSV catalog trên store ĐÃ seed, client ngắt sớm → success + aborted (status 200)", async () => {
        const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
        // DB được dọn giữa các ca → seed lại; bảo đảm route trả 200 (không phải 500 của store chưa seed — review 🟢F).
        await seedCatalog({ container });
        expect((await call("GET", "/admin/x/exports/products.csv", owner.headers)).status).toBe(200);
        await raw("GET", "/admin/x/exports/products.csv", owner.headers, undefined, { abort: true });
        const rows = await waitRows({ action: SECURITY_EVENTS.DATA_EXPORTED, actor_id: owner.userId }, 2);
        const aborted = rows.filter((r) => (r.changes as Row).aborted === true);
        expect(aborted).toHaveLength(1);
        expect(aborted[0]).toMatchObject({ outcome: "success", changes: { status: 200, format: "csv" } });
      });

      it("🟠B xoay địa chỉ IPv6 trong một /64 (X-Forwarded-For, proxy tin cậy loopback) → vẫn gộp: ≤ 2 dòng / 15 lần sai", async () => {
        await resetAuditThrottle();
        const rid = `r-t091-v6-${randomUUID().slice(0, 8)}`;
        for (let i = 0; i < 15; i++) {
          const res = await call(
            "POST",
            "/auth/user/emailpass",
            { "x-forwarded-for": `2001:db8:77:1::${(i + 1).toString(16)}`, "x-request-id": `${rid}-${i}` },
            { email: `v6-${randomUUID()}@x-shop.test`, password: "sai" },
          );
          expect(res.status).toBe(401);
        }
        await sleep(800);
        const rows = (
          await Promise.all(Array.from({ length: 15 }, (_v, i) => list({ request_id: `${rid}-${i}` })))
        ).flat();
        expect(
          rows
            .map((r) => ((r.changes as Row).throttle as Row).occurrence)
            .sort((a, b) => Number(a) - Number(b)),
        ).toEqual([1, 10]);
        // Cột ip_hash vẫn là băm của địa chỉ đầy đủ (khác nhau giữa các địa chỉ trong /64).
        expect(new Set(rows.map((r) => r.ip_hash)).size).toBe(2);
      });

      it("🟢E `//` trong đường dẫn (Express không khớp route → 404) → không ghi data.accessed", async () => {
        const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
        const res = await raw("GET", "/admin//customers", owner.headers);
        expect(res.status).not.toBe(200);
        await sleep(600);
        expect(await list({ action: SECURITY_EVENTS.DATA_ACCESSED, actor_id: owner.userId })).toHaveLength(0);
      });
    });

    describe("T-175: upload, đổi cấu hình native, 403 MFA/xác thực lại, đầu vào bị từ chối", () => {
      const baseUrl = () => String((rawApi as unknown as { defaults: { baseURL: string } }).defaults.baseURL);
      const byOccurrence = (rows: Row[]) =>
        rows
          .map((r) => ((r.changes as Row).throttle as Row).occurrence)
          .sort((a, b) => Number(a) - Number(b));

      async function upload(
        headers: Record<string, string>,
        files: Array<{ name: string; type: string; data: Buffer }>,
      ): Promise<{ status: number; body: Record<string, unknown> }> {
        const form = new FormData();
        for (const f of files)
          form.append("files", new Blob([new Uint8Array(f.data)], { type: f.type }), f.name);
        const res = await fetch(new URL("/admin/uploads", baseUrl()), {
          method: "POST",
          body: form,
          headers: { "user-agent": UA, ...headers },
        });
        const text = await res.text();
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          // không phải JSON
        }
        return { status: res.status, body };
      }

      /** Thân thô (JSON hỏng) — axios tự tuần tự hoá nên dùng fetch. */
      async function rawBody(method: string, path: string, headers: Record<string, string>, body: string) {
        const res = await fetch(new URL(path, baseUrl()), {
          method,
          body,
          headers: { "user-agent": UA, "content-type": "application/json", ...headers },
        });
        return { status: res.status, body: await res.text() };
      }

      /** Token cùng phiên nhưng đổi claim (mốc MFA cũ) — ký bằng JWT secret của app như mfa.spec.ts. */
      function forgeToken(base: MfaAdmin, claims: Record<string, unknown>) {
        const payload = jwtPayload(base.headers.authorization.slice("Bearer ".length));
        const { http: cfg } = container.resolve(ContainerRegistrationKeys.CONFIG_MODULE).projectConfig;
        const { exp: _exp, ...rest } = payload;
        const token = generateJwtToken(
          { ...rest, ...claims },
          { secret: cfg.jwtSecret as string, expiresIn: "1d" },
        );
        return { authorization: `Bearer ${token}` };
      }
      const staleMfa = (a: MfaAdmin) =>
        forgeToken(a, { mfa_challenge_completed_at: new Date(Date.now() - 6 * 60_000).toISOString() });

      async function storeId(): Promise<string> {
        const stores = await container.resolve(Modules.STORE).listStores({});
        if (stores[0]) return stores[0].id;
        const [created] = await container.resolve(Modules.STORE).createStores([{ name: "x-shop test" }]);
        return created!.id;
      }

      describe("upload", () => {
        it("PNG hợp lệ → file.uploaded success (id file, số file, MIME đã kiểm; không tên file); xoá → file.deleted", async () => {
          const owner = await createAdmin(rawApi, container, { roles: ["owner"] });
          const up = await upload(owner.headers, [
            { name: "nguyen-van-a-0912345678.png", type: "application/octet-stream", data: PNG },
          ]);
          expect(up.status).toBe(200);
          const fileId = (up.body.files as Array<{ id: string }>)[0]!.id;
          const rows = await waitRows({ action: SECURITY_EVENTS.FILE_UPLOADED, actor_id: owner.userId }, 1);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            outcome: "success",
            resource_type: "file",
            resource_id: fileId,
            changes: { status: 200, file_count: 1, total_bytes: PNG.length, mime_types: ["image/png"] },
          });

          const del = await call("DELETE", `/admin/uploads/${encodeURIComponent(fileId)}`, owner.headers);
          expect(del.status).toBe(200);
          const deleted = await waitRows({ action: SECURITY_EVENTS.FILE_DELETED, actor_id: owner.userId }, 1);
          expect(deleted).toHaveLength(1);
          expect(deleted[0]).toMatchObject({
            outcome: "success",
            resource_type: "file",
            resource_id: fileId,
          });
          expectWellFormed([...rows, ...deleted], [owner.email, "nguyen-van-a", "0912345678"]);
        });

        it("bị từ chối: SVG giả PNG (415), không phải multipart (415) → file.uploaded failure; vai trò thiếu quyền (403) → chỉ rbac.denied", async () => {
          const owner = await createAdmin(rawApi, container, { roles: ["owner"] });
          const bad = await upload(owner.headers, [{ name: "logo.png", type: "image/png", data: SVG }]);
          expect(bad.status).toBe(415);
          const failed = await waitRows({ action: SECURITY_EVENTS.FILE_UPLOADED, actor_id: owner.userId }, 1);
          expect(failed).toHaveLength(1);
          expect(failed[0]).toMatchObject({
            outcome: "failure",
            resource_id: null,
            changes: { status: 415, error_code: "UNSUPPORTED_MEDIA_TYPE", file_count: 1 },
          });
          expect((failed[0]?.changes as Row).mime_types).toBeUndefined();
          // Không phải multipart → chặn trước multer (uploadPrecheck) → vẫn có dấu vết.
          expect((await call("POST", "/admin/uploads", owner.headers, { files: [] })).status).toBe(415);
          const both = await waitRows({ action: SECURITY_EVENTS.FILE_UPLOADED, actor_id: owner.userId }, 2);
          expect(both).toHaveLength(2);

          const support = await createAdmin(rawApi, container, { roles: ["support"] });
          const denied403 = await upload(support.headers, [{ name: "a.png", type: "image/png", data: PNG }]);
          expect(denied403.status).toBe(403);
          const denied = await waitRows({ action: SECURITY_EVENTS.RBAC_DENIED, actor_id: support.userId }, 1);
          expect(denied).toHaveLength(1);
          expect(
            await list({ action: SECURITY_EVENTS.FILE_UPLOADED, actor_id: support.userId }),
          ).toHaveLength(0);
          expectWellFormed([...both, ...denied], [owner.email, support.email, "<svg"]);
        });
      });

      describe("đổi cấu hình qua route native", () => {
        it("store, khoá API (tạo/thu hồi/xoá), lời mời (tạo/xoá), user (token đặt lại, xoá) → config.changed; không giá trị/khoá bí mật/email", async () => {
          const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
          const sid = await storeId();
          const storeName = `Cửa hàng ${randomUUID().slice(0, 6)}`;
          expect(
            (await call("POST", `/admin/stores/${sid}`, owner.headers, { name: storeName })).status,
          ).toBe(200);

          const key = await call("POST", "/admin/api-keys", owner.headers, {
            title: "Kho đối tác",
            type: "secret",
          });
          expect(key.status).toBe(200);
          const apiKey = key.data.api_key as { id: string; token: string };
          expect(apiKey.token.length).toBeGreaterThan(10);
          expect((await call("POST", `/admin/api-keys/${apiKey.id}/revoke`, owner.headers, {})).status).toBe(
            200,
          );
          expect((await call("DELETE", `/admin/api-keys/${apiKey.id}`, owner.headers)).status).toBe(200);

          const inviteEmail = `moi-${randomUUID()}@x-shop.test`;
          const inv = await call("POST", "/admin/invites", owner.headers, { email: inviteEmail });
          expect(inv.status).toBe(200);
          const inviteId = (inv.data.invite as { id: string }).id;
          expect((await call("DELETE", `/admin/invites/${inviteId}`, owner.headers)).status).toBe(200);

          const target = await createAdmin(rawApi, container, { roles: [] });
          const reset = await call("POST", `/admin/users/${target.userId}/reset-password`, owner.headers, {});
          expect(reset.status).toBe(200);
          const resetToken = String(reset.data.token);
          expect((await call("DELETE", `/admin/users/${target.userId}`, owner.headers)).status).toBe(200);

          const rows = await waitRows({ action: SECURITY_EVENTS.CONFIG_CHANGED, actor_id: owner.userId }, 8);
          expect(rows).toHaveLength(8);
          const order = (x: unknown[], y: unknown[]) => JSON.stringify(x).localeCompare(JSON.stringify(y));
          expect(
            rows
              .map((r) => [r.resource_type, r.resource_id, (r.changes as Row).operation, r.outcome])
              .sort(order),
          ).toEqual(
            [
              ["store", sid, "update", "success"],
              ["api_key", apiKey.id, "create", "success"],
              ["api_key", apiKey.id, "revoke", "success"],
              ["api_key", apiKey.id, "delete", "success"],
              ["invite", inviteId, "create", "success"],
              ["invite", inviteId, "delete", "success"],
              ["user", target.userId, "reset_password_token_issued", "success"],
              ["user", target.userId, "delete", "success"],
            ].sort(order),
          );
          const byOp = Object.fromEntries(
            rows.map((r) => [`${String(r.resource_type)}:${String((r.changes as Row).operation)}`, r]),
          );
          expect((byOp["store:update"]?.changes as Row).fields).toEqual(["name"]);
          expect((byOp["invite:create"]?.changes as Row).fields).toEqual(["email"]);
          expect((byOp["api_key:create"]?.changes as Row).fields).toEqual(["title", "type"]);
          // Phản hồi reset-password chứa token của NGƯỜI KHÁC → actor vẫn là owner (token phản hồi ở /admin không được đọc).
          expect(byOp["user:reset_password_token_issued"]).toMatchObject({
            actor_type: "user",
            actor_id: owner.userId,
          });
          expectWellFormed(rows, [
            owner.email,
            target.email,
            inviteEmail,
            storeName,
            apiKey.token,
            resetToken,
          ]);
        });

        it("bị từ chối: owner chưa MFA → 403 MFA_REQUIRED = rbac.denied; vai trò thiếu quyền → rbac.denied; không có config.changed", async () => {
          const noMfa = await createAdmin(rawApi, container, { roles: ["owner"] });
          const res = await call("POST", "/admin/api-keys", noMfa.headers, { title: "x", type: "secret" });
          expect(res).toMatchObject({ status: 403, data: { code: "MFA_REQUIRED" } });
          const support = await createAdmin(rawApi, container, { roles: ["support"] });
          const sid = await storeId();
          expect((await call("POST", `/admin/stores/${sid}`, support.headers, { name: "x" })).status).toBe(
            403,
          );

          const mfa = await waitRows({ action: SECURITY_EVENTS.RBAC_DENIED, actor_id: noMfa.userId }, 1);
          expect(mfa).toHaveLength(1);
          expect(mfa[0]).toMatchObject({
            outcome: "denied",
            resource_type: "route",
            resource_id: "POST /admin/api-keys",
            changes: { reason: "MFA_REQUIRED", permission: "settings.manage" },
          });
          const forbidden = await waitRows(
            { action: SECURITY_EVENTS.RBAC_DENIED, actor_id: support.userId },
            1,
          );
          expect(forbidden[0]).toMatchObject({ changes: { reason: "missing_permission" } });
          for (const a of [noMfa, support])
            expect(await list({ action: SECURITY_EVENTS.CONFIG_CHANGED, actor_id: a.userId })).toHaveLength(
              0,
            );
          expectWellFormed([...mfa, ...forbidden], [noMfa.email, support.email]);
        });

        it("lỗi schema native (trường lạ) → config.changed failure + ĐÚNG MỘT input.validation_failed (handler lỗi và bộ quan sát không ghi trùng)", async () => {
          const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
          const sid = await storeId();
          const rid = `req-t175-schema-${randomUUID().slice(0, 8)}`;
          const secret = `mat-khau-${randomUUID()}`;
          const res = await call(
            "POST",
            `/admin/stores/${sid}`,
            { ...owner.headers, "x-request-id": rid },
            { name: "x", password: secret },
          );
          expect(res.status).toBe(400);
          const rows = await waitRows({ request_id: rid }, 2);
          expect(rows.map((r) => r.action).sort()).toEqual(
            [SECURITY_EVENTS.CONFIG_CHANGED, SECURITY_EVENTS.INPUT_VALIDATION_FAILED].sort(),
          );
          const input = rows.find((r) => r.action === SECURITY_EVENTS.INPUT_VALIDATION_FAILED) as Row;
          expect(input).toMatchObject({
            actor_type: "user",
            actor_id: owner.userId,
            outcome: "failure",
            resource_type: "http_route",
            resource_id: "POST /admin/stores/:id",
            changes: { status: 400, cause: "medusa_schema", error_code: "INVALID_DATA" },
          });
          const cfg = rows.find((r) => r.action === SECURITY_EVENTS.CONFIG_CHANGED) as Row;
          expect(cfg).toMatchObject({ outcome: "failure", resource_id: sid, changes: { status: 400 } });
          // Thân bị từ chối: KHÔNG chép tên trường (client tự đặt khoá được); thông điệp lỗi Medusa không được ghi.
          expect((cfg.changes as Row).fields).toBeUndefined();
          expectWellFormed(rows, [owner.email, secret, "Invalid request", "password"]);
        });

        it("🟠1 review: ghi native mang quyền settings.manage ngoài 4 nhóm (vùng, kênh bán, hồ sơ giao, kho, lý do trả, thuế, workflow) → config.changed suy từ bảng quyền", async () => {
          const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
          const tag = randomUUID().slice(0, 6);
          const reg = await call("POST", "/admin/regions", owner.headers, {
            name: `Vùng ${tag}`,
            currency_code: "vnd",
            countries: [],
          });
          expect(reg.status).toBe(200);
          const regionId = (reg.data.region as { id: string }).id;
          expect(
            (await call("POST", `/admin/regions/${regionId}`, owner.headers, { automatic_taxes: false }))
              .status,
          ).toBe(200);
          const sc = await call("POST", "/admin/sales-channels", owner.headers, { name: `Kênh ${tag}` });
          expect(sc.status).toBe(200);
          const sp = await call("POST", "/admin/shipping-profiles", owner.headers, {
            name: `Hồ sơ ${tag}`,
            type: "default",
          });
          expect(sp.status).toBe(200);
          const sl = await call("POST", "/admin/stock-locations", owner.headers, { name: `Kho ${tag}` });
          expect(sl.status).toBe(200);
          const rr = await call("POST", "/admin/return-reasons", owner.headers, {
            value: `ly_do_${tag}`,
            label: `Lý do ${tag}`,
          });
          expect(rr.status).toBe(200);
          // Bị từ chối ở schema / không tồn tại → vẫn có dấu vết (failure), không tên trường.
          const tax = await call("POST", "/admin/tax-regions", owner.headers, {
            country_code: "la",
            ten_la: "x",
          });
          expect(tax.status).toBeGreaterThanOrEqual(400);
          const wf = await call("POST", "/admin/workflows-executions/khong-co/run", owner.headers, {
            input: {},
          });
          expect(wf.status).toBeGreaterThanOrEqual(400);
          expect((await call("DELETE", `/admin/regions/${regionId}`, owner.headers)).status).toBe(200);

          const rows = await waitRows({ action: SECURITY_EVENTS.CONFIG_CHANGED, actor_id: owner.userId }, 9);
          expect(rows).toHaveLength(9);
          const got = rows.map((r) => [
            r.resource_type,
            (r.changes as Row).operation,
            r.outcome,
            (r.changes as Row).route,
          ]);
          const order = (x: unknown[], y: unknown[]) => JSON.stringify(x).localeCompare(JSON.stringify(y));
          expect(got.filter((g) => g[2] === "success").sort(order)).toEqual(
            [
              ["region", "create", "success", "POST /admin/regions"],
              ["region", "update", "success", "POST /admin/regions/:id"],
              ["region", "delete", "success", "DELETE /admin/regions/:id"],
              ["sales_channel", "create", "success", "POST /admin/sales-channels"],
              ["shipping_profile", "create", "success", "POST /admin/shipping-profiles"],
              ["stock_location", "create", "success", "POST /admin/stock-locations"],
              ["return_reason", "create", "success", "POST /admin/return-reasons"],
            ].sort(order),
          );
          const byRoute = Object.fromEntries(rows.map((r) => [String((r.changes as Row).route), r]));
          expect(byRoute["POST /admin/regions"]).toMatchObject({
            resource_id: regionId,
            changes: { fields: ["countries", "currency_code", "name"], derived_from: "rbac_permission" },
          });
          expect(byRoute["POST /admin/regions/:id"]).toMatchObject({ resource_id: regionId });
          expect(byRoute["POST /admin/sales-channels"]?.resource_id).toBe(
            (sc.data.sales_channel as { id: string }).id,
          );
          const failed = rows.filter((r) => r.outcome === "failure");
          expect(failed.map((r) => r.resource_type).sort()).toEqual(["tax_region", "workflows_execution"]);
          for (const f of failed) expect((f.changes as Row).fields).toBeUndefined();

          // Vai trò không có settings.manage → 403 (rbac.denied), không có config.changed.
          const catalog = await createAdmin(rawApi, container, { roles: ["catalog_manager"] });
          expect(
            (await call("POST", "/admin/regions", catalog.headers, { name: "x", currency_code: "vnd" }))
              .status,
          ).toBe(403);
          await sleep(500);
          expect(
            await list({ action: SECURITY_EVENTS.CONFIG_CHANGED, actor_id: catalog.userId }),
          ).toHaveLength(0);
          expectWellFormed(rows, [owner.email, `Vùng ${tag}`, `Kênh ${tag}`, `Lý do ${tag}`]);
        });

        it("🟢 review vòng 2: owner gõ sai đường dẫn ghi native (404, chưa tới route) → config.changed failure loại `unknown`, id NULL — không chép đường dẫn client", async () => {
          const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
          const rid = `req-t175-404-${randomUUID().slice(0, 8)}`;
          const res = await call(
            "POST",
            "/admin/khach-nguyen-van-a/0912345678",
            { ...owner.headers, "x-request-id": rid },
            { ghi_chu: "x" },
          );
          expect(res.status).toBe(404);
          const rows = await waitRows({ request_id: rid, action: SECURITY_EVENTS.CONFIG_CHANGED }, 1);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            actor_id: owner.userId,
            outcome: "failure",
            resource_type: "unknown",
            resource_id: null,
            changes: { status: 404, operation: "unknown", route: "POST (chưa tới route)" },
          });
          expect((rows[0]?.changes as Row).fields).toBeUndefined();
          expectWellFormed(rows, [owner.email, "khach-nguyen-van-a", "0912345678", "ghi_chu"]);
        });

        it("🟠3 review: chấp nhận lời mời — không token (401) → 1 dòng vô danh không tên trường; thành công → invite_accepted, id user từ phản hồi", async () => {
          await resetAuditThrottle();
          const rid = `req-t175-acc-${randomUUID().slice(0, 8)}`;
          const anon = await call(
            "POST",
            "/admin/invites/accept",
            { "x-request-id": rid },
            { first_name: "a", last_name: "b", ten_khach_nguyen_van_a: 1 },
          );
          expect(anon.status).toBe(401);
          const denied = await waitRows({ request_id: rid }, 1);
          expect(denied).toHaveLength(1);
          expect(denied[0]).toMatchObject({
            action: SECURITY_EVENTS.CONFIG_CHANGED,
            actor_type: "anonymous",
            actor_id: null,
            outcome: "failure",
            resource_type: "user",
            resource_id: null,
            changes: { operation: "invite_accepted", status: 401 },
          });
          expect((denied[0]?.changes as Row).fields).toBeUndefined();

          const email = `moi-nhan-${randomUUID()}@x-shop.test`;
          const password = `pw-${randomUUID()}`;
          const [invite] = await container.resolve(Modules.USER).createInvites([{ email }]);
          const reg = await call(
            "POST",
            "/auth/user/emailpass/register",
            {},
            {
              email,
              password,
              invite_token: invite!.token,
            },
          );
          expect(reg.status).toBe(200);
          const authIdentityId = jwtPayload(String(reg.data.token)).auth_identity_id as string;
          const rid2 = `req-t175-acc-ok-${randomUUID().slice(0, 8)}`;
          const acc = await call(
            "POST",
            `/admin/invites/accept?token=${encodeURIComponent(invite!.token)}`,
            { authorization: `Bearer ${String(reg.data.token)}`, "x-request-id": rid2 },
            { first_name: "Nhân", last_name: "Viên" },
          );
          expect(acc.status).toBe(200);
          const userId = (acc.data.user as { id: string }).id;
          const ok = await waitRows({ request_id: rid2, action: SECURITY_EVENTS.CONFIG_CHANGED }, 1);
          expect(ok).toHaveLength(1);
          expect(ok[0]).toMatchObject({
            actor_type: "auth_identity",
            actor_id: authIdentityId,
            outcome: "success",
            resource_type: "user",
            resource_id: userId,
            changes: { operation: "invite_accepted", status: 200, fields: ["first_name", "last_name"] },
          });
          expectWellFormed([...denied, ...ok], [email, password, invite!.token, "Nhân", "nguyen_van_a"]);
        });
      });

      describe("403 MFA_REQUIRED / REAUTH_REQUIRED", () => {
        it("cổng: mốc MFA cũ hơn 5 phút ở thao tác reauth → rbac.denied REAUTH_REQUIRED; MFA mới → được (không thêm dòng)", async () => {
          const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
          const target = await createAdmin(rawApi, container, { roles: [] });
          const url = `/admin/x/users/${target.userId}/roles`;
          const res = await call("POST", url, staleMfa(owner), { role: "support" });
          expect(res).toMatchObject({ status: 403, data: { code: "REAUTH_REQUIRED" } });
          expect((await call("POST", url, owner.headers, { role: "support" })).status).toBe(201);
          const rows = await waitRows({ action: SECURITY_EVENTS.RBAC_DENIED, actor_id: owner.userId }, 1);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            outcome: "denied",
            // rbac.denied ghi đường dẫn đã chuẩn hoá của cổng (normalizeAdminPath — chữ thường), như các lần từ chối khác.
            resource_id: `POST ${url.toLowerCase()}`,
            changes: { reason: "REAUTH_REQUIRED", permission: "user.manage" },
          });
          expectWellFormed(rows, [owner.email]);
        });

        it("trong route (hoàn tiền vượt ngưỡng): mốc MFA cũ → 403 REAUTH_REQUIRED = rbac.denied in_route; chưa MFA → MFA_REQUIRED ở cổng", async () => {
          const acc = await createMfaAdmin(rawApi, container, { roles: ["accountant"] });
          const body = { order_id: "order_khong_co", reason: "cancellation" };
          const key = { "idempotency-key": `t175-${randomUUID()}` };
          const res = await call("POST", "/admin/x/refunds", { ...staleMfa(acc), ...key }, body);
          expect(res).toMatchObject({ status: 403, data: { code: "REAUTH_REQUIRED" } });
          const inRoute = await waitRows({ action: SECURITY_EVENTS.RBAC_DENIED, actor_id: acc.userId }, 1);
          expect(inRoute).toHaveLength(1);
          expect(inRoute[0]).toMatchObject({
            resource_id: "POST /admin/x/refunds",
            changes: { reason: "REAUTH_REQUIRED", in_route: true },
          });

          const plain = await createAdmin(rawApi, container, { roles: ["accountant"] });
          const gate = await call("POST", "/admin/x/refunds", { ...plain.headers, ...key }, body);
          expect(gate).toMatchObject({ status: 403, data: { code: "MFA_REQUIRED" } });
          const atGate = await waitRows({ action: SECURITY_EVENTS.RBAC_DENIED, actor_id: plain.userId }, 1);
          expect(atGate[0]).toMatchObject({
            changes: { reason: "MFA_REQUIRED", permission: "refund.request" },
          });
          expectWellFormed([...inRoute, ...atGate], [acc.email, plain.email]);
        });

        it("ĐỒNG THỜI: 12 request MFA_REQUIRED song song của một actor → gộp (lần 1, 10), không trùng", async () => {
          const noMfa = await createAdmin(rawApi, container, { roles: ["owner"] });
          await awayFromWindowEdge();
          const all = await Promise.all(
            Array.from({ length: 12 }, () =>
              call("POST", "/admin/api-keys", noMfa.headers, { title: "x", type: "secret" }),
            ),
          );
          expect(all.map((r) => r.status)).toEqual(Array(12).fill(403));
          const rows = await waitRows({ action: SECURITY_EVENTS.RBAC_DENIED, actor_id: noMfa.userId }, 2);
          expect(byOccurrence(rows)).toEqual([1, 10]);
        });
      });

      describe("đầu vào bị từ chối", () => {
        it("JSON hỏng (ở đăng nhập, thân có mật khẩu) → input.deserialize_failed vô danh, một dòng, không chép thân", async () => {
          await resetAuditThrottle();
          const rid = `req-t175-json-${randomUUID().slice(0, 8)}`;
          const secret = `pw-${randomUUID()}`;
          const res = await rawBody(
            "POST",
            "/auth/user/emailpass",
            { "x-request-id": rid },
            `{"email":"nan@x-shop.test","password":"${secret}"`,
          );
          expect(res.status).toBe(400);
          expect(res.body).not.toContain(secret);
          const rows = await waitRows({ request_id: rid }, 1);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            action: SECURITY_EVENTS.INPUT_DESERIALIZE_FAILED,
            actor_type: "anonymous",
            actor_id: null,
            outcome: "failure",
            resource_type: "http_route",
            resource_id: "POST /auth/user/emailpass",
            changes: { status: 400, cause: "body_parse", error_code: "INVALID_DATA" },
          });
          expectWellFormed(rows, [secret, "nan@x-shop.test"]);
        });

        it("tham số đường dẫn mã hoá hỏng → input.deserialize_failed (path_decode, nhãn cố định); NUL trong thân → input.validation_failed", async () => {
          await resetAuditThrottle();
          const rid = `req-t175-uri-${randomUUID().slice(0, 8)}`;
          const bad = await call(
            "POST",
            "/auth/%E0%A4%A/emailpass",
            { "x-request-id": rid },
            { email: "a@example.test" },
          );
          expect(bad.status).toBe(400);
          const uri = await waitRows(
            { request_id: rid, action: SECURITY_EVENTS.INPUT_DESERIALIZE_FAILED },
            1,
          );
          expect(uri).toHaveLength(1);
          expect(uri[0]).toMatchObject({
            resource_id: "POST (đường dẫn không hợp lệ)",
            changes: { status: 400, cause: "path_decode", error_code: "INVALID_PATH" },
          });

          await resetAuditThrottle();
          const rid2 = `req-t175-nul-${randomUUID().slice(0, 8)}`;
          const nul = await call(
            "POST",
            "/auth/user/emailpass",
            { "x-request-id": rid2 },
            { email: "nul\u0000@x-shop.test", password: "x" },
          );
          expect(nul.status).toBe(400);
          const rows = await waitRows(
            { request_id: rid2, action: SECURITY_EVENTS.INPUT_VALIDATION_FAILED },
            1,
          );
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            changes: { status: 400, cause: "problem_code", error_code: "INVALID_CHARACTERS" },
          });
          expectWellFormed([...uri, ...rows], ["nul\u0000@", "a@example.test"]);
        });

        it("422 VALIDATION của route dự án → input.validation_failed có tên tham số (không giá trị); request hợp lệ → không ghi", async () => {
          const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
          const rid = `req-t175-422-${randomUUID().slice(0, 8)}`;
          const res = await call("GET", "/admin/x/audit?outcome=loi-0912345678", {
            ...owner.headers,
            "x-request-id": rid,
          });
          expect(res.status).toBe(422);
          const rows = await waitRows({ request_id: rid }, 1);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            action: SECURITY_EVENTS.INPUT_VALIDATION_FAILED,
            actor_id: owner.userId,
            resource_id: "GET /admin/x/audit",
            changes: { status: 422, error_code: "VALIDATION", cause: "problem_code", params: ["outcome"] },
          });
          const okRid = `req-t175-ok-${randomUUID().slice(0, 8)}`;
          const ok = await call("GET", "/admin/x/audit?outcome=failure", {
            ...owner.headers,
            "x-request-id": okRid,
          });
          expect(ok.status).toBe(200);
          expect(await waitRows({ request_id: okRid }, 0, 500)).toHaveLength(0);
          expectWellFormed(rows, [owner.email, "0912345678", "loi-"]);
        });

        it("ĐỒNG THỜI: 12 JSON hỏng song song cùng IP (email khác nhau) → gộp theo nguồn: đúng 2 dòng (lần 1, 10)", async () => {
          await resetAuditThrottle();
          const rid = `req-t175-flood-${randomUUID().slice(0, 8)}`;
          const all = await Promise.all(
            Array.from({ length: 12 }, (_v, i) =>
              rawBody(
                "POST",
                "/auth/user/emailpass",
                { "x-request-id": `${rid}-${i}` },
                `{"email":"f${i}@x-shop.test",`,
              ),
            ),
          );
          expect(all.map((r) => r.status)).toEqual(Array(12).fill(400));
          await sleep(800);
          const rows = (
            await Promise.all(Array.from({ length: 12 }, (_v, i) => list({ request_id: `${rid}-${i}` })))
          ).flat();
          expect(rows.every((r) => r.action === SECURITY_EVENTS.INPUT_DESERIALIZE_FAILED)).toBe(true);
          expect(byOccurrence(rows)).toEqual([1, 10]);
        });

        /** Request thô với method tuỳ ý (axios/fetch không gửi được mọi method). */
        function rawMethod(method: string, path: string, headers: Record<string, string>, body: string) {
          const u = new URL(baseUrl());
          return new Promise<number>((resolve, reject) => {
            const r = http.request(
              {
                host: u.hostname,
                port: u.port,
                method,
                path,
                headers: {
                  "user-agent": UA,
                  "content-type": "application/json",
                  "content-length": String(Buffer.byteLength(body)),
                  ...headers,
                },
              },
              (res) => {
                res.resume();
                res.on("end", () => resolve(res.statusCode ?? 0));
              },
            );
            r.on("error", reject);
            r.end(body);
          });
        }

        it("🟠2/M9 review: cùng IP, 32 method × 32 đường dẫn khác nhau, JSON hỏng → khoá gộp không có method/đường dẫn: 2 dòng (lần 1, 10)", async () => {
          await resetAuditThrottle();
          const methods = [
            "POST",
            "PUT",
            "PATCH",
            "DELETE",
            "GET",
            "OPTIONS",
            "PROPFIND",
            "MKCOL",
            "LOCK",
            "UNLOCK",
          ];
          methods.push(
            "COPY",
            "MOVE",
            "REPORT",
            "SEARCH",
            "PURGE",
            "MERGE",
            "NOTIFY",
            "SUBSCRIBE",
            "UNSUBSCRIBE",
          );
          methods.push(
            "ACL",
            "BIND",
            "REBIND",
            "UNBIND",
            "LINK",
            "UNLINK",
            "CHECKOUT",
            "MKACTIVITY",
            "MKCALENDAR",
          );
          methods.push("PROPPATCH", "SOURCE", "M-SEARCH", "QUERY");
          expect(methods).toHaveLength(32);
          const rid = `req-t175-m-${randomUUID().slice(0, 8)}`;
          const statuses: number[] = [];
          for (const [i, m] of methods.entries())
            statuses.push(
              await rawMethod(
                m,
                `/store/khong-co-${i}-${randomUUID().slice(0, 4)}`,
                { "x-request-id": `${rid}-${i}` },
                "{hong",
              ),
            );
          expect(statuses).toEqual(Array(32).fill(400));
          await sleep(800);
          const rows = (
            await Promise.all(methods.map((_m, i) => list({ request_id: `${rid}-${i}` })))
          ).flat();
          expect(rows.every((r) => r.action === SECURITY_EVENTS.INPUT_DESERIALIZE_FAILED)).toBe(true);
          expect(byOccurrence(rows)).toEqual([1, 10]);
          // Đích vẫn ghi method + đường dẫn của lần được ghi.
          expect(
            String(rows.find((r) => ((r.changes as Row).throttle as Row).occurrence === 1)?.resource_id),
          ).toMatch(/^POST \/store\/khong-co-0-/);
        });

        it(`🟠2 review: nhiều IP vô danh (X-Forwarded-For, proxy tin cậy loopback) → không quá trần chung ${INPUT_ANON_GLOBAL_CAP} dòng/cửa sổ`, async () => {
          await resetAuditThrottle();
          const n = INPUT_ANON_GLOBAL_CAP + 15;
          const rid = `req-t175-cap-${randomUUID().slice(0, 8)}`;
          for (let i = 0; i < n; i++) {
            const res = await rawBody(
              "POST",
              "/auth/user/emailpass",
              {
                "x-request-id": `${rid}-${i}`,
                "x-forwarded-for": `198.51.${100 + Math.floor(i / 200)}.${(i % 200) + 1}`,
              },
              "{hong",
            );
            expect(res.status).toBe(400);
          }
          // Ghi audit chạy SAU `finish`, bất đồng bộ — dưới tải có thể trễ quá một khoảng ngủ cố định. Chờ theo điều kiện:
          // bộ đếm dòng chung đã nhận đủ `n` quyết định trần (mỗi IP là lần 1 của nhóm nguồn → mọi request đều đếm dòng)
          // VÀ đã có ≥ trần + 1 dòng; rồi một nhịp nữa để dòng thừa (nếu có lỗi) kịp hiện — assert dưới vẫn so bằng.
          const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
          const rowsBucket = anonBucket(SECURITY_EVENTS.INPUT_DESERIALIZE_FAILED, "rows");
          const decided = async () =>
            Number(
              (
                (await pg.raw(
                  `SELECT COALESCE(SUM(count), 0) AS n FROM rate_limit_counter WHERE bucket = ?`,
                  [rowsBucket],
                )) as { rows: { n: string | number }[] }
              ).rows[0]?.n ?? 0,
            );
          const listAll = async () =>
            (
              await Promise.all(Array.from({ length: n }, (_v, i) => list({ request_id: `${rid}-${i}` })))
            ).flat();
          const until = Date.now() + 15_000;
          let rows = await listAll();
          while (((await decided()) < n || rows.length < INPUT_ANON_GLOBAL_CAP + 1) && Date.now() < until) {
            await sleep(100);
            rows = await listAll();
          }
          await sleep(400);
          rows = await listAll();
          expect(await decided()).toBe(n);
          // Trần + MỘT dòng đánh dấu (vòng 2 review: không chặn im lặng).
          expect(rows).toHaveLength(INPUT_ANON_GLOBAL_CAP + 1);
          // Mỗi IP là lần 1 của nhóm nguồn của nó — chỉ trần chung chặn phần vượt.
          expect(new Set(rows.map((r) => ((r.changes as Row).throttle as Row).occurrence))).toEqual(
            new Set([1]),
          );
          expect(new Set(rows.map((r) => r.ip_hash)).size).toBe(INPUT_ANON_GLOBAL_CAP + 1);
          const marked = rows.filter((r) => (r.changes as Row).global_cap !== undefined);
          expect(marked).toHaveLength(1);
          const mark = (marked[0]?.changes as Row).global_cap as Row;
          expect(mark).toMatchObject({ cap: INPUT_ANON_GLOBAL_CAP, mark: "reached" });
          // occurrence = số request vô danh THÔ của cửa sổ lúc chạm trần (bộ đếm đã xoá ở đầu ca).
          expect(Number(mark.occurrence)).toBeGreaterThanOrEqual(INPUT_ANON_GLOBAL_CAP + 1);
          expect(Number(mark.occurrence)).toBeLessThanOrEqual(n);
          // Actor đã xác thực không bị trần vô danh chặn.
          const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
          const rid2 = `req-t175-cap-owner-${randomUUID().slice(0, 8)}`;
          expect(
            (await call("GET", "/admin/x/audit?outcome=sai", { ...owner.headers, "x-request-id": rid2 }))
              .status,
          ).toBe(422);
          expect(await waitRows({ request_id: rid2 }, 1)).toHaveLength(1);
        });
      });
    });
  },
});
