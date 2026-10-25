import { model } from "@medusajs/framework/utils";
import ModelMeasurement from "./model-measurement";

/**
 * Thuộc tính thời trang của một sản phẩm (PDP04, ADM01) — nối với product qua module link một-một.
 * `kind` quyết luật xuất bản: apparel cần ≥ 3 ảnh + bảng size; shoes cần bảng size; accessory không.
 * Ngoại lệ ảnh (< 3 ảnh) phải ghi người chịu trách nhiệm (PDP02).
 */
const FashionProductAttributes = model.define("fashion_product_attributes", {
  id: model.id({ prefix: "fattr" }).primaryKey(),
  kind: model.enum(["apparel", "shoes", "accessory"]),
  material: model.text().nullable(),
  material_label: model.text().nullable(),
  composition: model.text().nullable(),
  stretch: model.enum(["none", "low", "medium", "high"]).nullable(),
  fit: model.text().nullable(),
  care: model.text().nullable(),
  origin: model.text().nullable(),
  image_exception_by: model.text().nullable(),
  image_exception_reason: model.text().nullable(),
  model_measurements: model.hasMany(() => ModelMeasurement, { mappedBy: "attributes" }),
});

export default FashionProductAttributes;
