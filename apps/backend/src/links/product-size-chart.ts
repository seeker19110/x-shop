import { defineLink } from "@medusajs/framework/utils";
import ProductModule from "@medusajs/medusa/product";
import FashionModule from "../modules/fashion";

/**
 * product (n) → (1) size_chart (một PHIÊN BẢN cụ thể). Một bảng size dùng cho nhiều sản phẩm; mỗi sản phẩm tối đa một
 * bảng (workflow setProductFashion gỡ link cũ trước khi nối link mới; reviseSizeChart chuyển link sang bản mới).
 */
export default defineLink(
  { linkable: ProductModule.linkable.product, isList: true },
  FashionModule.linkable.sizeChart,
);
