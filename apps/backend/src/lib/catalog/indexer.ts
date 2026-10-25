import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { searchKey } from "@x-shop/domain";
import { CATALOG_INDEX_MODULE } from "../../modules/catalog-index";
import type CatalogIndexModuleService from "../../modules/catalog-index/service";
import type { CatalogIndexRow } from "../../modules/catalog-index/service";
import { colorOf, loadDictionary, sizeOf, type Dictionary } from "./dictionary";
import { loadProductSources, type ProductSource } from "./product-source";
import {
  loadInStock,
  loadVariantPrices,
  resolvePricingContext,
  type PricingContext,
  type VariantPrice,
} from "./sell-state";

/** Khoá ghi read model: đồng bộ theo sự kiện và rebuild toàn phần không xen kẽ (không ghi đè bằng dữ liệu cũ). */
export const CATALOG_INDEX_LOCK = "x-shop:catalog-index";
const LOCK_TIMEOUT_SECONDS = 300;
const SOURCE_CHUNK = 100;

export interface IndexContext {
  dict: Dictionary;
  pricing: PricingContext;
}

export async function loadIndexContext(container: MedusaContainer): Promise<IndexContext> {
  const [dict, pricing] = await Promise.all([loadDictionary(container), resolvePricingContext(container)]);
  return { dict, pricing };
}

/** Văn bản tìm kiếm: tên + SKU + tên danh mục, chuẩn hoá bỏ dấu (CAT01). */
export function searchTextOf(p: ProductSource, sku: string): string {
  return searchKey([p.title, sku, ...p.categories.map((c) => c.name)].join(" "));
}

function thumbnailFor(p: ProductSource, color: string | null): string | null {
  return (
    (color ? p.images.find((i) => i.color === color)?.url : undefined) ??
    p.thumbnail ??
    p.images[0]?.url ??
    null
  );
}

/**
 * Dòng read model cho các sản phẩm: chỉ sản phẩm `published`, một dòng mỗi SKU có giá VND × mỗi kênh bán của sản
 * phẩm. SKU không có giá bán hiện hành không vào index (không bán được).
 */
export async function buildIndexRows(
  container: MedusaContainer,
  products: ProductSource[],
  ctx: IndexContext,
): Promise<CatalogIndexRow[]> {
  const published = products.filter((p) => p.status === "published" && p.salesChannelIds.length > 0);
  const prices: Map<string, VariantPrice> = await loadVariantPrices(
    container,
    published.flatMap((p) => p.variants.map((v) => v.id)),
    ctx.pricing,
  );
  const rows: CatalogIndexRow[] = [];
  // Còn hàng tính theo kênh: gom biến thể của mọi sản phẩm theo kênh rồi hỏi một lần mỗi kênh.
  const byChannel = new Map<string, ProductSource[]>();
  for (const p of published)
    for (const ch of p.salesChannelIds) byChannel.set(ch, [...(byChannel.get(ch) ?? []), p]);
  for (const [channelId, ps] of byChannel) {
    const stock = await loadInStock(
      container,
      ps.flatMap((p) => p.variants),
      channelId,
    );
    for (const p of ps) {
      const categoryHandles = [...new Set(p.categories.flatMap((c) => c.lineage))];
      for (const v of p.variants) {
        const price = prices.get(v.id);
        if (!price || v.sku === "") continue;
        const color = v.color ? colorOf(ctx.dict, v.color) : null;
        const size = v.size ? sizeOf(ctx.dict, v.size) : null;
        rows.push({
          variant_id: v.id,
          sales_channel_id: channelId,
          product_id: p.id,
          handle: p.handle,
          title: p.title,
          sku: v.sku,
          search_text: searchTextOf(p, v.sku),
          category_handles: categoryHandles,
          color: color?.value ?? null,
          color_label: color?.label ?? null,
          color_hex: color?.hex ?? null,
          color_rank: color?.rank ?? null,
          size: size?.value ?? null,
          size_label: size?.label ?? null,
          size_rank: size?.rank ?? null,
          material: p.attributes?.material ?? null,
          material_label: p.attributes?.materialLabel ?? p.attributes?.material ?? null,
          price: price.price,
          compare_at: price.compareAt,
          price_valid_until: price.validUntil,
          in_stock: stock.get(v.id) ?? false,
          variant_rank: v.rank,
          thumbnail: thumbnailFor(p, v.color),
          product_thumbnail: thumbnailFor(p, null),
          created_at: p.createdAt,
        });
      }
    }
  }
  return rows;
}

function indexService(container: MedusaContainer): CatalogIndexModuleService {
  return container.resolve(CATALOG_INDEX_MODULE);
}

async function sourcesInChunks(container: MedusaContainer, ids: string[]): Promise<ProductSource[]> {
  const out: ProductSource[] = [];
  for (let i = 0; i < ids.length; i += SOURCE_CHUNK) {
    out.push(...(await loadProductSources(container, { id: ids.slice(i, i + SOURCE_CHUNK) })));
  }
  return out;
}

async function syncUnlocked(container: MedusaContainer, ids: string[], ctx: IndexContext): Promise<number> {
  let written = 0;
  for (let i = 0; i < ids.length; i += SOURCE_CHUNK) {
    const chunk = ids.slice(i, i + SOURCE_CHUNK);
    const rows = await buildIndexRows(container, await sourcesInChunks(container, chunk), ctx);
    await indexService(container).replaceProducts(chunk, rows);
    written += rows.length;
  }
  return written;
}

async function rebuildUnlocked(container: MedusaContainer): Promise<{ products: number; rows: number }> {
  const ctx = await loadIndexContext(container);
  const products = await container
    .resolve(Modules.PRODUCT)
    .listProducts({ status: "published" }, { select: ["id"], take: null });
  const ids = products.map((p) => p.id);
  const rows = await buildIndexRows(container, await sourcesInChunks(container, ids), ctx);
  await indexService(container).replaceAll(rows);
  container
    .resolve(ContainerRegistrationKeys.LOGGER)
    .info(`[catalog-index] Rebuild: ${ids.length} sản phẩm, ${rows.length} dòng.`);
  return { products: ids.length, rows: rows.length };
}

/**
 * Đồng bộ ngay một tập sản phẩm (chờ khoá). Đọc nguồn SAU khi giữ khoá → luôn phản ánh trạng thái đã commit mới
 * nhất; mỗi lô sản phẩm thay trong một giao dịch.
 */
export async function syncCatalogProducts(container: MedusaContainer, productIds: string[]): Promise<number> {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0) return 0;
  return container
    .resolve(Modules.LOCKING)
    .execute(
      CATALOG_INDEX_LOCK,
      async () => syncUnlocked(container, ids, await loadIndexContext(container)),
      {
        timeout: LOCK_TIMEOUT_SECONDS,
      },
    );
}

/** Rebuild toàn phần: tính mọi dòng rồi thay cả bảng trong MỘT giao dịch (người đọc thấy bảng cũ tới khi commit). */
export async function rebuildCatalogIndex(
  container: MedusaContainer,
): Promise<{ products: number; rows: number }> {
  return container
    .resolve(Modules.LOCKING)
    .execute(CATALOG_INDEX_LOCK, () => rebuildUnlocked(container), { timeout: LOCK_TIMEOUT_SECONDS });
}

/** Ký hiệu "cần rebuild toàn phần" trong hàng đợi sản phẩm bẩn. */
export const REBUILD_MARK = "*";
const DRAIN_BATCH = 500;
// Lease ngắn + gia hạn mỗi 1/3 lease khi còn xả: tiến trình chết giữa chừng thì khoá tự hết sau ≤ 30 giây (lease
// dài 600 giây cũ làm index đứng 10 phút và chặn rebuild — chờ tối đa LOCK_TIMEOUT_SECONDS — tới khi hết hạn).
export const DRAIN_LOCK_EXPIRE_SECONDS = 30;

/** Đánh dấu sản phẩm cần đồng bộ (sự kiện) — ghi một dòng, rẻ; việc nặng do `drainCatalogIndex` làm theo lô. */
export async function markCatalogDirty(container: MedusaContainer, productIds: string[]): Promise<void> {
  await indexService(container).markDirty(productIds);
}

/**
 * Xả hàng đợi sản phẩm bẩn: chỉ MỘT tiến trình xả tại một thời điểm (khoá không chờ — tiến trình khác đang xả thì
 * trả về ngay, lượt xả đang chạy sẽ thấy dấu mới ở vòng lặp kế). Nhiều sự kiện của cùng sản phẩm gộp thành một lần
 * đồng bộ. Dấu đặt lại trong lúc đồng bộ được giữ cho vòng sau (so mốc marked_at). Trả số sản phẩm đã xử lý.
 */
export async function drainCatalogIndex(container: MedusaContainer): Promise<number> {
  const locking = container.resolve(Modules.LOCKING);
  const index = indexService(container);
  let processed = 0;
  // Vòng ngoài: sau khi nhả khoá còn dấu mới (đặt đúng lúc đang nhả) thì thử xả tiếp.
  for (let attempt = 0; attempt < 3; attempt++) {
    const ownerId = `drain-${randomUUID()}`;
    try {
      await locking.acquire(CATALOG_INDEX_LOCK, { ownerId, expire: DRAIN_LOCK_EXPIRE_SECONDS });
    } catch {
      return processed; // tiến trình khác đang giữ khoá (đang xả hoặc rebuild) — nó sẽ xử lý dấu này.
    }
    // Acquire lại cùng ownerId = gia hạn (SET XX). Gia hạn lỗi (Redis mất, app đã tắt) → bỏ qua: lease tự hết.
    const renewal = setInterval(
      () => {
        locking
          .acquire(CATALOG_INDEX_LOCK, { ownerId, expire: DRAIN_LOCK_EXPIRE_SECONDS })
          .catch(() => undefined);
      },
      (DRAIN_LOCK_EXPIRE_SECONDS * 1000) / 3,
    );
    renewal.unref?.();
    try {
      let ctx: IndexContext | null = null;
      for (;;) {
        const claims = await index.claimDirty(DRAIN_BATCH);
        if (claims.length === 0) break;
        if (claims.some((c) => c.product_id === REBUILD_MARK)) {
          await rebuildUnlocked(container);
          // Rebuild bao trùm mọi dấu có từ trước khi nó đọc nguồn.
          await index.clearDirty(claims);
        } else {
          ctx ??= await loadIndexContext(container);
          await syncUnlocked(
            container,
            claims.map((c) => c.product_id),
            ctx,
          );
          await index.clearDirty(claims);
        }
        processed += claims.length;
      }
    } finally {
      clearInterval(renewal);
      await locking.release(CATALOG_INDEX_LOCK, { ownerId });
    }
    if ((await index.dirtyCount()) === 0) break;
  }
  return processed;
}

let drainTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Hẹn một lượt xả sau `delayMs` (gộp mọi sự kiện đến trong khoảng đó thành một lô). Handler sự kiện chỉ đánh dấu rồi
 * trả về ngay → hàng đợi sự kiện không bị nghẽn bởi việc đồng bộ. Tiến trình chết trước khi xả → dấu còn trong DB,
 * job mỗi phút xả tiếp.
 */
export function scheduleCatalogDrain(container: MedusaContainer, delayMs = 250): void {
  if (drainTimer) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    drainCatalogIndex(container).catch((e: unknown) =>
      container
        .resolve(ContainerRegistrationKeys.LOGGER)
        .error(`[catalog-index] Xả hàng đợi lỗi: ${(e as Error).message}`),
    );
  }, delayMs);
  drainTimer.unref?.();
}

/** Đánh dấu sản phẩm có giá khuyến mãi đã hết hạn (ca biên "giá khuyến mãi hết hạn" của SPEC-catalog). */
export async function markExpiredPrices(container: MedusaContainer, now = new Date()): Promise<number> {
  const ids = await indexService(container).productIdsWithExpiredPrice(now);
  await markCatalogDirty(container, ids);
  return ids.length;
}
