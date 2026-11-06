import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { containsNul, MAX_SCAN_DEPTH, rejectNulBytes } from "../nul-bytes";

function run(req: { originalUrl?: string; url?: string; body?: unknown }) {
  const out: { status?: number; body?: Record<string, unknown> } = {};
  const res = {
    req: { requestId: "r-1" },
    status(c: number) {
      out.status = c;
      return res;
    },
    setHeader() {
      return res;
    },
    send(b: string) {
      out.body = JSON.parse(b) as Record<string, unknown>;
      return res;
    },
  };
  const next = jest.fn();
  rejectNulBytes(
    req as unknown as MedusaRequest,
    res as unknown as MedusaResponse,
    next as unknown as MedusaNextFunction,
  );
  return { out, next };
}

describe("containsNul", () => {
  it.each([
    ["chuỗi có NUL", "a\u0000b", true],
    ["chuỗi sạch (Unicode, RTL, emoji)", "Áo đen ‮😀", false],
    ["rỗng", "", false],
    ["null", null, false],
    ["undefined", undefined, false],
    ["số 0", 0, false],
    ["khoá có NUL", { "a\u0000": 1 }, true],
    ["lồng trong mảng/object", { a: [{ b: ["x", "y\u0000"] }] }, true],
    ["object sạch", { a: [1, true, null, { b: "c" }] }, false],
    ["Buffer (thân thô, không phải chuỗi đã parse)", Buffer.from([0, 1, 2]), false],
  ])("%s → %s", (_n, v, expected) => {
    expect(containsNul(v)).toBe(expected);
  });

  it(`lồng sâu quá ${MAX_SCAN_DEPTH} cấp → coi là không hợp lệ (không duyệt vô hạn)`, () => {
    let deep: unknown = "x";
    for (let i = 0; i < MAX_SCAN_DEPTH + 5; i++) deep = [deep];
    expect(containsNul(deep)).toBe(true);
    let ok: unknown = "x";
    for (let i = 0; i < 10; i++) ok = { a: ok };
    expect(containsNul(ok)).toBe(false);
  });
});

describe("rejectNulBytes", () => {
  it.each([
    ["đường dẫn %00", { originalUrl: "/admin/x/imports/%00" }],
    ["query %00 (chữ thường/hoa)", { originalUrl: "/store/x/search?q=a%00" }],
    ["thân JSON có NUL", { originalUrl: "/store/x/checkout/quote", body: { cart_id: "\u0000" } }],
    ["thân text có NUL", { originalUrl: "/admin/x/imports/preview", body: "a,b\n\u0000,1" }],
  ])("%s → 400 INVALID_CHARACTERS problem có trace_id, không gọi next", (_n, req) => {
    const { out, next } = run(req);
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ code: "INVALID_CHARACTERS", status: 400, trace_id: "r-1" });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ["URL sạch", { originalUrl: "/store/x/products?q=%C3%A1o" }],
    ['"%2500" là chữ "%00" đã mã hoá — không phải NUL', { originalUrl: "/store/x/search?q=%2500" }],
    ["thân sạch", { originalUrl: "/store/x/checkout/quote", body: { cart_id: "cart_01" } }],
    ["không originalUrl → dùng url", { url: "/x/health" }],
  ])("%s → next()", (_n, req) => {
    const { out, next } = run(req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(out.status).toBeUndefined();
  });
});
