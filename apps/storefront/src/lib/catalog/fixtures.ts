import type {
  ColorOption,
  ModelMeasurement,
  ProductAttributes,
  ProductDetail,
  ProductImage,
  ProductVariant,
  SizeChart,
  SizeOption,
} from "./types";

/**
 * Bộ dữ liệu demo thời trang (nguồn `XS_DATA_SOURCE=fixtures`): shape giống API-CONTRACT, ảnh SVG cục bộ ở
 * `public/demo/`. Cố ý chứa các ca biên của catalog — xem chú thích từng sản phẩm. KHÔNG phải dữ liệu thương hiệu thật.
 */

export const COLORS = {
  den: { value: "den", label: "Đen", hex: "#1a1a1a" },
  trang: { value: "trang", label: "Trắng", hex: "#f4f1eb" },
  be: { value: "be", label: "Be", hex: "#d6bf9b" },
  "xanh-navy": { value: "xanh-navy", label: "Xanh navy", hex: "#26344f" },
  "do-do": { value: "do-do", label: "Đỏ đô", hex: "#9c2f35" },
} as const satisfies Record<string, ColorOption>;

type ColorKey = keyof typeof COLORS;
type Shape = "top" | "pants" | "dress" | "bag";

export const FIXTURE_CATEGORIES = [
  { handle: "ao", name: "Áo" },
  { handle: "quan", name: "Quần" },
  { handle: "vay", name: "Váy và đầm" },
  { handle: "phu-kien", name: "Phụ kiện" },
] as const;

const VIEWS = [
  { key: "front", label: "mặt trước" },
  { key: "back", label: "mặt sau" },
  { key: "detail", label: "chi tiết chất liệu" },
] as const;

const SIZE_LABELS: Record<string, string> = { s: "S", m: "M", l: "L", xl: "XL", free: "Free" };

interface Spec {
  handle: string;
  title: string;
  description: string;
  category: (typeof FIXTURE_CATEGORIES)[number]["handle"];
  shape: Shape;
  code: string;
  colors: ColorKey[];
  sizes: string[];
  price: number;
  compareAt?: number;
  attributes: Partial<ProductAttributes> & { material: string };
  /** Ghi đè từng biến thể theo "màu-size". */
  overrides?: Record<string, Partial<Pick<ProductVariant, "price" | "compare_at" | "in_stock">>>;
  /** Chỉ tạo các cặp "màu-size" liệt kê (mặc định: đủ tích Descartes). */
  only?: string[];
  soldOut?: boolean;
  model?: ColorKey[];
}

const FIT_ROWS: Record<string, [string, string]> = {
  s: ["84", "64"],
  m: ["88", "66"],
  l: ["92", "68"],
  xl: ["96", "70"],
  free: ["—", "—"],
};

function buildChart(spec: Spec): SizeChart | null {
  if (spec.shape === "bag") return null;
  const columns =
    spec.shape === "pants"
      ? ["Size", "Vòng eo", "Dài quần"]
      : spec.shape === "dress"
        ? ["Size", "Ngực", "Dài váy"]
        : ["Size", "Ngực", "Dài áo"];
  const rows = spec.sizes.map((s) => {
    const [a, b] = FIT_ROWS[s] ?? ["—", "—"];
    return [SIZE_LABELS[s] ?? s.toUpperCase(), a, b];
  });
  return { version: 1, unit: "cm", columns, rows };
}

function build(spec: Spec, index: number): ProductDetail {
  const colors = spec.colors.map((c) => COLORS[c]);
  const sizes: SizeOption[] = spec.sizes.map((s) => ({ value: s, label: SIZE_LABELS[s] ?? s.toUpperCase() }));
  const variants: ProductVariant[] = [];
  for (const c of spec.colors) {
    for (const s of spec.sizes) {
      const key = `${c}-${s}`;
      if (spec.only && !spec.only.includes(key)) continue;
      const o = spec.overrides?.[key] ?? {};
      variants.push({
        variant_id: `variant_${spec.code}_${c}_${s}`.toLowerCase(),
        sku: `${spec.code}-${c}-${s}`.toUpperCase(),
        color: c,
        size: s,
        price: o.price ?? spec.price,
        compare_at: o.compare_at !== undefined ? o.compare_at : (spec.compareAt ?? null),
        in_stock: spec.soldOut ? false : (o.in_stock ?? true),
      });
    }
  }
  const images: ProductImage[] = spec.colors.flatMap((c) =>
    VIEWS.map((v) => ({
      url: `/demo/${spec.shape}-${c}-${v.key}.svg`,
      alt: `${spec.title} màu ${COLORS[c].label}, ${v.label}`,
      color: c,
      width: 1600,
      height: 2000,
    })),
  );
  const model: ModelMeasurement[] = (spec.model ?? []).map((c) => ({
    image_set: c,
    height_cm: 168,
    bust_cm: spec.shape === "pants" || spec.shape === "bag" ? null : 82,
    wearing_size: "S",
  }));
  return {
    product_id: `prod_${spec.code}`.toLowerCase(),
    handle: spec.handle,
    title: spec.title,
    description: spec.description,
    kind: spec.shape === "bag" ? "accessory" : "apparel",
    attributes: {
      material: spec.attributes.material,
      composition: spec.attributes.composition ?? null,
      stretch: spec.attributes.stretch ?? null,
      fit: spec.attributes.fit ?? null,
      care: spec.attributes.care ?? "Giặt nhẹ ở nhiệt độ thường, không tẩy.",
      origin: spec.attributes.origin ?? "Việt Nam",
    },
    category: FIXTURE_CATEGORIES.find((c) => c.handle === spec.category)!,
    options: { color: colors, size: sizes },
    variants,
    images,
    size_chart: buildChart(spec),
    model_measurements: model,
    // Giảm dần theo thứ tự khai báo: sản phẩm đứng trước = mới hơn.
    updated_at: new Date(Date.UTC(2026, 9, 24 - index, 9, 0, 0)).toISOString().replace(".000Z", "Z"),
  };
}

const SPECS: Spec[] = [
  {
    // AT01/AT02: chỉ có đen-S và trắng-M — đổi từ đen (S) sang trắng thì size S không tồn tại.
    handle: "ao-so-mi-lua",
    title: "Áo sơ mi lụa",
    description: "Áo sơ mi lụa dáng suông, cổ đứng, cài khuy ngọc trai. Chất lụa mềm, rủ nhẹ.",
    category: "ao",
    shape: "top",
    code: "sml",
    colors: ["den", "trang"],
    sizes: ["s", "m"],
    only: ["den-s", "trang-m"],
    price: 700000,
    attributes: {
      material: "Lụa",
      composition: "100% lụa tơ tằm",
      fit: "Suông",
      care: "Giặt tay, phơi bóng râm.",
    },
    model: ["den"],
  },
  {
    // AT31: đen-M 700.000, trắng-S 300.000 — giá lọc/hiển thị phải theo SKU khớp.
    handle: "ao-khoac-kaki-mong",
    title: "Áo khoác kaki mỏng",
    description: "Áo khoác kaki mỏng, hai túi hộp, lót nửa thân.",
    category: "ao",
    shape: "top",
    code: "kkm",
    colors: ["den", "trang"],
    sizes: ["s", "m"],
    only: ["den-m", "trang-s"],
    overrides: { "trang-s": { price: 300000 } },
    price: 700000,
    attributes: {
      material: "Cotton",
      composition: "98% cotton, 2% spandex",
      stretch: "Co giãn nhẹ",
      fit: "Regular",
    },
  },
  {
    handle: "ao-so-mi-oxford",
    title: "Áo sơ mi Oxford",
    description: "Sơ mi Oxford cotton dày vừa, cổ button-down.",
    category: "ao",
    shape: "top",
    code: "oxf",
    colors: ["den", "trang", "xanh-navy"],
    sizes: ["s", "m", "l"],
    overrides: { "xanh-navy-l": { in_stock: false } },
    price: 520000,
    attributes: { material: "Cotton", composition: "100% cotton Oxford", fit: "Regular" },
    model: ["trang"],
  },
  {
    // Giảm giá hợp lệ trên mọi biến thể.
    handle: "ao-thun-cotton-co-tron",
    title: "Áo thun cotton cổ tròn",
    description: "Áo thun cotton 220gsm, cổ tròn bo gân.",
    category: "ao",
    shape: "top",
    code: "tct",
    colors: ["den", "trang", "be", "do-do"],
    sizes: ["s", "m", "l", "xl"],
    price: 290000,
    compareAt: 390000,
    attributes: {
      material: "Cotton",
      composition: "100% cotton chải kỹ",
      stretch: "Co giãn 4 chiều nhẹ",
      fit: "Regular",
    },
    model: ["den", "trang"],
  },
  {
    handle: "ao-len-co-tron",
    title: "Áo len cổ tròn",
    description: "Áo len mỏng, mặc được quanh năm ở phòng điều hòa.",
    category: "ao",
    shape: "top",
    code: "lct",
    colors: ["be", "do-do"],
    sizes: ["s", "m", "l"],
    price: 650000,
    attributes: {
      material: "Len",
      composition: "50% len merino, 50% acrylic",
      fit: "Regular",
      care: "Giặt tay lạnh, phơi ngang.",
    },
  },
  {
    // Khoảng giá: size L, XL đắt hơn → "Từ 350.000 ₫".
    handle: "ao-polo-pique",
    title: "Áo polo pique",
    description: "Polo pique cổ dệt, hai khuy.",
    category: "ao",
    shape: "top",
    code: "pol",
    colors: ["den", "trang", "xanh-navy"],
    sizes: ["s", "m", "l", "xl"],
    overrides: {
      "den-l": { price: 380000 },
      "den-xl": { price: 380000 },
      "trang-l": { price: 380000 },
      "trang-xl": { price: 380000 },
      "xanh-navy-l": { price: 380000 },
      "xanh-navy-xl": { price: 380000 },
    },
    price: 350000,
    attributes: { material: "Cotton", composition: "100% cotton pique", fit: "Regular" },
  },
  {
    // Hết hàng toàn bộ: trang vẫn tồn tại, CTA "Hết hàng".
    handle: "quan-tay-ong-dung",
    title: "Quần tây ống đứng",
    description: "Quần tây ống đứng, lưng cao, xếp ly trước.",
    category: "quan",
    shape: "pants",
    code: "qtd",
    colors: ["den", "xanh-navy"],
    sizes: ["s", "m", "l"],
    soldOut: true,
    price: 560000,
    attributes: { material: "Polyester", composition: "70% polyester, 30% viscose", fit: "Ống đứng" },
  },
  {
    handle: "quan-jean-ong-suong",
    title: "Quần jean ống suông",
    description: "Quần jean denim 11oz, ống suông, lưng cao.",
    category: "quan",
    shape: "pants",
    code: "jos",
    colors: ["den", "xanh-navy"],
    sizes: ["s", "m", "l"],
    price: 690000,
    attributes: { material: "Denim", composition: "100% cotton denim", fit: "Ống suông" },
  },
  {
    handle: "quan-short-linen",
    title: "Quần short linen",
    description: "Quần short linen lưng thun, hai túi.",
    category: "quan",
    shape: "pants",
    code: "sli",
    colors: ["be", "trang"],
    sizes: ["s", "m", "l"],
    price: 450000,
    attributes: { material: "Linen", composition: "55% linen, 45% cotton", fit: "Rộng thoải mái" },
  },
  {
    handle: "quan-kaki-slim",
    title: "Quần kaki slim",
    description: "Quần kaki ống slim, co giãn nhẹ.",
    category: "quan",
    shape: "pants",
    code: "ksl",
    colors: ["be", "den", "xanh-navy"],
    sizes: ["s", "m", "l", "xl"],
    price: 480000,
    compareAt: 600000,
    attributes: {
      material: "Cotton",
      composition: "97% cotton, 3% spandex",
      stretch: "Co giãn nhẹ",
      fit: "Slim",
    },
  },
  {
    handle: "vay-midi-lua",
    title: "Váy midi lụa",
    description: "Váy midi lụa cắt chéo, dài qua gối.",
    category: "vay",
    shape: "dress",
    code: "vml",
    colors: ["do-do", "den"],
    sizes: ["s", "m"],
    price: 1250000,
    attributes: { material: "Lụa", composition: "100% lụa tơ tằm", fit: "A-line", care: "Giặt khô." },
    model: ["do-do"],
  },
  {
    handle: "dam-linen-co-v",
    title: "Đầm linen cổ V",
    description: "Đầm linen cổ V, dây rút eo.",
    category: "vay",
    shape: "dress",
    code: "dlv",
    colors: ["be", "trang", "xanh-navy"],
    sizes: ["s", "m", "l"],
    price: 890000,
    attributes: { material: "Linen", composition: "100% linen", fit: "Dáng rộng" },
  },
  {
    handle: "chan-vay-xep-ly",
    title: "Chân váy xếp ly",
    description: "Chân váy xếp ly dài 70 cm, lưng thun sau.",
    category: "vay",
    shape: "dress",
    code: "cvx",
    colors: ["den", "be"],
    sizes: ["s", "m", "l"],
    price: 420000,
    attributes: { material: "Polyester", composition: "100% polyester", fit: "Xếp ly" },
  },
  {
    handle: "dam-suong-cotton",
    title: "Đầm suông cotton",
    description: "Đầm suông cotton poplin, tay lỡ.",
    category: "vay",
    shape: "dress",
    code: "dsc",
    colors: ["trang", "do-do"],
    sizes: ["s", "m", "l"],
    price: 750000,
    compareAt: 950000,
    attributes: { material: "Cotton", composition: "100% cotton poplin", fit: "Suông" },
  },
  {
    // Phụ kiện: một size "Free".
    handle: "tui-tote-vai-canvas",
    title: "Túi tote vải canvas",
    description: "Túi tote canvas dày, quai dài 60 cm, ngăn khóa kéo bên trong.",
    category: "phu-kien",
    shape: "bag",
    code: "ttc",
    colors: ["be", "den"],
    sizes: ["free"],
    price: 250000,
    attributes: { material: "Canvas", composition: "100% cotton canvas 16oz" },
  },
  {
    handle: "that-lung-da",
    title: "Thắt lưng da",
    description: "Thắt lưng da bò, khóa kim loại mạ nhám.",
    category: "phu-kien",
    shape: "bag",
    code: "tld",
    colors: ["den", "be"],
    sizes: ["s", "m", "l"],
    price: 380000,
    attributes: { material: "Da", composition: "Da bò thật", care: "Lau khô, tránh nước." },
  },
];

export const FIXTURE_PRODUCTS: readonly ProductDetail[] = SPECS.map(build);
