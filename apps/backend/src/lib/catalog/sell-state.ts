import type { MedusaContainer } from "@medusajs/framework/types";
import {
  ContainerRegistrationKeys,
  getVariantAvailability,
  Modules,
  QueryContext,
} from "@medusajs/framework/utils";
import { CURRENCY, QUERY_ID_BATCH } from "./constants";
import type { SourceVariant } from "./product-source";
import { toVnd } from "./product-source";
import { isNonEmpty } from "@x-shop/domain";

/** Giá bán hiện hành + giá gạch + hạn giá + còn hàng của một SKU — tính từ nguồn có thẩm quyền (Pricing, Inventory). */
export interface VariantPrice {
  price: number;
  /** Giá trước giảm, chỉ khi lớn hơn giá bán (CAT04: giá gạch khi giảm hợp lệ). */
  compareAt: number | null;
  /** Hết hạn của price list đang áp (nếu có) — read model tự làm mới sau mốc này. */
  validUntil: Date | null;
}

export interface PricingContext {
  regionId: string | null;
  currencyCode: string;
}

/** Region bán VND (ưu tiên region có quốc gia VN). Không có region → tính theo tiền tệ. */
export async function resolvePricingContext(container: MedusaContainer): Promise<PricingContext> {
  const regions = await container
    .resolve(Modules.REGION)
    .listRegions({ currency_code: CURRENCY }, { relations: ["countries"] });
  const vn = regions.find((r) => r.countries?.some((c) => c.iso_2 === "vn")) ?? regions[0];
  return { regionId: vn?.id ?? null, currencyCode: CURRENCY };
}

type RawCalculated = {
  id: string;
  calculated_price?: {
    calculated_amount?: number | string | null;
    original_amount?: number | string | null;
    currency_code?: string | null;
    calculated_price?: { price_list_id?: string | null } | null;
  } | null;
};

/** Chia danh sách thành các lô cố định (lô cuối có thể ngắn hơn). */
export function chunked<T>(xs: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`Kích thước lô không hợp lệ: ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/**
 * Giá theo SKU qua calculated_price của Query (cùng cách Store API native tính giá, gồm price list).
 *
 * Đọc theo lô `QUERY_ID_BATCH` biến thể mỗi lời gọi: ở Medusa 2.22.1, `query.graph` tự chia danh sách id ≥ 4.000
 * thành nhiều lô (MAX_BATCH_SIZE của ModuleDataFetcher) dùng CHUNG một `options`, và `listPriceSets` của Pricing xoá
 * `calculated_price` khỏi `options.relations` ở lô đầu → mọi lô sau trả biến thể KHÔNG có giá (không lỗi, không cảnh
 * báo). Lô cố định < 4.000 tránh hẳn nhánh đó (T-057).
 */
export async function loadVariantPrices(
  container: MedusaContainer,
  variantIds: string[],
  ctx: PricingContext,
): Promise<Map<string, VariantPrice>> {
  const out = new Map<string, VariantPrice>();
  const ids = [...new Set(variantIds)];
  if (ids.length === 0) return out;
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const priceListIds = new Set<string>();
  const pending: { id: string; price: number; compareAt: number | null; listId: string | null }[] = [];
  for (const batch of chunked(ids, QUERY_ID_BATCH)) {
    const { data } = await query.graph({
      entity: "product_variant",
      fields: ["id", "calculated_price.*"],
      filters: { id: batch },
      context: {
        calculated_price: QueryContext({
          currency_code: ctx.currencyCode,
          ...(isNonEmpty(ctx.regionId) ? { region_id: ctx.regionId } : {}),
        }),
      },
    });
    for (const r of data as unknown as RawCalculated[]) {
      const cp = r.calculated_price;
      if (!cp || cp.currency_code !== ctx.currencyCode) continue;
      const price = toVnd(cp.calculated_amount);
      if (price === null) continue;
      const original = toVnd(cp.original_amount);
      const listId = cp.calculated_price?.price_list_id ?? null;
      if (isNonEmpty(listId)) priceListIds.add(listId);
      pending.push({
        id: r.id,
        price,
        compareAt: original !== null && original > price ? original : null,
        listId,
      });
    }
  }
  const endsAt = new Map<string, Date | null>();
  for (const batch of chunked([...priceListIds], QUERY_ID_BATCH)) {
    const lists = await container
      .resolve(Modules.PRICING)
      .listPriceLists({ id: batch }, { select: ["id", "ends_at"], take: batch.length });
    for (const l of lists) endsAt.set(l.id, isNonEmpty(l.ends_at) ? new Date(l.ends_at) : null);
  }
  for (const p of pending) {
    out.set(p.id, {
      price: p.price,
      compareAt: p.compareAt,
      validUntil: isNonEmpty(p.listId) ? (endsAt.get(p.listId) ?? null) : null,
    });
  }
  return out;
}

/**
 * Còn hàng theo kênh bán (INV02): tồn bán được trừ đã giữ, cộng trên các kho gắn kênh (getVariantAvailability của
 * Medusa). Không quản tồn hoặc cho đặt trước → coi là còn hàng.
 */
export async function loadInStock(
  container: MedusaContainer,
  variants: SourceVariant[],
  salesChannelId: string,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const managed: SourceVariant[] = [];
  for (const v of variants) {
    if (v.manageInventory && !v.allowBackorder) managed.push(v);
    else out.set(v.id, true);
  }
  if (managed.length === 0) return out;
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  // Theo lô cố định như giá: giữ mỗi truy vấn dưới ngưỡng tự chia lô của Query (4.000 id) và bộ nhớ có hạn.
  for (const batch of chunked(managed, QUERY_ID_BATCH)) {
    const availability = await getVariantAvailability(query, {
      variant_ids: batch.map((v) => v.id),
      sales_channel_id: salesChannelId,
    });
    for (const v of batch) out.set(v.id, (availability[v.id]?.availability ?? 0) > 0);
  }
  return out;
}
