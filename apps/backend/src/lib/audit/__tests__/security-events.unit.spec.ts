import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultOutcomeOf } from "../../../modules/audit/service";
import { SECURITY_EVENT_NAMES, SECURITY_EVENTS } from "../events";
import { AUDIT_ROUTES, matchAuditRoute, outcomeOfStatus, resolveActor, tokenClaims } from "../http";
import { sanitizeUserAgent, USER_AGENT_MAX } from "../sanitize";
import { SecurityAuditRecord, securityEventJsonSchema } from "../schema";

const DOCS = join(__dirname, "../../../../../../docs/security");
const jwt = (payload: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

describe("bảng route audit (matchAuditRoute)", () => {
  const at = (url: string) => ({ originalUrl: url });
  const ev = (method: string, url: string) => matchAuditRoute(method, at(url))?.route.event ?? null;
  const segs = (method: string, url: string) => matchAuditRoute(method, at(url))?.segments ?? null;

  it("đăng nhập: mọi actor (identity emailpass dùng chung — T-138); route /auth tĩnh không bị nhận nhầm", () => {
    expect(ev("POST", "/auth/user/emailpass")).toBe(SECURITY_EVENTS.LOGIN);
    expect(ev("POST", "/auth/customer/emailpass?x=1")).toBe(SECURITY_EVENTS.LOGIN);
    expect(ev("POST", "/AUTH/User/EmailPass/")).toBe(SECURITY_EVENTS.LOGIN);
    expect(ev("POST", "/auth/token/refresh")).toBe(SECURITY_EVENTS.TOKEN_REFRESHED);
    expect(ev("POST", "/auth/mfa/factors")).toBe(SECURITY_EVENTS.MFA_ENROLL_STARTED);
    expect(ev("POST", "/auth/mfa/recovery-codes")).toBe(SECURITY_EVENTS.MFA_RECOVERY_CODES_ISSUED);
    expect(ev("POST", "/auth/verification/request")).toBeNull();
    expect(ev("POST", "/auth/verification/confirm")).toBeNull();
    // Actor lạ vẫn đoán được mật khẩu admin qua identity emailpass chung → vẫn là đăng nhập (review T-091 🔴1).
    expect(ev("POST", "/auth/admin/emailpass")).toBe(SECURITY_EVENTS.LOGIN);
    // GET đăng nhập emailpass (405 từ T-138) vẫn là một lần thử; GET provider khác / route tĩnh GET thì không.
    expect(ev("GET", "/auth/user/emailpass")).toBe(SECURITY_EVENTS.LOGIN);
    expect(ev("HEAD", "/auth/user/emailpass")).toBe(SECURITY_EVENTS.LOGIN);
    expect(ev("GET", "/auth/user/providers")).toBeNull();
    expect(ev("GET", "/auth/emailpass/user")).toBeNull();
    expect(ev("POST", "/auth/user/emailpass/register")).toBeNull();
    expect(ev("POST", "/auth/user/emailpass/callback")).toBeNull();
  });

  it("MFA, phiên, mật khẩu", () => {
    expect(ev("POST", "/auth/mfa/challenges/mfac_1/verify")).toBe(SECURITY_EVENTS.MFA_VERIFIED);
    expect(ev("POST", "/auth/mfa/factors/mfaf_1/verify")).toBe(SECURITY_EVENTS.MFA_ENROLLED);
    expect(ev("DELETE", "/auth/mfa/factors/mfaf_1")).toBe(SECURITY_EVENTS.MFA_FACTOR_REMOVED);
    expect(ev("POST", "/auth/session")).toBe(SECURITY_EVENTS.SESSION_CREATED);
    expect(ev("DELETE", "/auth/session")).toBe(SECURITY_EVENTS.LOGOUT);
    expect(ev("POST", "/auth/user/emailpass/reset-password")).toBe(SECURITY_EVENTS.PASSWORD_RESET_REQUESTED);
    expect(ev("POST", "/auth/user/emailpass/update")).toBe(SECURITY_EVENTS.PASSWORD_CHANGED);
  });

  it("xuất/truy cập dữ liệu; HEAD = GET; ghi thường không khớp", () => {
    expect(ev("GET", "/admin/x/exports/products.csv")).toBe(SECURITY_EVENTS.DATA_EXPORTED);
    expect(ev("HEAD", "/admin/x/exports/products.csv")).toBe(SECURITY_EVENTS.DATA_EXPORTED);
    for (const p of ["orders", "customers", "products", "inventory-items"]) {
      expect(ev("POST", `/admin/${p}/export`)).toBe(SECURITY_EVENTS.DATA_EXPORTED);
    }
    expect(ev("GET", "/admin/x/settlements/batches/sb_1")).toBe(SECURITY_EVENTS.DATA_ACCESSED);
    expect(ev("GET", "/admin/x/settlements/batches")).toBeNull();
    expect(ev("GET", "/admin/customers")).toBe(SECURITY_EVENTS.DATA_ACCESSED);
    expect(ev("GET", "/admin/customers/cus_1/addresses")).toBe(SECURITY_EVENTS.DATA_ACCESSED);
    expect(ev("GET", "/admin/orders/order_1")).toBe(SECURITY_EVENTS.DATA_ACCESSED);
    expect(ev("POST", "/admin/orders/order_1")).toBeNull();
    expect(ev("GET", "/admin/products")).toBeNull();
    expect(ev("GET", "/store/x/products")).toBeNull();
    expect(
      matchAuditRoute("GET", at("/admin/customers/cus_1"))?.route.target?.(
        ["admin", "customers", "cus_1"],
        {} as never,
      ),
    ).toEqual({
      type: "customer",
      id: "cus_1",
    });
  });

  it("khớp như router Express thấy (T-145): tham số giải mã %xx, đoạn tĩnh so chuỗi thô, URL tuyệt đối, `\\`, `#`", () => {
    // Tham số được giải mã: `%75ser` = `user`.
    expect(ev("POST", "/auth/%75ser/emailpass")).toBe(SECURITY_EVENTS.LOGIN);
    expect(segs("POST", "/auth/%75ser/%65mailpass")).toEqual(["auth", "user", "emailpass"]);
    // Đoạn tĩnh mã hoá không khớp route tĩnh (Express cũng không) → rơi về mẫu tham số như router.
    expect(ev("POST", "/auth/%74oken/refresh")).toBe(SECURITY_EVENTS.LOGIN);
    expect(ev("GET", "/admin/%63ustomers/cus_1")).toBeNull();
    // Request-target tuyệt đối / `\` / `#` (production: server chặn 400 trước Express — T-145; không hook thì vẫn khớp).
    expect(ev("POST", "http://evil.test/auth/user/emailpass")).toBe(SECURITY_EVENTS.LOGIN);
    expect(ev("GET", "http://h/admin/customers/cus_1?fields=email")).toBe(SECURITY_EVENTS.DATA_ACCESSED);
    expect(ev("GET", "/admin\\customers\\cus_1#x")).toBe(SECURITY_EVENTS.DATA_ACCESSED);
    // Id mã hoá được giải mã trước safeId (review T-091 🟠3); mã hoá hỏng → không khớp (Express trả 400).
    expect(segs("GET", "/admin/customers/cus%5F01ABC")).toEqual(["admin", "customers", "cus_01ABC"]);
    expect(ev("GET", "/admin/customers/%zz")).toBeNull();
    expect(matchAuditRoute("GET", {})).toBeNull();
  });

  it("route PII native theo order.read được ghi data.accessed", () => {
    for (const p of [
      "customer-groups",
      "draft-orders",
      "returns",
      "claims",
      "exchanges",
      "order-changes",
      "order-edits",
      "fulfillments",
    ]) {
      expect({ p, ev: ev("GET", `/admin/${p}/x_1`) }).toEqual({ p, ev: SECURITY_EVENTS.DATA_ACCESSED });
    }
  });

  it("id trên đường dẫn giữ nguyên hoa/thường (khớp mẫu không phân biệt)", () => {
    const m = matchAuditRoute("DELETE", at("/AUTH/mfa/factors/authmfa_01ABCxyz/?a=1"));
    expect(m?.route.event).toBe(SECURITY_EVENTS.MFA_FACTOR_REMOVED);
    expect(m?.route.target?.(m.segments, {} as never)).toEqual({
      type: "mfa_factor",
      id: "authmfa_01ABCxyz",
    });
  });

  it("mọi sự kiện trong bảng route thuộc danh mục", () => {
    for (const r of AUDIT_ROUTES) expect(SECURITY_EVENT_NAMES).toContain(r.event);
  });
});

describe("outcomeOfStatus", () => {
  it.each([
    [200, "success"],
    [201, "success"],
    [302, "success"],
    [401, "failure"],
    [403, "denied"],
    [429, "denied"],
    [404, "failure"],
    [422, "failure"],
    [500, "failure"],
  ])("%i → %s", (status, outcome) => expect(outcomeOfStatus(status)).toBe(outcome));

  it("defaultOutcomeOf: người gọi cũ có tên hành động nói lên kết quả; còn lại success", () => {
    expect(defaultOutcomeOf("rbac.denied")).toBe("denied");
    expect(defaultOutcomeOf("refund.failed")).toBe("failure");
    expect(defaultOutcomeOf("catalog.import.commit_failed")).toBe("failure");
    expect(defaultOutcomeOf("return.rejected")).toBe("success");
    expect(defaultOutcomeOf("refund.approved")).toBe("success");
    expect(defaultOutcomeOf("toString")).toBe("success");
    expect(defaultOutcomeOf("")).toBe("success");
  });
});

describe("tokenClaims / resolveActor", () => {
  const pseudo = (v: string) => `idh_${v.length}`;

  it("đọc payload token trong phản hồi; thân lạ/không phải JWT → null", () => {
    expect(
      tokenClaims({ token: jwt({ actor_id: "user_1", actor_type: "user", auth_identity_id: "authid_1" }) }),
    ).toEqual({
      actor_id: "user_1",
      actor_type: "user",
      auth_identity_id: "authid_1",
    });
    expect(tokenClaims({ token: "khong-phai-jwt" })).toBeNull();
    expect(tokenClaims({ token: 42 })).toBeNull();
    expect(tokenClaims(null)).toBeNull();
    expect(tokenClaims("chuoi")).toBeNull();
  });

  it("thứ tự: actor trong token → auth_context → auth identity → vô danh", () => {
    expect(
      resolveActor({ actor_id: "user_1", actor_type: "user" }, { actor_id: "user_2" }, pseudo),
    ).toMatchObject({
      actor_type: "user",
      actor_id: "user_1",
    });
    expect(resolveActor({ actor_id: "", auth_identity_id: "authid_9" }, undefined, pseudo)).toEqual({
      actor_type: "auth_identity",
      actor_id: "authid_9",
      pseudonymized: false,
    });
    expect(resolveActor(null, { actor_id: "user_2", actor_type: "user" }, pseudo).actor_id).toBe("user_2");
    expect(resolveActor(null, undefined, pseudo)).toEqual({
      actor_type: "anonymous",
      actor_id: null,
      pseudonymized: false,
    });
  });

  it("actor_id dạng email (token đặt lại mật khẩu) → bí danh, không giữ email; id có ký tự lạ → null", () => {
    const r = resolveActor(null, { actor_id: "a@example.test", actor_type: "user" }, pseudo);
    expect(r).toEqual({ actor_type: "user", actor_id: "idh_14", pseudonymized: true });
    expect(resolveActor(null, { actor_id: "x\ny", actor_type: "user" }, pseudo).actor_id).toBeNull();
  });
});

describe("sanitizeUserAgent", () => {
  it("rỗng / không phải chuỗi → null; mảng → phần tử đầu", () => {
    for (const v of [undefined, null, "", "   ", 5, {}]) expect(sanitizeUserAgent(v)).toBeNull();
    expect(sanitizeUserAgent(["curl/8.0", "khac"])).toBe("curl/8.0");
  });

  it("bỏ ký tự điều khiển/bidi/xuống dòng (chống log injection), gộp khoảng trắng", () => {
    const ua = sanitizeUserAgent("Mozilla/5.0\r\nX-Fake: 1\u0000\u202e\u2028  (iPhone)");
    expect(ua).toBe("Mozilla/5.0X-Fake: 1 (iPhone)");
  });

  it("che email/SĐT lẫn trong UA; giữ phần còn lại", () => {
    const ua = sanitizeUserAgent("ShopApp/2.1 (user=nguyen.van.a@example.test; tel=0912345678)");
    expect(ua).not.toContain("nguyen.van.a@");
    expect(ua).not.toContain("0912345678");
    expect(ua).toContain("ShopApp/2.1");
  });

  it("cắt ≤ 256 code point, không cắt đôi emoji", () => {
    const long = `A${"😀".repeat(400)}`;
    const ua = sanitizeUserAgent(long) as string;
    expect([...ua]).toHaveLength(USER_AGENT_MAX);
    expect(ua.endsWith("😀")).toBe(true);
    expect(sanitizeUserAgent("x".repeat(10_000))).toHaveLength(USER_AGENT_MAX);
  });
});

describe("schema sự kiện bảo mật (SEC-LOG-002)", () => {
  const sample = {
    id: "audit_01JABCDEF",
    created_at: "2026-10-26T10:00:00.000Z",
    action: "auth.login",
    actor_type: "anonymous",
    actor_id: null,
    resource_type: "login_identifier",
    resource_id: "idh_0123456789abcdef0123456789abcdef",
    outcome: "failure",
    ip_hash: "0123456789abcdef0123456789abcdef",
    user_agent: "curl/8.0",
    request_id: "req-1",
    reason: null,
    changes: { status: 401 },
  };

  it("mẫu hợp lệ qua; thiếu trường / outcome lạ / giờ không UTC / IP thô → bị từ chối", () => {
    expect(SecurityAuditRecord.safeParse(sample).success).toBe(true);
    const { outcome: _o, ...noOutcome } = sample;
    expect(SecurityAuditRecord.safeParse(noOutcome).success).toBe(false);
    expect(SecurityAuditRecord.safeParse({ ...sample, outcome: "error" }).success).toBe(false);
    expect(
      SecurityAuditRecord.safeParse({ ...sample, created_at: "2026-10-26T17:00:00+07:00" }).success,
    ).toBe(false);
    expect(SecurityAuditRecord.safeParse({ ...sample, ip_hash: "203.0.113.5" }).success).toBe(false);
    expect(SecurityAuditRecord.safeParse({ ...sample, email: "a@example.test" }).success).toBe(false);
  });

  it("docs/security/security-event.schema.json khớp schema trong mã", () => {
    const file = join(DOCS, "security-event.schema.json");
    const generated = `${JSON.stringify(securityEventJsonSchema(), null, 2)}\n`;
    if (process.env.UPDATE_SECURITY_SCHEMA === "1") writeFileSync(file, generated);
    // So sánh theo nội dung (file được prettier định dạng lại).
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(JSON.parse(generated));
  });
});

describe("docs/security/security-events.md ↔ tên sự kiện trong mã (SEC-LOG-001)", () => {
  const doc = readFileSync(join(DOCS, "security-events.md"), "utf8");

  it("mọi sự kiện trong danh mục có dòng trong bảng tài liệu", () => {
    for (const name of SECURITY_EVENT_NAMES)
      expect({ name, documented: doc.includes(`\`${name}\``) }).toEqual({
        name,
        documented: true,
      });
  });

  it("tài liệu không nêu sự kiện auth./data./rbac. mà mã không có", () => {
    const mentioned = new Set([...doc.matchAll(/`((?:auth|data|rbac)\.[a-z0-9_.]+)`/g)].map((m) => m[1]));
    for (const name of mentioned)
      expect({ name, inCode: (SECURITY_EVENT_NAMES as readonly string[]).includes(name as string) }).toEqual({
        name,
        inCode: true,
      });
  });
});
