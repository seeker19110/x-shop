import { checkoutQuoteRequestSchema, checkoutSubmitRequestSchema } from "@x-shop/domain/validation";
import { z } from "zod";
import { parseCheckoutBody } from "../../checkout/http";
import { AdjustmentBody } from "../../inventory/adjust";
import { DiscrepancyListQuery, ImportQuery } from "../../settlement/http";
import { AdminReturnListQuery, AdminRefundQueueQuery } from "../../../workflows/returns/admin-read";
import {
  DecisionBody,
  ExecuteBody,
  InspectBody,
  ReceiveBody,
  RefundCreateBody,
  ReturnRequestBody,
} from "../../../workflows/returns/http";
import { adminPageQuery, parseStorePage } from "../pagination";
import { readQuery } from "../request-input";

/**
 * BASE-DATA-003 (T-200): bảng ca biên cho trường TUỲ CHỌN ở biên API — mỗi trường thử `vắng`, `null`, `""`, `[]`,
 * `0`/`"0"` và một giá trị hợp lệ. Mục đích: 0 hợp lệ không bị coi là vắng, rỗng không bị coi là 0, `null` (JSON) khác
 * vắng theo đúng hợp đồng của từng trường (ghi ở cột "vì sao"). Query string đi qua `readQuery` như route thật (qs chỉ
 * sinh chuỗi/mảng/object — `null` vẫn thử để chắc schema không ép kiểu ngầm); thân JSON đi qua schema route dùng.
 */

/** Đánh dấu "không gửi trường" (khác `undefined` tường minh chỉ ở chỗ khoá không tồn tại). */
const ABSENT = Symbol("vắng");
type Input = unknown;
/** `{ ok: value }` = chấp nhận với giá trị đầu ra; `"reject"` = 422. */
type Expected = { ok: unknown } | "reject";
type Row = [label: string, input: Input, expected: Expected, why: string];

const withField = (base: Record<string, unknown>, key: string, value: Input) => {
  const out: Record<string, unknown> = { ...base };
  if (value !== ABSENT) out[key] = value;
  return out;
};

/** Chạy bảng: `parse` trả `{ ok: true, data }` hoặc `{ ok: false }`; `pick` lấy trường đang kiểm từ đầu ra. */
function table(
  rows: Row[],
  parse: (input: Input) => { ok: true; data: unknown } | { ok: false },
  pick: (data: unknown) => unknown,
) {
  it.each(rows)("%s (%j) → %j — %s", (_label, input, expected, _why) => {
    const r = parse(input);
    if (expected === "reject") expect(r.ok).toBe(false);
    else {
      expect(r.ok).toBe(true);
      if (r.ok) expect(pick(r.data)).toStrictEqual(expected.ok);
    }
  });
}

const zodParse =
  (schema: z.ZodType, base: Record<string, unknown>, key: string) =>
  (value: Input): { ok: true; data: unknown } | { ok: false } => {
    const r = schema.safeParse(withField(base, key, value));
    return r.success ? { ok: true, data: r.data } : { ok: false };
  };

const queryParse =
  (schema: z.ZodType, base: Record<string, unknown>, key: string) =>
  (value: Input): { ok: true; data: unknown } | { ok: false } => {
    const r = readQuery({ query: withField(base, key, value) }, schema);
    return r.ok ? { ok: true, data: r.data } : { ok: false };
  };

const field = (key: string) => (data: unknown) => (data as Record<string, unknown>)[key];

describe("optional-fields — limit/offset Admin (adminPageQuery qua readQuery)", () => {
  const Q = z.object(adminPageQuery).strict();
  describe("offset", () => {
    table(
      [
        ["vắng", ABSENT, { ok: 0 }, "mặc định 0"],
        ['"0"', "0", { ok: 0 }, "0 là trang đầu hợp lệ"],
        ['"7"', "7", { ok: 7 }, "số nguyên thập phân"],
        ['""', "", "reject", "rỗng không phải 0 (BASE-DATA-003)"],
        ['" "', " ", "reject", "khoảng trắng không phải 0"],
        ["[]", [], "reject", "mảng không phải số"],
        ['["5"]', ["5"], "reject", "?offset[]=5 — mảng, không ép về phần tử đầu"],
        ["null", null, "reject", "null không phải 0"],
        ['"1e2"', "1e2", "reject", "chỉ chữ số thập phân (cùng quy ước Store)"],
        ['"0x10"', "0x10", "reject", "chỉ chữ số thập phân"],
        ['"+5"', "+5", "reject", "chỉ chữ số thập phân"],
        ['"-0"', "-0", "reject", "không dấu"],
      ],
      queryParse(Q, {}, "offset"),
      field("offset"),
    );
  });
  describe("limit", () => {
    table(
      [
        ["vắng", ABSENT, { ok: 50 }, "mặc định 50"],
        ['"0"', "0", "reject", "0 có mặt → vượt khoảng 1–100, KHÔNG thay bằng mặc định"],
        ['"1"', "1", { ok: 1 }, "biên dưới"],
        ['"100"', "100", { ok: 100 }, "biên trên"],
        ['""', "", "reject", "rỗng ≠ vắng"],
        ["[]", [], "reject", "mảng"],
        ['["5"]', ["5"], "reject", "mảng"],
        ["null", null, "reject", "null ≠ vắng"],
        ['"5.0"', "5.0", "reject", "chỉ số nguyên thập phân"],
      ],
      queryParse(Q, {}, "limit"),
      field("limit"),
    );
  });
  it("cùng luật cho mọi danh sách Admin dùng adminPageQuery (returns, hàng đợi hoàn, chênh lệch đối soát)", () => {
    for (const [schema, base] of [
      [AdminReturnListQuery, {}],
      [AdminRefundQueueQuery, { state: "requested" }],
      [DiscrepancyListQuery, {}],
    ] as const) {
      expect(readQuery({ query: { ...base, offset: "" } }, schema).ok).toBe(false);
      expect(readQuery({ query: { ...base, offset: "0", limit: "1" } }, schema)).toMatchObject({
        ok: true,
        data: { offset: 0, limit: 1 },
      });
    }
  });
});

describe("optional-fields — limit/offset Store (parseStorePage)", () => {
  const OPTS = { limitDefault: 24, limitMax: 48, offsetMax: 1000 };
  const parse = (key: string) => (value: Input) => {
    const r = parseStorePage(withField({}, key, value), OPTS);
    return r.errors.length === 0 ? { ok: true as const, data: r.page } : { ok: false as const };
  };
  describe("offset", () => {
    table(
      [
        ["vắng", ABSENT, { ok: 0 }, "mặc định 0"],
        ['"0"', "0", { ok: 0 }, "0 hợp lệ"],
        ['""', "", "reject", "rỗng ≠ 0"],
        ["[]", [], "reject", "mảng"],
        ["null", null, "reject", "null ≠ vắng"],
      ],
      parse("offset"),
      field("offset"),
    );
  });
  describe("limit", () => {
    table(
      [
        ["vắng", ABSENT, { ok: 24 }, "mặc định"],
        ['"0"', "0", "reject", "0 có mặt → lỗi, không thay bằng mặc định"],
        ['"49"', "49", { ok: 48 }, "Store kẹp về trần"],
        ['""', "", "reject", "rỗng ≠ vắng"],
        ["[]", [], "reject", "mảng"],
        ["null", null, "reject", "null ≠ vắng"],
      ],
      parse("limit"),
      field("limit"),
    );
  });
});

describe("optional-fields — bộ lọc tuỳ chọn của danh sách Admin", () => {
  // Client Admin (admin/lib/api.ts buildQuery) bỏ tham số rỗng; server coi `order_id=` là sai chứ không phải "không lọc".
  describe("AdminReturnListQuery.order_id", () => {
    table(
      [
        ["vắng", ABSENT, { ok: undefined }, "không lọc"],
        ['"order_1"', "order_1", { ok: "order_1" }, "lọc theo đơn"],
        ['" order_1 "', " order_1 ", { ok: "order_1" }, "bỏ khoảng trắng đầu/cuối"],
        ['""', "", "reject", "rỗng ≠ không lọc"],
        ['"   "', "   ", "reject", "toàn khoảng trắng = rỗng"],
        ["[]", [], "reject", "mảng"],
        ['["a","b"]', ["a", "b"], "reject", "?order_id=a&order_id=b"],
        ["null", null, "reject", "null"],
      ],
      queryParse(AdminReturnListQuery, {}, "order_id"),
      field("order_id"),
    );
  });
  describe("ImportQuery.external_ref (mã batch đối soát)", () => {
    table(
      [
        ["vắng", ABSENT, { ok: undefined }, "không có mã batch"],
        ['"0"', "0", { ok: "0" }, '"0" là mã hợp lệ, không bị coi là vắng'],
        ['""', "", "reject", "rỗng ≠ vắng"],
        ["[]", [], "reject", "mảng"],
        ["null", null, "reject", "null"],
      ],
      queryParse(ImportQuery, { source: "vnpay" }, "external_ref"),
      field("external_ref"),
    );
  });
});

/** Thân checkout hợp lệ tối thiểu (schema; không chạm CSDL). */
const ADDRESS = { province_code: "01", ward_code: "00004", line: "12 Ngõ 34 Phố Huế" };
const checkoutParse =
  (
    schema: typeof checkoutQuoteRequestSchema | typeof checkoutSubmitRequestSchema,
    body: (v: Input) => unknown,
  ) =>
  (value: Input): { ok: true; data: unknown } | { ok: false } => {
    try {
      return { ok: true, data: parseCheckoutBody(schema, body(value)) };
    } catch {
      return { ok: false };
    }
  };

describe("optional-fields — discount_code (POST /store/x/checkout/quote)", () => {
  const base = { cart_id: "cart_1", payment_method: "cod", address: ADDRESS };
  table(
    [
      ["vắng", ABSENT, { ok: null }, "không mã"],
      ["null", null, { ok: null }, "null = không mã (nullish)"],
      ['""', "", { ok: null }, "ô mã để trống = không mã"],
      ['"   "', "   ", { ok: null }, "toàn khoảng trắng = không mã"],
      ['"0"', "0", { ok: "0" }, '"0" là mã, không bị coi là vắng'],
      ['" SALE10 "', " SALE10 ", { ok: "SALE10" }, "bỏ khoảng trắng đầu/cuối"],
      ["[]", [], "reject", "mảng"],
      ["0", 0, "reject", "số không phải mã"],
      ["false", false, "reject", "boolean không phải mã"],
      ["65 ký tự", "A".repeat(65), "reject", "quá 64 ký tự"],
    ],
    checkoutParse(checkoutQuoteRequestSchema, (v) => withField(base, "discount_code", v)),
    field("discount_code"),
  );
});

describe("optional-fields — contact.email (POST /store/x/checkout/submit)", () => {
  const body = (email: Input) => ({
    cart_id: "cart_1",
    cart_version: 1,
    quote_id: "quote_1",
    payment_method: "cod",
    contact: withField({ name: "Nguyễn Văn A", phone: "0912345678" }, "email", email),
    address: ADDRESS,
  });
  table(
    [
      ["vắng", ABSENT, { ok: null }, "email không bắt buộc"],
      ["null", null, { ok: null }, "null = không email"],
      ['""', "", { ok: null }, "ô email để trống = không email"],
      ['"  "', "  ", { ok: null }, "toàn khoảng trắng = không email"],
      ['" A@B.VN "', " A@B.VN ", { ok: "a@b.vn" }, "chuẩn hoá chữ thường, bỏ khoảng trắng"],
      ['"0"', "0", "reject", "có giá trị thì phải đúng dạng email"],
      ["[]", [], "reject", "mảng"],
      ["0", 0, "reject", "số"],
    ],
    checkoutParse(checkoutSubmitRequestSchema, body),
    (data) => (data as { contact: { email: unknown } }).contact.email,
  );
});

/**
 * Ghi chú tự do: `.optional()` không `.nullable()` — vắng → undefined (route lưu null bằng `?? null`), `""` giữ nguyên là
 * chuỗi rỗng (đã gửi nhưng trống — khác vắng), `null` bị từ chối (client bỏ trường thay vì gửi null).
 */
const NOTE_ROWS: Row[] = [
  ["vắng", ABSENT, { ok: undefined }, "không ghi chú"],
  ['""', "", { ok: "" }, "đã gửi nhưng trống — giữ nguyên, khác vắng"],
  ['"   "', "   ", { ok: "" }, "trim → rỗng"],
  ['"0"', "0", { ok: "0" }, '"0" là nội dung, không bị coi là vắng'],
  ['" ok "', " ok ", { ok: "ok" }, "trim"],
  ["null", null, "reject", "không nullable"],
  ["[]", [], "reject", "mảng"],
  ["0", 0, "reject", "số"],
];

describe("optional-fields — note", () => {
  describe("ReturnRequestBody.note (khách/CSKH tạo yêu cầu đổi/trả)", () => {
    table(
      NOTE_ROWS,
      zodParse(
        ReturnRequestBody,
        { kind: "return", reason: "changed_mind", lines: [{ line_id: "l1", quantity: 1 }] },
        "note",
      ),
      field("note"),
    );
  });
  describe("DecisionBody.note (duyệt yêu cầu)", () => {
    table(NOTE_ROWS, zodParse(DecisionBody, {}, "note"), field("note"));
  });
  describe("AdjustmentBody.note (điều chỉnh tồn)", () => {
    table(
      NOTE_ROWS,
      zodParse(
        AdjustmentBody,
        { inventory_item_id: "ii_1", location_id: "sloc_1", delta: 1, reason: "receiving" },
        "note",
      ),
      field("note"),
    );
  });
  describe("RefundCreateBody.note với reason=other (ghi chú BẮT BUỘC có nội dung)", () => {
    table(
      [
        ["vắng", ABSENT, "reject", "cần ghi chú lý do"],
        ['""', "", "reject", "rỗng = thiếu ghi chú"],
        ['"   "', "   ", "reject", "trim → rỗng = thiếu"],
        ['"0"', "0", { ok: "0" }, '"0" là nội dung'],
        ["null", null, "reject", "không nullable"],
      ],
      zodParse(RefundCreateBody, { order_id: "order_1", reason: "other", amount: 1000 }, "note"),
      field("note"),
    );
  });
});

describe("optional-fields — số tuỳ chọn và danh sách tuỳ chọn", () => {
  describe("RefundCreateBody.amount (reason=other; reason=cancellation thì vắng = server tính)", () => {
    table(
      [
        ["vắng", ABSENT, "reject", "bắt buộc với reason=other"],
        ["0", 0, "reject", "hoàn 0 đồng vô nghĩa — dương"],
        ["1", 1, { ok: 1 }, "biên dưới"],
        ['"1000"', "1000", "reject", "thân JSON: không ép chuỗi thành số"],
        ["null", null, "reject", "null ≠ vắng"],
        ["1.5", 1.5, "reject", "tiền là số nguyên VND"],
      ],
      zodParse(RefundCreateBody, { order_id: "order_1", reason: "other", note: "chuyển nhầm" }, "amount"),
      field("amount"),
    );
    it("reason=cancellation: vắng → undefined (server tính), 0 vẫn bị từ chối", () => {
      const base = { order_id: "order_1", reason: "cancellation" };
      const parsed = RefundCreateBody.safeParse(base);
      expect(parsed.success).toBe(true);
      expect(parsed.data?.amount).toBeUndefined();
      expect(RefundCreateBody.safeParse({ ...base, amount: 0 }).success).toBe(false);
    });
  });
  describe("ReceiveBody.lines (vắng = nhận đủ; [] khác vắng)", () => {
    table(
      [
        ["vắng", ABSENT, { ok: undefined }, "nhận đủ mọi dòng"],
        ["[]", [], "reject", "danh sách rỗng ≠ vắng"],
        ["null", null, "reject", "null ≠ vắng"],
        [
          "quantity 0",
          [{ line_id: "l1", quantity: 0 }],
          { ok: [{ line_id: "l1", quantity: 0 }] },
          "nhận 0 hợp lệ",
        ],
      ],
      zodParse(ReceiveBody, {}, "lines"),
      field("lines"),
    );
  });
  it("InspectBody: restock_quantity/damaged_quantity = 0 hợp lệ (không bị coi là thiếu)", () => {
    const line = { line_id: "l1", restock_quantity: 0, damaged_quantity: 0 };
    expect(InspectBody.safeParse({ lines: [line] })).toMatchObject({
      success: true,
      data: { lines: [line] },
    });
    expect(InspectBody.safeParse({ lines: [{ line_id: "l1", restock_quantity: 0 }] }).success).toBe(false);
  });
  describe("ExecuteBody.evidence_ref (chứng từ hoàn tay)", () => {
    table(
      [
        ["vắng", ABSENT, { ok: undefined }, "không chứng từ"],
        ['""', "", "reject", "rỗng ≠ vắng — client bỏ trường"],
        ["null", null, "reject", "null ≠ vắng"],
        ['"UNC-001"', "UNC-001", { ok: "UNC-001" }, "mã chứng từ"],
      ],
      zodParse(ExecuteBody, {}, "evidence_ref"),
      field("evidence_ref"),
    );
  });
});
