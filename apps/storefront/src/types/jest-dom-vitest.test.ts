import { describe, expect, it } from "vitest";

// Kiểu của matcher jest-dom (jest-dom-vitest.d.ts) được `pnpm typecheck` kiểm; vitest typecheck chưa bật nên các hàm
// dưới đây là kiểm ở thời điểm biên dịch: đồng bộ trả void, `.resolves` trả Promise<void> (sai tham số kiểu → tsc đỏ).
function syncReturnsVoid(el: HTMLElement): void {
  const result: void = expect(el).toBeInTheDocument();
  return result;
}
function resolvesReturnsPromise(el: HTMLElement): Promise<void> {
  const result: Promise<void> = expect(Promise.resolve(el)).resolves.toBeInTheDocument();
  return result;
}

describe("kiểu matcher jest-dom trên vitest", () => {
  it("matcher chạy được với kiểu đã khai báo", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    syncReturnsVoid(el);
    await resolvesReturnsPromise(el);
    el.remove();
    expect(el).not.toBeInTheDocument();
  });
});
