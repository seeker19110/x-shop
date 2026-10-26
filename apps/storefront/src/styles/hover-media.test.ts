import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * UX-RESP-005: chức năng không phụ thuộc hover — mọi quy tắc `:hover` phải nằm trong `@media (hover: hover)`, để thiết
 * bị cảm ứng không bị "dính hover" sau khi chạm. Quét mọi file .css của storefront.
 */
const SRC = `${join(process.cwd(), "src")}/`;

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return cssFiles(p);
    return p.endsWith(".css") ? [p] : [];
  });
}

/** Danh sách selector chứa `:hover` nằm NGOÀI `@media (hover: hover)`. */
export function unguardedHoverSelectors(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const stack: string[] = [];
  const found: string[] = [];
  let prelude = "";
  for (const ch of clean) {
    if (ch === "{") {
      const head = prelude.trim();
      if (!head.startsWith("@") && head.includes(":hover")) {
        const guarded = stack.some((s) => /^@media[^{]*\(\s*hover\s*:\s*hover\s*\)/i.test(s));
        if (!guarded) found.push(head.replace(/\s+/g, " "));
      }
      stack.push(head);
      prelude = "";
    } else if (ch === "}") {
      stack.pop();
      prelude = "";
    } else if (ch === ";") {
      prelude = "";
    } else {
      prelude += ch;
    }
  }
  return found;
}

describe("unguardedHoverSelectors (bộ quét)", () => {
  it("bắt :hover trần, kể cả selector ghép", () => {
    expect(unguardedHoverSelectors(".a:hover { color: red; }")).toEqual([".a:hover"]);
    expect(unguardedHoverSelectors(".a:hover,\n.b[x] { color: red; }")).toEqual([".a:hover, .b[x]"]);
  });

  it("chấp nhận :hover trong @media (hover: hover), kể cả lồng thêm điều kiện", () => {
    expect(unguardedHoverSelectors("@media (hover: hover) { .a:hover { color: red; } }")).toEqual([]);
    expect(
      unguardedHoverSelectors("@media (hover: hover) and (min-width: 48em) { .a:hover { color: red; } }"),
    ).toEqual([]);
  });

  it("@media khác (min-width) không đủ; bỏ qua chú thích; rỗng thì không có gì", () => {
    expect(unguardedHoverSelectors("@media (min-width: 48em) { .a:hover { color: red; } }")).toEqual([
      ".a:hover",
    ]);
    expect(unguardedHoverSelectors("/* .a:hover { } */ .b { color: red; }")).toEqual([]);
    expect(unguardedHoverSelectors("")).toEqual([]);
  });

  it("quy tắc sau khối @media đã đóng không được thừa hưởng bảo vệ", () => {
    const css = "@media (hover: hover) { .a:hover { color: red; } } .b:hover { color: blue; }";
    expect(unguardedHoverSelectors(css)).toEqual([".b:hover"]);
  });
});

describe("CSS storefront", () => {
  const files = cssFiles(SRC);

  it("có file CSS để quét (không xanh giả)", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((f) => [f.slice(SRC.length), f] as const))(
    "%s: mọi :hover nằm trong @media (hover: hover)",
    (_name, file) => {
      expect(unguardedHoverSelectors(readFileSync(file, "utf8"))).toEqual([]);
    },
  );
});
