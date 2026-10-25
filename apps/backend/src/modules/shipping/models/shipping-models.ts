import { model } from "@medusajs/framework/utils";
import { SETTLEMENT_STATES, SHIPMENT_STATES } from "@x-shop/domain";

export const SHIPPING_PAYERS = ["shop", "recipient"] as const;
export type ShippingPayer = (typeof SHIPPING_PAYERS)[number];

/**
 * Vận đơn (SPEC-fulfillment S-303…S-305). Ràng buộc nghiệp vụ ở Postgres:
 * - UNIQUE(client_order_code) — reference ổn định gửi hãng, tra lại khi timeout; 2 nhân viên cùng tạo → 1 dòng;
 * - provider_order_code NULL = đã giữ chỗ nhưng chưa biết kết quả ở hãng (timeout) — lần sau tra trước khi gửi lại;
 * - tiền số nguyên VND ≥ 0. `label_url` là dữ liệu riêng tư (chứa thông tin người nhận) — không trả ra Store API.
 * `settlement_state` của COD chỉ đổi khi có batch/chứng từ đối soát (T-028), KHÔNG từ delivered hay callback (AT14).
 */
export const Shipment = model
  .define("shipment", {
    id: model.id({ prefix: "shp" }).primaryKey(),
    order_id: model.text(),
    client_order_code: model.text(),
    provider: model.text(),
    provider_order_code: model.text().nullable(),
    state: model.enum([...SHIPMENT_STATES]).default("unfulfilled"),
    cod_amount: model.number(),
    /** Phí hãng tính cho vận đơn (null tới khi hãng trả). */
    shipping_fee: model.number().nullable(),
    payer: model.enum([...SHIPPING_PAYERS]),
    label_url: model.text().nullable(),
    created_by: model.text(),
    /** Courier báo đã chuyển tiền COD (chưa đối soát) — chỉ là lời báo, không phải bằng chứng thu tiền. */
    cod_reported_amount: model.number().nullable(),
    cod_reported_at: model.dateTime().nullable(),
    settlement_state: model.enum([...SETTLEMENT_STATES]).default("unsettled"),
    delivered_at: model.dateTime().nullable(),
  })
  .indexes([
    { name: "IDX_shipment_client_order_code_unique", on: ["client_order_code"], unique: true, where: null },
    { name: "IDX_shipment_order_id", on: ["order_id"], where: null },
    {
      name: "IDX_shipment_provider_order_code_unique",
      on: ["provider", "provider_order_code"],
      unique: true,
      where: "provider_order_code IS NOT NULL",
    },
  ])
  .checks([
    { name: "shipment_cod_amount_nonneg", expression: (c) => `${c.cod_amount} >= 0` },
    {
      name: "shipment_shipping_fee_nonneg",
      expression: (c) => `${c.shipping_fee} IS NULL OR ${c.shipping_fee} >= 0`,
    },
    {
      name: "shipment_cod_reported_nonneg",
      expression: (c) => `${c.cod_reported_amount} IS NULL OR ${c.cod_reported_amount} >= 0`,
    },
  ]);

/**
 * Callback giao vận đã nhận — lưu TRƯỚC khi xử lý, khử trùng theo event_key = `<provider>:<OrderCode|Type|Status|Time>`. `raw` đã lọc
 * PII (chỉ giữ trường trong danh sách cho phép). `applied` = đã đối chiếu API và áp xong (kể cả khi bị bỏ qua vì lặp
 * hoặc sai thứ tự); false = lần sau (hãng gửi lại) xử lý tiếp.
 */
export const ShipmentEvent = model
  .define("shipment_event", {
    id: model.id({ prefix: "shpev" }).primaryKey(),
    provider: model.text(),
    event_key: model.text(),
    shipment_id: model.text().nullable(),
    provider_order_code: model.text(),
    type: model.text(),
    status: model.text(),
    raw: model.json(),
    applied: model.boolean().default(false),
    result: model.json().nullable(),
  })
  .indexes([
    { name: "IDX_shipment_event_event_key_unique", on: ["event_key"], unique: true, where: null },
    { name: "IDX_shipment_event_shipment_id", on: ["shipment_id"], where: null },
  ]);
