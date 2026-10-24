import OrderModule from "@medusajs/medusa/order";
import { defineLink } from "@medusajs/framework/utils";
import CheckoutModule from "../modules/checkout";

/**
 * Liên kết CHỈ ĐỌC order_finance.order_id → order native (docs/design/checkout-flow.md §1): cho phép
 * `query.graph({ entity: "order_finance", fields: ["order.*"] })` mà không tạo bảng nối (khóa nằm sẵn trong cột).
 */
export default defineLink(
  { linkable: CheckoutModule.linkable.orderFinance, field: "order_id" },
  OrderModule.linkable.order,
  { readOnly: true },
);
