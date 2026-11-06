import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { saveScroll, SCROLL_STORAGE_KEY } from "../components/catalog/scroll-restore";
import { looksLikePii } from "./analytics/schema";
import { resetAnalyticsForTests, setAnalyticsConsent, track } from "./analytics/track";

/**
 * FE-STATE-008: kho bền phía trình duyệt chỉ chứa khoá đã duyệt ở docs/CLIENT-STORAGE.md; không token/PII.
 */
// vitest chạy với cwd = apps/storefront (môi trường jsdom: `import.meta.url` không phải `file:`).
const SRC = join(process.cwd(), "src");
const DOC = readFileSync(join(process.cwd(), "../../docs/CLIENT-STORAGE.md"), "utf8");

const FORBIDDEN_KEY =
  /token|session|email|mail|phone|sdt|password|passwd|secret|otp|auth|jwt|cookie|address|name/i;
const STORAGE_API = /\b(?:localStorage|sessionStorage|indexedDB)\b|\bpersist\s*\(|\bdocument\.cookie\b/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Cột đầu của các hàng bảng trong một mục (`## <heading>`), bỏ dấu backtick. */
function tableFirstCells(heading: string): string[] {
  const start = DOC.indexOf(`## ${heading}`);
  if (start < 0) throw new Error(`thiếu mục "${heading}" trong CLIENT-STORAGE.md`);
  const rest = DOC.slice(start + 3);
  const end = rest.indexOf("\n## ");
  const section = end < 0 ? rest : rest.slice(0, end);
  return section
    .split("\n")
    .filter((l) => /^\|\s*`/.test(l))
    .map((l) => l.split("|")[1]!.trim().replaceAll("`", ""));
}

const approvedKeys = tableFirstCells("Khoá đã duyệt");
const approvedFiles = tableFirstCells("Tệp được dùng API kho");

/** `xs_purchase_<mã đơn hiển thị>` → tiền tố; còn lại khớp nguyên văn. */
function isApprovedKey(key: string): boolean {
  return approvedKeys.some((k) =>
    k.includes("<") ? key.startsWith(k.slice(0, k.indexOf("<"))) && key.length > k.indexOf("<") : k === key,
  );
}

describe("client-storage: tài liệu đối chiếu với mã nguồn", () => {
  it("bảng duyệt không rỗng và không khoá nào chứa token/session/email/...", () => {
    expect(approvedKeys.length).toBeGreaterThan(0);
    expect(approvedFiles.length).toBeGreaterThan(0);
    for (const k of approvedKeys) expect(k, k).not.toMatch(FORBIDDEN_KEY);
  });

  it("tệp nguồn (không test) dùng API kho đều nằm trong danh sách đã duyệt", () => {
    const users = walk(SRC)
      .filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f) && !/\.test\.|\.spec\./.test(f))
      .filter((f) => STORAGE_API.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(SRC, f).split(sep).join("/"));
    expect(users.length).toBeGreaterThan(0);
    for (const f of users)
      expect(approvedFiles, `${f} dùng API kho nhưng chưa có trong docs/CLIENT-STORAGE.md`).toContain(f);
  });

  it("mọi tệp trong danh sách duyệt thật sự tồn tại (không để mục mồ côi)", () => {
    const all = new Set(walk(SRC).map((f) => relative(SRC, f).split(sep).join("/")));
    for (const f of approvedFiles) expect(all.has(f), f).toBe(true);
  });

  it("bộ so khoá: khoá lạ bị từ chối, khoá duyệt được nhận", () => {
    expect(isApprovedKey("xs_analytics_consent")).toBe(true);
    expect(isApprovedKey("xs_purchase_XS-ABC123")).toBe(true);
    expect(isApprovedKey("xs_purchase_")).toBe(false);
    expect(isApprovedKey("auth_token")).toBe(false);
    expect(isApprovedKey("xs_email")).toBe(false);
  });
});

describe("client-storage: luồng thật chỉ ghi khoá đã duyệt, giá trị không phải PII", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.dataLayer = [];
    resetAnalyticsForTests();
  });

  function dump(): { store: string; key: string; value: string }[] {
    const out: { store: string; key: string; value: string }[] = [];
    for (const [name, s] of [
      ["localStorage", window.localStorage],
      ["sessionStorage", window.sessionStorage],
    ] as const) {
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i)!;
        out.push({ store: name, key, value: s.getItem(key) ?? "" });
      }
    }
    return out;
  }

  it("đồng ý phân tích + purchase + cuộn → đúng 3 loại khoá, không khoá/giá trị nhạy cảm", () => {
    setAnalyticsConsent(true);
    expect(track({ event: "purchase", order_id: "XS-ABC123", value: 450000 })).toBe(true);
    saveScroll(window.sessionStorage, "/danh-muc/ao-so-mi?size=M", 1234.6);

    const entries = dump();
    expect(entries.map((e) => e.key).sort()).toEqual(
      ["xs_analytics_consent", "xs_purchase_XS-ABC123", SCROLL_STORAGE_KEY].sort(),
    );
    for (const e of entries) {
      expect(isApprovedKey(e.key), e.key).toBe(true);
      expect(e.key, e.key).not.toMatch(FORBIDDEN_KEY);
      expect(looksLikePii(e.value), `${e.key}=${e.value}`).toBe(false);
      expect(e.value).not.toMatch(/@|eyJ[A-Za-z0-9_-]{10,}/); // email / dạng JWT
    }
    expect(JSON.parse(window.sessionStorage.getItem(SCROLL_STORAGE_KEY)!)).toEqual({
      "/danh-muc/ao-so-mi?size=M": 1235,
    });
  });

  it("từ chối đồng ý → xoá khoá; kho rỗng khi chưa có gì", () => {
    expect(dump()).toEqual([]);
    setAnalyticsConsent(true);
    setAnalyticsConsent(false);
    expect(dump()).toEqual([]);
  });

  it("sự kiện chứa PII bị bỏ, không ghi gì vào kho", () => {
    expect(track({ event: "purchase", order_id: "khach@example.com", value: 1000 })).toBe(false);
    expect(track({ event: "purchase", order_id: "0912345678", value: 1000 })).toBe(false);
    expect(dump()).toEqual([]);
  });

  it("cuộn: giá trị không hợp lệ (NaN/âm) không ghi gì", () => {
    saveScroll(window.sessionStorage, "/a", Number.NaN);
    saveScroll(window.sessionStorage, "/a", -5);
    expect(dump()).toEqual([]);
  });
});
