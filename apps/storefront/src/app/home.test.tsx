import { render, screen } from "@testing-library/react";
import HomePage from "./page";

describe("HomePage (khung tạm)", () => {
  it("render đúng một h1", () => {
    render(<HomePage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "X-Shop" })).toBeInTheDocument();
  });
});
