import type { MedusaContainer } from "@medusajs/framework/types";
import {
  ContainerRegistrationKeys,
  getVariantAvailability,
  Modules,
  QueryContext,
} from "@medusajs/framework/utils";
import { CURRENCY } from "./constants";
import type { SourceVariant } from "./product-source";
import { toVnd } from "./product-source";

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

/** Giá theo SKU qua calculated_price của Query (cùng cách Store API native tính giá, gồm price list). */
export async function loadVariantPrices(
  container: MedusaContainer,
  variantIds: string[],
  ctx: PricingContext,
): Promise<Map<string, VariantPrice>> {
  const out = new Map<string, VariantPrice>();
  if (variantIds.length === 0) return out;
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "product_variant",
    fields: ["id", "calculated_price.*"],
    filters: { id: variantIds },
    context: {
      calculated_price: QueryContext({
        currency_code: ctx.currencyCode,
        ...(ctx.regionId ? { region_id: ctx.regionId } : {}),
      }),
    },
  });
  const rows: RawCalculated[] = data;
  const priceListIds = new Set<string>();
  const pending: { id: string; price: number; compareAt: number | null; listId: string | null }[] = [];
  for (const r of rows) {
    const cp = r.calculated_price;
    if (!cp || cp.currency_code !== ctx.currencyCode) continue;
    const price = toVnd(cp.calculated_amount);
    if (price === null) continue;
    const original = toVnd(cp.original_amount);
    const listId = cp.calculated_price?.price_list_id ?? null;
    if (listId) priceListIds.add(listId);
    pending.push({
      id: r.id,
      price,
      compareAt: original !== null && original > price ? original : null,
      listId,
    });
  }
  const endsAt = new Map<string, Date | null>();
  if (priceListIds.size) {
    const lists = await container
      .resolve(Modules.PRICING)
      .listPriceLists({ id: [...priceListIds] }, { select: ["id", "ends_at"] });
    for (const l of lists) endsAt.set(l.id, l.ends_at ? new Date(l.ends_at) : null);
  }
  for (const p of pending) {
    out.set(p.id, {
      price: p.price,
      compareAt: p.compareAt,
      validUntil: p.listId ? (endsAt.get(p.listId) ?? null) : null,
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
  const managed = variants.filter((v) => v.manageInventory && !v.allowBackorder);
  for (const v of variants) if (!managed.includes(v)) out.set(v.id, true);
  if (managed.length === 0) return out;
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const availability = await getVariantAvailability(query, {
    variant_ids: managed.map((v) => v.id),
    sales_channel_id: salesChannelId,
  });
  for (const v of managed) out.set(v.id, (availability[v.id]?.availability ?? 0) > 0);
  return out;
}
