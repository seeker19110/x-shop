// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeVnPhone, validateAddress } from "@x-shop/domain";
import { runSubmit, type FlowDeps } from "./flow";
import { createKeyKeeper } from "./idempotency";
import { mapAttemptResponse, mapQuote, mapQuoteResponse, mapSubmitResponse } from "./map";
import type { PollResult, SubmitInput, SubmitResult } from "./types";
import { addressComplete, firstErrorField, normalizePhone, validateForm } from "./validate";

const fx = (n: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./__fixtures__/${n}.json`, import.meta.url)), "utf8"));

describe("map: phản hồi thật của backend", () => {
  it("quote: tiền nguyên, từng dòng, phí ship, tổng", () => {
    const r = mapQuoteResponse(200, fx("quote"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote).toMatchObject({
      subtotal: 1300000,
      discountTotal: 0,
      shippingFee: 30000,
      total: 1330000,
      cartVersion: 1,
    });
    expect(r.quote.lines).toHaveLength(2);
    expect(r.quote.id).toMatch(/^cqt_/);
  });

  it("quote hỏng (tiền âm/không nguyên) → không tin, UNAVAILABLE", () => {
    const q = (fx("quote") as { quote: Record<string, unknown> }).quote;
    expect(mapQuote({ ...q, total: -1 })).toBeNull();
    expect(mapQuote({ ...q, total: 1.5 })).toBeNull();
    expect(mapQuoteResponse(200, { quote: { ...q, total: "x" } })).toMatchObject({
      ok: false,
      code: "UNAVAILABLE",
    });
  });

  it("quote 422 gắn trường: address.ward_code → ward", () => {
    const r = mapQuoteResponse(422, {
      code: "VALIDATION",
      detail: "Vui lòng chọn phường/xã",
      field: "address.ward_code",
    });
    expect(r).toEqual({ ok: false, code: "VALIDATION", message: "Vui lòng chọn phường/xã", field: "ward" });
    expect(mapQuoteResponse(500, null)).toMatchObject({ code: "UNAVAILABLE" });
  });

  it("submit 200 COD → placed với mã đơn, không có payment_url", () => {
    expect(mapSubmitResponse(200, fx("submit-cod"))).toMatchObject({
      kind: "placed",
      ref: "XS-34JSE3",
      total: 1330000,
      state: "placed",
      paymentUrl: null,
    });
  });

  it("submit 200 VNPAY → placed kèm payment_url; 201 cũng được chấp nhận", () => {
    const r = mapSubmitResponse(201, fx("submit-vnpay"));
    expect(r).toMatchObject({ kind: "placed", state: "awaiting_payment" });
    expect(r.kind === "placed" && r.paymentUrl).toMatch(/^https:\/\/sandbox\.vnpayment\.vn\//);
  });

  it("submit 202 → pending (poll); 5xx/null → network", () => {
    expect(mapSubmitResponse(202, { checkout_attempt_id: "chk_1", state: "preparing" })).toEqual({
      kind: "pending",
      attemptId: "chk_1",
    });
    expect(mapSubmitResponse(503, null)).toEqual({ kind: "network" });
    expect(mapSubmitResponse(0, null)).toEqual({ kind: "network" });
  });

  it("AT03: 409 PRICE/SHIPPING/DISCOUNT_CHANGED kèm quote mới; CART_CHANGED không có quote", () => {
    const q = (fx("quote") as { quote: Record<string, unknown> }).quote;
    const r = mapSubmitResponse(409, {
      code: "PRICE_CHANGED",
      detail: "Giá đổi",
      quote: { ...q, total: 1380000 },
    });
    expect(r).toMatchObject({ kind: "changed", code: "PRICE_CHANGED" });
    expect(r.kind === "changed" && r.quote?.total).toBe(1380000);
    expect(mapSubmitResponse(409, { code: "CART_CHANGED", detail: "x" })).toMatchObject({
      kind: "changed",
      quote: null,
    });
  });

  it("503 LOCK_UNAVAILABLE → unavailable (Retry-After); 503 khác/không body vẫn là network", () => {
    const body = { code: "LOCK_UNAVAILABLE", detail: "x" };
    expect(mapSubmitResponse(503, body, "60")).toEqual({ kind: "unavailable", retryAfterSeconds: 60 });
    expect(mapSubmitResponse(503, body)).toEqual({ kind: "unavailable", retryAfterSeconds: null });
    expect(mapSubmitResponse(503, body, "0")).toEqual({ kind: "unavailable", retryAfterSeconds: null });
    expect(mapSubmitResponse(503, body, "abc")).toEqual({ kind: "unavailable", retryAfterSeconds: null });
    // BASE-DATA-003: header rỗng là "thiếu", không phải 0 giây (Number("") === 0).
    expect(mapSubmitResponse(503, body, "")).toEqual({ kind: "unavailable", retryAfterSeconds: null });
    expect(mapSubmitResponse(503, body, null)).toEqual({ kind: "unavailable", retryAfterSeconds: null });
    expect(mapSubmitResponse(503, { code: "SHIPPING_UNAVAILABLE" }, "60")).toEqual({ kind: "network" });
  });

  it("unavailable: runSubmit không tự gửi lại", async () => {
    const { d, keys, sleeps } = deps([{ kind: "unavailable", retryAfterSeconds: 60 }, placed]);
    expect(await runSubmit(d, input)).toEqual({ kind: "unavailable", retryAfterSeconds: 60 });
    expect(keys).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("poll: attempt failed LOCK_UNAVAILABLE → unavailable (giữ khóa, không báo lỗi cứng)", async () => {
    const { d } = deps(
      [{ kind: "pending", attemptId: "chk_1" }],
      [{ kind: "failed", code: "LOCK_UNAVAILABLE", message: "x" }],
    );
    expect(await runSubmit(d, input)).toEqual({ kind: "unavailable", retryAfterSeconds: null });
  });

  it("409 INSUFFICIENT_STOCK chỉ ra dòng; BUSY_RETRY có giới hạn thời gian; IDEMPOTENCY_CONFLICT cần khóa mới", () => {
    const s = mapSubmitResponse(409, {
      code: "INSUFFICIENT_STOCK",
      detail: "Hết",
      lines: [{ line_item_id: "li_1", variant_id: "v_1", requested: 3, available: 1 }],
    });
    expect(s).toMatchObject({ kind: "stock", lines: [{ lineItemId: "li_1", requested: 3, available: 1 }] });
    expect(mapSubmitResponse(409, { code: "BUSY_RETRY", retry_after_ms: 999999 })).toEqual({
      kind: "busy",
      retryAfterMs: 5000,
    });
    expect(mapSubmitResponse(409, { code: "BUSY_RETRY" })).toEqual({ kind: "busy", retryAfterMs: 1000 });
    // Retry-After rỗng → mặc định 1000 ms, KHÔNG phải 0 ms (vòng lặp gửi dồn); "0" là giá trị thật → 0.
    expect(mapSubmitResponse(409, { code: "BUSY_RETRY" }, "")).toEqual({ kind: "busy", retryAfterMs: 1000 });
    expect(mapSubmitResponse(409, { code: "BUSY_RETRY" }, "0")).toEqual({ kind: "busy", retryAfterMs: 0 });
    expect(mapSubmitResponse(409, { code: "IDEMPOTENCY_CONFLICT", detail: "x" })).toMatchObject({
      kind: "error",
      newKey: true,
    });
    expect(
      mapSubmitResponse(422, { code: "VALIDATION", detail: "SĐT", field: "contact.phone" }),
    ).toMatchObject({
      kind: "error",
      field: "phone",
      newKey: false,
    });
  });

  it("attempts: ready → placed; preparing → pending; failed/compensated → failed", () => {
    expect(mapAttemptResponse(200, fx("attempt-ready"))).toMatchObject({ kind: "placed", ref: "XS-34JSE3" });
    expect(mapAttemptResponse(200, { state: "preparing" })).toEqual({ kind: "pending" });
    expect(
      mapAttemptResponse(200, { state: "failed", error: { code: "INSUFFICIENT_STOCK", message: "Hết" } }),
    ).toMatchObject({
      kind: "failed",
      code: "INSUFFICIENT_STOCK",
    });
    expect(mapAttemptResponse(200, { state: "compensated" })).toMatchObject({
      kind: "failed",
      code: "ATTEMPT_ABORTED",
    });
    expect(mapAttemptResponse(404, { code: "NOT_FOUND" })).toMatchObject({ kind: "failed" });
    expect(mapAttemptResponse(502, null)).toEqual({ kind: "network" });
  });
});

const input: SubmitInput = {
  idempotencyKey: "k".repeat(20),
  quoteId: "cqt_1",
  cartVersion: 1,
  paymentMethod: "cod",
  contact: { name: "A", phone: "0912345678", email: "" },
  address: { provinceCode: "01", wardCode: "00004", line: "12 Phố" },
  discountCode: null,
};

function deps(submits: SubmitResult[], polls: PollResult[] = []) {
  const keys: string[] = [];
  const sleeps: number[] = [];
  const d: FlowDeps = {
    submit: async (i) => {
      keys.push(i.idempotencyKey);
      return submits.shift() ?? { kind: "network" };
    },
    poll: async () => polls.shift() ?? { kind: "pending" },
    sleep: async (ms) => void sleeps.push(ms),
  };
  return { d, keys, sleeps };
}
const placed: SubmitResult = {
  kind: "placed",
  attemptId: "chk_1",
  ref: "XS-AAAA11",
  state: "placed",
  total: 1,
  paymentUrl: null,
};

describe("flow: runSubmit", () => {
  it("BUSY_RETRY: thử lại CÙNG khóa, chờ theo retry_after, rồi thành công", async () => {
    const { d, keys, sleeps } = deps([
      { kind: "busy", retryAfterMs: 700 },
      { kind: "busy", retryAfterMs: 700 },
      placed,
    ]);
    expect((await runSubmit(d, input)).kind).toBe("placed");
    expect(new Set(keys).size).toBe(1);
    expect(keys).toHaveLength(3);
    expect(sleeps).toEqual([700, 700]);
  });

  it("BUSY_RETRY liên tục: dừng sau giới hạn (3 lần thử lại) → busy", async () => {
    const busy: SubmitResult = { kind: "busy", retryAfterMs: 1 };
    const { d, keys } = deps([busy, busy, busy, busy, busy]);
    expect(await runSubmit(d, input)).toEqual({ kind: "busy" });
    expect(keys).toHaveLength(4);
  });

  it("202 → poll tới khi đặt xong", async () => {
    const { d } = deps(
      [{ kind: "pending", attemptId: "chk_9" }],
      [
        { kind: "pending" },
        { kind: "placed", attemptId: "chk_9", ref: "XS-BBBB22", state: "placed", total: 5, paymentUrl: null },
      ],
    );
    expect(await runSubmit(d, input)).toMatchObject({ kind: "placed", ref: "XS-BBBB22" });
  });

  it("poll hết lượt → processing (kèm mã tham chiếu, không đặt lại); poll lỗi mạng liên tiếp cũng vậy", async () => {
    const a = deps([{ kind: "pending", attemptId: "chk_9" }]);
    expect(await runSubmit(a.d, input, { maxPolls: 3 })).toEqual({ kind: "processing", attemptId: "chk_9" });
    const b = deps(
      [{ kind: "pending", attemptId: "chk_9" }],
      [{ kind: "network" }, { kind: "network" }, { kind: "network" }],
    );
    expect(await runSubmit(b.d, input)).toEqual({ kind: "processing", attemptId: "chk_9" });
  });

  it("poll thất bại → error cần khóa mới; mạng lỗi/409 trả nguyên", async () => {
    const a = deps([{ kind: "pending", attemptId: "c" }], [{ kind: "failed", code: "X", message: "m" }]);
    expect(await runSubmit(a.d, input)).toMatchObject({ kind: "error", newKey: true });
    expect((await runSubmit(deps([{ kind: "network" }]).d, input)).kind).toBe("network");
  });
});

describe("idempotency keeper", () => {
  it("cùng nội dung → cùng khóa (retry); đổi nội dung hoặc reset → khóa mới; khóa hợp lệ 16–128 [A-Za-z0-9_-]", () => {
    let n = 0;
    const k = createKeyKeeper(() => `key-${String(++n).padStart(16, "0")}`);
    const a = k.keyFor("x");
    expect(k.keyFor("x")).toBe(a);
    expect(k.keyFor("y")).not.toBe(a);
    const b = k.keyFor("y");
    k.reset();
    expect(k.keyFor("y")).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(createKeyKeeper().keyFor("z")).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });
});

describe("validate: đối chiếu với domain", () => {
  it.each([
    "0912345678",
    "+84912345678",
    "0912 345 678",
    "091.234.5678",
    "(0912)345-678",
    "0212345678",
    "123",
    "",
    "09123456789",
    "+8412345",
    "０９１２３４５６７８",
  ])("SĐT %p cho kết quả như normalizeVnPhone", (raw) => {
    const d = normalizeVnPhone(raw);
    expect(normalizePhone(raw)).toBe(d.ok ? d.value : null);
  });

  it.each([
    ["01", "00004", "12 Phố Điện Biên Phủ"],
    ["01", "00004", "ab"],
    ["01", "00004", "  x  y  "],
    ["", "00004", "12 Phố"],
    ["01", "", "12 Phố"],
    ["01", "00004", "a".repeat(201)],
  ])("địa chỉ %p/%p/%p: addressComplete khớp validateAddress ở các ca cấu trúc", (p, w, l) => {
    const d = validateAddress({ provinceCode: p, wardCode: w, line: l });
    // client chỉ kiểm cấu trúc (mã tồn tại do server/danh mục kiểm): đồng ý với domain khi mã hợp lệ
    if (p === "01" && w === "00004")
      expect(addressComplete({ provinceCode: p, wardCode: w, line: l })).toBe(d.ok);
    else expect(addressComplete({ provinceCode: p, wardCode: w, line: l })).toBe(false);
  });

  it("validateForm: tên rỗng/trắng, email sai, thiếu tỉnh/xã; lỗi đầu tiên theo thứ tự DOM; email rỗng hợp lệ", () => {
    const e = validateForm({
      name: "  ",
      phone: "12",
      email: "a@b",
      provinceCode: "",
      wardCode: "",
      line: "x",
    });
    expect(Object.keys(e).sort()).toEqual(["email", "line", "name", "phone", "province", "ward"]);
    expect(firstErrorField(e)).toBe("name");
    expect(
      validateForm({
        name: "An",
        phone: "0912345678",
        email: "",
        provinceCode: "01",
        wardCode: "00004",
        line: "12 Phố",
      }),
    ).toEqual({});
    expect(firstErrorField({})).toBeNull();
  });
});
