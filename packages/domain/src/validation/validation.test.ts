import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { listWards, normalizeVnPhone, validateAddress } from "../address/address.js";
import {
  CHECKOUT_FORM_FIELDS,
  CHECKOUT_MESSAGES as M,
  addressLineSchema,
  cartVersionSchema,
  charLength,
  checkoutAddressFormSchema,
  checkoutFieldIssues,
  checkoutFormFieldOf,
  checkoutFormSchema,
  checkoutQuoteInputSchema,
  checkoutQuoteRequestSchema,
  checkoutSubmitInputSchema,
  checkoutSubmitRequestSchema,
  contactNameSchema,
  discountCodeSchema,
  normalizePhone,
  normalizeText,
  optionalEmailSchema,
  parseCheckoutForm,
  parseCheckoutRequest,
  paymentMethodSchema,
  vnPhoneSchema,
} from "./index.js";

const WARD = listWards("01")[0]!;
const ADDRESS = { province_code: "01", ward_code: WARD.code, line: "12 Phố Huế" };
const CONTACT = { name: "Nguyễn Văn An", phone: "0912 345 678", email: "An@Example.Test" };
const QUOTE = { cart_id: "cart_01", payment_method: "cod", address: ADDRESS };
const SUBMIT = {
  cart_id: "cart_01",
  cart_version: 1,
  quote_id: "cqt_01",
  payment_method: "vnpay",
  contact: CONTACT,
  address: ADDRESS,
};
const FORM_ADDRESS = { provinceCode: "01", wardCode: WARD.code, line: "12 Phố Huế" };
const FORM_CONTACT = { name: "An", phone: "0912345678", email: "" };

/**
 * Mọi chỗ nạp module trong mã nguồn: `… from "x"` (import/export, kể cả `import type`), `import "x"` (không tên),
 * `import("x")` động, `require("x")`. Bắt thừa (vd chuỗi trong chú thích) chỉ làm test đỏ — an toàn.
 */
const SPEC_RE =
  /(?:\bfrom\s*|\bimport\s*(?:\(\s*(?:\/\*[\s\S]*?\*\/\s*)*)?|\brequire\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)*)["'`]([^"'`]+)["'`]/g;
const importSpecs = (src: string): string[] => [...src.matchAll(SPEC_RE)].map((m) => m[1]!);

describe("validation: subpath thuần (không kéo phần khác của domain vào bundle client)", () => {
  it("bộ trích import bắt đủ: from, import không tên, import() động, require(), export * from", () => {
    expect(
      importSpecs(
        'import "../money/index.js";\nconst a = await import("node:fs");\nconst b = require(\'../ledger\');\n' +
          'export * from "./x.js";\nimport type { T } from "y";\nimport * as z from "zod/mini";\n' +
          "const c = import(`../state/index.js`);\n" +
          'const d = import(/* webpackChunkName: "p" */ "../pricing/index.js");',
      ),
    ).toEqual([
      "../money/index.js",
      "node:fs",
      "../ledger",
      "./x.js",
      "y",
      "zod/mini",
      "../state/index.js",
      "../pricing/index.js",
    ]);
  });

  it("mọi file nguồn chỉ import trong thư mục validation/ và `zod/mini`", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.sort()).toEqual(["checkout.ts", "index.ts", "payment-methods.ts", "phone.ts", "text.ts"]);
    // Hằng phương thức thanh toán dùng ở entry client riêng (telemetry): không import gì, kể cả zod.
    expect(importSpecs(readFileSync(`${dir}payment-methods.ts`, "utf8"))).toEqual([]);
    const specs = files.flatMap((f) => importSpecs(readFileSync(`${dir}${f}`, "utf8")));
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((s) => !(s === "zod/mini" || /^\.\/[\w-]+\.js$/.test(s)))).toEqual([]);
  });

  it("package.json khai subpath ./validation trỏ đúng index (nguồn + dist)", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as {
      exports: Record<string, Record<string, string>>;
      dependencies: Record<string, string>;
    };
    expect(pkg.exports["./validation"]).toEqual({
      "@x-shop/source": "./src/validation/index.ts",
      types: "./dist/validation/index.d.ts",
      default: "./dist/validation/index.js",
    });
    expect(pkg.dependencies.zod).toBeDefined();
  });
});

describe("validation: chuẩn hoá chữ và SĐT", () => {
  it.each([
    ["0912345678", "0912345678"],
    ["+84912345678", "0912345678"],
    ["0912 345 678", "0912345678"],
    ["091.234.5678", "0912345678"],
    ["(0912)345-678", "0912345678"],
    ["0212345678", null],
    ["123", null],
    ["", null],
    ["09123456789", null],
    ["+8412345", null],
    ["０９１２３４５６７８", null],
  ])("normalizePhone(%p) = %p, khớp normalizeVnPhone", (raw, want) => {
    expect(normalizePhone(raw)).toBe(want);
    const d = normalizeVnPhone(raw);
    expect(d.ok ? d.value : null).toBe(want);
  });

  it("thuộc tính: đầu ra chuẩn hoá là 0 + 9 số và chuẩn hoá lại không đổi", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^(0|\+84)[35789]\d{8}$/), (raw) => {
        const n = normalizePhone(raw);
        expect(n).toMatch(/^0[35789]\d{8}$/);
        expect(normalizePhone(n!)).toBe(n);
      }),
    );
  });

  it("normalizeText: NFC, gọn khoảng trắng; charLength đếm code point", () => {
    expect(normalizeText("  Nguyễn \t  An \n")).toBe("Nguyễn An");
    expect(charLength("😀a")).toBe(2);
    expect("😀a".length).toBe(3);
  });
});

describe("validation: schema theo trường (ca biên)", () => {
  it("họ tên: rỗng/trắng/không phải chuỗi → lỗi; 100 ký tự (kể cả emoji) được, 101 thì không", () => {
    expect(contactNameSchema.safeParse("  An   Bình ").data).toBe("An Bình");
    for (const bad of ["", "   ", null, 5, undefined]) {
      expect(contactNameSchema.safeParse(bad).error?.issues[0]?.message).toBe(M.name);
    }
    expect(contactNameSchema.safeParse("😀".repeat(100)).success).toBe(true);
    expect(contactNameSchema.safeParse("😀".repeat(101)).error?.issues[0]?.message).toBe(M.nameTooLong);
  });

  it("SĐT: đầu ra đã chuẩn hoá; sai/quá dài/không phải chuỗi → lỗi SĐT", () => {
    expect(vnPhoneSchema.safeParse("+84 912 345 678").data).toBe("0912345678");
    for (const bad of ["0212345678", "0".repeat(33), 912345678, null]) {
      expect(vnPhoneSchema.safeParse(bad).error?.issues[0]?.message).toBe(M.phone);
    }
  });

  it("email không bắt buộc: vắng/null/rỗng/trắng → null; có thì chữ thường; sai dạng/quá 254/không phải chuỗi → lỗi", () => {
    for (const none of [undefined, null, "", "   "])
      expect(optionalEmailSchema.safeParse(none).data).toBeNull();
    expect(optionalEmailSchema.safeParse(" An@Example.Test ").data).toBe("an@example.test");
    for (const bad of ["a@b", "a b@c.d", `${"a".repeat(250)}@b.vn`, 5]) {
      expect(optionalEmailSchema.safeParse(bad).error?.issues[0]?.message).toBe(M.email);
    }
  });

  it("địa chỉ: cùng kết quả với validateAddress của server ở các ca cấu trúc", () => {
    for (const line of [
      "12 Phố Huế",
      "ab",
      "  a  b ",
      "a".repeat(200),
      "a".repeat(201),
      "😀😀😀",
      "x".repeat(501),
    ]) {
      const schema = addressLineSchema.safeParse(line);
      const server = validateAddress({ provinceCode: "01", wardCode: WARD.code, line });
      expect({ line: line.slice(0, 8), ok: schema.success }).toEqual({
        line: line.slice(0, 8),
        ok: server.ok,
      });
      if (!schema.success && !server.ok) expect(schema.error.issues[0]?.message).toBe(server.message);
    }
    expect(addressLineSchema.safeParse("  12   Phố  Huế ").data).toBe("12 Phố Huế");
  });

  it("mã giảm giá: vắng/null/rỗng → null; bỏ trắng; > 64 hoặc không phải chuỗi → lỗi mã giảm", () => {
    expect(discountCodeSchema.safeParse(undefined).data).toBeNull();
    expect(discountCodeSchema.safeParse(null).data).toBeNull();
    expect(discountCodeSchema.safeParse("   ").data).toBeNull();
    expect(discountCodeSchema.safeParse(" sale10 ").data).toBe("sale10");
    for (const bad of [5, ["A"], { code: "A" }, "x".repeat(65), true]) {
      expect(discountCodeSchema.safeParse(bad).error?.issues[0]?.message).toBe(M.discount);
    }
  });

  it("phương thức thanh toán và phiên bản giỏ", () => {
    expect(paymentMethodSchema.safeParse("cod").success).toBe(true);
    expect(paymentMethodSchema.safeParse("COD").error?.issues[0]?.message).toBe(M.payment);
    expect(cartVersionSchema.safeParse(1).success).toBe(true);
    expect(cartVersionSchema.safeParse(1_000_000).success).toBe(true);
    for (const bad of [0, -1, 1.5, "1", null, 1_000_001, Number.NaN]) {
      expect(cartVersionSchema.safeParse(bad).error?.issues[0]?.message).toBe(M.cartVersion);
    }
  });
});

describe("validation: giới hạn chiều dài và trường thừa (biên đúng/sai)", () => {
  const quoteFields = (body: unknown) => {
    const r = parseCheckoutRequest(checkoutQuoteRequestSchema, body);
    return r.ok ? [] : r.issues;
  };

  it("địa chỉ là strictObject: trường thừa trong address → lỗi riêng `address.<khoá>`", () => {
    expect(quoteFields({ ...QUOTE, address: { ...ADDRESS, district_code: "001" } })).toEqual([
      { field: "address.district_code", message: M.unknownKey },
    ]);
    const submit = parseCheckoutRequest(checkoutSubmitRequestSchema, {
      ...SUBMIT,
      address: { ...ADDRESS, x: 1 },
      contact: { ...CONTACT, y: 1 },
    });
    expect(submit.ok ? [] : submit.issues.map((i) => i.field)).toEqual(["contact.y", "address.x"]);
  });

  it("dòng địa chỉ thô > 500 ký tự bị chặn TRƯỚC khi chuẩn hoá (dù gọn lại chỉ còn ít ký tự)", () => {
    const padded = (n: number) => `12 Phố Huế${" ".repeat(n - "12 Phố Huế".length)}`;
    expect(addressLineSchema.safeParse(padded(500)).data).toBe("12 Phố Huế");
    expect(addressLineSchema.safeParse(padded(501)).error?.issues[0]?.message).toBe(M.lineTooLong);
    expect(quoteFields({ ...QUOTE, address: { ...ADDRESS, line: padded(501) } })).toEqual([
      { field: "address.line", message: M.lineTooLong },
    ]);
  });

  it("mã tỉnh/xã tối đa 10 ký tự (sau khi bỏ trắng)", () => {
    const ok = quoteFields({ ...QUOTE, address: { ...ADDRESS, province_code: "0".repeat(10) } });
    expect(ok).toEqual([]);
    expect(
      quoteFields({
        ...QUOTE,
        address: { ...ADDRESS, province_code: "0".repeat(11), ward_code: "1".repeat(11) },
      }),
    ).toEqual([
      { field: "address.province_code", message: M.province },
      { field: "address.ward_code", message: M.ward },
    ]);
    expect(quoteFields({ ...QUOTE, address: { ...ADDRESS, ward_code: ` ${WARD.code} ` } })).toEqual([]);
  });

  it("id giỏ/báo giá tối đa 100 ký tự", () => {
    expect(quoteFields({ ...QUOTE, cart_id: "c".repeat(100) })).toEqual([]);
    expect(quoteFields({ ...QUOTE, cart_id: "c".repeat(101) })).toEqual([
      { field: "cart_id", message: M.cartId },
    ]);
    const r = parseCheckoutRequest(checkoutSubmitRequestSchema, { ...SUBMIT, quote_id: "q".repeat(101) });
    expect(r.ok ? [] : r.issues).toEqual([{ field: "quote_id", message: M.quoteId }]);
    const empty = parseCheckoutRequest(checkoutSubmitRequestSchema, { ...SUBMIT, quote_id: "  " });
    expect(empty.ok ? [] : empty.issues).toEqual([{ field: "quote_id", message: M.quoteId }]);
  });
});

describe("validation: thân request backend (wire)", () => {
  it("hợp lệ → dữ liệu đã chuẩn hoá (SĐT, email, tên, địa chỉ); email vắng → null", () => {
    const r = parseCheckoutRequest(checkoutSubmitRequestSchema, SUBMIT);
    expect(r).toEqual({
      ok: true,
      data: {
        ...SUBMIT,
        contact: { name: "Nguyễn Văn An", phone: "0912345678", email: "an@example.test" },
      },
    });
    const noEmail = parseCheckoutRequest(checkoutSubmitRequestSchema, {
      ...SUBMIT,
      contact: { name: "An", phone: "0912345678" },
    });
    expect(noEmail.ok && noEmail.data.contact.email).toBeNull();
    const q = parseCheckoutRequest(checkoutQuoteRequestSchema, { ...QUOTE, discount_code: " SALE " });
    expect(q.ok && q.data.discount_code).toBe("SALE");
  });

  it("nhiều trường sai → mỗi trường một lỗi, theo thứ tự schema; trường thừa → lỗi riêng", () => {
    const r = parseCheckoutRequest(checkoutSubmitRequestSchema, {
      ...SUBMIT,
      cart_version: 0,
      contact: { name: " ", phone: "123", email: "x" },
      address: { province_code: "", ward_code: WARD.code, line: "a" },
      total: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues).toEqual([
      { field: "cart_version", message: M.cartVersion },
      { field: "contact.name", message: M.name },
      { field: "contact.phone", message: M.phone },
      { field: "contact.email", message: M.email },
      { field: "address.province_code", message: M.province },
      { field: "address.line", message: M.line },
      { field: "total", message: M.unknownKey },
    ]);
  });

  it("sai hình dạng: thiếu/null/mảng ở object con, gốc null/chuỗi/mảng → lỗi có field, không ném", () => {
    const fieldsOf = (body: unknown) => {
      const r = parseCheckoutRequest(checkoutSubmitRequestSchema, body);
      return r.ok ? [] : r.issues.map((i) => i.field);
    };
    const { contact: _c, ...noContact } = SUBMIT;
    expect(fieldsOf(noContact)).toEqual(["contact"]);
    expect(fieldsOf({ ...SUBMIT, address: null })).toEqual(["address"]);
    expect(fieldsOf({ ...SUBMIT, address: [ADDRESS] })).toEqual(["address"]);
    expect(fieldsOf({ ...SUBMIT, contact: { ...CONTACT, extra: 1 } })).toEqual(["contact.extra"]);
    expect(fieldsOf(null)[0]).toBe("cart_id");
    expect(fieldsOf("chuỗi")).toEqual(["body"]);
    expect(fieldsOf([SUBMIT])).toEqual(["body"]);
    const q = parseCheckoutRequest(checkoutQuoteRequestSchema, { ...QUOTE, discount_code: 5 });
    expect(q.ok ? null : q.issues).toEqual([{ field: "discount_code", message: M.discount }]);
  });

  it("checkoutFieldIssues: lỗi không có thông điệp → thông điệp chung; danh sách rỗng → [] ", () => {
    expect(checkoutFieldIssues({ issues: [{ code: "custom", path: ["a", 0], message: "" }] })).toEqual([
      { field: "a.0", message: M.invalid },
    ]);
    expect(checkoutFieldIssues({ issues: [] })).toEqual([]);
  });
});

describe("validation: form và đầu vào Server Action (camelCase)", () => {
  it("form phẳng: lỗi gắn đúng ô, ô đầu tiên theo thứ tự DOM; email rỗng hợp lệ", () => {
    const r = parseCheckoutForm(checkoutFormSchema, {
      name: "  ",
      phone: "12",
      email: "a@b",
      provinceCode: "",
      wardCode: "",
      line: "x",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(["email", "line", "name", "phone", "province", "ward"]);
    expect(r.field).toBe("name");
    expect(r.message).toBe(M.name);
    expect(parseCheckoutForm(checkoutFormSchema, { ...FORM_CONTACT, ...FORM_ADDRESS }).ok).toBe(true);
  });

  it.each([
    // Thiếu mọi trường: ô đầu tiên theo thứ tự DOM (tỉnh) trước phương thức thanh toán.
    ["null", null, "province"],
    ["mảng", [], "province"],
    ["chuỗi", "cod", "province"],
    ["chỉ sai phương thức", { paymentMethod: 1, address: FORM_ADDRESS }, "payment"],
    ["thiếu address", { paymentMethod: "cod", discountCode: null }, "province"],
    ["address null", { paymentMethod: "cod", address: null, discountCode: null }, "province"],
    ["address mảng", { paymentMethod: "cod", address: [], discountCode: null }, "province"],
    ["discountCode số", { paymentMethod: "cod", address: FORM_ADDRESS, discountCode: 5 }, "discount"],
    [
      "discountCode object",
      { paymentMethod: "cod", address: FORM_ADDRESS, discountCode: { a: 1 } },
      "discount",
    ],
    ["line không phải chuỗi", { paymentMethod: "cod", address: { ...FORM_ADDRESS, line: 12 } }, "line"],
  ])("quote input sai hình dạng (%s) → lỗi ô %s", (_n, input, field) => {
    const r = parseCheckoutForm(checkoutQuoteInputSchema, input);
    expect(r.ok ? null : r.field).toBe(field);
  });

  it.each([
    ["thiếu contact", { cartVersion: 1, paymentMethod: "cod", address: FORM_ADDRESS }, "name"],
    ["contact null", { cartVersion: 1, paymentMethod: "cod", contact: null, address: FORM_ADDRESS }, "name"],
    [
      "email số",
      { cartVersion: 1, paymentMethod: "cod", contact: { ...FORM_CONTACT, email: 1 }, address: FORM_ADDRESS },
      "email",
    ],
    ["thiếu address", { cartVersion: 1, paymentMethod: "cod", contact: FORM_CONTACT }, "province"],
  ])("submit input sai hình dạng (%s) → lỗi ô %s", (_n, input, field) => {
    const r = parseCheckoutForm(checkoutSubmitInputSchema, input);
    expect(r.ok ? null : r.field).toBe(field);
  });

  it("lỗi không thuộc ô nào (cartVersion) → field vắng, thông điệp của trường đó", () => {
    const r = parseCheckoutForm(checkoutSubmitInputSchema, {
      cartVersion: "1",
      paymentMethod: "cod",
      contact: FORM_CONTACT,
      address: FORM_ADDRESS,
    });
    expect(r).toEqual({ ok: false, errors: {}, field: undefined, message: M.cartVersion });
  });

  it("addressFormSchema là điều kiện báo giá (đủ tỉnh, xã, địa chỉ 3–200 ký tự)", () => {
    expect(checkoutAddressFormSchema.safeParse(FORM_ADDRESS).success).toBe(true);
    expect(checkoutAddressFormSchema.safeParse({ ...FORM_ADDRESS, wardCode: "" }).success).toBe(false);
  });

  it("checkoutFormFieldOf: wire/form/nhóm → ô; khoá lạ và khoá prototype → undefined", () => {
    expect(checkoutFormFieldOf("contact.phone")).toBe("phone");
    expect(checkoutFormFieldOf(["address", "provinceCode"])).toBe("province");
    expect(checkoutFormFieldOf("address")).toBe("province");
    expect(checkoutFormFieldOf("contact")).toBe("name");
    expect(checkoutFormFieldOf("discount_code")).toBe("discount");
    expect(checkoutFormFieldOf("payment_method")).toBe("payment");
    for (const k of [
      "cart_id",
      "Idempotency-Key",
      "quote_id",
      "total",
      "constructor",
      "__proto__",
      "toString",
      "",
    ]) {
      expect(checkoutFormFieldOf(k)).toBeUndefined();
    }
    expect(CHECKOUT_FORM_FIELDS).toEqual([
      "name",
      "phone",
      "email",
      "province",
      "ward",
      "line",
      "discount",
      "payment",
    ]);
  });
});
