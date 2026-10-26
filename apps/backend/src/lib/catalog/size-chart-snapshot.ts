import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { isNonEmpty } from "@x-shop/domain";

/** Bảng size (đúng PHIÊN BẢN) của sản phẩm tại thời điểm đặt hàng — chụp vào metadata dòng đơn (ADM03, T-027). */
export interface LineSizeChart {
  size_chart_id: string | null;
  size_chart_code: string | null;
  size_chart_version: number | null;
}

export const NO_SIZE_CHART: LineSizeChart = {
  size_chart_id: null,
  size_chart_code: null,
  size_chart_version: null,
};

/**
 * product_id → bảng size đang gắn (link product ↔ size_chart trỏ MỘT phiên bản; reviseSizeChart chuyển link sang bản
 * mới, bản cũ giữ nguyên). Đơn lưu id + code + version nên đổi bảng size về sau không đổi điều khách đã thấy lúc mua.
 */
export async function sizeChartsOfProducts(
  container: Pick<MedusaContainer, "resolve">,
  productIds: readonly string[],
): Promise<Map<string, LineSizeChart>> {
  const ids = [...new Set(productIds.filter(Boolean))];
  const out = new Map<string, LineSizeChart>();
  if (ids.length === 0) return out;
  const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: "product",
    fields: ["id", "size_chart.id", "size_chart.code", "size_chart.version"],
    filters: { id: ids },
  });
  type Row = { id: string; size_chart?: { id?: string; code?: string; version?: number } | null };
  for (const p of data as Row[]) {
    const c = p.size_chart;
    out.set(
      p.id,
      c && isNonEmpty(c.id) && isNonEmpty(c.code) && Number.isSafeInteger(c.version)
        ? { size_chart_id: c.id, size_chart_code: c.code, size_chart_version: Number(c.version) }
        : NO_SIZE_CHART,
    );
  }
  return out;
}
