import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findPii, looksLikePii } from "./schema";
import { resetAnalyticsForTests, track } from "./track";
import { validateEvent } from "./validate";

/**
 * T-136 (D-065, D-066): cùng bộ mẫu `scripts/fixtures/pii-samples.json` với test của bộ che log backend
 * (`redact-pii-fixtures.unit.spec.ts`). Mẫu `scopes ∋ storefront` phải bị bộ quét `track()` nhận ra ở mọi vị trí (giá trị,
 * khoá, lồng, mảng); mẫu `negatives` (số tiền, thời gian, mã đơn…) không bị nhận nhầm. Hai bản mẫu nhận diện được giữ
 * riêng (bundle client không kéo domain/node) nhưng bị khoá chung một fixture để không lệch nhau.
 */
interface Sample {
  id: string;
  kind: string;
  value?: string;
  parts?: string[];
  prefix?: string;
  scopes: string[];
}
const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../scripts/fixtures/pii-samples.json"), "utf8"),
) as { samples: Sample[]; negatives: string[] };
const text = (s: Sample) => `${s.prefix ?? ""}${s.value ?? (s.parts ?? []).join("")}`;
const samples = fixture.samples.filter((s) => s.scopes.includes("storefront"));

beforeEach(() => {
  window.dataLayer = [];
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetAnalyticsForTests();
});

describe("analytics: bộ mẫu PII dùng chung", () => {
  it("fixture có đủ loại PII mà storefront phải chặn", () => {
    const kinds = new Set(samples.map((s) => s.kind));
    for (const k of ["email", "phone", "address", "cccd", "cmnd"]) expect(kinds).toContain(k);
    expect(samples.length).toBeGreaterThanOrEqual(20);
  });

  it.each(samples.map((s) => [s.id, s] as const))("%s: looksLikePii", (_id, s) => {
    expect(looksLikePii(text(s))).toBe(true);
  });

  it.each(samples.map((s) => [s.id, s] as const))("%s: findPii ở giá trị, khoá, lồng, mảng", (_id, s) => {
    const v = text(s);
    expect(findPii(v)).toBe("$");
    expect(findPii({ note: v })).toBe("$.note");
    expect(findPii({ [v]: 1 })).toBe(`$.${v}`);
    expect(findPii({ a: { b: [1, { c: v }] } })).toBe("$.a.b[1].c");
    expect(findPii([v])).toBe("$[0]");
    expect(findPii({ note: `giao tới: ${v} nhé` })).toBe("$.note");
  });

  it.each(samples.map((s) => [s.id, s] as const))("%s: track() bỏ sự kiện, không vào dataLayer", (_id, s) => {
    expect(track({ event: "add_to_cart", list_id: text(s) })).toBe(false);
    expect(track({ event: "view_item", items: [{ item_id: "ao-so-mi", sku: text(s) }] })).toBe(false);
    expect(window.dataLayer).toEqual([]);
  });

  it.each(samples.map((s) => [s.id, s] as const))(
    "%s: validateEvent (server) chặn kể cả trường lạ",
    (_id, s) => {
      const base = { v: 1, event: "add_to_cart", currency: "VND" };
      expect(validateEvent({ ...base, list_id: text(s) })).toMatchObject({ ok: false, reason: "pii" });
      expect(validateEvent({ ...base, ghi_chu: text(s) })).toMatchObject({
        ok: false,
        reason: "pii",
        path: "$.ghi_chu",
      });
    },
  );

  it.each(fixture.negatives.map((n) => [n]))("không nhận nhầm %j", (n) => {
    expect(looksLikePii(n)).toBe(false);
    expect(findPii({ note: n, list: [n] })).toBeNull();
  });
});

describe("NFKC: NBSP và toàn chiều rộng (D-112)", () => {
  it.each([
    "0912\u00a0345\u00a0678",
    "\uff10\uff19\uff11\uff12\uff13\uff14\uff15\uff16\uff17\uff18",
    "a.b\uff20example.test",
  ])("nhận %j", (v) => {
    expect(looksLikePii(v)).toBe(true);
  });
  it("ký tự nở khi chuẩn hoá không làm chậm (CPU < 50 ms)", () => {
    const input = "\ufdfa".repeat(32_000);
    const t0 = process.cpuUsage();
    looksLikePii(input);
    const d = process.cpuUsage(t0);
    expect((d.user + d.system) / 1000).toBeLessThan(50);
  });
});

describe("chuẩn hoá NFC (D-112)", () => {
  it.each(["Phường Dịch Vọng, Quận Cầu Giấy", "chứng minh nhân dân số 271234567", "Số 5 ngõ 12 Láng Hạ"])(
    "dạng tách dấu của %j được nhận như dạng NFC",
    (v) => {
      expect(looksLikePii(v.normalize("NFD"))).toBe(true);
      expect(findPii({ k: v.normalize("NFD") })).toBe("$.k");
    },
  );
  it("chuỗi rỗng không phải PII", () => {
    expect(looksLikePii("")).toBe(false);
  });
});

describe("CMND 9 số: nhận diện khi có từ khoá, không nhận số tiền (D-066)", () => {
  it.each([
    "CMND 012345678",
    "cmnd: 271234567",
    "CMT 123456789",
    "chứng minh nhân dân số 271234567",
    "chung minh thu 271234567",
    "CMND 271-234-567",
    "cmt số 123456789",
    "CMT #123456789",
  ])("nhận %j", (v) => {
    expect(looksLikePii(v)).toBe(true);
  });

  it.each([
    "tổng tiền 123456789 đ",
    "amount 271234567",
    "CMND không hợp lệ",
    "CMND 12345",
    "CMND 1234567890123",
    "chứng minh được lỗi ở đơn 123456789",
    "[cmt] refund 250000000 VND",
    "cmtx 123456789",
  ])("không nhận %j", (v) => {
    expect(looksLikePii(v)).toBe(false);
  });

  it("giá trị tiền hợp lệ của track() (số nguyên 9 chữ số) vẫn đi qua", () => {
    expect(track({ event: "add_to_cart", value: 123456789 })).toBe(true);
    expect(window.dataLayer).toHaveLength(1);
  });
});

/** Ngân sách ReDoS cho luật mới: đo CPU time (như phía backend). */
describe("looksLikePii: đầu vào đối nghịch (CPU < 50 ms / 32K ký tự)", () => {
  const N = 32_000;
  const cases: [string, string][] = [
    ["CMND lặp", "CMND ".repeat(N / 5)],
    ["CMND + khoảng trắng dài", `CMND${" ".repeat(N)}1`],
    ["CMND + số dài", `CMND ${"1".repeat(N)}`],
    ["CMND + số tách nhóm", `CMND ${"1 ".repeat(N / 2)}`],
    ["chứng minh nhân dân lặp", "chứng minh nhân dân ".repeat(N / 20)],
    ["chung minh lặp", "chung minh ".repeat(N / 11)],
    // Mẫu có từ trước T-136 nhưng chưa có ca đối nghịch: bản cũ bậc hai (550 ms CPU với 32K ký tự).
    ["email: chữ không @", "a".repeat(N)],
    ["email: nhiều @ không tên miền", "a@".repeat(N / 2)],
    ["email: tên miền dài không TLD", `a@${"b".repeat(N)}`],
    ["email: chấm lặp", `${"a.".repeat(N / 2)}@`],
    ["NFD: dấu kết hợp lặp", `a${"\u0301".repeat(N)}`],
    ["số dài", "1".repeat(N)],
    ["số/số lặp", "1/".repeat(N / 2)],
    ["số + khoảng trắng + phẩy", `1${" ".repeat(N)},`],
    ["số tách nhóm", "0 ".repeat(N / 2)],
    ["địa chỉ: phẩy lặp", "1,".repeat(N / 2)],
    ["SĐT/CCCD: số tách chấm", "0.".repeat(N / 2)],
  ];
  it.each(cases)("%s", (_name, input) => {
    looksLikePii(input.slice(0, 100));
    const t0 = process.cpuUsage();
    looksLikePii(input);
    findPii({ a: input });
    const d = process.cpuUsage(t0);
    expect((d.user + d.system) / 1000).toBeLessThan(50);
  });
});
