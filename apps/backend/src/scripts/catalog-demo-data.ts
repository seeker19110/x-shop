/**
 * DỮ LIỆU DEMO — không phải sản phẩm/thương hiệu thật. Ảnh là placeholder SVG cục bộ (`/static/demo/*.svg`), không
 * hotlink. Mọi sản phẩm seed mang `metadata.demo = true` để lọc/xoá khi lên dữ liệu thật.
 *
 * Ca kiểm thử cố định (SPEC-catalog):
 *  - AT31 / S-202: "Áo sơ mi lụa" có đen-M 700.000đ và trắng-S 300.000đ.
 *  - AT01 / S-201: "Áo thun gân tăm" chỉ có đen-S và trắng-M.
 *  - Có SKU hết hàng (stock 0) ở Kho chính.
 */
import type { SizeChartContent } from "../modules/fashion/validators";

export const DEMO_MARK = "x-shop-catalog-demo";

export const DEMO_COLORS = [
  { value: "den", label: "Đen", hex: "#1A1A1A" },
  { value: "trang", label: "Trắng", hex: "#FFFFFF" },
  { value: "be", label: "Be", hex: "#D8C3A5" },
  { value: "xam", label: "Xám", hex: "#8C8C8C" },
  { value: "xanh-navy", label: "Xanh navy", hex: "#1F2A44" },
  { value: "xanh-reu", label: "Xanh rêu", hex: "#5B6B3A" },
  { value: "nau", label: "Nâu", hex: "#6B4423" },
  { value: "do", label: "Đỏ", hex: "#B3261E" },
  { value: "hong", label: "Hồng", hex: "#E8A0B4" },
] as const;

export const DEMO_SIZES = [
  { value: "xs", label: "XS" },
  { value: "s", label: "S" },
  { value: "m", label: "M" },
  { value: "l", label: "L" },
  { value: "xl", label: "XL" },
  ...["36", "37", "38", "39", "40", "41", "42"].map((v) => ({ value: v, label: v })),
  { value: "onesize", label: "Một cỡ" },
] as const;

export const DEMO_CATEGORIES: { handle: string; name: string; parent: string | null }[] = [
  { handle: "nu", name: "Nữ", parent: null },
  { handle: "nam", name: "Nam", parent: null },
  { handle: "giay", name: "Giày", parent: null },
  { handle: "phu-kien", name: "Phụ kiện", parent: null },
  { handle: "ao-nu", name: "Áo nữ", parent: "nu" },
  { handle: "quan-nu", name: "Quần nữ", parent: "nu" },
  { handle: "vay-dam", name: "Váy & đầm", parent: "nu" },
  { handle: "ao-nam", name: "Áo nam", parent: "nam" },
  { handle: "quan-nam", name: "Quần nam", parent: "nam" },
  { handle: "tui", name: "Túi", parent: "phu-kien" },
  { handle: "mu-non", name: "Mũ nón", parent: "phu-kien" },
  { handle: "that-lung", name: "Thắt lưng", parent: "phu-kien" },
];

const LETTER_SIZES = ["xs", "s", "m", "l", "xl"];
const range = (a: number, b: number) => [a, b] as [number, number];

export const DEMO_SIZE_CHARTS: (SizeChartContent & { code: string })[] = [
  {
    code: "ao-nu",
    name: "Bảng size áo nữ",
    garment_type: "ao",
    unit: "cm",
    columns: [
      { key: "nguc", label: "Vòng ngực", basis: "body" },
      { key: "eo", label: "Vòng eo", basis: "body" },
      { key: "dai_ao", label: "Dài áo", basis: "garment" },
    ],
    rows: LETTER_SIZES.map((s, i) => ({
      size: s,
      label: s.toUpperCase(),
      values: { nguc: range(78 + i * 4, 82 + i * 4), eo: range(60 + i * 4, 64 + i * 4), dai_ao: 60 + i * 2 },
    })),
  },
  {
    code: "quan-nu",
    name: "Bảng size quần nữ",
    garment_type: "quan",
    unit: "cm",
    columns: [
      { key: "eo", label: "Vòng eo", basis: "body" },
      { key: "mong", label: "Vòng mông", basis: "body" },
      { key: "dai_quan", label: "Dài quần", basis: "garment" },
    ],
    rows: LETTER_SIZES.map((s, i) => ({
      size: s,
      label: s.toUpperCase(),
      values: { eo: range(60 + i * 4, 64 + i * 4), mong: range(84 + i * 4, 88 + i * 4), dai_quan: 96 + i },
    })),
  },
  {
    code: "vay-dam",
    name: "Bảng size váy & đầm",
    garment_type: "vay",
    unit: "cm",
    columns: [
      { key: "nguc", label: "Vòng ngực", basis: "body" },
      { key: "eo", label: "Vòng eo", basis: "body" },
      { key: "mong", label: "Vòng mông", basis: "body" },
    ],
    rows: LETTER_SIZES.map((s, i) => ({
      size: s,
      label: s.toUpperCase(),
      values: {
        nguc: range(78 + i * 4, 82 + i * 4),
        eo: range(60 + i * 4, 64 + i * 4),
        mong: range(84 + i * 4, 88 + i * 4),
      },
    })),
  },
  {
    code: "ao-nam",
    name: "Bảng size áo nam",
    garment_type: "ao",
    unit: "cm",
    columns: [
      { key: "nguc", label: "Vòng ngực", basis: "body" },
      { key: "vai", label: "Rộng vai", basis: "garment" },
      { key: "dai_ao", label: "Dài áo", basis: "garment" },
    ],
    rows: LETTER_SIZES.map((s, i) => ({
      size: s,
      label: s.toUpperCase(),
      values: { nguc: range(86 + i * 4, 90 + i * 4), vai: 42 + i * 2, dai_ao: 68 + i * 2 },
    })),
  },
  {
    code: "quan-nam",
    name: "Bảng size quần nam",
    garment_type: "quan",
    unit: "cm",
    columns: [
      { key: "eo", label: "Vòng eo", basis: "body" },
      { key: "mong", label: "Vòng mông", basis: "body" },
      { key: "dai_quan", label: "Dài quần", basis: "garment" },
    ],
    rows: LETTER_SIZES.map((s, i) => ({
      size: s,
      label: s.toUpperCase(),
      values: { eo: range(70 + i * 4, 74 + i * 4), mong: range(90 + i * 4, 94 + i * 4), dai_quan: 100 + i },
    })),
  },
  {
    code: "giay",
    name: "Bảng size giày",
    garment_type: "giay",
    unit: "cm",
    columns: [{ key: "dai_ban_chan", label: "Dài bàn chân", basis: "body" }],
    rows: ["36", "37", "38", "39", "40", "41", "42"].map((s, i) => ({
      size: s,
      label: s,
      values: { dai_ban_chan: 22.5 + i * 0.5 },
    })),
  },
];

/** [màu, size, giá VND, tồn ở Kho chính] */
type V = [string, string, number, number];

export interface DemoProduct {
  handle: string;
  title: string;
  sku: string;
  category: string;
  kind: "apparel" | "shoes" | "accessory";
  material: [string, string];
  composition: string;
  fit: string | null;
  stretch: "none" | "low" | "medium" | "high" | null;
  description: string;
  sizeChart: string | null;
  variants: V[];
  model?: { height_cm: number; chest_cm: number; waist_cm: number; hip_cm: number; size_worn: string };
}

const each = (colors: string[], sizes: string[], price: number, stock: number): V[] =>
  colors.flatMap((c) => sizes.map((s): V => [c, s, price, stock]));

const CARE_TEXTILE =
  "Giặt tay hoặc giặt máy chế độ nhẹ ở 30°C, không tẩy, phơi trong bóng râm, là ở nhiệt độ thấp.";

export const DEMO_PRODUCTS: DemoProduct[] = [
  {
    handle: "ao-so-mi-lua",
    title: "Áo sơ mi lụa",
    sku: "SMLUA",
    category: "ao-nu",
    kind: "apparel",
    material: ["lua", "Lụa"],
    composition: "100% lụa tơ tằm",
    fit: "Suông",
    stretch: "none",
    description: "Áo sơ mi lụa tơ tằm mềm, form suông, cổ đức, phù hợp đi làm và dạo phố. (Dữ liệu demo)",
    sizeChart: "ao-nu",
    variants: [
      ["den", "m", 700_000, 5],
      ["trang", "s", 300_000, 8],
      ["den", "s", 650_000, 0],
      ["trang", "m", 350_000, 4],
    ],
    model: { height_cm: 168, chest_cm: 82, waist_cm: 62, hip_cm: 90, size_worn: "s" },
  },
  {
    handle: "ao-thun-gan-tam",
    title: "Áo thun gân tăm",
    sku: "ATGAN",
    category: "ao-nu",
    kind: "apparel",
    material: ["cotton", "Cotton"],
    composition: "95% cotton, 5% spandex",
    fit: "Ôm",
    stretch: "high",
    description:
      "Áo thun gân tăm co giãn tốt, ôm nhẹ dáng, dễ phối với chân váy và quần jean. (Dữ liệu demo)",
    sizeChart: "ao-nu",
    variants: [
      ["den", "s", 250_000, 10],
      ["trang", "m", 250_000, 10],
    ],
  },
  {
    handle: "ao-blouse-co-no",
    title: "Áo blouse cổ nơ",
    sku: "BLNO",
    category: "ao-nu",
    kind: "apparel",
    material: ["voan", "Voan"],
    composition: "100% polyester voan",
    fit: "Suông",
    stretch: "none",
    description: "Áo blouse voan cổ thắt nơ, tay bồng nhẹ, lót trong chống xuyên thấu. (Dữ liệu demo)",
    sizeChart: "ao-nu",
    variants: [...each(["trang"], ["s", "m", "l"], 420_000, 6), ...each(["hong"], ["s", "m"], 450_000, 3)],
  },
  {
    handle: "ao-len-mong",
    title: "Áo len mỏng dệt kim",
    sku: "LENMG",
    category: "ao-nu",
    kind: "apparel",
    material: ["len", "Len"],
    composition: "70% len merino, 30% nylon",
    fit: "Vừa",
    stretch: "medium",
    description: "Áo len dệt kim mỏng, giữ ấm nhẹ cho mùa thu, mặt vải mịn không xù. (Dữ liệu demo)",
    sizeChart: "ao-nu",
    variants: [
      ...each(["be"], ["s", "m", "l"], 520_000, 5),
      ...each(["xam"], ["m", "l"], 520_000, 2),
      ["den", "m", 540_000, 0],
    ],
  },
  {
    handle: "ao-khoac-blazer-nu",
    title: "Áo khoác blazer nữ",
    sku: "BLZNU",
    category: "ao-nu",
    kind: "apparel",
    material: ["polyester", "Polyester"],
    composition: "65% polyester, 35% viscose",
    fit: "Vừa",
    stretch: "low",
    description: "Blazer nữ hai lớp, vai độn mỏng, túi nắp hai bên, mặc công sở thanh lịch. (Dữ liệu demo)",
    sizeChart: "ao-nu",
    variants: [...each(["den"], ["s", "m", "l"], 1_200_000, 3), ["be", "m", 1_250_000, 2]],
  },
  {
    handle: "quan-jean-ong-dung",
    title: "Quần jean ống đứng",
    sku: "JNUDG",
    category: "quan-nu",
    kind: "apparel",
    material: ["denim", "Denim"],
    composition: "98% cotton, 2% spandex",
    fit: "Ống đứng",
    stretch: "low",
    description: "Quần jean nữ lưng cao, ống đứng, wash nhẹ, tôn dáng và dễ phối đồ. (Dữ liệu demo)",
    sizeChart: "quan-nu",
    variants: [...each(["xanh-navy"], ["s", "m", "l"], 650_000, 7), ...each(["den"], ["m", "l"], 680_000, 4)],
  },
  {
    handle: "quan-tay-ong-suong",
    title: "Quần tây ống suông",
    sku: "QTSUO",
    category: "quan-nu",
    kind: "apparel",
    material: ["polyester", "Polyester"],
    composition: "80% polyester, 20% rayon",
    fit: "Ống suông",
    stretch: "low",
    description: "Quần tây nữ ống suông, cạp cao có đỉa, vải đứng form ít nhăn. (Dữ liệu demo)",
    sizeChart: "quan-nu",
    variants: [...each(["den", "be"], ["s", "m"], 590_000, 5), ["xam", "l", 560_000, 1]],
  },
  {
    handle: "quan-short-linen",
    title: "Quần short linen",
    sku: "SHLIN",
    category: "quan-nu",
    kind: "apparel",
    material: ["linen", "Linen"],
    composition: "100% linen",
    fit: "Rộng",
    stretch: "none",
    description: "Quần short linen thoáng mát, cạp chun sau, hợp đi biển và dạo phố mùa hè. (Dữ liệu demo)",
    sizeChart: "quan-nu",
    variants: [...each(["be"], ["s", "m"], 390_000, 6), ["trang", "m", 390_000, 0]],
  },
  {
    handle: "dam-suong-linen",
    title: "Đầm suông linen",
    sku: "DMLIN",
    category: "vay-dam",
    kind: "apparel",
    material: ["linen", "Linen"],
    composition: "100% linen",
    fit: "Suông",
    stretch: "none",
    description: "Đầm suông linen dáng dài qua gối, cổ tròn, có túi hai bên tiện dụng. (Dữ liệu demo)",
    sizeChart: "vay-dam",
    variants: [...each(["be"], ["s", "m", "l"], 890_000, 4), ["xanh-reu", "m", 920_000, 2]],
    model: { height_cm: 165, chest_cm: 80, waist_cm: 61, hip_cm: 88, size_worn: "s" },
  },
  {
    handle: "chan-vay-midi-xep-ly",
    title: "Chân váy midi xếp ly",
    sku: "VMIDI",
    category: "vay-dam",
    kind: "apparel",
    material: ["polyester", "Polyester"],
    composition: "100% polyester",
    fit: "Xòe",
    stretch: "none",
    description: "Chân váy midi xếp ly nhỏ, cạp chun ẩn, chuyển động mềm khi bước. (Dữ liệu demo)",
    sizeChart: "vay-dam",
    variants: [...each(["den"], ["s", "m"], 480_000, 5), ["xam", "s", 450_000, 3]],
  },
  {
    handle: "dam-lua-hai-day",
    title: "Đầm lụa hai dây",
    sku: "DMLUA",
    category: "vay-dam",
    kind: "apparel",
    material: ["lua", "Lụa"],
    composition: "100% lụa satin",
    fit: "Ôm nhẹ",
    stretch: "none",
    description: "Đầm lụa hai dây cắt xéo vải, dáng midi, phù hợp tiệc tối. (Dữ liệu demo)",
    sizeChart: "vay-dam",
    variants: [
      ...each(["do"], ["s", "m"], 1_150_000, 2),
      ["den", "s", 1_150_000, 1],
      ["den", "m", 990_000, 3],
    ],
  },
  {
    handle: "ao-polo-nam",
    title: "Áo polo nam",
    sku: "POLO",
    category: "ao-nam",
    kind: "apparel",
    material: ["cotton", "Cotton"],
    composition: "100% cotton cá sấu",
    fit: "Vừa",
    stretch: "low",
    description: "Áo polo nam vải cá sấu thoáng khí, cổ dệt bo, giữ form sau nhiều lần giặt. (Dữ liệu demo)",
    sizeChart: "ao-nam",
    variants: [
      ...each(["trang"], ["m", "l", "xl"], 390_000, 8),
      ...each(["xanh-navy"], ["m", "l"], 390_000, 6),
      ["den", "xl", 420_000, 2],
    ],
    model: { height_cm: 180, chest_cm: 94, waist_cm: 78, hip_cm: 95, size_worn: "l" },
  },
  {
    handle: "ao-so-mi-oxford-nam",
    title: "Áo sơ mi Oxford nam",
    sku: "OXF",
    category: "ao-nam",
    kind: "apparel",
    material: ["cotton", "Cotton"],
    composition: "100% cotton Oxford",
    fit: "Slim",
    stretch: "none",
    description: "Áo sơ mi nam vải Oxford dày dặn, cổ button-down, mặc đi làm hoặc cuối tuần. (Dữ liệu demo)",
    sizeChart: "ao-nam",
    variants: [
      ...each(["trang"], ["m", "l"], 520_000, 6),
      ["xanh-navy", "m", 520_000, 4],
      ["xam", "l", 499_000, 0],
    ],
  },
  {
    handle: "ao-thun-nam-co-tron",
    title: "Áo thun nam cổ tròn",
    sku: "TNAM",
    category: "ao-nam",
    kind: "apparel",
    material: ["cotton", "Cotton"],
    composition: "100% cotton compact",
    fit: "Vừa",
    stretch: "low",
    description: "Áo thun nam cổ tròn basic, vải cotton compact mịn, ít xù lông. (Dữ liệu demo)",
    sizeChart: "ao-nam",
    variants: [...each(["den", "trang"], ["s", "m", "l", "xl"], 199_000, 12), ["xam", "m", 179_000, 5]],
  },
  {
    handle: "ao-khoac-kaki-nam",
    title: "Áo khoác kaki nam",
    sku: "AKKAK",
    category: "ao-nam",
    kind: "apparel",
    material: ["kaki", "Kaki"],
    composition: "100% cotton kaki",
    fit: "Rộng",
    stretch: "none",
    description: "Áo khoác kaki nam dáng utility, nhiều túi hộp, chống gió nhẹ. (Dữ liệu demo)",
    sizeChart: "ao-nam",
    variants: [...each(["be"], ["m", "l"], 890_000, 3), ...each(["xanh-reu"], ["l", "xl"], 920_000, 2)],
  },
  {
    handle: "quan-kaki-nam-slim",
    title: "Quần kaki nam slim",
    sku: "QKNAM",
    category: "quan-nam",
    kind: "apparel",
    material: ["kaki", "Kaki"],
    composition: "97% cotton, 3% spandex",
    fit: "Slim",
    stretch: "low",
    description: "Quần kaki nam dáng slim, co giãn nhẹ, đứng dáng khi ngồi lâu. (Dữ liệu demo)",
    sizeChart: "quan-nam",
    variants: [
      ...each(["be"], ["m", "l"], 550_000, 6),
      ...each(["den"], ["m", "l", "xl"], 550_000, 5),
      ["xanh-navy", "l", 570_000, 2],
    ],
  },
  {
    handle: "quan-jean-nam-ong-con",
    title: "Quần jean nam ống côn",
    sku: "JNAM",
    category: "quan-nam",
    kind: "apparel",
    material: ["denim", "Denim"],
    composition: "99% cotton, 1% spandex",
    fit: "Ống côn",
    stretch: "low",
    description: "Quần jean nam ống côn, màu chàm đậm, đường may chắc chắn. (Dữ liệu demo)",
    sizeChart: "quan-nam",
    variants: [...each(["xanh-navy"], ["m", "l", "xl"], 720_000, 5), ["den", "l", 750_000, 2]],
  },
  {
    handle: "quan-short-the-thao-nam",
    title: "Quần short thể thao nam",
    sku: "SHNAM",
    category: "quan-nam",
    kind: "apparel",
    material: ["polyester", "Polyester"],
    composition: "100% polyester thun lạnh",
    fit: "Vừa",
    stretch: "medium",
    description: "Quần short thể thao nam nhanh khô, cạp chun dây rút, có túi khoá kéo. (Dữ liệu demo)",
    sizeChart: "quan-nam",
    variants: [...each(["den"], ["m", "l"], 290_000, 9), ["xam", "m", 270_000, 4]],
  },
  {
    handle: "giay-sneaker-da-trang",
    title: "Giày sneaker da trắng",
    sku: "SNKR",
    category: "giay",
    kind: "shoes",
    material: ["da", "Da"],
    composition: "Da bò thật, đế cao su",
    fit: null,
    stretch: null,
    description: "Giày sneaker da trắng tối giản, đế cao su êm, khâu viền chắc chắn. (Dữ liệu demo)",
    sizeChart: "giay",
    variants: [
      ...each(["trang"], ["36", "37", "38", "39", "40", "41", "42"], 1_350_000, 3),
      ["den", "39", 1_390_000, 2],
      ["den", "40", 1_390_000, 0],
      ["den", "41", 1_390_000, 1],
    ],
  },
  {
    handle: "giay-loafer-nu",
    title: "Giày loafer nữ",
    sku: "LOAF",
    category: "giay",
    kind: "shoes",
    material: ["da", "Da"],
    composition: "Da bò, lót da heo",
    fit: null,
    stretch: null,
    description: "Giày loafer nữ mũi tròn, gót thấp 2 cm, đi êm cả ngày. (Dữ liệu demo)",
    sizeChart: "giay",
    variants: [...each(["den"], ["36", "37", "38"], 990_000, 3), ...each(["nau"], ["37", "38"], 990_000, 2)],
  },
  {
    handle: "tui-tote-canvas",
    title: "Túi tote canvas",
    sku: "TOTE",
    category: "tui",
    kind: "accessory",
    material: ["cotton", "Cotton"],
    composition: "100% cotton canvas",
    fit: null,
    stretch: null,
    description: "Túi tote canvas dày, quai dài đeo vai, đựng vừa laptop 14 inch. (Dữ liệu demo)",
    sizeChart: null,
    variants: [
      ["be", "onesize", 350_000, 10],
      ["den", "onesize", 350_000, 0],
    ],
  },
  {
    handle: "tui-deo-cheo-da",
    title: "Túi đeo chéo da",
    sku: "TUIDA",
    category: "tui",
    kind: "accessory",
    material: ["da", "Da"],
    composition: "Da bò thật",
    fit: null,
    stretch: null,
    description: "Túi đeo chéo da bò, khoá kim loại, dây đeo điều chỉnh được độ dài. (Dữ liệu demo)",
    sizeChart: null,
    variants: [
      ["den", "onesize", 1_450_000, 3],
      ["nau", "onesize", 1_490_000, 2],
    ],
  },
  {
    handle: "mu-bucket-kaki",
    title: "Mũ bucket kaki",
    sku: "BUCK",
    category: "mu-non",
    kind: "accessory",
    material: ["kaki", "Kaki"],
    composition: "100% cotton kaki",
    fit: null,
    stretch: null,
    description: "Mũ bucket vành rộng chống nắng, vải kaki mềm, gấp gọn được. (Dữ liệu demo)",
    sizeChart: null,
    variants: [
      ["be", "onesize", 220_000, 8],
      ["den", "onesize", 220_000, 6],
      ["xanh-reu", "onesize", 240_000, 4],
    ],
  },
  {
    handle: "that-lung-da-bo",
    title: "Thắt lưng da bò",
    sku: "BELT",
    category: "that-lung",
    kind: "accessory",
    material: ["da", "Da"],
    composition: "Da bò nguyên tấm",
    fit: null,
    stretch: null,
    description:
      "Thắt lưng da bò bản 3,5 cm, khoá kim loại mờ, dùng được cả công sở và thường ngày. (Dữ liệu demo)",
    sizeChart: null,
    variants: [
      ["den", "onesize", 450_000, 5],
      ["nau", "onesize", 450_000, 5],
    ],
  },
];

export const DEMO_CARE = CARE_TEXTILE;
