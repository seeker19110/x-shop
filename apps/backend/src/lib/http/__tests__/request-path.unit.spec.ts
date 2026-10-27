import { createRequire } from "node:module";
import { normalizeAdminPath } from "../../admin-security/route-match";
import { decodePathSegments, rawRequestPath, requestPath, routerPathname } from "../request-path";

/** T-145 — đường dẫn request theo đúng cách router Express thấy (URL tuyệt đối, `%xx`, `\`+`#`). */

const path = (target: string) => requestPath({ originalUrl: target });

describe("requestPath", () => {
  it("URL tuyệt đối → pathname đã parse (bỏ scheme/host/query), không phân biệt hoa thường của scheme", () => {
    expect(path("http://localhost:9000/admin/customers/cus_1")).toBe("/admin/customers/cus_1");
    expect(path("http://localhost:9000/admin/x/audit?limit=1")).toBe("/admin/x/audit");
    expect(path("HTTP://X/ADMIN/CUSTOMERS/a")).toBe("/ADMIN/CUSTOMERS/a");
    expect(path("https://user:pw@shop.example:8443/admin")).toBe("/admin");
    expect(path("http://localhost:9000")).toBe("/");
  });

  it("%xx ký tự unreserved được giải mã từng đoạn: %61dmin, %63ustomers không lách", () => {
    expect(path("/%61dmin/%63ustomers/cus_1")).toBe("/admin/customers/cus_1");
    expect(path("/admin/%7Euser/%2D%2E%5F")).toBe("/admin/~user/-._");
    expect(path("/admin/products/%C3%A1o-thun")).toBe("/admin/products/áo-thun");
    expect(normalizeAdminPath(path("/%41DMIN/X/%41udit/") ?? "")).toBe("/admin/x/audit");
  });

  it("%xx ký tự reserved: %2F, %3F, %23, %25 giữ dạng mã hoá — giải mã không đổi số đoạn hay cắt query", () => {
    expect(path("/admin/orders/x%2Fy/cancel")).toBe("/admin/orders/x%2Fy/cancel");
    expect(path("/admin/orders/x%2fy/cancel")).toBe("/admin/orders/x%2Fy/cancel");
    expect(path("/admin/orders/x%3F/cancel")).toBe("/admin/orders/x%3F/cancel");
    expect(path("/admin/orders/x%23/cancel")).toBe("/admin/orders/x%23/cancel");
    expect(path("/admin/a%2541")).toBe("/admin/a%2541");
    expect(path("/admin/a%20b")).toBe("/admin/a b");
    // normalizeAdminPath (cắt ở `?`) không cắt nhầm đoạn đã giải mã.
    expect(normalizeAdminPath(path("/admin/orders/x%3F/cancel") ?? "")).toBe("/admin/orders/x%3f/cancel");
  });

  it("mã hoá hỏng → null (nơi gọi trả 400)", () => {
    for (const bad of [
      "/admin/%zz",
      "/admin/%C3",
      "/admin/%E0%A4%A",
      "/admin/%ED%A0%80",
      "/admin/%",
      "/%G1",
    ]) {
      expect({ bad, path: path(bad) }).toEqual({ bad, path: null });
    }
  });

  it("`//` và `/` cuối giữ nguyên (chuẩn hoá ở normalizeAdminPath); `//host` không bị hiểu là host", () => {
    expect(path("/admin//x/refunds/")).toBe("/admin//x/refunds/");
    expect(normalizeAdminPath(path("/admin//x/refunds/") ?? "")).toBe("/admin/x/refunds");
    expect(path("//evil.example/admin/customers")).toBe("//evil.example/admin/customers");
  });

  it("query và fragment bị bỏ; `\\` + `#` đi đường url.parse như Express (đổi `\\` → `/`)", () => {
    expect(path("/admin/x/audit?q=a/b&r=%zz")).toBe("/admin/x/audit");
    expect(path("/admin/customers/a?x#y")).toBe("/admin/customers/a");
    expect(path("/admin/customers/a#?x")).toBe("/admin/customers/a");
    expect(path("/admin\\customers/a#f")).toBe("/admin/customers/a");
    // Không có ký tự chuyển đường chậm → Express khớp chuỗi có `\` (không tới route /admin/customers/:id).
    expect(path("/admin\\customers/a")).toBe("/admin\\customers/a");
  });

  it("không hợp lệ: rỗng, `*`, không bắt đầu bằng `/`, thiếu url", () => {
    expect(path("")).toBeNull();
    expect(path("*")).toBeNull();
    expect(path("x/admin/customers")).toBeNull();
    expect(path("localhost:9000")).toBeNull();
    expect(requestPath({})).toBeNull();
    expect(requestPath({ originalUrl: 42 })).toBeNull();
  });

  it("ưu tiên originalUrl (req.url của middleware đã mount bị cắt tiền tố); không có thì dùng url", () => {
    expect(requestPath({ originalUrl: "/admin/customers/a", url: "/customers/a" })).toBe(
      "/admin/customers/a",
    );
    expect(requestPath({ url: "/store/x/products?q=1" })).toBe("/store/x/products");
    expect(rawRequestPath({ originalUrl: "/%61dmin/x" })).toBe("/%61dmin/x");
  });

  it("decodePathSegments: đoạn rỗng giữ nguyên", () => {
    expect(decodePathSegments("/")).toBe("/");
    expect(decodePathSegments("/a//b/")).toBe("/a//b/");
  });

  it("routerPathname khớp đúng `parseurl` của Express đang cài (đối chiếu trên các request-target đối nghịch)", () => {
    const fwRequire = createRequire(require.resolve("@medusajs/framework/http"));
    const expressRequire = createRequire(fwRequire.resolve("express"));
    const parseurl = expressRequire("parseurl") as (req: {
      url: string;
    }) => { pathname: string | null } | undefined;
    const targets = [
      "/admin/customers/a",
      "/admin/customers/a?b=1",
      "/admin/customers/a?b=1#c",
      "/admin\\customers/a#f",
      "/admin\\customers/a",
      "/admin/cus tomers",
      "/admin/ x",
      "/admin/﻿x",
      "/admin/\tx",
      "http://localhost:9000/admin/customers/a",
      "http://localhost:9000\\admin/customers/a",
      "HTTPS://H/ADMIN?x",
      "//evil.example/admin",
      "/%61dmin/%2F",
      "*",
      "x/admin",
      "mailto:a@example.test",
    ];
    for (const t of targets) {
      expect({ t, p: routerPathname(t) }).toEqual({ t, p: parseurl({ url: t })?.pathname ?? null });
    }
  });
});
