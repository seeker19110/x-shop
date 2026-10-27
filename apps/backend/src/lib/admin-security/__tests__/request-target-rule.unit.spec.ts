import { adminRuleOf } from "../guard";
import { isAdminPath, resolveAdminRule, strictestRule, type AdminRule } from "../policy";

/** T-145 — cổng RBAC tra quyền theo pathname router thấy; giải mã `%xx` không đưa về quy tắc lỏng hơn. */

const rule = (method: string, originalUrl: string) => adminRuleOf({ originalUrl }, method);
const perm = (permission: string, also: string[] = [], reauth = false) => ({
  kind: "permission",
  permission,
  also,
  reauth,
});

describe("adminRuleOf (guard RBAC, T-145)", () => {
  it("URL tuyệt đối → cùng quy tắc như origin-form (không rơi xuống any_role)", () => {
    expect(rule("GET", "http://localhost:9000/admin/customers/cus_1")).toEqual({
      path: "/admin/customers/cus_1",
      rule: perm("order.read"),
    });
    expect(rule("GET", "HTTP://X/ADMIN/X/AUDIT?limit=1")?.rule).toEqual(
      resolveAdminRule("GET", "/admin/x/audit"),
    );
    expect(rule("GET", "http://h/admin/x/audit")?.rule.kind).toBe("permission");
  });

  it("`\\` + `#` (Express đi url.parse, tới /admin/customers/:id) → order.read", () => {
    expect(rule("GET", "/admin\\customers/cus_1#x")).toEqual({
      path: "/admin/customers/cus_1",
      rule: perm("order.read"),
    });
  });

  it("%61dmin/%63ustomers: quy tắc chặt hơn của (đã giải mã, chuỗi router khớp)", () => {
    expect(rule("GET", "/admin/%63ustomers/cus_1")).toEqual({
      path: "/admin/customers/cus_1",
      rule: perm("order.read"),
    });
    // Giải mã ra `self` (/admin/users/me) nhưng router khớp /admin/users/:id → vẫn cần user.manage.
    expect(rule("GET", "/admin/users/%6De")?.rule).toEqual(perm("user.manage"));
    // Giải mã ra route công khai nhưng chuỗi router khớp là route khác → không thành public.
    expect(rule("POST", "/admin/invites/%61ccept")?.rule).toEqual(perm("user.manage"));
    expect(rule("GET", "/admin/users/me")?.rule).toEqual({ kind: "self" });
  });

  it("%2F trong đoạn giữ cấu trúc: POST /admin/orders/x%2Fy/cancel vẫn bị đóng như route hủy native", () => {
    expect(rule("POST", "/admin/orders/x%2Fy/cancel")?.rule).toEqual({
      kind: "deny",
      reason: "NATIVE_ORDER_CANCEL",
    });
    expect(rule("POST", "/admin/orders/x%3Fy/cancel")?.rule).toEqual({
      kind: "deny",
      reason: "NATIVE_ORDER_CANCEL",
    });
  });

  it("không hợp lệ → null (400): mã hoá hỏng, không dưới /admin, không parse được", () => {
    for (const bad of [
      "/admin/%zz",
      "/admin/customers/%C3",
      "//evil.example/admin/customers",
      "*",
      "admin/x",
      "http://h/x/admin",
    ]) {
      expect({ bad, r: rule("GET", bad) }).toEqual({ bad, r: null });
    }
  });

  it("luồng thường không đổi: hoa/thường, `/` cuối, `//`, query", () => {
    expect(rule("POST", "/ADMIN/X/Refunds/?a=1")?.rule).toEqual(resolveAdminRule("POST", "/admin/x/refunds"));
    expect(rule("POST", "/admin//x/refunds")?.path).toBe("/admin/x/refunds");
    expect(rule("GET", "/admin/products?limit=1")?.rule).toEqual({ kind: "any_role" });
    expect(rule("POST", "/admin/invites/accept")?.rule).toEqual({ kind: "public" });
    // Request đi qua middleware mount (req.url bị cắt tiền tố) — dùng originalUrl.
    expect(adminRuleOf({ originalUrl: "/admin/customers/a", url: "/customers/a" }, "GET")?.rule).toEqual(
      perm("order.read"),
    );
  });
});

describe("strictestRule / isAdminPath", () => {
  const pub: AdminRule = { kind: "public" };
  const self: AdminRule = { kind: "self" };
  const any: AdminRule = { kind: "any_role" };
  const deny: AdminRule = { kind: "deny", reason: "UNDECLARED_ROUTE" };
  const a = perm("order.read") as AdminRule;
  const b = perm("refund.approve", ["payment.read"], true) as AdminRule;

  it("thứ tự chặt: public < self < any_role < permission < deny (đối xứng)", () => {
    const order = [pub, self, any, a, deny];
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        const expected = order[Math.max(i, j)];
        expect(strictestRule(order[i] as AdminRule, order[j] as AdminRule)).toEqual(expected);
      }
    }
  });

  it("hai quyền → cần mọi quyền của cả hai, reauth nếu một bên đòi; trùng không lặp", () => {
    expect(strictestRule(a, b)).toEqual(perm("order.read", ["refund.approve", "payment.read"], true));
    expect(strictestRule(a, a)).toEqual(a);
  });

  it("isAdminPath", () => {
    expect(isAdminPath("/admin")).toBe(true);
    expect(isAdminPath("/admin/x")).toBe(true);
    expect(isAdminPath("/administrator")).toBe(false);
    expect(isAdminPath("//admin")).toBe(false);
  });
});
