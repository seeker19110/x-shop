import type { MedusaContainer } from "@medusajs/framework/types";
import { MedusaError } from "@medusajs/framework/utils";
import { checkPublishReadiness, type PublishCandidate, type PublishIssue } from "@x-shop/domain";
import { loadProductSources, type ProductSource } from "./product-source";

export interface ReadinessIssue {
  issue: PublishIssue;
  detail?: string;
}

/**
 * Ánh xạ ảnh chụp sản phẩm sang ứng viên xuất bản của domain (ADM03, S-207). Sản phẩm chưa có thuộc tính thời trang
 * được xét như hàng may mặc — luật chặt nhất (cần ≥ 3 ảnh + bảng size), để không lọt sản phẩm thiếu dữ liệu.
 */
export function toPublishCandidate(p: ProductSource): PublishCandidate {
  return {
    title: p.title,
    kind: p.attributes?.kind ?? "apparel",
    description: p.description,
    sizeChartId: p.sizeChart?.id ?? null,
    images: p.images.map((i) => ({ url: i.url, alt: i.alt, color: i.color })),
    variants: p.variants.map((v) => ({ sku: v.sku, color: v.color, size: v.size, price: v.basePrice })),
    imageExceptionBy: p.attributes?.imageExceptionBy ?? null,
  };
}

export function readinessOf(p: ProductSource): ReadinessIssue[] {
  return checkPublishReadiness(toPublishCandidate(p));
}

export function describeIssues(issues: ReadinessIssue[]): string {
  return issues.map((i) => (i.detail ? `${i.issue} (${i.detail})` : i.issue)).join(", ");
}

/** Mã lỗi ổn định ở đầu thông điệp để client nhận diện (đặc tả §9.1). */
export const PUBLISH_BLOCKED = "PUBLISH_BLOCKED";

/**
 * Chặn mọi sản phẩm `published` chưa đạt kiểm trước xuất bản. Ném MedusaError INVALID_DATA liệt kê MỌI vấn đề của
 * từng sản phẩm — workflow gọi hàm này thất bại và bù trừ (hoàn tác bản ghi vừa tạo/sửa).
 */
export async function assertPublishable(container: MedusaContainer, productIds: string[]): Promise<void> {
  const products = await loadProductSources(container, { id: [...new Set(productIds)] });
  const blocked = products
    .filter((p) => p.status === "published")
    .map((p) => ({ p, issues: readinessOf(p) }))
    .filter((x) => x.issues.length > 0);
  if (blocked.length === 0) return;
  const detail = blocked.map(({ p, issues }) => `«${p.title || p.id}»: ${describeIssues(issues)}`).join("; ");
  throw new MedusaError(
    MedusaError.Types.INVALID_DATA,
    `${PUBLISH_BLOCKED}: Sản phẩm chưa đủ điều kiện xuất bản — ${detail}`,
  );
}
