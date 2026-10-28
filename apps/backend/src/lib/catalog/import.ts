import type { MedusaContainer } from "@medusajs/framework/types";
import { createHash } from "node:crypto";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import {
  createInventoryLevelsWorkflow,
  createProductsWorkflow,
  updateInventoryLevelsWorkflow,
  updateProductsWorkflow,
  updateProductVariantsWorkflow,
} from "@medusajs/medusa/core-flows";
import {
  IMPORT_COLUMNS,
  isNonEmpty,
  mibToBytes,
  parseCsv,
  toCsv,
  type ImportRow,
  type ImportRowError,
  validateImport,
  minutesToMs,
} from "@x-shop/domain";
import { CATALOG_IMPORT_MODULE } from "../../modules/catalog-import";
import type CatalogImportModuleService from "../../modules/catalog-import/service";
import { setProductFashionWorkflow } from "../../workflows/fashion/set-product-fashion";
import { withOwnedLock } from "../checkout/locks";
import { CURRENCY, OPTION_COLOR, OPTION_SIZE } from "./constants";
import { colorOf, loadDictionary, sizeOf } from "./dictionary";
import { loadProductSources } from "./product-source";

/** Giới hạn file nhập (ADM02): 2 MB — đủ cho ~20.000 dòng, chặn file làm treo tiến trình. */
export const MAX_IMPORT_BYTES = mibToBytes(2);

export interface PlannedVariant {
  line: number;
  sku: string;
  color: string | null;
  size: string | null;
  price: number;
  stock: number | null;
  existingVariantId: string | null;
}

export interface PlannedProduct {
  handle: string;
  title: string;
  kind: ImportRow["kind"];
  categoryId: string;
  category: string;
  material: string | null;
  materialLabel: string | null;
  description: string | null;
  existingId: string | null;
  variants: PlannedVariant[];
}

export interface ImportSummary {
  rows_total: number;
  rows_valid: number;
  products_new: number;
  products_existing: number;
  variants_new: number;
  variants_existing: number;
}

export interface ImportPreview {
  rows: ImportRow[];
  errors: ImportRowError[];
  plan: PlannedProduct[];
  summary: ImportSummary;
}

const PRODUCT_FIELDS = ["title", "kind", "category", "material", "description"] as const;

/** Nhãn chất liệu gốc (validateImport chỉ trả slug) — đọc lại ô thô theo số dòng. */
function rawMaterials(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch {
    return out;
  }
  const idx = (table[0] ?? []).map((h) => h.trim().toLowerCase()).indexOf("material");
  if (idx < 0) return out;
  table.forEach((cells, i) => {
    const v = (cells[idx] ?? "").trim().normalize("NFC");
    if (i > 0 && v) out.set(i + 1, v);
  });
  return out;
}

async function storeDefaults(container: MedusaContainer) {
  const [store] = await container.resolve(Modules.STORE).listStores({}, { take: 1 });
  if (!store || !isNonEmpty(store.default_sales_channel_id) || !isNonEmpty(store.default_location_id)) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Store chưa có kênh bán/kho mặc định — chạy seed nền",
    );
  }
  return { salesChannelId: store.default_sales_channel_id, locationId: store.default_location_id };
}

/**
 * Preview (S-206): kiểm từng dòng bằng `validateImport` của domain rồi đối chiếu dữ liệu hiện có — danh mục, bảng
 * màu/size, SKU thuộc sản phẩm khác (ADM01: SKU không tái sử dụng), dữ liệu cấp sản phẩm nhất quán giữa các dòng.
 * KHÔNG ghi gì. Lỗi nêu dòng (header = 1) + cột.
 */
export async function previewImport(container: MedusaContainer, text: string): Promise<ImportPreview> {
  const { rows, errors } = validateImport(text);
  const allErrors: ImportRowError[] = [...errors];
  const productService = container.resolve(Modules.PRODUCT);
  const handles = [...new Set(rows.map((r) => r.handle))];
  const skus = [...new Set(rows.map((r) => r.sku))];
  const categoryHandles = [...new Set(rows.map((r) => r.category))];
  // handle danh mục/sản phẩm và SKU là duy nhất → mỗi giá trị tra tối đa một dòng: `take` = số giá trị (không `take: null`).
  const [categories, products, variants, dict] = await Promise.all([
    categoryHandles.length
      ? productService.listProductCategories({ handle: categoryHandles }, { take: categoryHandles.length })
      : Promise.resolve([]),
    handles.length
      ? productService.listProducts({ handle: handles }, { select: ["id", "handle"], take: handles.length })
      : Promise.resolve([]),
    skus.length
      ? productService.listProductVariants(
          { sku: skus },
          { select: ["id", "sku", "product_id"], take: skus.length },
        )
      : Promise.resolve([]),
    loadDictionary(container),
  ]);
  const categoryId = new Map(categories.map((c) => [c.handle, c.id]));
  const productByHandle = new Map(products.map((p) => [p.handle, p.id]));
  const handleByProductId = new Map(products.map((p) => [p.id, p.handle]));
  const variantBySku = new Map(variants.map((v) => [v.sku as string, v]));
  const materials = rawMaterials(text);

  const plan = new Map<string, PlannedProduct>();
  const firstLine = new Map<string, ImportRow>();
  const valid: ImportRow[] = [];
  for (const r of rows) {
    const rowErrors: ImportRowError[] = [];
    const err = (column: string, message: string) => rowErrors.push({ line: r.line, column, message });
    const catId = categoryId.get(r.category);
    if (!isNonEmpty(catId)) err("category", `Danh mục "${r.category}" không tồn tại`);
    if (r.color !== null && !dict.colors.has(r.color))
      err("color", `Màu "${r.color}" chưa có trong bảng màu`);
    if (r.size !== null && !dict.sizes.has(r.size)) err("size", `Size "${r.size}" chưa có trong bảng size`);
    const head = firstLine.get(r.handle);
    if (head) {
      for (const f of PRODUCT_FIELDS) {
        if (head[f] !== r[f]) err(f, `Khác dòng ${head.line} của cùng sản phẩm "${r.handle}"`);
      }
      const p = plan.get(r.handle);
      if (p?.variants.some((v) => v.color === r.color && v.size === r.size) === true)
        err("color,size", `Trùng biến thể ${r.color ?? "-"}/${r.size ?? "-"} trong sản phẩm`);
      if (
        p &&
        p.variants.some(
          (v) => (v.color === null) !== (r.color === null) || (v.size === null) !== (r.size === null),
        )
      )
        err("color,size", "Các dòng của một sản phẩm phải cùng có/không có màu, size");
    } else firstLine.set(r.handle, r);
    const existingProductId = productByHandle.get(r.handle) ?? null;
    const existingVariant = variantBySku.get(r.sku);
    if (existingVariant && existingVariant.product_id !== existingProductId) {
      err(
        "sku",
        `SKU đã thuộc sản phẩm khác (${handleByProductId.get(existingVariant.product_id ?? "") ?? existingVariant.product_id})`,
      );
    }
    if (isNonEmpty(existingProductId) && !existingVariant) {
      err("sku", "Thêm SKU mới vào sản phẩm đã có chưa hỗ trợ qua CSV — tạo biến thể trong Admin");
    }
    if (rowErrors.length) {
      allErrors.push(...rowErrors);
      continue;
    }
    valid.push(r);
    const p =
      plan.get(r.handle) ??
      ({
        handle: r.handle,
        title: r.title,
        kind: r.kind,
        categoryId: catId as string,
        category: r.category,
        material: r.material,
        materialLabel: materials.get(r.line) ?? r.material,
        description: r.description,
        existingId: existingProductId,
        variants: [],
      } satisfies PlannedProduct);
    p.variants.push({
      line: r.line,
      sku: r.sku,
      color: r.color,
      size: r.size,
      price: r.price,
      stock: r.stock,
      existingVariantId: existingVariant?.id ?? null,
    });
    plan.set(r.handle, p);
  }
  const planned = [...plan.values()];
  allErrors.sort((a, b) => a.line - b.line || (a.column < b.column ? -1 : 1));
  return {
    rows: valid,
    errors: allErrors,
    plan: planned,
    summary: {
      rows_total: rows.length + new Set(errors.map((e) => e.line).filter((l) => l > 1)).size,
      rows_valid: valid.length,
      products_new: planned.filter((p) => !isNonEmpty(p.existingId)).length,
      products_existing: planned.filter((p) => isNonEmpty(p.existingId)).length,
      variants_new: planned.flatMap((p) => p.variants).filter((v) => !isNonEmpty(v.existingVariantId)).length,
      variants_existing: planned.flatMap((p) => p.variants).filter((v) => isNonEmpty(v.existingVariantId))
        .length,
    },
  };
}

export interface ImportResult {
  products_created: string[];
  products_updated: string[];
  price_changes: { sku: string; before: number | null; after: number }[];
  stock_changes: { sku: string; before: number | null; after: number }[];
}

type VariantInventory = {
  variant_id: string;
  sku: string;
  inventoryItemId: string | null;
  stocked: number | null;
};

async function variantInventory(
  container: MedusaContainer,
  productId: string,
  locationId: string,
): Promise<Map<string, VariantInventory>> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "product_variant",
    fields: [
      "id",
      "sku",
      "inventory_items.inventory_item_id",
      "inventory_items.inventory.location_levels.location_id",
      "inventory_items.inventory.location_levels.stocked_quantity",
    ],
    filters: { product_id: productId },
  });
  const rows = data as unknown as {
    id: string;
    sku: string | null;
    inventory_items?: {
      inventory_item_id: string;
      inventory?: { location_levels?: { location_id: string; stocked_quantity: number }[] | null } | null;
    }[];
  }[];
  return new Map(
    rows.map((v) => {
      const item = v.inventory_items?.[0];
      const level = item?.inventory?.location_levels?.find((l) => l.location_id === locationId);
      return [
        v.sku ?? "",
        {
          variant_id: v.id,
          sku: v.sku ?? "",
          inventoryItemId: item?.inventory_item_id ?? null,
          stocked: level ? Number(level.stocked_quantity) : null,
        },
      ];
    }),
  );
}

async function setStock(
  container: MedusaContainer,
  inv: VariantInventory,
  locationId: string,
  qty: number,
  result: ImportResult,
): Promise<void> {
  if (!isNonEmpty(inv.inventoryItemId) || inv.stocked === qty) return;
  if (inv.stocked === null) {
    await createInventoryLevelsWorkflow(container).run({
      input: {
        inventory_levels: [
          { inventory_item_id: inv.inventoryItemId, location_id: locationId, stocked_quantity: qty },
        ],
      },
    });
  } else {
    await updateInventoryLevelsWorkflow(container).run({
      input: {
        updates: [{ inventory_item_id: inv.inventoryItemId, location_id: locationId, stocked_quantity: qty }],
      },
    });
  }
  result.stock_changes.push({ sku: inv.sku, before: inv.stocked, after: qty });
}

/**
 * Ghi kế hoạch nhập: sản phẩm mới tạo ở trạng thái draft (xuất bản vẫn phải qua kiểm trước xuất bản); sản phẩm đã có
 * cập nhật nội dung, giá, tồn theo SKU. Mọi bước là upsert theo handle/SKU → chạy lại sau lỗi giữa chừng không tạo
 * trùng (bản ghi đã tạo ở lần trước được coi là "đã có").
 */
export async function applyImport(container: MedusaContainer, plan: PlannedProduct[]): Promise<ImportResult> {
  const { salesChannelId, locationId } = await storeDefaults(container);
  const dict = await loadDictionary(container);
  const result: ImportResult = {
    products_created: [],
    products_updated: [],
    price_changes: [],
    stock_changes: [],
  };
  for (const p of plan) {
    let productId = p.existingId;
    const attributes = {
      kind: p.kind,
      material: p.material,
      material_label: p.materialLabel,
    };
    if (!isNonEmpty(productId)) {
      const colors = [...new Set(p.variants.map((v) => v.color).filter((c): c is string => c !== null))].sort(
        (a, b) => colorOf(dict, a).rank - colorOf(dict, b).rank,
      );
      const sizes = [...new Set(p.variants.map((v) => v.size).filter((s): s is string => s !== null))].sort(
        (a, b) => sizeOf(dict, a).rank - sizeOf(dict, b).rank,
      );
      const options = [
        ...(colors.length ? [{ title: OPTION_COLOR, values: colors }] : []),
        ...(sizes.length ? [{ title: OPTION_SIZE, values: sizes }] : []),
      ];
      const { result: created } = await createProductsWorkflow(container).run({
        input: {
          products: [
            {
              title: p.title,
              handle: p.handle,
              description: p.description,
              status: "draft",
              category_ids: [p.categoryId],
              sales_channels: [{ id: salesChannelId }],
              ...(options.length ? { options } : {}),
              variants: p.variants.map((v, i) => ({
                title:
                  [
                    isNonEmpty(v.color) ? colorOf(dict, v.color).label : null,
                    isNonEmpty(v.size) ? sizeOf(dict, v.size).label : null,
                  ]
                    .filter(Boolean)
                    .join(" / ") || p.title,
                sku: v.sku,
                manage_inventory: true,
                variant_rank: i,
                options: {
                  ...(isNonEmpty(v.color) ? { [OPTION_COLOR]: v.color } : {}),
                  ...(isNonEmpty(v.size) ? { [OPTION_SIZE]: v.size } : {}),
                },
                prices: [{ amount: v.price, currency_code: CURRENCY }],
              })),
            },
          ],
        },
      });
      productId = (created[0] as { id: string }).id;
      result.products_created.push(productId);
      for (const v of p.variants) result.price_changes.push({ sku: v.sku, before: null, after: v.price });
    } else {
      await updateProductsWorkflow(container).run({
        input: {
          selector: { id: productId },
          update: { title: p.title, description: p.description, category_ids: [p.categoryId] },
        },
      });
      result.products_updated.push(productId);
      const [source] = await loadProductSources(container, { id: [productId] });
      const before = new Map((source?.variants ?? []).map((v) => [v.sku, v]));
      const priceUpdates = p.variants.filter((v) => before.get(v.sku)?.basePrice !== v.price);
      if (priceUpdates.length) {
        await updateProductVariantsWorkflow(container).run({
          input: {
            product_variants: priceUpdates.map((v) => ({
              id: v.existingVariantId as string,
              prices: [{ amount: v.price, currency_code: CURRENCY }],
            })),
          },
        });
        for (const v of priceUpdates)
          result.price_changes.push({
            sku: v.sku,
            before: before.get(v.sku)?.basePrice ?? null,
            after: v.price,
          });
      }
    }
    await setProductFashionWorkflow(container).run({ input: { product_id: productId, attributes } });
    const inventory = await variantInventory(container, productId, locationId);
    for (const v of p.variants) {
      const inv = inventory.get(v.sku);
      if (v.stock !== null && inv) await setStock(container, inv, locationId, v.stock, result);
    }
  }
  return result;
}

/**
 * Xuất catalog ra CSV cùng định dạng nhập (vòng nhập/xuất được), chống công thức bằng `toCsv` của domain
 * (ô bắt đầu = + - @ được thêm tiền tố '). Có BOM để Excel nhận UTF-8 tiếng Việt.
 */
export async function exportProductsCsv(container: MedusaContainer): Promise<string> {
  const { locationId } = await storeDefaults(container);
  const products = await container
    .resolve(Modules.PRODUCT)
    .listProducts({}, { select: ["id"], take: null, order: { created_at: "ASC" } });
  const lines: (string | number | null)[][] = [[...IMPORT_COLUMNS]];
  for (let i = 0; i < products.length; i += 100) {
    const sources = await loadProductSources(container, { id: products.slice(i, i + 100).map((p) => p.id) });
    for (const p of sources) {
      const inventory = await variantInventory(container, p.id, locationId);
      for (const v of p.variants) {
        lines.push([
          p.handle,
          p.title,
          p.attributes?.kind ?? "",
          p.categories[0]?.handle ?? "",
          p.attributes?.materialLabel ?? p.attributes?.material ?? "",
          p.description ?? "",
          v.sku,
          v.color ?? "",
          v.size ?? "",
          v.basePrice,
          inventory.get(v.sku)?.stocked ?? null,
        ]);
      }
    }
  }
  return String.fromCharCode(0xfeff) + toCsv(lines);
}

/** Khoá ghi nhập CSV: mọi commit chạy tuần tự (hai import cùng tạo một handle không thể chen nhau). */
export const CATALOG_IMPORT_LOCK = "x-shop:catalog-import";
/** Chờ tối đa khi một commit khác đang giữ khóa (như `timeout: 300` của `locking.execute` trước đây). */
export const IMPORT_LOCK_WAIT_MS = minutesToMs(5);
/**
 * Lease khóa nhập: gia hạn nền mỗi 1/3 TTL (20 s) suốt lúc commit chạy — file lớn chạy bao lâu cũng giữ khóa; tiến trình
 * chết thì khóa tự nhả sau ≤ 60 s (bằng hạn mặc định của `locking.execute` native).
 */
const IMPORT_LOCK_TTL_SECONDS = 60;

export interface ImportJobView {
  import_id: string;
  status: "previewed" | "committed" | "failed";
  file_hash: string;
  file_name: string | null;
  summary: ImportSummary;
  errors: ImportRowError[];
  result: ImportResult | null;
  previewed_by: string;
  committed_by: string | null;
  committed_at: string | null;
}

type JobRecord = {
  id: string;
  status: ImportJobView["status"];
  file_hash: string;
  file_name: string | null;
  content: string;
  summary: unknown;
  errors: unknown;
  result: unknown;
  previewed_by: string;
  committed_by: string | null;
  committed_at: Date | string | null;
};

export function jobView(j: JobRecord): ImportJobView {
  return {
    import_id: j.id,
    status: j.status,
    file_hash: j.file_hash,
    file_name: j.file_name,
    summary: j.summary as ImportSummary,
    errors: j.errors as ImportRowError[],
    result: (j.result as ImportResult | null) ?? null,
    previewed_by: j.previewed_by,
    committed_by: j.committed_by,
    committed_at: isNonEmpty(j.committed_at) ? new Date(j.committed_at).toISOString() : null,
  };
}

function importService(container: MedusaContainer): CatalogImportModuleService {
  return container.resolve(CATALOG_IMPORT_MODULE);
}

/** Preview + lưu import_job (hash file, lỗi, tóm tắt, người thao tác). Không ghi gì vào catalog. */
export async function recordPreview(
  container: MedusaContainer,
  input: { text: string; bytes: Buffer; fileName: string | null; actorId: string },
): Promise<{ job: ImportJobView; rows: ImportRow[] }> {
  const preview = await previewImport(container, input.text);
  const job = (await importService(container).createCatalogImportJobs({
    file_hash: createHash("sha256").update(input.bytes).digest("hex"),
    file_name: input.fileName,
    content: input.text,
    status: "previewed",
    rows_total: preview.summary.rows_total,
    rows_valid: preview.summary.rows_valid,
    errors: preview.errors,
    summary: preview.summary,
    previewed_by: input.actorId,
  } as never)) as unknown as JobRecord;
  return { job: jobView(job), rows: preview.rows };
}

export type CommitOutcome =
  | { kind: "committed"; job: ImportJobView; replayed: boolean }
  | { kind: "has_errors"; job: ImportJobView; errors: ImportRowError[] };

/**
 * Commit idempotent theo import id (S-206): đã commit → trả kết quả đã lưu, không ghi lại; còn lỗi (lúc preview hoặc
 * khi kiểm lại trên dữ liệu hiện tại) → từ chối. Lỗi giữa chừng → job `failed`, gọi lại commit sẽ chạy tiếp an toàn.
 */
export async function commitImportJob(
  container: MedusaContainer,
  importId: string,
  actorId: string,
  /**
   * Chạy TRONG khóa nhập sau khi job ở trạng thái committed (cả lần ghi lẫn lần trả lại) — vd ghi audit đúng một lần:
   * các commit đồng thời cùng id đi tuần tự qua đây. Lỗi ở hook được ném ra (job vẫn committed; gọi lại sẽ chạy lại hook).
   */
  onCommitted?: (job: ImportJobView, replayed: boolean) => Promise<void>,
): Promise<CommitOutcome> {
  const service = importService(container);
  // Mọi lời gọi Redis có hạn (LOCK_CALL_TIMEOUT_MS): Redis câm/mất → LOCK_UNAVAILABLE (503) và KHÔNG chạy commit; khóa
  // bận quá IMPORT_LOCK_WAIT_MS → BUSY_RETRY. Như `locking.execute` native: lease bị chủ khác lấy mất giữa chừng (Redis
  // không trả lời lâu hơn TTL) → báo lỗi thay vì trả "committed" như thể độc quyền; commit idempotent nên gọi lại an toàn.
  return withOwnedLock(
    container.resolve(Modules.LOCKING),
    CATALOG_IMPORT_LOCK,
    {
      waitMs: IMPORT_LOCK_WAIT_MS,
      ttlSeconds: IMPORT_LOCK_TTL_SECONDS,
      scope: "catalog-import",
      ownerPrefix: "import",
      failOnLeaseLoss: true,
      onReleaseError: (e) =>
        container
          .resolve(ContainerRegistrationKeys.LOGGER)
          .warn(`[import] Nhả khoá lỗi/quá hạn (lease tự hết): ${(e as Error).message}`),
    },
    async (): Promise<CommitOutcome> => {
      const [job] = (await service.listCatalogImportJobs(
        { id: importId },
        { take: 1 },
      )) as unknown as JobRecord[];
      if (!job) throw new MedusaError(MedusaError.Types.NOT_FOUND, `Không có import ${importId}`);
      if (job.status === "committed") {
        const view = jobView(job);
        await onCommitted?.(view, true);
        return { kind: "committed", job: view, replayed: true };
      }
      if ((job.errors as unknown[]).length) {
        return { kind: "has_errors", job: jobView(job), errors: job.errors as ImportRowError[] };
      }
      // Dữ liệu có thể đã đổi từ lúc preview — kiểm lại trên trạng thái hiện tại.
      const preview = await previewImport(container, job.content);
      if (preview.errors.length) return { kind: "has_errors", job: jobView(job), errors: preview.errors };
      let updated: JobRecord;
      try {
        const result = await applyImport(container, preview.plan);
        updated = (await service.updateCatalogImportJobs({
          id: job.id,
          status: "committed",
          result,
          last_error: null,
          committed_by: actorId,
          committed_at: new Date(),
        } as never)) as unknown as JobRecord;
      } catch (e) {
        await service.updateCatalogImportJobs({
          id: job.id,
          status: "failed",
          last_error: (e as Error).message ?? String(e),
        } as never);
        throw e;
      }
      // Ngoài try: job đã committed — lỗi của hook không được hạ job về `failed`.
      const view = jobView(updated);
      await onCommitted?.(view, false);
      return { kind: "committed", job: view, replayed: false };
    },
  );
}
