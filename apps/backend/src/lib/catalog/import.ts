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
  parseCsv,
  toCsv,
  validateImport,
  type ImportRow,
  type ImportRowError,
} from "@x-shop/domain";
import { CATALOG_IMPORT_MODULE } from "../../modules/catalog-import";
import type CatalogImportModuleService from "../../modules/catalog-import/service";
import { setProductFashionWorkflow } from "../../workflows/fashion/set-product-fashion";
import { CURRENCY, OPTION_COLOR, OPTION_SIZE } from "./constants";
import { colorOf, loadDictionary, sizeOf } from "./dictionary";
import { loadProductSources } from "./product-source";

/** Giới hạn file nhập (ADM02): 2 MB — đủ cho ~20.000 dòng, chặn file làm treo tiến trình. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

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
  if (!store?.default_sales_channel_id || !store.default_location_id) {
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
  const [categories, products, variants, dict] = await Promise.all([
    rows.length
      ? productService.listProductCategories(
          { handle: [...new Set(rows.map((r) => r.category))] },
          { take: null },
        )
      : Promise.resolve([]),
    handles.length
      ? productService.listProducts({ handle: handles }, { select: ["id", "handle"], take: null })
      : Promise.resolve([]),
    skus.length
      ? productService.listProductVariants({ sku: skus }, { select: ["id", "sku", "product_id"], take: null })
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
    if (!catId) err("category", `Danh mục "${r.category}" không tồn tại`);
    if (r.color !== null && !dict.colors.has(r.color))
      err("color", `Màu "${r.color}" chưa có trong bảng màu`);
    if (r.size !== null && !dict.sizes.has(r.size)) err("size", `Size "${r.size}" chưa có trong bảng size`);
    const head = firstLine.get(r.handle);
    if (head) {
      for (const f of PRODUCT_FIELDS) {
        if (head[f] !== r[f]) err(f, `Khác dòng ${head.line} của cùng sản phẩm "${r.handle}"`);
      }
      const p = plan.get(r.handle);
      if (p?.variants.some((v) => v.color === r.color && v.size === r.size))
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
    if (existingProductId && !existingVariant) {
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
      products_new: planned.filter((p) => !p.existingId).length,
      products_existing: planned.filter((p) => p.existingId).length,
      variants_new: planned.flatMap((p) => p.variants).filter((v) => !v.existingVariantId).length,
      variants_existing: planned.flatMap((p) => p.variants).filter((v) => v.existingVariantId).length,
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
  if (!inv.inventoryItemId || inv.stocked === qty) return;
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
    if (!productId) {
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
                  [v.color && colorOf(dict, v.color).label, v.size && sizeOf(dict, v.size).label]
                    .filter(Boolean)
                    .join(" / ") || p.title,
                sku: v.sku,
                manage_inventory: true,
                variant_rank: i,
                options: {
                  ...(v.color ? { [OPTION_COLOR]: v.color } : {}),
                  ...(v.size ? { [OPTION_SIZE]: v.size } : {}),
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
    committed_at: j.committed_at ? new Date(j.committed_at).toISOString() : null,
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
): Promise<CommitOutcome> {
  const service = importService(container);
  return container.resolve(Modules.LOCKING).execute(
    CATALOG_IMPORT_LOCK,
    async () => {
      const [job] = (await service.listCatalogImportJobs(
        { id: importId },
        { take: 1 },
      )) as unknown as JobRecord[];
      if (!job) throw new MedusaError(MedusaError.Types.NOT_FOUND, `Không có import ${importId}`);
      if (job.status === "committed") return { kind: "committed", job: jobView(job), replayed: true };
      if ((job.errors as unknown[]).length) {
        return { kind: "has_errors", job: jobView(job), errors: job.errors as ImportRowError[] };
      }
      // Dữ liệu có thể đã đổi từ lúc preview — kiểm lại trên trạng thái hiện tại.
      const preview = await previewImport(container, job.content);
      if (preview.errors.length) return { kind: "has_errors", job: jobView(job), errors: preview.errors };
      try {
        const result = await applyImport(container, preview.plan);
        const updated = (await service.updateCatalogImportJobs({
          id: job.id,
          status: "committed",
          result,
          last_error: null,
          committed_by: actorId,
          committed_at: new Date(),
        } as never)) as unknown as JobRecord;
        return { kind: "committed", job: jobView(updated), replayed: false };
      } catch (e) {
        await service.updateCatalogImportJobs({
          id: job.id,
          status: "failed",
          last_error: (e as Error).message ?? String(e),
        } as never);
        throw e;
      }
    },
    { timeout: 300 },
  );
}
