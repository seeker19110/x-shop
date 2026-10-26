import { fireEvent, render, screen } from "@testing-library/react";
import AppError from "./error";
import GlobalError from "./global-error";

const SECRET = new Error("TypeError: SELECT * FROM orders at /srv/app/server.js:10") as Error & {
  digest?: string;
};
SECRET.digest = "digest-9f8e";
const LEAK = /(Error:|at .*\.js|SELECT|Exception|TypeError|digest-9f8e)/;

describe("app/error.tsx (UX-STATE-005)", () => {
  it("thông báo tiếng Việt, không lộ chi tiết lỗi, có alert", () => {
    render(<AppError error={SECRET} reset={vi.fn()} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Đã có sự cố" })).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(LEAK);
  });

  it("nút Thử lại gọi reset đúng một lần", () => {
    const reset = vi.fn();
    render(<AppError error={SECRET} reset={reset} />);
    fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe("global-error.tsx (UX-STATE-005)", () => {
  it("không lộ chi tiết lỗi, có alert, Thử lại gọi reset", () => {
    const reset = vi.fn();
    const { container } = render(<GlobalError error={SECRET} reset={reset} />);
    expect(container.textContent ?? "").not.toMatch(LEAK);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
