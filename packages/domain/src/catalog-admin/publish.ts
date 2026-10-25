/** Kiểm dữ liệu trước xuất bản (ADM03, PDP02, S-207). Trả MỌI vấn đề một lần để admin sửa hết. */
export interface PublishCandidate {
  title: string;
  /** "apparel" (quần áo: cần ≥ 3 ảnh + bảng size), "shoes" (cần bảng size), "accessory". */
  kind: "apparel" | "shoes" | "accessory";
  description: string | null;
  sizeChartId: string | null;
  images: { url: string; alt: string | null; color: string | null }[];
  variants: { sku: string; color: string | null; size: string | null; price: number | null }[];
  /** Ngoại lệ ảnh (< 3 ảnh) phải có người chịu trách nhiệm (PDP02). */
  imageExceptionBy: string | null;
}

export type PublishIssue =
  | "TITLE_MISSING"
  | "DESCRIPTION_MISSING"
  | "NO_VARIANTS"
  | "SKU_MISSING"
  | "SKU_DUPLICATE"
  | "OPTION_MISSING"
  | "VARIANT_DUPLICATE"
  | "PRICE_MISSING"
  | "PRICE_INVALID"
  | "IMAGES_TOO_FEW"
  | "IMAGE_ALT_MISSING"
  | "COLOR_WITHOUT_IMAGE"
  | "SIZE_CHART_MISSING";

export const MIN_APPAREL_IMAGES = 3;

export function checkPublishReadiness(p: PublishCandidate): { issue: PublishIssue; detail?: string }[] {
  const out: { issue: PublishIssue; detail?: string }[] = [];
  if (p.title.trim() === "") out.push({ issue: "TITLE_MISSING" });
  if (p.description === null || p.description.trim().length < 20) out.push({ issue: "DESCRIPTION_MISSING" });
  if (p.variants.length === 0) out.push({ issue: "NO_VARIANTS" });
  const skus = new Set<string>();
  const combos = new Set<string>();
  for (const v of p.variants) {
    if (v.sku.trim() === "") out.push({ issue: "SKU_MISSING" });
    else if (skus.has(v.sku)) out.push({ issue: "SKU_DUPLICATE", detail: v.sku });
    skus.add(v.sku);
    if (p.kind !== "accessory" && (v.color === null || v.size === null)) {
      out.push({ issue: "OPTION_MISSING", detail: v.sku });
    }
    const combo = `${v.color ?? ""}|${v.size ?? ""}`;
    if (combos.has(combo)) out.push({ issue: "VARIANT_DUPLICATE", detail: combo });
    combos.add(combo);
    if (v.price === null) out.push({ issue: "PRICE_MISSING", detail: v.sku });
    else if (!Number.isSafeInteger(v.price) || v.price <= 0)
      out.push({ issue: "PRICE_INVALID", detail: v.sku });
  }
  if (p.kind === "apparel" && p.images.length < MIN_APPAREL_IMAGES && p.imageExceptionBy === null) {
    out.push({ issue: "IMAGES_TOO_FEW", detail: `${p.images.length}/${MIN_APPAREL_IMAGES}` });
  }
  if (p.images.some((i) => i.alt === null || i.alt.trim() === "")) out.push({ issue: "IMAGE_ALT_MISSING" });
  const colorsWithImages = new Set(p.images.map((i) => i.color).filter((c): c is string => c !== null));
  for (const c of new Set(p.variants.map((v) => v.color).filter((c): c is string => c !== null))) {
    if (!colorsWithImages.has(c)) out.push({ issue: "COLOR_WITHOUT_IMAGE", detail: c });
  }
  if ((p.kind === "apparel" || p.kind === "shoes") && p.sizeChartId === null) {
    out.push({ issue: "SIZE_CHART_MISSING" });
  }
  return out;
}
