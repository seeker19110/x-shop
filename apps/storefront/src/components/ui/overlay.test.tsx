import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";
import { Drawer } from "./Drawer";

function Harness({ kind = "drawer" }: { kind?: "drawer" | "dialog" }) {
  const [open, setOpen] = useState(false);
  const Comp = kind === "drawer" ? Drawer : Dialog;
  return (
    <>
      <button onClick={() => setOpen(true)}>Mở</button>
      <Comp open={open} onClose={() => setOpen(false)} title="Giỏ hàng">
        <button>Một</button>
        <button>Hai</button>
      </Comp>
    </>
  );
}

afterEach(() => {
  document.body.style.overflow = "";
});

describe.each(["drawer", "dialog"] as const)("%s", (kind) => {
  it("đóng: không render; mở: role=dialog, aria-modal, nhãn bằng tiêu đề", () => {
    render(<Harness kind={kind} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mở" }));
    const dlg = screen.getByRole("dialog", { name: "Giỏ hàng" });
    expect(dlg).toHaveAttribute("aria-modal", "true");
  });

  it("focus vào phần tử đầu trong lớp mở; Esc đóng và trả focus về nút mở", () => {
    render(<Harness kind={kind} />);
    const opener = screen.getByRole("button", { name: "Mở" });
    opener.focus();
    fireEvent.click(opener);
    const dlg = screen.getByRole("dialog");
    expect(dlg.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("nút Đóng đóng và trả focus", () => {
    render(<Harness kind={kind} />);
    const opener = screen.getByRole("button", { name: "Mở" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Đóng" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("Tab ở phần tử cuối quay về đầu; Shift+Tab ở đầu về cuối (khóa focus)", () => {
    render(<Harness kind={kind} />);
    fireEvent.click(screen.getByRole("button", { name: "Mở" }));
    const first = screen.getByRole("button", { name: "Đóng" });
    const last = screen.getByRole("button", { name: "Hai" });
    last.focus();
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
    expect(first).toHaveFocus();
    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
    expect(last).toHaveFocus();
  });

  it("focus bị đưa ra ngoài thì kéo lại vào lớp", () => {
    render(<Harness kind={kind} />);
    const opener = screen.getByRole("button", { name: "Mở" });
    fireEvent.click(opener);
    act(() => opener.focus());
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("khóa cuộn nền khi mở và mở khóa khi đóng", () => {
    document.body.style.overflow = "auto";
    render(<Harness kind={kind} />);
    fireEvent.click(screen.getByRole("button", { name: "Mở" }));
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.body.style.overflow).toBe("auto");
  });

  it("bấm nền mờ đóng, bấm trong panel thì không", () => {
    const onClose = vi.fn();
    const Comp = kind === "drawer" ? Drawer : Dialog;
    render(
      <Comp open onClose={onClose} title="T">
        <p>nội dung</p>
      </Comp>,
    );
    fireEvent.mouseDown(screen.getByText("nội dung"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Drawer", () => {
  it("side=bottom render được", () => {
    render(
      <Drawer open onClose={() => {}} title="Bộ lọc" side="bottom">
        <p>x</p>
      </Drawer>,
    );
    expect(screen.getByRole("dialog", { name: "Bộ lọc" }).className).toMatch(/bottom/);
  });

  it("returnFocusRef được ưu tiên khi trả focus", () => {
    function H() {
      const [open, setOpen] = useState(true);
      const other = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={other}>Khác</button>
          <Drawer open={open} onClose={() => setOpen(false)} title="T" returnFocusRef={other}>
            <p>x</p>
          </Drawer>
        </>
      );
    }
    render(<H />);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Khác" })).toHaveFocus();
  });
});
