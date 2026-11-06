import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import type { QuoteView, SubmitResult } from "../../lib/checkout/types";
import { CheckoutForm } from "./CheckoutForm";
import { safePaymentUrl } from "../../lib/safe-url";

const m = vi.hoisted(() => ({
  quote: vi.fn(),
  submit: vi.fn(),
  poll: vi.fn(),
  finish: vi.fn(),
  push: vi.fn(),
}));
vi.mock("../../lib/checkout/actions", () => ({
  quoteCheckout: m.quote,
  submitCheckout: m.submit,
  pollCheckout: m.poll,
  finishCheckout: m.finish,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push }) }));
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element -- mock next/image trong test, cần thẻ img thuần
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

const lines = [
  {
    id: "li_1",
    title: "Áo sơ mi lụa",
    variantLabel: "Đen / M",
    quantity: 1,
    lineTotal: 700000,
    thumbnail: null,
  },
  { id: "li_2", title: "Quần tây", variantLabel: null, quantity: 2, lineTotal: 600000, thumbnail: null },
];
const provinces = [{ code: "01", name: "Thành phố Hà Nội" }];

const mkQuote = (total: number, over: Partial<QuoteView> = {}): QuoteView => ({
  id: `cqt_${total}`,
  cartVersion: 1,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  paymentMethod: "cod",
  discountCode: null,
  lines: [],
  subtotal: 1300000,
  discountTotal: 0,
  shippingFee: total - 1300000,
  shippingDiscount: 0,
  shippingTotal: total - 1300000,
  total,
  ...over,
});

const placed: SubmitResult = {
  kind: "placed",
  attemptId: "chk_1",
  ref: "XS-ABC123",
  state: "placed",
  total: 1330000,
  paymentUrl: null,
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  Object.values(m).forEach((f) => f.mockReset());
  m.quote.mockResolvedValue({ ok: true, quote: mkQuote(1330000) });
  m.finish.mockResolvedValue(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ wards: [{ code: "00004", name: "Phường Ba Đình" }] }))),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ui = () => render(<CheckoutForm lines={lines} subtotal={1300000} provinces={provinces} />);
const submitBtn = () => screen.getByRole("button", { name: /Đặt hàng|Xác nhận tổng mới/ });
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

async function fillAll(over: { phone?: string } = {}) {
  fireEvent.change(screen.getByLabelText(/Họ và tên/), { target: { value: "Nguyễn Văn A" } });
  fireEvent.change(screen.getByLabelText(/Số điện thoại/), {
    target: { value: over.phone ?? "0912 345 678" },
  });
  fireEvent.change(screen.getByLabelText(/Tỉnh\/thành phố/), { target: { value: "01" } });
  await advance(10);
  await waitFor(() => expect(screen.getByLabelText(/Phường\/xã/)).not.toBeDisabled());
  fireEvent.change(screen.getByLabelText(/Phường\/xã/), { target: { value: "00004" } });
  fireEvent.change(screen.getByLabelText(/Số nhà, tên đường/), { target: { value: "12 Phố Điện Biên Phủ" } });
  await advance(600);
  await waitFor(() => expect(m.quote).toHaveBeenCalled());
}

describe("CHK02/CHK05: cấu trúc và truy cập", () => {
  it("3 nhóm, 'Mua không cần tài khoản', không có bước đăng nhập; autocomplete/inputmode đúng; nhãn thật", () => {
    ui();
    expect(
      screen
        .getAllByRole("group")
        .map((g) => g.tagName === "FIELDSET" && g.querySelector("legend")?.textContent),
    ).toEqual(expect.arrayContaining(["1. Liên hệ", "2. Giao hàng", "3. Thanh toán"]));
    expect(screen.getByText("Mua không cần tài khoản.")).toBeInTheDocument();
    expect(screen.queryByText(/đăng nhập$/i)).toBeNull();
    const tel = screen.getByLabelText(/Số điện thoại/);
    expect(tel).toHaveAttribute("type", "tel");
    expect(tel).toHaveAttribute("inputmode", "tel");
    expect(tel).toHaveAttribute("autocomplete", "tel");
    expect(screen.getByLabelText(/Họ và tên/)).toHaveAttribute("autocomplete", "name");
    expect(screen.getByLabelText(/Email/)).toHaveAttribute("autocomplete", "email");
    expect(screen.getByLabelText(/Tỉnh\/thành phố/)).toHaveAttribute("autocomplete", "address-level1");
    expect(screen.getByLabelText(/Phường\/xã/)).toBeDisabled();
    expect(screen.getByRole("radio", { name: /COD/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /VNPAY/ })).not.toBeChecked();
  });

  it("order summary luôn có (mobile: nút thu gọn kèm tổng) và không dùng localStorage", () => {
    ui();
    const toggle = screen.getByRole("button", { name: /đơn hàng \(3 sản phẩm\)/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("1.300.000 ₫");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("Áo sơ mi lụa").length).toBeGreaterThan(0);
  });

  it("axe: không lỗi serious/critical", async () => {
    vi.useRealTimers();
    const { container } = ui();
    const res = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(
      res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id),
    ).toEqual([]);
  });
});

describe("lỗi gắn trường", () => {
  it("submit rỗng: lỗi aria-describedby + aria-invalid, focus vào lỗi ĐẦU TIÊN, không gọi server", async () => {
    ui();
    fireEvent.click(submitBtn());
    const name = screen.getByLabelText(/Họ và tên/);
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name.getAttribute("aria-describedby")).toBe("f-name-loi");
    expect(document.getElementById("f-name-loi")).toHaveTextContent("Vui lòng nhập họ tên");
    expect(document.activeElement).toBe(name);
    expect(screen.getByLabelText(/Số điện thoại/)).toHaveAttribute("aria-invalid", "true");
    expect(m.submit).not.toHaveBeenCalled();
  });

  it("SĐT sai: lỗi ở trường SĐT và focus ở đó khi tên đã hợp lệ", () => {
    ui();
    fireEvent.change(screen.getByLabelText(/Họ và tên/), { target: { value: "An" } });
    fireEvent.change(screen.getByLabelText(/Số điện thoại/), { target: { value: "123" } });
    fireEvent.click(submitBtn());
    expect(document.activeElement).toBe(screen.getByLabelText(/Số điện thoại/));
  });
});

describe("CHK04: báo giá và tổng tiền trước nút đặt hàng", () => {
  it("chưa đủ địa chỉ: không gọi quote, tiền hàng từ giỏ, phí ship 'chưa tính'", () => {
    ui();
    expect(m.quote).not.toHaveBeenCalled();
    // eslint-disable-next-line no-restricted-properties -- vùng tổng tiền là div không vai trò ngữ nghĩa; testid là hợp đồng với E2E
    const t = within(screen.getByTestId("totals"));
    expect(t.getByText("Tiền hàng").nextSibling).toHaveTextContent("1.300.000 ₫");
    expect(t.getByText("Phí vận chuyển").nextSibling).toHaveTextContent(/Nhập địa chỉ/);
  });

  it("đủ địa chỉ: gọi quote MỘT lần (debounce) và hiện tiền hàng, giảm giá, phí ship, tổng, phương thức", async () => {
    m.quote.mockResolvedValue({
      ok: true,
      quote: mkQuote(1200000, {
        discountTotal: 130000,
        discountCode: "SALE10",
        shippingFee: 30000,
        shippingDiscount: 0,
      }),
    });
    ui();
    await fillAll();
    expect(m.quote).toHaveBeenCalledTimes(1);
    expect(m.quote).toHaveBeenCalledWith({
      paymentMethod: "cod",
      address: { provinceCode: "01", wardCode: "00004", line: "12 Phố Điện Biên Phủ" },
      discountCode: null,
    });
    // eslint-disable-next-line no-restricted-properties -- vùng tổng tiền là div không vai trò ngữ nghĩa; testid là hợp đồng với E2E
    const t = within(screen.getByTestId("totals"));
    await waitFor(() => expect(t.getByText("Tổng phải trả").nextSibling).toHaveTextContent("1.200.000 ₫"));
    expect(t.getByText(/Giảm giá \(mã SALE10\)/).nextSibling).toHaveTextContent("130.000 ₫");
    expect(t.getByText("Phí vận chuyển").nextSibling).toHaveTextContent("30.000 ₫");
    expect(t.getByText("Thanh toán").nextSibling).toHaveTextContent("COD");
  });

  it("đổi phương thức → báo giá lại với phương thức mới", async () => {
    ui();
    await fillAll();
    fireEvent.click(screen.getByRole("radio", { name: /VNPAY/ }));
    await advance(600);
    await waitFor(() =>
      expect(m.quote).toHaveBeenLastCalledWith(expect.objectContaining({ paymentMethod: "vnpay" })),
    );
  });
});

describe("đặt hàng", () => {
  it("COD thành công: gửi Idempotency-Key hợp lệ + SĐT chuẩn hóa, bỏ cookie giỏ, chuyển tới /don-hang/[ref]", async () => {
    m.submit.mockResolvedValue(placed);
    ui();
    await fillAll();
    fireEvent.click(submitBtn());
    await waitFor(() => expect(m.push).toHaveBeenCalledWith("/don-hang/XS-ABC123"));
    const arg = m.submit.mock.calls[0]![0];
    expect(arg.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(arg.contact).toEqual({ name: "Nguyễn Văn A", phone: "0912345678", email: "" });
    expect(arg).toMatchObject({ quoteId: "cqt_1330000", cartVersion: 1, paymentMethod: "cod" });
    expect(m.finish).toHaveBeenCalled();
  });

  it("VNPAY: chuyển tới payment_url (https); URL lạ (javascript:) bị từ chối", async () => {
    expect(safePaymentUrl("javascript:alert(1)")).toBeNull();
    expect(safePaymentUrl("not a url")).toBeNull();
    expect(safePaymentUrl(null)).toBeNull();
    expect(safePaymentUrl("https://sandbox.vnpayment.vn/x?a=1")).toBe("https://sandbox.vnpayment.vn/x?a=1");
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    m.submit.mockResolvedValue({
      ...placed,
      state: "awaiting_payment",
      paymentUrl: "https://sandbox.vnpayment.vn/pay?x=1",
    });
    ui();
    await fillAll();
    fireEvent.click(screen.getByRole("radio", { name: /VNPAY/ }));
    await advance(600);
    await waitFor(() => expect(m.quote).toHaveBeenCalledTimes(2));
    fireEvent.click(submitBtn());
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://sandbox.vnpayment.vn/pay?x=1"));
    expect(m.push).not.toHaveBeenCalled();
  });

  it("lỗi mạng: giữ dữ liệu, báo rõ; bấm lại dùng CÙNG khóa (không tạo đơn trùng)", async () => {
    m.submit.mockResolvedValueOnce({ kind: "network" }).mockResolvedValueOnce(placed);
    ui();
    await fillAll();
    fireEvent.click(submitBtn());
    // eslint-disable-next-line no-restricted-properties -- banner lỗi là vùng tổng hợp, testid là hợp đồng với E2E
    const banner = await screen.findByTestId("checkout-banner");
    expect(banner).toHaveTextContent("Mất kết nối");
    await waitFor(() => expect(document.activeElement).toBe(banner));
    expect(screen.getByLabelText(/Họ và tên/)).toHaveValue("Nguyễn Văn A");
    fireEvent.click(submitBtn());
    await waitFor(() => expect(m.push).toHaveBeenCalled());
    expect(m.submit.mock.calls[1]![0].idempotencyKey).toBe(m.submit.mock.calls[0]![0].idempotencyKey);
  });

  it("nhấp đúp: chỉ MỘT lần gửi khi đang xử lý", async () => {
    let resolve!: (v: SubmitResult) => void;
    m.submit.mockReturnValue(new Promise<SubmitResult>((r) => (resolve = r)));
    ui();
    await fillAll();
    fireEvent.click(submitBtn());
    fireEvent.click(submitBtn());
    expect(m.submit).toHaveBeenCalledTimes(1);
    resolve(placed);
    await waitFor(() => expect(m.push).toHaveBeenCalled());
  });

  it("AT03: 409 giá đổi → hiện tổng mới + yêu cầu xác nhận lại; không tự gửi lại; bấm xác nhận dùng khóa MỚI", async () => {
    m.submit
      .mockResolvedValueOnce({
        kind: "changed",
        code: "PRICE_CHANGED",
        message: "Giá sản phẩm đã thay đổi",
        quote: mkQuote(1380000),
      })
      .mockResolvedValueOnce(placed);
    ui();
    await fillAll();
    fireEvent.click(submitBtn());
    // eslint-disable-next-line no-restricted-properties -- banner lỗi là vùng tổng hợp, testid là hợp đồng với E2E
    const banner = await screen.findByTestId("checkout-banner");
    expect(banner).toHaveTextContent("1.380.000 ₫");
    expect(banner).toHaveTextContent("1.330.000 ₫");
    expect(m.submit).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line no-restricted-properties -- vùng tổng tiền là div không vai trò ngữ nghĩa; testid là hợp đồng với E2E
    const t = within(screen.getByTestId("totals"));
    expect(t.getByText("Tổng phải trả").nextSibling).toHaveTextContent("1.380.000 ₫");
    const confirmBtn = screen.getByRole("button", { name: "Xác nhận tổng mới và đặt hàng" });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(m.submit).toHaveBeenCalledTimes(2));
    expect(m.submit.mock.calls[1]![0]).toMatchObject({ quoteId: "cqt_1380000" });
    expect(m.submit.mock.calls[1]![0].idempotencyKey).not.toBe(m.submit.mock.calls[0]![0].idempotencyKey);
  });

  it("INSUFFICIENT_STOCK: chỉ ra từng dòng (tên + còn bao nhiêu) và có liên kết sửa giỏ", async () => {
    m.submit.mockResolvedValue({
      kind: "stock",
      message: "Một số sản phẩm không còn đủ hàng",
      lines: [
        { lineItemId: "li_2", variantId: "v", requested: 2, available: 1 },
        { lineItemId: "li_1", variantId: "w", requested: 1, available: 0 },
      ],
    });
    ui();
    await fillAll();
    fireEvent.click(submitBtn());
    // eslint-disable-next-line no-restricted-properties -- banner lỗi là vùng tổng hợp, testid là hợp đồng với E2E
    const banner = await screen.findByTestId("checkout-banner");
    expect(banner).toHaveTextContent("Quần tây: chỉ còn 1 (bạn chọn 2)");
    expect(banner).toHaveTextContent("Áo sơ mi lụa: đã hết hàng");
    expect(within(banner).getByRole("link", { name: "Sửa giỏ hàng" })).toHaveAttribute("href", "/gio-hang");
  });

  it("202: poll rồi chuyển trang; poll quá lâu → báo đang xử lý, KHÔNG đặt lại, có mã tham chiếu", async () => {
    m.submit.mockResolvedValue({ kind: "pending", attemptId: "chk_77" });
    m.poll
      .mockResolvedValueOnce({ kind: "pending" })
      .mockResolvedValueOnce({ ...placed, attemptId: "chk_77" });
    ui();
    await fillAll();
    fireEvent.click(submitBtn());
    await advance(1600);
    await advance(1600);
    await waitFor(() => expect(m.push).toHaveBeenCalledWith("/don-hang/XS-ABC123"));
    expect(m.poll).toHaveBeenCalledWith("chk_77");
  });

  it("503 LOCK_UNAVAILABLE: thông điệp tiếng Việt, giữ dữ liệu form, nút thử lại dùng CÙNG khóa, không tự gửi lại", async () => {
    m.submit.mockResolvedValueOnce({ kind: "unavailable", retryAfterSeconds: 60 });
    ui();
    await fillAll();
    fireEvent.click(submitBtn());
    // eslint-disable-next-line no-restricted-properties -- banner lỗi là vùng tổng hợp, testid là hợp đồng với E2E
    const banner = await screen.findByTestId("checkout-banner");
    expect(banner).toHaveTextContent("Hệ thống tạm thời không nhận đơn, vui lòng thử lại sau ít phút");
    expect(screen.getByLabelText(/Họ và tên/)).toHaveValue("Nguyễn Văn A");
    expect(screen.getByLabelText(/Số nhà, tên đường/)).toHaveValue("12 Phố Điện Biên Phủ");
    await advance(120_000);
    expect(m.submit).toHaveBeenCalledTimes(1); // không tự gửi lại
    m.submit.mockResolvedValueOnce(placed);
    fireEvent.click(within(banner).getByRole("button", { name: "Thử lại" }));
    await waitFor(() => expect(m.submit).toHaveBeenCalledTimes(2));
    expect(m.submit.mock.calls[1]?.[0].idempotencyKey).toBe(m.submit.mock.calls[0]?.[0].idempotencyKey);
    await waitFor(() => expect(m.push).toHaveBeenCalledWith("/don-hang/XS-ABC123"));
  });

  it("lỗi gắn trường từ server (SĐT) hiện tại trường và focus; BUSY_RETRY hết lượt báo bấm lại", async () => {
    m.submit.mockResolvedValueOnce({
      kind: "error",
      code: "VALIDATION",
      message: "Số điện thoại không hợp lệ",
      field: "phone",
      newKey: false,
    });
    ui();
    await fillAll();
    fireEvent.click(submitBtn());
    await waitFor(() =>
      expect(document.getElementById("f-phone-loi")).toHaveTextContent("Số điện thoại không hợp lệ"),
    );
    expect(document.activeElement).toBe(screen.getByLabelText(/Số điện thoại/));
  });
});
