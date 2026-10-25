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
import { FASHION_MODULE } from "../../modules/fashion";
import type FashionModuleService from "../../modules/fashion/service";
import type { ProductFashionInput } from "../../modules/fashion/validators";

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
    if (attributesId) {
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
  if (from)
    await link.dismiss({
      [Modules.PRODUCT]: { product_id: productId },
      [FASHION_MODULE]: { size_chart_id: from },
    });
  if (to)
    await link.create({
      [Modules.PRODUCT]: { product_id: productId },
      [FASHION_MODULE]: { size_chart_id: to },
    });
}

type MeasurementInput = NonNullable<ProductFashionInput["model_measurements"]>[number];

const replaceMeasurementsStep = createStep(
  "x-replace-model-measurements",
  async (
    input: { attributes_id: string; model_measurements: MeasurementInput[] | undefined },
    { container },
  ) => {
    if (input.model_measurements === undefined) return new StepResponse(undefined, null);
    const fashion: FashionModuleService = container.resolve(FASHION_MODULE);
    const previous = await fashion.listModelMeasurements({ attributes_id: input.attributes_id });
    if (previous.length) await fashion.deleteModelMeasurements(previous.map((m) => m.id));
    const created = input.model_measurements.length
      ? await fashion.createModelMeasurements(
          input.model_measurements.map((m) => ({ ...m, attributes_id: input.attributes_id })) as never,
        )
      : [];
    return new StepResponse(undefined, {
      createdIds: (created as { id: string }[]).map((m) => m.id),
      previousIds: previous.map((m) => m.id),
    });
  },
  async (comp, { container }) => {
    if (!comp) return;
    const fashion: FashionModuleService = container.resolve(FASHION_MODULE);
    if (comp.createdIds.length) await fashion.deleteModelMeasurements(comp.createdIds);
    if (comp.previousIds.length) await fashion.restoreModelMeasurements(comp.previousIds);
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

/** Đặt thuộc tính thời trang + bảng size + số đo người mẫu cho một sản phẩm (ADM01, PDP03–04). */
export const setProductFashionWorkflow = createWorkflow(
  "x-set-product-fashion",
  (input: SetProductFashionInput) => {
    const attributesId = upsertAttributesStep({ product_id: input.product_id, attributes: input.attributes });
    setSizeChartStep({ product_id: input.product_id, size_chart_id: input.size_chart_id });
    replaceMeasurementsStep({ attributes_id: attributesId, model_measurements: input.model_measurements });
    assertStillPublishableStep({ product_id: input.product_id });
    const eventData = transform({ input }, ({ input }) => ({ product_ids: [input.product_id] }));
    emitEventStep({ eventName: CATALOG_PRODUCTS_CHANGED, data: eventData });
    return new WorkflowResponse({ attributes_id: attributesId });
  },
);
