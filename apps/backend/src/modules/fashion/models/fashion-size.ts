import { model } from "@medusajs/framework/utils";

/** Bảng size dùng chung: `value` là giá trị option "Size" (slug, vd "m", "38"); `rank` quyết thứ tự hiển thị. */
const FashionSize = model
  .define("fashion_size", {
    id: model.id({ prefix: "fsz" }).primaryKey(),
    value: model.text(),
    label: model.text(),
    rank: model.number().default(0),
  })
  .indexes([{ on: ["value"], unique: true, where: "deleted_at IS NULL" }]);

export default FashionSize;
