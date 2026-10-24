import { model } from "@medusajs/framework/utils";

/**
 * Bảng màu dùng chung: giá trị option "Màu" của sản phẩm là `value` (slug, vd "den"); nhãn tiếng Việt và mã swatch ở
 * đây để danh sách, facet và PDP hiển thị cùng một tên (CAT04: màu có tên truy cập).
 */
const FashionColor = model
  .define("fashion_color", {
    id: model.id({ prefix: "fcol" }).primaryKey(),
    value: model.text(),
    label: model.text(),
    hex: model.text().nullable(),
    rank: model.number().default(0),
  })
  .indexes([{ on: ["value"], unique: true, where: "deleted_at IS NULL" }]);

export default FashionColor;
