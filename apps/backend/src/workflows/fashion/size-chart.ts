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
import { FASHION_MODULE } from "../../modules/fashion";
import type FashionModuleService from "../../modules/fashion/service";
import type { SizeChartContent } from "../../modules/fashion/validators";
import { relinkSizeChart } from "./set-product-fashion";

type SizeChartRecord = { id: string; code: string; version: number; superseded_at?: Date | string | null };

const createChartStep = createStep(
  "x-create-size-chart",
  async (input: SizeChartContent & { code: string }, { container }) => {
    const fashion: FashionModuleService = container.resolve(FASHION_MODULE);
    const existing = await fashion.listSizeCharts({ code: input.code }, { take: 1 });
    if (existing.length)
      throw new MedusaError(
        MedusaError.Types.DUPLICATE_ERROR,
        `Bảng size "${input.code}" đã có — đổi nội dung bằng cách tạo phiên bản mới`,
      );
    const chart = await fashion.createSizeCharts({ ...input, version: 1 } as never);
    return new StepResponse(chart as unknown as SizeChartRecord, (chart as unknown as SizeChartRecord).id);
  },
  async (id, { container }) => {
    if (!id) return;
    const fashion: FashionModuleService = container.resolve(FASHION_MODULE);
    await fashion.deleteSizeCharts(id);
  },
);

export const createSizeChartWorkflow = createWorkflow(
  "x-create-size-chart",
  (input: SizeChartContent & { code: string }) => new WorkflowResponse(createChartStep(input)),
);

type ReviseResult = { chart: SizeChartRecord; previous: SizeChartRecord; product_ids: string[] };

/**
 * Bảng size bất biến theo phiên bản: tạo bản `version + 1`, đánh dấu bản cũ `superseded_at`, chuyển link sản phẩm sang
 * bản mới. Bản cũ KHÔNG bị sửa/xoá — đơn đã mua vẫn trỏ được về đúng bảng size lúc mua (ADM03). Hai lần revise đồng
 * thời: chỉ một lần thắng nhờ UNIQUE(code, version); lần kia lỗi và bù trừ.
 */
const reviseChartStep = createStep(
  "x-revise-size-chart",
  async (input: SizeChartContent & { code: string }, { container }) => {
    // Tuần tự hoá theo code: đọc bản hiện hành → tạo bản mới → chuyển link phải là một khối; không thì hai lần revise
    // xen kẽ để lại sản phẩm trỏ bản đã bị thay (đã tái hiện bằng test song song).
    const locking = container.resolve(Modules.LOCKING);
    const { result, compensation } = await locking.execute(`x-shop:size-chart:${input.code}`, () =>
      reviseUnlocked(container, input),
    );
    return new StepResponse(result, compensation);
  },
  async (comp, { container }) => {
    if (!comp) return;
    const fashion: FashionModuleService = container.resolve(FASHION_MODULE);
    for (const pid of comp.productIds) await relinkSizeChart(container, pid, comp.chartId, comp.previousId);
    await fashion.updateSizeCharts({ id: comp.previousId, superseded_at: null } as never);
    await fashion.deleteSizeCharts(comp.chartId);
  },
);

async function reviseUnlocked(container: MedusaContainer, input: SizeChartContent & { code: string }) {
  const fashion: FashionModuleService = container.resolve(FASHION_MODULE);
  const [current] = (await fashion.listSizeCharts(
    { code: input.code, superseded_at: null },
    { order: { version: "DESC" }, take: 1 },
  )) as unknown as SizeChartRecord[];
  if (!current) throw new MedusaError(MedusaError.Types.NOT_FOUND, `Không có bảng size "${input.code}"`);
  const chart = (await fashion.createSizeCharts({
    ...input,
    version: current.version + 1,
  } as never)) as unknown as SizeChartRecord;
  const moved: string[] = [];
  try {
    await fashion.updateSizeCharts({ id: current.id, superseded_at: new Date() } as never);
    const query = container.resolve(ContainerRegistrationKeys.QUERY);
    const { data } = await query.graph({
      entity: "size_chart",
      fields: ["id", "products.id"],
      filters: { id: current.id },
    });
    const rows = data as unknown as { products?: ({ id: string } | null)[] | null }[];
    for (const p of rows[0]?.products ?? []) {
      if (!p) continue;
      await relinkSizeChart(container, p.id, current.id, chart.id);
      moved.push(p.id);
    }
  } catch (e) {
    // Bước tự thất bại không được bù trừ bởi workflow → tự hoàn tác phần đã làm.
    for (const pid of moved) await relinkSizeChart(container, pid, chart.id, current.id);
    await fashion.updateSizeCharts({ id: current.id, superseded_at: null } as never);
    await fashion.deleteSizeCharts(chart.id);
    throw e;
  }
  const result: ReviseResult = { chart, previous: current, product_ids: moved };
  return { result, compensation: { previousId: current.id, chartId: chart.id, productIds: moved } };
}

export const reviseSizeChartWorkflow = createWorkflow(
  "x-revise-size-chart",
  (input: SizeChartContent & { code: string }) => {
    const result = reviseChartStep(input);
    const eventData = transform({ result }, ({ result }) => ({ product_ids: result.product_ids }));
    emitEventStep({ eventName: CATALOG_PRODUCTS_CHANGED, data: eventData });
    return new WorkflowResponse(result);
  },
);
