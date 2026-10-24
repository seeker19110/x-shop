import { createProductsWorkflow, updateProductsWorkflow } from "@medusajs/medusa/core-flows";
import { StepResponse } from "@medusajs/framework/workflows-sdk";
import { assertPublishable } from "../../lib/catalog/publish-readiness";

/**
 * Kiểm trước xuất bản (ADM03, S-207) ở MỌI đường tạo/sửa sản phẩm: Admin API, batch, import, script — vì hook gắn vào
 * workflow lõi chứ không vào một route. Sản phẩm `published` thiếu dữ liệu → hook ném lỗi → workflow bù trừ, bản ghi
 * trở về trạng thái trước (tạo mới thì bị xoá). Mỗi hook chỉ có MỘT handler (workflows-sdk) — file này là chủ duy nhất.
 */
createProductsWorkflow.hooks.productsCreated(async ({ products }, { container }) => {
  await assertPublishable(
    container,
    products.map((p) => p.id),
  );
  return new StepResponse(undefined);
});

updateProductsWorkflow.hooks.productsUpdated(async ({ products }, { container }) => {
  await assertPublishable(
    container,
    products.map((p) => p.id),
  );
  return new StepResponse(undefined);
});
