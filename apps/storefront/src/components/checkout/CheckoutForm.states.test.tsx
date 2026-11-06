// UX-STATE-001: 4 trạng thái của CheckoutForm ở phần tải dữ liệu phường/xã theo tỉnh.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CheckoutForm } from "./CheckoutForm";

vi.mock("../../lib/checkout/actions", () => ({
  quoteCheckout: vi.fn(async () => ({ ok: false, code: "X", message: "x" })),
  submitCheckout: vi.fn(),
  pollCheckout: vi.fn(),
  finishCheckout: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element -- mock next/image trong test, cần thẻ img thuần
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

const lines = [
  { id: "li_1", title: "Áo", variantLabel: null, quantity: 1, lineTotal: 100000, thumbnail: null },
];
const provinces = [{ code: "01", name: "Thành phố Hà Nội" }];

const ui = () => render(<CheckoutForm lines={lines} subtotal={100000} provinces={provinces} />);
const pickProvince = () =>
  fireEvent.change(screen.getByLabelText(/Tỉnh\/thành phố/), { target: { value: "01" } });
const ward = () => screen.getByLabelText(/Phường\/xã/);

afterEach(() => vi.unstubAllGlobals());

describe("CheckoutForm — 4 trạng thái tải phường/xã", () => {
  it("loading: chọn tỉnh, đang tải → ô phường/xã khóa, hiện 'Đang tải…'", () => {
    vi.stubGlobal("fetch", () => new Promise<Response>(() => undefined));
    ui();
    pickProvince();
    expect(ward()).toBeDisabled();
    expect(screen.getByRole("option", { name: "Đang tải…" })).toBeInTheDocument();
  });

  it("empty: tỉnh không có phường/xã → thông báo tiếng Việt, không lỗi, không nút tải lại", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ wards: [] })));
    ui();
    pickProvince();
    const hint = await screen.findByText(/Chưa có danh sách phường\/xã cho tỉnh\/thành này/);
    expect(hint).toBeInTheDocument();
    expect(ward().getAttribute("aria-describedby")?.split(" ")).toContain(hint.id);
    expect(screen.queryByRole("button", { name: "Thử tải lại" })).toBeNull();
    expect(ward()).not.toBeDisabled();
  });

  it("error: tải thất bại (404) → báo lỗi + nút 'Thử tải lại'; bấm thì tải lại và thành công", async () => {
    let ok = false;
    vi.stubGlobal("fetch", async () =>
      ok
        ? new Response(JSON.stringify({ wards: [{ code: "00004", name: "Phường Ba Đình" }] }))
        : new Response("{}", { status: 404 }),
    );
    ui();
    pickProvince();
    expect(await screen.findByText("Không tải được danh sách phường/xã.")).toBeInTheDocument();
    ok = true;
    fireEvent.click(screen.getByRole("button", { name: "Thử tải lại" }));
    expect(await screen.findByRole("option", { name: "Phường Ba Đình" })).toBeInTheDocument();
    expect(screen.queryByText("Không tải được danh sách phường/xã.")).toBeNull();
  });

  it("success: có danh sách → ô phường/xã mở, liệt kê phường/xã", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ wards: [{ code: "00004", name: "Phường Ba Đình" }] })),
    );
    ui();
    pickProvince();
    await waitFor(() => expect(ward()).not.toBeDisabled());
    expect(screen.getByRole("option", { name: "Phường Ba Đình" })).toBeInTheDocument();
  });
});
