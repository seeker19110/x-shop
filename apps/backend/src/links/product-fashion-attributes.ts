import { defineLink } from "@medusajs/framework/utils";
import ProductModule from "@medusajs/medusa/product";
import FashionModule from "../modules/fashion";

/** product (1) ↔ (1) thuộc tính thời trang (PDP04). */
export default defineLink(ProductModule.linkable.product, FashionModule.linkable.fashionProductAttributes);
