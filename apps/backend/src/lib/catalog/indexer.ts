import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { searchKey } from "@x-shop/domain";
import { CATALOG_INDEX_MODULE } from "../../modules/catalog-index";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import type CatalogIndexModuleService from "../../modules/catalog-index/service";
import type { CatalogIndexRow, DirtyClaim, DirtyDefer } from "../../modules/catalog-index/service";
import { acquireOrdered, isLockUnavailable, releaseOwnedQuietly, withOwnedLock } from "../checkout/locks";
import { colorOf, loadDictionary, sizeOf, type Dictionary } from "./dictionary";
import { loadProductSources, PRODUCT_SOURCE_BATCH, toVnd, type ProductSource } from "./product-source";
import {
  loadInStock,
  loadVariantPrices,
  resolvePricingContext,
  type PricingContext,
  type VariantPrice,
} from "./sell-state";

/** Khoá ghi read model: đồng bộ theo sự kiện và rebuild toàn phần không xen kẽ (không ghi đè bằng dữ liệu cũ). */
export const CATALOG_INDEX_LOCK = "x-shop:catalog-index";
/** Chờ tối đa khi khóa đang bị giữ (rebuild/xả dài); Redis câm thì lời gọi có hạn riêng (LOCK_CALL_TIMEOUT_MS). */
const LOCK_WAIT_MS = 300_000;
/** Lease khóa của sync/rebuild — gia hạn nền khi còn chạy; tiến trình chết thì tự hết sau ≤ 30 giây. */
const WRITE_LOCK_TTL_SECONDS = 30;
const LOCK_SCOPE = "catalog-index";

const withIndexLock = <T>(container: MedusaContainer, fn: () => Promise<T>): Promise<T> =>
  withOwnedLock(
    container.resolve(Modules.LOCKING),
    CATALOG_INDEX_LOCK,
    {
      waitMs: LOCK_WAIT_MS,
      ttlSeconds: WRITE_LOCK_TTL_SECONDS,
      scope: LOCK_SCOPE,
      onReleaseError: (e) =>
        container
          .resolve(ContainerRegistrationKeys.LOGGER)
          .warn(`[catalog-index] Nhả khoá lỗi/quá hạn (lease tự hết): ${(e as Error).message}`),
    },
    fn,
  );
/** Số sản phẩm mỗi lô đồng bộ/rebuild (đọc nguồn + giá + tồn cho lô rồi mới sang lô kế). */
const SOURCE_CHUNK = PRODUCT_SOURCE_BATCH;
/** Số SKU nêu ví dụ trong log lệch/thiếu giá. */
const LOG_SAMPLE = 10;

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
 * Đối chiếu một lượt dựng read model: SKU bán được theo nguồn độc lập (giá niêm yết VND đọc cùng ảnh chụp sản phẩm,
 * không qua calculated_price) so với dòng đã dựng — để lỗi đọc giá hàng loạt không còn làm mất sản phẩm im lặng.
 */
export interface IndexBuildReport {
  /** Số dòng (SKU × kênh) kỳ vọng: sản phẩm published có kênh bán, SKU khác rỗng, có giá niêm yết VND hợp lệ. */
  expected: number;
  /** Số dòng đã dựng. */
  rows: number;
  /** SKU có giá niêm yết nhưng KHÔNG ra giá bán (calculated_price) — bất thường, phải bằng 0. */
  missing: string[];
  /** Sản phẩm có ít nhất một SKU trong `missing` (không được ghi vào bảng). */
  productsWithMissing: string[];
  /** SKU thật sự không có giá bán (không giá niêm yết, không price list áp được) — loại khỏi index, có log. */
  unpriced: string[];
  /** Sản phẩm published có kênh bán nhưng không SKU nào vào index. */
  productsWithoutRows: string[];
}

const emptyReport = (): IndexBuildReport => ({
  expected: 0,
  rows: 0,
  missing: [],
  productsWithMissing: [],
  unpriced: [],
  productsWithoutRows: [],
});

function mergeReport(into: IndexBuildReport, r: IndexBuildReport): void {
  into.expected += r.expected;
  into.rows += r.rows;
  into.missing.push(...r.missing);
  into.productsWithMissing.push(...r.productsWithMissing);
  into.unpriced.push(...r.unpriced);
  into.productsWithoutRows.push(...r.productsWithoutRows);
}

/**
 * Dòng read model cho các sản phẩm: chỉ sản phẩm `published`, một dòng mỗi SKU có giá VND × mỗi kênh bán của sản
 * phẩm. SKU không có giá bán hiện hành không vào index (không bán được). Kèm báo cáo đối chiếu (`IndexBuildReport`).
 */
export async function buildIndexRowsWithReport(
  container: MedusaContainer,
  products: ProductSource[],
  ctx: IndexContext,
): Promise<{ rows: CatalogIndexRow[]; report: IndexBuildReport }> {
  const published = products.filter((p) => p.status === "published" && p.salesChannelIds.length > 0);
  const prices: Map<string, VariantPrice> = await loadVariantPrices(
    container,
    published.flatMap((p) => p.variants.map((v) => v.id)),
    ctx.pricing,
  );
  const report = emptyReport();
  for (const p of published) {
    let productRows = 0;
    let productMissing = false;
    for (const v of p.variants) {
      if (v.sku === "") continue;
      const listed = v.basePrice !== null && toVnd(v.basePrice) !== null;
      if (listed) report.expected += p.salesChannelIds.length;
      if (prices.has(v.id)) productRows += p.salesChannelIds.length;
      else if (listed) {
        report.missing.push(v.id);
        productMissing = true;
      } else report.unpriced.push(v.id);
    }
    if (productMissing) report.productsWithMissing.push(p.id);
    if (productRows === 0) report.productsWithoutRows.push(p.id);
  }
  const rows: CatalogIndexRow[] = [];
  // Còn hàng tính theo kênh: gom biến thể của mọi sản phẩm theo kênh rồi hỏi theo lô mỗi kênh.
  const byChannel = new Map<string, ProductSource[]>();
  for (const p of published) {
    for (const ch of p.salesChannelIds) {
      const list = byChannel.get(ch);
      if (list) list.push(p);
      else byChannel.set(ch, [p]);
    }
  }
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
  report.rows = rows.length;
  return { rows, report };
}

/** Như `buildIndexRowsWithReport`, chỉ trả dòng. */
export async function buildIndexRows(
  container: MedusaContainer,
  products: ProductSource[],
  ctx: IndexContext,
): Promise<CatalogIndexRow[]> {
  return (await buildIndexRowsWithReport(container, products, ctx)).rows;
}

function indexService(container: MedusaContainer): CatalogIndexModuleService {
  return container.resolve(CATALOG_INDEX_MODULE);
}

const sample = (ids: string[]): string =>
  ids.slice(0, LOG_SAMPLE).join(", ") + (ids.length > LOG_SAMPLE ? `, … (+${ids.length - LOG_SAMPLE})` : "");

/**
 * Kiểm cuối sau khi ghi: (1) SKU có giá niêm yết mà không ra giá bán, (2) số dòng trong bảng khác số dòng vừa ghi →
 * log ERROR kèm số liệu (không im lặng). SKU thật sự không có giá → log WARN (loại có chủ đích). Trả true nếu khớp.
 */
function reportBuild(
  container: MedusaContainer,
  op: "rebuild" | "sync",
  report: IndexBuildReport,
  stored: number,
): boolean {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  if (report.unpriced.length > 0) {
    logger.warn(
      `[catalog-index] ${op}: ${report.unpriced.length} SKU không có giá bán hiện hành — không vào index ` +
        `(${report.productsWithoutRows.length} sản phẩm không còn dòng nào). SKU: ${sample(report.unpriced)}`,
    );
  }
  const ok = report.missing.length === 0 && stored === report.rows;
  if (!ok) {
    logger.error(
      `[catalog-index] LỆCH read model sau ${op}: kỳ vọng ${report.expected} dòng bán được (SKU có giá niêm yết × ` +
        `kênh), dựng ${report.rows}, trong bảng ${stored}; ${report.missing.length} SKU có giá niêm yết nhưng ` +
        `không ra giá bán${report.missing.length ? `: ${sample(report.missing)}` : ""}.`,
    );
  }
  return ok;
}

/** Kind ngoại lệ vận hành khi read model dựng lệch (SKU có giá niêm yết mà không ra giá bán) — D-040. */
export const CATALOG_INDEX_MISMATCH_KIND = "catalog_index_mismatch";

/**
 * Mở ngoại lệ `catalog_index_mismatch` nếu CHƯA có cái đang mở/đang xử lý cùng kind (nhiều lượt lỗi liên tiếp chỉ
 * một ngoại lệ; xử lý xong mà lỗi tái diễn thì mở lại). Gọi dưới khoá ghi index nên không tranh nhau.
 */
async function openMismatchException(
  container: MedusaContainer,
  op: "rebuild" | "sync",
  report: IndexBuildReport,
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  try {
    await container.resolve<CheckoutModuleService>(CHECKOUT_MODULE).openOpsExceptionIfNoneActive({
      kind: CATALOG_INDEX_MISMATCH_KIND,
      dedupe_key: `${CATALOG_INDEX_MISMATCH_KIND}:${randomUUID()}`,
      priority: "high",
      detail: {
        op,
        expected: report.expected,
        built: report.rows,
        missing: report.missing.length,
        missing_sample: report.missing.slice(0, LOG_SAMPLE),
        products_with_missing: report.productsWithMissing.length,
      },
    });
  } catch (e) {
    logger.error(
      `[catalog-index] Không mở được ngoại lệ ${CATALOG_INDEX_MISMATCH_KIND}: ${(e as Error).message}`,
    );
  }
}

/**
 * Sync theo lô: sản phẩm có SKU thiếu giá bán KHÔNG được ghi (giữ dòng cũ của nó — hơn là xoá khỏi listing); các sản
 * phẩm còn lại trong lô vẫn ghi bình thường (lỗi cô lập theo sản phẩm, không kéo cả lô). Có sản phẩm bị bỏ → log ERROR
 * + mở ngoại lệ (cùng kind với rebuild).
 */
async function syncUnlocked(
  container: MedusaContainer,
  ids: string[],
  ctx: IndexContext,
): Promise<{ rows: number; skipped: Set<string> }> {
  const index = indexService(container);
  const report = emptyReport();
  const written = new Set<string>();
  const skipped = new Set<string>();
  let writtenRows = 0;
  for (let i = 0; i < ids.length; i += SOURCE_CHUNK) {
    const chunk = ids.slice(i, i + SOURCE_CHUNK);
    const built = await buildIndexRowsWithReport(
      container,
      await loadProductSources(container, { id: chunk }),
      ctx,
    );
    const skip = new Set(built.report.productsWithMissing);
    const okIds = chunk.filter((id) => !skip.has(id));
    for (const id of skip) skipped.add(id);
    const okRows = built.rows.filter((r) => !skip.has(r.product_id));
    await index.replaceProducts(okIds, okRows);
    for (const id of okIds) written.add(id);
    writtenRows += okRows.length;
    mergeReport(report, built.report);
  }
  // Đang giữ khoá ghi → không ai khác ghi các sản phẩm này giữa lúc ghi và lúc đếm.
  const stored = written.size > 0 ? await index.countRows([...written]) : 0;
  reportBuild(container, "sync", { ...report, rows: writtenRows }, stored);
  if (report.missing.length > 0) await openMismatchException(container, "sync", report);
  return { rows: writtenRows, skipped };
}

export interface RebuildResult {
  products: number;
  /** Số dòng đã ghi vào bảng (0 khi rebuild bị hủy vì `missing > 0` — bảng cũ được giữ). */
  rows: number;
  /** Số dòng kỳ vọng theo giá niêm yết (xem `IndexBuildReport.expected`). */
  expected: number;
  /** SKU có giá niêm yết mà không ra giá bán — khác 0 là lỗi (đã log ERROR). */
  missing: number;
  /** SKU thật sự không có giá bán (đã loại, log WARN). */
  unpriced: number;
}

/**
 * Rebuild theo lô `SOURCE_CHUNK` sản phẩm (như sync) nhưng gom mọi dòng rồi thay cả bảng trong MỘT giao dịch cuối —
 * người đọc thấy bảng cũ tới khi commit.
 */
async function rebuildUnlocked(container: MedusaContainer): Promise<RebuildResult> {
  const ctx = await loadIndexContext(container);
  const index = indexService(container);
  const products = await container
    .resolve(Modules.PRODUCT)
    .listProducts({ status: "published" }, { select: ["id"], take: null, order: { id: "ASC" } });
  const ids = products.map((p) => p.id);
  const rows: CatalogIndexRow[] = [];
  const report = emptyReport();
  for (let i = 0; i < ids.length; i += SOURCE_CHUNK) {
    const built = await buildIndexRowsWithReport(
      container,
      await loadProductSources(container, { id: ids.slice(i, i + SOURCE_CHUNK) }),
      ctx,
    );
    for (const r of built.rows) rows.push(r);
    mergeReport(report, built.report);
  }
  if (report.missing.length > 0) {
    // Dấu hiệu lỗi hệ thống (đọc giá hỏng): KHÔNG thay bảng — giữ bảng cũ (còn đúng hơn bảng thiếu dòng), báo ngay.
    reportBuild(container, "rebuild", report, await index.countRows());
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(
        `[catalog-index] Rebuild BỊ HỦY, giữ bảng cũ: ${report.missing.length} SKU có giá niêm yết nhưng không ra ` +
          `giá bán (kỳ vọng ${report.expected} dòng, dựng ${report.rows}).`,
      );
    await openMismatchException(container, "rebuild", report);
    return {
      products: ids.length,
      rows: 0,
      expected: report.expected,
      missing: report.missing.length,
      unpriced: report.unpriced.length,
    };
  }
  await index.replaceAll(rows);
  reportBuild(container, "rebuild", report, await index.countRows());
  container
    .resolve(ContainerRegistrationKeys.LOGGER)
    .info(
      `[catalog-index] Rebuild: ${ids.length} sản phẩm, ${rows.length} dòng (kỳ vọng ${report.expected}, ` +
        `thiếu giá bán ${report.missing.length}, không giá ${report.unpriced.length}).`,
    );
  return {
    products: ids.length,
    rows: rows.length,
    expected: report.expected,
    missing: report.missing.length,
    unpriced: report.unpriced.length,
  };
}

/**
 * Đồng bộ ngay một tập sản phẩm (chờ khoá). Đọc nguồn SAU khi giữ khoá → luôn phản ánh trạng thái đã commit mới
 * nhất; mỗi lô sản phẩm thay trong một giao dịch.
 */
export async function syncCatalogProducts(container: MedusaContainer, productIds: string[]): Promise<number> {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0) return 0;
  return withIndexLock(container, async () => {
    const { rows } = await syncUnlocked(container, ids, await loadIndexContext(container));
    return rows;
  });
}

/** Rebuild toàn phần: tính mọi dòng rồi thay cả bảng trong MỘT giao dịch (người đọc thấy bảng cũ tới khi commit). */
export async function rebuildCatalogIndex(container: MedusaContainer): Promise<RebuildResult> {
  return withIndexLock(container, () => rebuildUnlocked(container));
}

/** Ký hiệu "cần rebuild toàn phần" trong hàng đợi sản phẩm bẩn. */
export const REBUILD_MARK = "*";
const DRAIN_BATCH = 500;
/** Backoff (giây) trước lần thử lại thứ n của sản phẩm bị bỏ qua vì lệch giá: 1 → 5 → 15 → 15 phút. */
export const SKIP_RETRY_DELAYS_SECONDS = [60, 300, 900, 900] as const;
/** Số lần bị bỏ qua tối đa; lần thứ N này thì xoá dấu (ngoại lệ catalog_index_mismatch đã mở lo tiếp). */
export const SKIP_MAX_ATTEMPTS = SKIP_RETRY_DELAYS_SECONDS.length + 1;
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
      // Không chờ khoá (waitMs 0); gia hạn lease nền do acquireOrdered đảm nhiệm (cùng ownerId, bỏ qua lỗi tạm).
      await acquireOrdered(locking, [CATALOG_INDEX_LOCK], {
        ownerId,
        waitMs: 0,
        ttlSeconds: DRAIN_LOCK_EXPIRE_SECONDS,
        scope: LOCK_SCOPE,
      });
    } catch (e) {
      // Bận: tiến trình khác đang giữ (xả/rebuild) — nó sẽ xử lý dấu này. Redis lỗi/không trả lời: bỏ lượt, dấu bẩn còn
      // trong DB nên lượt/job sau xả tiếp.
      if (isLockUnavailable(e)) {
        container
          .resolve(ContainerRegistrationKeys.LOGGER)
          .warn(`[catalog-index] Bỏ lượt xả — hạ tầng khoá không sẵn sàng: ${(e as Error).message}`);
      }
      return processed;
    }
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
          const { skipped } = await syncUnlocked(
            container,
            claims.map((c) => c.product_id),
            ctx,
          );
          // Sản phẩm bị bỏ qua (lệch giá) KHÔNG xoá dấu: lùi giờ thử lại; hết lượt thì xoá, ngoại lệ lo tiếp.
          const defers: DirtyDefer[] = [];
          const giveUp: DirtyClaim[] = [];
          const done: DirtyClaim[] = [];
          for (const c of claims) {
            if (!skipped.has(c.product_id)) done.push(c);
            else if (c.attempts + 1 >= SKIP_MAX_ATTEMPTS) giveUp.push(c);
            else
              defers.push({
                ...c,
                attempts: c.attempts + 1,
                delay_seconds: SKIP_RETRY_DELAYS_SECONDS[c.attempts] ?? SKIP_RETRY_DELAYS_SECONDS.at(-1)!,
              });
          }
          if (giveUp.length > 0) {
            container
              .resolve(ContainerRegistrationKeys.LOGGER)
              .error(
                `[catalog-index] Bỏ thử lại sau ${SKIP_MAX_ATTEMPTS} lần: ${giveUp.length} sản phẩm vẫn lệch giá, ` +
                  `xoá dấu (xử lý theo ngoại lệ ${CATALOG_INDEX_MISMATCH_KIND}): ${sample(giveUp.map((c) => c.product_id))}`,
              );
          }
          await index.clearDirty([...done, ...giveUp]);
          await index.deferDirty(defers);
        }
        processed += claims.length;
      }
    } finally {
      const err = await releaseOwnedQuietly(locking, ownerId, [CATALOG_INDEX_LOCK]);
      if (err) {
        container
          .resolve(ContainerRegistrationKeys.LOGGER)
          .warn(`[catalog-index] Nhả khoá xả lỗi/quá hạn (lease tự hết): ${(err as Error).message}`);
      }
    }
    if ((await index.dirtyCount(true)) === 0) break;
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
