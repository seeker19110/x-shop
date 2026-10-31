// @vitest-environment node
import { CHECKOUT_MESSAGES as M } from "@x-shop/domain/validation";
import type { SubmitInput } from "./types";

/**
 * T-188 (FE-FORM-001): Server Action `quoteCheckout`/`submitCheckout` nhận đối số từ client → kiểu TS không bảo vệ gì.
 * Input sai hình dạng (thiếu address/contact, discountCode không phải chuỗi, null, mảng…) phải trả VALIDATION có `field`
 * (ô form) — không ném TypeError (→ 500) và không gọi backend. Input đúng đi qua schema chung rồi tới backend đã chuẩn hoá.
 */
const h = vi.hoisted(() => ({
  cartId: "cart_01JABCDEFGHJKMNPQRS" as string | null,
  calls: [] as Array<{ path: string; body: Record<string, unknown> | undefined; headers: unknown }>,
}));

vi.mock("../cart/cookie", () => ({ readCartId: async () => h.cartId }));
vi.mock("../cart/service", () => ({ cartEnabled: () => true, forgetCart: vi.fn() }));
vi.mock("../orders/cookie", () => ({ writeOrderAccess: vi.fn() }));
vi.mock("../cart/medusa", () => {
  class StoreApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly code: string,
      readonly body: Record<string, unknown> = {},
    ) {
      super(message);
    }
  }
  return {
    StoreApiError,
    storeApi: async (path: string, req: { body?: Record<string, unknown>; headers?: unknown }) => {
      h.calls.push({ path, body: req.body, headers: req.headers });
      // Backend giả: luôn 202 cho submit, quote hỏng hình dạng → UNAVAILABLE (chỉ cần biết đã được gọi).
      return path.endsWith("/submit")
        ? { status: 202, data: { checkout_attempt_id: "chk_01", state: "preparing" } }
        : { status: 503, data: null };
    },
  };
});

import { quoteCheckout, submitCheckout } from "./actions";

const ADDRESS = { provinceCode: "01", wardCode: "00004", line: "  12   Điện Biên Phủ " };
const SUBMIT: SubmitInput = {
  idempotencyKey: "idem_0123456789abcdef",
  quoteId: "cqt_01M5QKNFYMJ615YBYS4TWEGSS0",
  cartVersion: 1,
  paymentMethod: "cod",
  contact: { name: " An ", phone: "+84 912 345 678", email: " An@Example.Test " },
  address: ADDRESS,
  discountCode: null,
};
type AnyAction = (input: unknown) => Promise<unknown>;
const quote = quoteCheckout as AnyAction;
const submit = submitCheckout as AnyAction;

beforeEach(() => {
  h.calls = [];
  h.cartId = "cart_01JABCDEFGHJKMNPQRS";
});

describe("quoteCheckout: input sai hình dạng → VALIDATION có field, không ném, không gọi backend", () => {
  it.each<[string, unknown, string, string]>([
    ["null", null, "province", M.address],
    ["undefined", undefined, "province", M.address],
    ["mảng", [ADDRESS], "province", M.address],
    ["chuỗi", "cod", "province", M.address],
    ["thiếu address", { paymentMethod: "cod", discountCode: null }, "province", M.address],
    ["address null", { paymentMethod: "cod", address: null, discountCode: null }, "province", M.address],
    ["address là mảng", { paymentMethod: "cod", address: [], discountCode: null }, "province", M.address],
    ["line là số", { paymentMethod: "cod", address: { ...ADDRESS, line: 12 } }, "line", M.line],
    [
      "discountCode là số",
      { paymentMethod: "cod", address: ADDRESS, discountCode: 5 },
      "discount",
      M.discount,
    ],
    [
      "discountCode là mảng",
      { paymentMethod: "cod", address: ADDRESS, discountCode: ["A"] },
      "discount",
      M.discount,
    ],
    [
      "discountCode là object",
      { paymentMethod: "cod", address: ADDRESS, discountCode: {} },
      "discount",
      M.discount,
    ],
    ["phương thức lạ", { paymentMethod: "momo", address: ADDRESS, discountCode: null }, "payment", M.payment],
  ])("%s", async (_name, input, field, message) => {
    await expect(quote(input)).resolves.toEqual({ ok: false, code: "VALIDATION", message, field });
    expect(h.calls).toEqual([]);
  });

  it("được phép (đối chứng): input đúng → gửi backend dữ liệu đã chuẩn hoá; mã rỗng không gửi", async () => {
    await quote({ paymentMethod: "vnpay", address: ADDRESS, discountCode: "  " });
    await quote({ paymentMethod: "cod", address: ADDRESS, discountCode: " SALE10 " });
    expect(h.calls.map((c) => c.body)).toEqual([
      {
        cart_id: "cart_01JABCDEFGHJKMNPQRS",
        payment_method: "vnpay",
        address: { province_code: "01", ward_code: "00004", line: "12 Điện Biên Phủ" },
      },
      {
        cart_id: "cart_01JABCDEFGHJKMNPQRS",
        payment_method: "cod",
        address: { province_code: "01", ward_code: "00004", line: "12 Điện Biên Phủ" },
        discount_code: "SALE10",
      },
    ]);
  });

  it("input đúng nhưng không có giỏ → CART_EMPTY (kiểm hình dạng không đổi hợp đồng cũ)", async () => {
    h.cartId = null;
    await expect(
      quote({ paymentMethod: "cod", address: ADDRESS, discountCode: null }),
    ).resolves.toMatchObject({
      ok: false,
      code: "CART_EMPTY",
    });
    expect(h.calls).toEqual([]);
  });
});

describe("submitCheckout: input sai hình dạng → VALIDATION có field, không ném, không gọi backend", () => {
  const { contact: _c, ...noContact } = SUBMIT;
  const { address: _a, ...noAddress } = SUBMIT;
  it.each<[string, unknown, string, string]>([
    ["thiếu contact", noContact, "name", M.contact],
    ["contact null", { ...SUBMIT, contact: null }, "name", M.contact],
    ["contact là mảng", { ...SUBMIT, contact: [] }, "name", M.contact],
    ["thiếu address", noAddress, "province", M.address],
    ["email là số", { ...SUBMIT, contact: { ...SUBMIT.contact, email: 1 } }, "email", M.email],
    ["SĐT sai", { ...SUBMIT, contact: { ...SUBMIT.contact, phone: "0212345678" } }, "phone", M.phone],
    ["tên trắng", { ...SUBMIT, contact: { ...SUBMIT.contact, name: "   " } }, "name", M.name],
    ["discountCode là số", { ...SUBMIT, discountCode: 5 }, "discount", M.discount],
  ])("%s", async (_name, input, field, message) => {
    await expect(submit(input)).resolves.toEqual({
      kind: "error",
      code: "VALIDATION",
      message,
      field,
      newKey: false,
    });
    expect(h.calls).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["mảng", [SUBMIT]],
    ["chuỗi", "x"],
    ["khoá idempotency là số", { ...SUBMIT, idempotencyKey: 123 }],
    ["quoteId là object", { ...SUBMIT, quoteId: { id: "cqt_1" } }],
  ])(
    "gốc/khoá/mã báo giá sai hình dạng (%s) → VALIDATION không field (tải lại trang)",
    async (_name, input) => {
      await expect(submit(input)).resolves.toMatchObject({
        kind: "error",
        code: "VALIDATION",
        newKey: false,
      });
      expect(h.calls).toEqual([]);
    },
  );

  it("cartVersion sai (không thuộc ô nào) → VALIDATION không field", async () => {
    const r = await submit({ ...SUBMIT, cartVersion: "1" });
    expect(r).toEqual({ kind: "error", code: "VALIDATION", message: M.cartVersion, newKey: false });
    expect(h.calls).toEqual([]);
  });

  it("được phép (đối chứng): input đúng → backend nhận liên hệ/địa chỉ đã chuẩn hoá, đúng khoá idempotency", async () => {
    await expect(submit(SUBMIT)).resolves.toEqual({ kind: "pending", attemptId: "chk_01" });
    expect(h.calls).toEqual([
      {
        path: "/store/x/checkout/submit",
        headers: { "Idempotency-Key": SUBMIT.idempotencyKey },
        body: {
          cart_id: "cart_01JABCDEFGHJKMNPQRS",
          cart_version: 1,
          quote_id: SUBMIT.quoteId,
          payment_method: "cod",
          contact: { name: "An", phone: "0912345678", email: "an@example.test" },
          address: { province_code: "01", ward_code: "00004", line: "12 Điện Biên Phủ" },
        },
      },
    ]);
  });

  it("đồng thời: lời gọi đúng và sai xen kẽ → mỗi lời gọi nhận kết quả của chính nó, chỉ lời gọi đúng tới backend", async () => {
    const inputs: unknown[] = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0
        ? { ...SUBMIT, idempotencyKey: `idem_${String(i).padStart(16, "0")}` }
        : { ...SUBMIT, contact: null },
    );
    const results = await Promise.all(inputs.map((x) => submit(x)));
    expect(results.map((r) => (r as { kind: string }).kind)).toEqual(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? "pending" : "error")),
    );
    expect(h.calls.map((c) => (c.headers as Record<string, string>)["Idempotency-Key"]).sort()).toEqual(
      [0, 2, 4, 6, 8].map((i) => `idem_${String(i).padStart(16, "0")}`),
    );
  });
});
