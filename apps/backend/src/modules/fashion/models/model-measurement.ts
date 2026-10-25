import { model } from "@medusajs/framework/utils";
import FashionProductAttributes from "./product-attributes";

/**
 * Số đo người mẫu gắn với MỘT bộ ảnh thật (PDP04: không tạo thông tin giả). `image_set` khớp `metadata.set` của ảnh;
 * `color` là màu sản phẩm trong bộ ảnh (nếu có). Đơn vị cm.
 */
const ModelMeasurement = model.define("fashion_model_measurement", {
  id: model.id({ prefix: "fmm" }).primaryKey(),
  image_set: model.text(),
  color: model.text().nullable(),
  height_cm: model.number(),
  chest_cm: model.number().nullable(),
  waist_cm: model.number().nullable(),
  hip_cm: model.number().nullable(),
  size_worn: model.text(),
  note: model.text().nullable(),
  attributes: model.belongsTo(() => FashionProductAttributes, { mappedBy: "model_measurements" }),
});

export default ModelMeasurement;
