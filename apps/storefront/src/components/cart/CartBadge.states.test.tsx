// UX-STATE-001: 4 trạng thái của CartBadge. Badge ở header cố ý KHÔNG hiện UI lỗi/đang tải (không chặn việc mua):
// loading = giữ số ban đầu, error = giữ số hiện có, empty = 0 sản phẩm, success = số từ API.
import { act, render, screen, waitFor } from "@testing-library/react";
import { CartBadge } from "./CartBadge";

afterEach(() => vi.unstubAllGlobals());

const label = (n: number) => `Giỏ hàng, ${n} sản phẩm`;

describe("CartBadge — 4 trạng thái", () => {
  it("loading: chờ API thì hiện số ban đầu, chưa nháy 0", async () => {
    vi.stubGlobal("fetch", () => new Promise<Response>(() => undefined));
    render(<CartBadge initial={3} />);
    await act(async () => undefined);
    expect(screen.getByText(label(3))).toBeInTheDocument();
  });

  it("empty: giỏ trống (count 0) → nhãn 0 sản phẩm", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ count: 0 })));
    render(<CartBadge initial={5} />);
    await waitFor(() => expect(screen.getByText(label(0))).toBeInTheDocument());
  });

  it("error: mạng lỗi hoặc HTTP 500 → giữ số hiện có, không ném, không hiện lỗi", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    const { unmount } = render(<CartBadge initial={2} />);
    await act(async () => undefined);
    expect(screen.getByText(label(2))).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    unmount();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    render(<CartBadge initial={2} />);
    await act(async () => undefined);
    expect(screen.getByText(label(2))).toBeInTheDocument();
  });

  it("success: số từ API được hiển thị", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ count: 7 })));
    render(<CartBadge />);
    await waitFor(() => expect(screen.getByText(label(7))).toBeInTheDocument());
  });
});
