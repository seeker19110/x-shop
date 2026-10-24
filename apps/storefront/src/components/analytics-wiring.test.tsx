import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { findPii, type AnalyticsEvent } from "../lib/analytics/schema";
import { resetAnalyticsForTests } from "../lib/analytics/track";
import { FIXTURE_PRODUCTS } from "../lib/catalog/fixtures";
import { ListAnalytics } from "./catalog/ListAnalytics";
import { CheckoutForm } from "./checkout/CheckoutForm";
import { ProductExperience } from "./product/ProductExperience";
import { initialSelection } from "./product/selection";

const m = vi.hoisted(() => ({
  addToCart: vi.fn(),
  quote: vi.fn(),
  submit: vi.fn(),
  poll: vi.fn(),
  finish: vi.fn(),
  push: vi.fn(),
}));
vi.mock("../lib/cart/actions", () => ({ addToCart: m.addToCart }));
vi.mock("../lib/checkout/actions", () => ({
  quoteCheckout: m.quote,
  submitCheckout: m.submit,
  pollCheckout: m.poll,
  finishCheckout: m.finish,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push }) }));
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

const events = () => (window.dataLayer ?? []) as AnalyticsEvent[];
const names = () => events().map((e) => e.event);

beforeEach(() => {
  window.dataLayer = [];
  window.sessionStorage.clear();
  resetAnalyticsForTests();
  Object.values(m).forEach((f) => f.mockReset());
  vi.spyOn(window.history, "replaceState").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("analytics: PDP", () => {
  const p = FIXTURE_PRODUCTS.find((x) => x.handle === "ao-so-mi-lua")!;
  const ui = (params: Record<string, string> = {}) =>
    render(
      <ProductExperience product={p} initial={initialSelection(p, params)}>
        <p>x</p>
      </ProductExperience>,
    );

  it("view_item khi mở; select_variant khi đổi màu/size; view_size_guide; add_to_cart có sku + giá; không PII", async () => {
    m.addToCart.mockResolvedValue({ ok: true, message: "ok", count: 1 });
    ui({ color: "den", size: "s" });
    expect(names()).toEqual(["view_item"]);
    expect(events()[0]!.items).toEqual([
      { item_id: "ao-so-mi-lua", sku: expect.any(String), price: expect.any(Number) },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /^Trắng/ }));
    expect(names()).toContain("select_variant");

    fireEvent.click(screen.getByRole("button", { name: "Hướng dẫn chọn size" }));
    expect(names()).toContain("view_size_guide");
    for (const ev of events()) expect(findPii(ev)).toBeNull();
  });

  it("add_to_cart sau khi server xác nhận (không gửi khi thất bại)", async () => {
    m.addToCart.mockResolvedValueOnce({ ok: false, message: "lỗi" });
    ui({ color: "den", size: "s" });
    const btn = document.querySelector<HTMLButtonElement>("button[data-cta]")!;
    await act(async () => fireEvent.click(btn));
    expect(names()).not.toContain("add_to_cart");

    m.addToCart.mockResolvedValueOnce({ ok: true, message: "ok", count: 1 });
    await act(async () => fireEvent.click(btn));
    await waitFor(() => expect(names()).toContain("add_to_cart"));
    const e = events().find((x) => x.event === "add_to_cart")!;
    expect(e.items?.[0]).toMatchObject({ item_id: "ao-so-mi-lua", quantity: 1 });
    expect(Number.isInteger(e.value)).toBe(true);
    for (const ev of events()) expect(findPii(ev)).toBeNull();
  });
});

/* Thẻ giả cho bộ ủy quyền click: cần `<a>` thuần (không điều hướng thật trong jsdom). */
/* eslint-disable @next/next/no-html-link-for-pages */
describe("analytics: danh sách", () => {
  it("view_item_list một lần; click thẻ → select_item đúng handle/vị trí; gỡ listener khi unmount", () => {
    const { unmount } = render(
      <>
        <ListAnalytics
          listId="ao"
          items={[
            { handle: "a-1", price: 100 },
            { handle: "b-2", price: 200 },
          ]}
        />
        <ul className="product-grid">
          <li>
            <a href="/san-pham/a-1">A</a>
          </li>
          <li>
            <a href="/san-pham/b-2">B</a>
          </li>
        </ul>
        <a href="/san-pham/ngoai-luoi">ngoài lưới</a>
      </>,
    );
    expect(names()).toEqual(["view_item_list"]);
    expect(events()[0]).toMatchObject({ list_id: "ao", items: [{ item_id: "a-1" }, { item_id: "b-2" }] });
    fireEvent.click(screen.getByText("B"));
    expect(events().at(-1)).toMatchObject({
      event: "select_item",
      index: 1,
      items: [{ item_id: "b-2", price: 200 }],
    });
    fireEvent.click(screen.getByText("ngoài lưới"));
    expect(names()).toEqual(["view_item_list", "select_item"]);
    unmount();
    fireEvent.click(document.body);
    expect(names()).toHaveLength(2);
  });

  it("danh sách rỗng không gửi gì", () => {
    render(<ListAnalytics listId="ao" items={[]} />);
    expect(names()).toEqual([]);
  });
});

/* eslint-enable @next/next/no-html-link-for-pages */
describe("analytics: checkout", () => {
  const lines = [
    {
      id: "li_1",
      itemId: "ao-so-mi-lua",
      title: "Áo sơ mi lụa",
      variantLabel: "Đen / M",
      quantity: 1,
      lineTotal: 700000,
      thumbnail: null,
    },
    {
      id: "li_2",
      itemId: null,
      title: "Quần",
      variantLabel: null,
      quantity: 2,
      lineTotal: 600000,
      thumbnail: null,
    },
  ];
  const quote = {
    id: "cqt_1",
    cartVersion: 1,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    paymentMethod: "cod",
    discountCode: null,
    lines: [],
    subtotal: 1300000,
    discountTotal: 0,
    shippingFee: 30000,
    shippingDiscount: 0,
    shippingTotal: 30000,
    total: 1330000,
  };

  it("begin_checkout lúc mở; add_payment_info khi đổi phương thức (một lần mỗi phương thức); order_placed không PII", async () => {
    m.quote.mockResolvedValue({ ok: true, quote });
    m.finish.mockResolvedValue(undefined);
    m.submit.mockResolvedValue({
      kind: "placed",
      attemptId: "chk_1",
      ref: "XS-ABC123",
      state: "placed",
      total: 1330000,
      paymentUrl: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ wards: [{ code: "00004", name: "Phường Ba Đình" }] }))),
    );
    render(<CheckoutForm lines={lines} subtotal={1300000} provinces={[{ code: "01", name: "Hà Nội" }]} />);
    expect(events()[0]).toMatchObject({
      event: "begin_checkout",
      value: 1300000,
      items: [{ item_id: "ao-so-mi-lua", quantity: 1 }],
    });

    fireEvent.click(screen.getByRole("radio", { name: /VNPAY/ }));
    fireEvent.click(screen.getByRole("radio", { name: /COD/ }));
    fireEvent.click(screen.getByRole("radio", { name: /VNPAY/ }));
    expect(
      events()
        .filter((e) => e.event === "add_payment_info")
        .map((e) => e.payment_type),
    ).toEqual(["vnpay", "cod"]);

    fireEvent.change(screen.getByLabelText(/Họ và tên/), { target: { value: "Nguyễn Văn A" } });
    fireEvent.change(screen.getByLabelText(/Số điện thoại/), { target: { value: "0912 345 678" } });
    fireEvent.change(screen.getByLabelText(/Tỉnh\/thành phố/), { target: { value: "01" } });
    await waitFor(() => expect(screen.getByLabelText(/Phường\/xã/)).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText(/Phường\/xã/), { target: { value: "00004" } });
    fireEvent.change(screen.getByLabelText(/Số nhà, tên đường/), {
      target: { value: "12 Phố Điện Biên Phủ" },
    });
    await waitFor(() => expect(names()).toContain("add_shipping_info"));
    await waitFor(() => expect(m.quote).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("radio", { name: /COD/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Đặt hàng/ })).toBeEnabled(), {
      timeout: 3000,
    });
    await waitFor(() => expect(screen.queryByText(/Đang tính/)).toBeNull(), { timeout: 3000 });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Đặt hàng/ })));
    await waitFor(() => expect(names()).toContain("order_placed"), { timeout: 3000 });

    const placed = events().find((e) => e.event === "order_placed")!;
    expect(placed).toMatchObject({ order_id: "XS-ABC123", currency: "VND", v: 1 });
    expect(Number.isInteger(placed.value)).toBe(true);
    // Quét toàn bộ payload: không có tên/SĐT/địa chỉ khách đã nhập.
    const blob = JSON.stringify(events());
    for (const secret of ["Nguyễn Văn A", "0912", "Điện Biên Phủ", "Ba Đình"])
      expect(blob).not.toContain(secret);
    for (const ev of events()) expect(findPii(ev)).toBeNull();
    vi.unstubAllGlobals();
  });
});
