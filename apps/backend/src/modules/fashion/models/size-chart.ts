import { model } from "@medusajs/framework/utils";

/**
 * Bảng size theo loại hàng (PDP03): đơn vị cm, cột là số đo cơ thể hoặc thành phẩm.
 * Bất biến sau khi tạo — đổi bảng size = tạo bản ghi `version + 1` cùng `code` (workflow reviseSizeChart); bản cũ giữ
 * nguyên để đơn cũ trỏ về đúng phiên bản đã xem lúc mua (ADM03: đơn cũ giữ snapshot).
 *
 * `columns`: [{ key, label, basis: "body" | "garment" }]
 * `rows`:    [{ size, label, values: { [key]: number | [min, max] } }]
 */
const SizeChart = model
  .define("size_chart", {
    id: model.id({ prefix: "szc" }).primaryKey(),
    code: model.text(),
    version: model.number(),
    name: model.text(),
    garment_type: model.text(),
    unit: model.enum(["cm"]).default("cm"),
    columns: model.json(),
    rows: model.json(),
    superseded_at: model.dateTime().nullable(),
  })
  .indexes([{ on: ["code", "version"], unique: true, where: "deleted_at IS NULL" }]);

export default SizeChart;
