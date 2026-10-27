import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, MedusaError, Modules } from "@medusajs/framework/utils";
import {
  createStep,
  createWorkflow,
  StepResponse,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { emitEventStep } from "@medusajs/medusa/core-flows";
import { CATALOG_PRODUCTS_CHANGED } from "../../lib/catalog/constants";
import { assertPublishable } from "../../lib/catalog/publish-readiness";
import { acquireOrdered, releaseOwnedQuietly } from "../../lib/checkout/locks";
import { FASHION_MODULE } from "../../modules/fashion";
import type FashionModuleService from "../../modules/fashion/service";
import type { ProductFashionInput } from "../../modules/fashion/validators";
import { isNonEmpty } from "@x-shop/domain";

export type SetProductFashionInput = ProductFashionInput & { product_id: string };

type AttributesData = ProductFashionInput["attributes"];

async function currentLinks(container: MedusaContainer, productId: string) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "product",
    fields: ["id", "fashion_product_attributes.id", "size_chart.id"],
    filters: { id: productId },
  });
  const rows = data as unknown as {
    id: string;
    fashion_product_attributes?: { id: string } | null;
    size_chart?: { id: string } | null;
  }[];
  const row = rows[0];
  if (!row) throw new MedusaError(MedusaError.Types.NOT_FOUND, `Không thấy sản phẩm ${productId}`);
  return {
    attributesId: row.fashion_product_attributes?.id ?? null,
    sizeChartId: row.size_chart?.id ?? null,
  };
}

const ATTRIBUTE_KEYS = [
  "kind",
  "material",
  "material_label",
  "composition",
  "stretch",
  "fit",
  "care",
  "origin",
  "image_exception_by",
  "image_exception_reason",
] as const;

function attributesPayload(a: AttributesData) {
  return Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, a[k] ?? null])) as Record<
    (typeof ATTRIBUTE_KEYS)[number],
    string | null
  >;
}

type AttrCompensation =
  | { created: true; productId: string; attributesId: string }
  | { created: false; attributesId: string; previous: Record<string, string | null> };

const upsertAttributesStep = createStep(
  "x-upsert-fashion-attributes",
  async (input: { product_id: string; attributes: AttributesData }, { container }) => {
    const fashion: FashionModuleService = container.resolve(FASHION_MODULE);
    const { attributesId } = await currentLinks(container, input.product_id);
    const payload = attributesPayload(input.attributes);
    if (isNonEmpty(attributesId)) {
      const prev = await fashion.retrieveFashionProductAttributes(attributesId);
      await fashion.updateFashionProductAttributes({ id: attributesId, ...payload } as never);
      const previous = Object.fromEntries(
        ATTRIBUTE_KEYS.map((k) => [k, (prev as Record<string, unknown>)[k] as string | null]),
      );
      return new StepResponse(attributesId, { created: false, attributesId, previous } as AttrCompensation);
    }
    const created = await fashion.createFashionProductAttributes(payload as never);
    const link = container.resolve(ContainerRegistrationKeys.LINK);
    await link.create({
      [Modules.PRODUCT]: { product_id: input.product_id },
      [FASHION_MODULE]: { fashion_product_attributes_id: created.id },
    });
    return new StepResponse(created.id, {
      created: true,
      productId: input.product_id,
      attributesId: created.id,
    } as AttrCompensation);
  },
  async (comp, { container }) => {
    if (!comp) return;
    const fashion: FashionModuleService = container.resolve(FASHION_MODULE);
    if (comp.created) {
      const link = container.resolve(ContainerRegistrationKeys.LINK);
      await link.dismiss({
        [Modules.PRODUCT]: { product_id: comp.productId },
        [FASHION_MODULE]: { fashion_product_attributes_id: comp.attributesId },
      });
      await fashion.deleteFashionProductAttributes(comp.attributesId);
    } else {
      await fashion.updateFashionProductAttributes({ id: comp.attributesId, ...comp.previous } as never);
    }
  },
);

const setSizeChartStep = createStep(
  "x-set-product-size-chart",
  async (input: { product_id: string; size_chart_id: string | null | undefined }, { container }) => {
    if (input.size_chart_id === undefined) return new StepResponse(undefined, null);
    const { sizeChartId: previous } = await currentLinks(container, input.product_id);
    if (previous === input.size_chart_id) return new StepResponse(undefined, null);
    if (input.size_chart_id !== null) {
      const fashion: FashionModuleService = container.resolve(FASHION_MODULE);
      const [chart] = await fashion.listSizeCharts({ id: input.size_chart_id });
      if (!chart) throw new MedusaError(MedusaError.Types.INVALID_DATA, "size_chart_id không tồn tại");
      if (chart.superseded_at)
        throw new MedusaError(MedusaError.Types.INVALID_DATA, "Bảng size đã có phiên bản mới hơn");
    }
    await relinkSizeChart(container, input.product_id, previous, input.size_chart_id);
    return new StepResponse(undefined, { productId: input.product_id, previous, next: input.size_chart_id });
  },
  async (comp, { container }) => {
    if (!comp) return;
    await relinkSizeChart(container, comp.productId, comp.next, comp.previous);
  },
);

export async function relinkSizeChart(
  container: MedusaContainer,
  productId: string,
  from: string | null,
  to: string | null,
): Promise<void> {
  const link = container.resolve(ContainerRegistrationKeys.LINK);
  if (isNonEmpty(from))
    await link.dismiss({
      [Modules.PRODUCT]: { product_id: productId },
      [FASHION_MODULE]: { size_chart_id: from },
    });
  if (isNonEmpty(to))
    await link.create({
      [Modules.PRODUCT]: { product_id: productId },
      [FASHION_MODULE]: { size_chart_id: to },
    });
}

type MeasurementInput = NonNullable<ProductFashionInput["model_measurements"]>[number];

/* ---------------------------------------------------------------- khoá theo sản phẩm */

/** Như `reviseSizeChartWorkflow`: chờ khoá bận 5 s (quá → BUSY_RETRY 409); lease 60 s, gia hạn nền khi còn chạy. */
const FASHION_LOCK_WAIT_MS = 5_000;
const FASHION_LOCK_TTL_SECONDS = 60;
export const productFashionLockKey = (productId: string) => `x-shop:product-fashion:${productId}`;

type HeldLock = { ownerId: string; keys: string[] };

async function releaseFashionLock(container: MedusaContainer, held: HeldLock): Promise<void> {
  const err = await releaseOwnedQuietly(container.resolve(Modules.LOCKING), held.ownerId, held.keys);
  if (err !== null)
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(`[set-product-fashion] Nhả khoá lỗi/quá hạn (lease tự hết): ${(err as Error).message}`);
}

/**
 * Bước ĐẦU workflow: giữ khoá theo sản phẩm suốt workflow. Đọc–xoá–tạo số đo, đổi link bảng size và bù trừ (tạo lại bản
 * chụp) chỉ đúng khi không có lượt khác cho cùng sản phẩm chen giữa: thiếu khoá, bù trừ của lượt lỗi làm sống lại số đo
 * cũ đè lên kết quả của lượt thành công, hai lượt song song để lại hai bộ số đo (T-144, T-150). Bù trừ chạy ngược thứ
 * tự bước nên bù trừ của bước này (nhả khoá) chạy SAU mọi bù trừ khác; đường thành công nhả ở `releaseFashionLockStep`.
 * Dùng `acquireOrdered` (lời gọi Redis có hạn, gia hạn lease) thay `acquireLockStep` của core-flows — lý do ở
 * `lib/checkout/locks.ts`; `withOwnedLock` không dùng được vì chỉ bọc một bước.
 */
const acquireFashionLockStep = createStep(
  "x-product-fashion-acquire-lock",
  async (input: { product_id: string }, { container }) => {
    const ownerId = `product-fashion:${randomUUID()}`;
    const keys = await acquireOrdered(
      container.resolve(Modules.LOCKING),
      [productFashionLockKey(input.product_id)],
      {
        ownerId,
        waitMs: FASHION_LOCK_WAIT_MS,
        ttlSeconds: FASHION_LOCK_TTL_SECONDS,
        scope: "product-fashion",
      },
    );
    const held: HeldLock = { ownerId, keys };
    return new StepResponse(held, held);
  },
  async (held, { container }) => {
    if (!held || held.keys.length === 0) return;
    await releaseFashionLock(container, held);
  },
);

const releaseFashionLockStep = createStep(
  "x-product-fashion-release-lock",
  async (held: HeldLock, { container }) => {
    await releaseFashionLock(container, held);
    return new StepResponse(undefined);
  },
);

/* ---------------------------------------------------------------- số đo người mẫu */

/** Cột của `fashion_model_measurement` cần chụp để tạo lại y nguyên khi bù trừ (giữ cả `id`). */
const MEASUREMENT_KEYS = [
  "id",
  "image_set",
  "color",
  "height_cm",
  "chest_cm",
  "waist_cm",
  "hip_cm",
  "size_worn",
  "note",
] as const;

export type MeasurementSnapshot = Record<(typeof MEASUREMENT_KEYS)[number], unknown> & { id: string };

/**
 * Tạo lại số đo đã chụp, idempotent khi bù trừ được gọi lại: chỉ tạo bản ghi chưa có. Tạo lỗi mà mọi id đã có mặt (lượt
 * trước đã tạo xong) → kết quả đã đúng, bỏ qua; còn thiếu id → ném lại lỗi gốc. Không thay cho khoá theo sản phẩm: hai
 * lượt cho cùng sản phẩm phải tuần tự nhờ `acquireFashionLockStep`.
 */
export async function recreateMeasurements(
  fashion: FashionModuleService,
  attributesId: string,
  snapshot: MeasurementSnapshot[],
): Promise<void> {
  const ids = snapshot.map((m) => m.id);
  const presentIds = async () => new Set((await fashion.listModelMeasurements({ id: ids })).map((m) => m.id));
  const present = await presentIds();
  const missing = snapshot.filter((m) => !present.has(m.id));
  if (!missing.length) return;
  try {
    await fashion.createModelMeasurements(
      missing.map((m) => ({ ...m, attributes_id: attributesId })) as never,
    );
  } catch (e) {
    const after = await presentIds();
    if (!ids.every((id) => after.has(id))) throw e;
  }
}

/**
 * Mô tả lỗi an toàn để log: chỉ `name`, `code` (mã lỗi Postgres nếu có) và phần sau " - " CUỐI của message (thông điệp
 * của Postgres trong dạng "<câu SQL> - <lỗi>" của knex). KHÔNG log message thô: knex chép giá trị bind vào câu SQL nên
 * số đo người mẫu (PII) sẽ lọt vào log — bộ che log chỉ băm chuỗi trong nháy, số giữ nguyên.
 */
function safeErrorSummary(e: unknown): string {
  if (!(e instanceof Error)) return `non-error(${typeof e})`;
  const parts = [e.name];
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") parts.push(`code=${code}`);
  const cut = e.message.lastIndexOf(" - ");
  if (cut >= 0) parts.push(`pg=${e.message.slice(cut + 3).slice(0, 200)}`);
  return parts.join(" ");
}

/**
 * Lỗi thay cho lỗi DB thô khi ném ra khỏi bước: message chỉ có `safeErrorSummary`, KHÔNG gắn `cause` (handler HTTP ghi
 * message/stack/chuỗi cause của lỗi 500 — lỗi thô sẽ đưa câu SQL kèm số đo vào log). API vẫn trả 500.
 */
function sanitizedError(what: string, e: unknown): MedusaError {
  return new MedusaError(MedusaError.Types.UNEXPECTED_STATE, `${what}: ${safeErrorSummary(e)}`);
}

type MeasurementCompensation = {
  attributesId: string;
  createdIds: string[];
  previous: MeasurementSnapshot[];
};

/**
 * Hoàn tác bước thay số đo: đưa số đo của `attributes_id` về ĐÚNG bản chụp — xoá mọi bản ghi không có trong bản chụp
 * (gồm cả bản lượt này đã tạo mà không kịp nhận id, vd. lệnh tạo đã commit nhưng client báo lỗi), rồi tạo lại bản thiếu.
 * An toàn vì workflow giữ khoá theo sản phẩm: không lượt nào khác ghi số đo của sản phẩm này trong lúc đó.
 * Lỗi → log (chỉ id, không số đo — PII) rồi ném lỗi đã làm sạch (`sanitizedError`) để workflow báo bù trừ thất bại.
 */
async function undoReplaceMeasurements(
  container: MedusaContainer,
  comp: MeasurementCompensation,
): Promise<void> {
  const fashion: FashionModuleService = container.resolve(FASHION_MODULE);
  try {
    const keep = new Set(comp.previous.map((m) => m.id));
    const current = await fashion.listModelMeasurements({ attributes_id: comp.attributesId });
    const extra = [...new Set([...comp.createdIds, ...current.map((m) => m.id)])].filter(
      (id) => !keep.has(id),
    );
    if (extra.length) await fashion.deleteModelMeasurements(extra);
    if (comp.previous.length) await recreateMeasurements(fashion, comp.attributesId, comp.previous);
  } catch (e) {
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(
        `[set-product-fashion] Hoàn tác số đo người mẫu lỗi: attributes_id=${comp.attributesId} ` +
          `created_ids=${comp.createdIds.join(",") || "-"} previous_ids=${comp.previous.map((m) => m.id).join(",") || "-"}: ` +
          safeErrorSummary(e),
      );
    throw sanitizedError("Hoàn tác số đo người mẫu lỗi", e);
  }
}

/**
 * Thay toàn bộ số đo người mẫu. Bản cũ bị XOÁ CỨNG (số đo là PII của người mẫu, data-map `retention: model-release` —
 * không để lại bản soft-delete không ai dọn), nên bước chụp đủ cột bản cũ vào dữ liệu bù trừ và tạo lại cùng `id` khi
 * workflow lỗi ở bước sau (vd. `assertStillPublishableStep`). `restore*` của MedusaService chỉ gỡ soft-delete, không
 * cứu được bản ghi đã xoá cứng (T-144). Bước tự lỗi (tạo bản mới lỗi sau khi đã xoá) không được workflow bù trừ → tự
 * hoàn tác rồi ném lỗi đã làm sạch (không để lỗi DB thô kèm số đo tới log 500 của route).
 */
const replaceMeasurementsStep = createStep(
  "x-replace-model-measurements",
  async (
    input: { attributes_id: string; model_measurements: MeasurementInput[] | undefined },
    { container },
  ) => {
    if (input.model_measurements === undefined) return new StepResponse(undefined, null);
    const fashion: FashionModuleService = container.resolve(FASHION_MODULE);
    const previous = await fashion.listModelMeasurements({ attributes_id: input.attributes_id });
    const snapshot = previous.map(
      (m) =>
        Object.fromEntries(
          MEASUREMENT_KEYS.map((k) => [k, (m as Record<string, unknown>)[k] ?? null]),
        ) as MeasurementSnapshot,
    );
    const comp: MeasurementCompensation = {
      attributesId: input.attributes_id,
      createdIds: [],
      previous: snapshot,
    };
    try {
      if (previous.length) await fashion.deleteModelMeasurements(previous.map((m) => m.id));
      const created = input.model_measurements.length
        ? await fashion.createModelMeasurements(
            input.model_measurements.map((m) => ({ ...m, attributes_id: input.attributes_id })) as never,
          )
        : [];
      comp.createdIds = (created as { id: string }[]).map((m) => m.id);
    } catch (e) {
      try {
        await undoReplaceMeasurements(container, comp);
      } catch (undoError) {
        // Lỗi hoàn tác sẽ thay lỗi gốc khi ném ra → ghi lỗi gốc trước (an toàn, không PII).
        container
          .resolve(ContainerRegistrationKeys.LOGGER)
          .error(
            `[set-product-fashion] Thay số đo người mẫu lỗi (lỗi gốc trước khi hoàn tác lỗi): ` +
              `attributes_id=${comp.attributesId}: ${safeErrorSummary(e)}`,
          );
        throw undoError; // đã làm sạch trong undoReplaceMeasurements
      }
      throw sanitizedError("Thay số đo người mẫu lỗi", e);
    }
    return new StepResponse(undefined, comp);
  },
  async (comp, { container }) => {
    if (!comp) return;
    await undoReplaceMeasurements(container, comp);
  },
);

/** Sau khi đổi thuộc tính/bảng size, sản phẩm đang `published` vẫn phải đạt kiểm xuất bản — không thì hoàn tác. */
const assertStillPublishableStep = createStep(
  "x-assert-still-publishable",
  async (input: { product_id: string }, { container }) => {
    await assertPublishable(container, [input.product_id]);
    return new StepResponse(undefined);
  },
);

/**
 * Đặt thuộc tính thời trang + bảng size + số đo người mẫu cho một sản phẩm (ADM01, PDP03–04).
 *
 * KHÔNG bật `store`/`retentionTime`/`idempotent`/timeout/bước async cho workflow này: khi đó engine lưu lượt chạy (cả dữ
 * liệu bù trừ — bản chụp số đo người mẫu, PII) vào `workflow_execution`, ngoài vòng xoá theo data-map. Test
 * `catalog-model` khẳng định không có bản lưu.
 */
export const setProductFashionWorkflow = createWorkflow(
  "x-set-product-fashion",
  (input: SetProductFashionInput) => {
    const lock = acquireFashionLockStep({ product_id: input.product_id });
    const attributesId = upsertAttributesStep({ product_id: input.product_id, attributes: input.attributes });
    setSizeChartStep({ product_id: input.product_id, size_chart_id: input.size_chart_id });
    replaceMeasurementsStep({ attributes_id: attributesId, model_measurements: input.model_measurements });
    assertStillPublishableStep({ product_id: input.product_id });
    const eventData = transform({ input }, ({ input }) => ({ product_ids: [input.product_id] }));
    emitEventStep({ eventName: CATALOG_PRODUCTS_CHANGED, data: eventData });
    releaseFashionLockStep(lock);
    return new WorkflowResponse({ attributes_id: attributesId });
  },
);
