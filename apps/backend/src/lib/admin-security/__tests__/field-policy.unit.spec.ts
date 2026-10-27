import type { MedusaRequest } from "@medusajs/framework/http";
import { applyNativeFieldPolicy } from "../guard";
import {
  CATALOG_FIELD_SEGMENTS,
  FULFILLMENT_MIN_FIELDS,
  forbiddenFields,
  INVENTORY_ITEM_FIELDS,
  isOrderFamilyPath,
  nativeFieldPolicy,
  ORDER_MIN_FIELDS,
  PII_FIELD_SEGMENTS,
  requestedFields,
  VARIANT_INVENTORY_FIELDS,
} from "../field-policy";

/** T-147 review: chính sách `?fields=`/`?order=` cho route admin native (mọi method). */

const VARIANT = "/admin/products/p1/variants/v1";

describe("nativeFieldPolicy", () => {
  it("vai trò có order.read + catalog.read → không giới hạn; thiếu order.read → cấm đoạn PII", () => {
    expect(nativeFieldPolicy("/admin/regions", ["owner"])).toBeNull();
    expect(nativeFieldPolicy("/admin/regions", ["order_staff", "catalog_manager"])).toBeNull();
    for (const role of ["support", "warehouse", "catalog_manager"] as const) {
      const p = nativeFieldPolicy("/admin/regions", [role]);
      expect(p?.allowed).toBeNull();
      expect(p?.disallowed).toEqual(expect.arrayContaining([...PII_FIELD_SEGMENTS]));
    }
    // User chưa có vai trò (route `self`: /admin/users/me) cũng bị cấm đi tiếp qua quan hệ.
    expect(nativeFieldPolicy("/admin/users/me", [])?.disallowed).toContain("users");
  });

  it("thiếu catalog.read: cấm đoạn catalog ngoài họ đơn hàng; trong họ đơn hàng (dòng hàng có sản phẩm) không cấm", () => {
    for (const role of ["order_staff", "accountant", "support"] as const) {
      expect(nativeFieldPolicy("/admin/sales-channels", [role])?.disallowed).toEqual(
        expect.arrayContaining([...CATALOG_FIELD_SEGMENTS]),
      );
    }
    expect(nativeFieldPolicy("/admin/orders/o1", ["order_staff", "warehouse"])).toBeNull();
    // Họ đơn hàng: tên sản phẩm của dòng hàng được, vòng sang catalog khác (link, số nhiều, lồng ngoài items.) bị cấm.
    for (const role of ["order_staff", "accountant"] as const) {
      const p = nativeFieldPolicy("/admin/orders", [role])!;
      expect(p.allowed).toBeNull();
      expect(
        forbiddenFields(
          [
            "items.variant",
            "items.variant.product",
            "items.variant.options",
            "items.variant.inventory_items.inventory",
            "item.variant.product",
            "items.product_title",
            "sales_channel",
            "payment_collections.payments.refunds.refund_reason",
          ],
          p,
        ),
      ).toEqual([]);
      expect(
        forbiddenFields(
          [
            "sales_channel.products_link.product.title",
            "sales_channel.products_link",
            "promotions.application_method.target_rules.values",
            "items.variant.product.collection.products.title",
            "items.variant.product.variants.sku",
            "shipping_methods.shipping_option.shipping_profile.products_link",
            "region.something.product",
            "fulfillments.items.variant",
          ],
          p,
        ),
      ).toEqual([
        "sales_channel.products_link.product.title",
        "sales_channel.products_link",
        "items.variant.product.collection.products.title",
        "items.variant.product.variants.sku",
        "shipping_methods.shipping_option.shipping_profile.products_link",
        "region.something.product",
        "fulfillments.items.variant",
      ]);
    }
    expect(nativeFieldPolicy("/admin/sales-channels", ["warehouse"])?.disallowed).not.toContain("product");
  });

  it("route biến thể kèm tồn / tồn kho: thiếu catalog.read → allowlist; có catalog.read → không allowlist", () => {
    expect(nativeFieldPolicy(VARIANT, ["order_staff"])?.allowed).toEqual([...VARIANT_INVENTORY_FIELDS]);
    expect(nativeFieldPolicy(VARIANT, ["warehouse"])?.allowed).toBeNull();
    expect(nativeFieldPolicy(VARIANT, ["owner"])).toBeNull();
    for (const path of [
      "/admin/inventory-items",
      "/admin/inventory-items/i1",
      "/admin/inventory-items/i1/location-levels",
    ])
      expect(nativeFieldPolicy(path, ["order_staff"])?.allowed).toEqual([...INVENTORY_ITEM_FIELDS]);
    expect(nativeFieldPolicy("/admin/inventory-items", ["warehouse"])?.allowed).toBeNull();
    expect(INVENTORY_ITEM_FIELDS).not.toContain("variants");
    // Bảng mức tồn của dashboard: `+stock_locations.id,+stock_locations.name`.
    const levels = nativeFieldPolicy("/admin/inventory-items/i1/location-levels", ["order_staff"])!;
    expect(
      forbiddenFields(requestedFields({ fields: "+stock_locations.id,+stock_locations.name" })!, levels),
    ).toEqual([]);
    expect(forbiddenFields(["stock_locations.address"], levels)).toEqual(["stock_locations.address"]);
  });

  it("họ đơn hàng, vai trò thiếu order.read (kho ghi vận đơn) → trường tối thiểu, không email/khách/địa chỉ", () => {
    expect(
      nativeFieldPolicy("/admin/orders/o1/fulfillments/f1/mark-as-delivered", ["warehouse"])?.allowed,
    ).toEqual([...ORDER_MIN_FIELDS]);
    expect(nativeFieldPolicy("/admin/fulfillments/f1/shipment", ["warehouse"])?.allowed).toEqual([
      ...FULFILLMENT_MIN_FIELDS,
    ]);
    expect(nativeFieldPolicy("/admin/returns/r1", ["warehouse"])?.allowed).toEqual(["id"]);
    for (const f of [
      "email",
      "customer",
      "shipping_address",
      "billing_address",
      "items",
      "delivery_address",
      "data",
    ])
      expect({ f, order: ORDER_MIN_FIELDS.includes(f), ful: FULFILLMENT_MIN_FIELDS.includes(f) }).toEqual({
        f,
        order: false,
        ful: f === "items",
      });
    expect(isOrderFamilyPath("/admin/orders")).toBe(true);
    expect(isOrderFamilyPath("/admin/orders-khac")).toBe(false);
  });
});

describe("applyNativeFieldPolicy (cổng)", () => {
  const reqOf = (query: Record<string, unknown>) =>
    ({ query }) as unknown as MedusaRequest & {
      disallowed?: unknown[];
      allowed?: string[];
    };

  it("không yêu cầu trường cấm → gán req.disallowed (gỡ trường MẶC ĐỊNH) và req.allowed khi có allowlist", () => {
    const support = reqOf({});
    expect(applyNativeFieldPolicy(support, "/admin/regions", ["support"])).toBeNull();
    expect(support.disallowed).toEqual(expect.arrayContaining(["orders", "customer", /_link$/]));
    expect(support.allowed).toBeUndefined();

    const warehouse = reqOf({});
    expect(
      applyNativeFieldPolicy(warehouse, "/admin/orders/o1/fulfillments/f1/shipments", ["warehouse"]),
    ).toBeNull();
    expect(warehouse.allowed).toEqual([...ORDER_MIN_FIELDS]);

    const owner = reqOf({ fields: "orders.email" });
    expect(applyNativeFieldPolicy(owner, "/admin/regions", ["owner"])).toBeNull();
    expect(owner.disallowed).toBeUndefined();
    expect(owner.allowed).toBeUndefined();
  });

  it("yêu cầu trường cấm, hoặc fields/order dạng lạ → trả danh sách (403), KHÔNG gán req.disallowed", () => {
    const bad = reqOf({ fields: "id,orders.email" });
    expect(applyNativeFieldPolicy(bad, "/admin/regions", ["support"])).toEqual(["orders.email"]);
    expect(bad.disallowed).toBeUndefined();
    for (const query of [
      { fields: { orders: "email" } },
      { fields: ["id", 7] },
      { "fields.orders": "email" },
      { order: {} },
    ])
      expect(applyNativeFieldPolicy(reqOf(query), "/admin/regions", ["support"])).toEqual([
        "(fields/order không hợp lệ)",
      ]);
    // Vai trò đủ quyền: dạng lạ để Medusa tự trả 400 (không phải việc của cổng RBAC).
    expect(applyNativeFieldPolicy(reqOf({ fields: { a: 1 } }), "/admin/regions", ["owner"])).toBeNull();
  });
});

describe("requestedFields", () => {
  it("bỏ +, *, .*, khoảng trắng; bỏ qua trường loại trừ (-x); gộp mảng; tính cả order (bỏ dấu -)", () => {
    expect(
      requestedFields({
        fields: "id,+orders.email, *customer,sales_channels.*,-variants",
        order: "-orders.email",
      }),
    ).toEqual(["id", "orders.email", "customer", "sales_channels", "orders.email"]);
    expect(requestedFields({ fields: ["id", "ORDERS.Email"] })).toEqual(["id", "orders.email"]);
    expect(requestedFields({})).toEqual([]);
    expect(requestedFields(undefined)).toEqual([]);
  });

  it("dạng lạ → null (nơi gọi từ chối): object, phần tử không phải chuỗi, khoá lồng fields.x / fields[x]", () => {
    expect(requestedFields({ fields: { orders: "email" } })).toBeNull();
    expect(requestedFields({ fields: ["id", 1] })).toBeNull();
    expect(requestedFields({ "fields.orders": "email" })).toBeNull();
    expect(requestedFields({ "fields[orders]": "email" })).toBeNull();
  });

  it("Unicode: NFKC + chữ thường như DisallowedFieldFilter (ｏｒｄｅｒｓ → orders)", () => {
    expect(requestedFields({ fields: "ｏｒｄｅｒｓ.email" })).toEqual(["orders.email"]);
  });
});

describe("forbiddenFields", () => {
  const support = nativeFieldPolicy("/admin/regions", ["support"])!;

  it("chặn theo TỪNG đoạn và họ *_link; giữ trường hợp lệ", () => {
    expect(
      forbiddenFields(
        [
          "id",
          "name",
          "orders.email",
          "payment_providers.payment_collections",
          "refunds.payment.payment_collection.order",
          "sales_channels.orders.shipping_address",
          "order_link.order.email",
          "sales_channels.products_link",
          "countries",
          "payment_providers",
        ],
        support,
      ),
    ).toEqual([
      "orders.email",
      "payment_providers.payment_collections",
      "refunds.payment.payment_collection.order",
      "sales_channels.orders.shipping_address",
      "order_link.order.email",
      "sales_channels.products_link",
    ]);
    expect(forbiddenFields([], support)).toEqual([]);
  });

  it("allowlist biến thể: chỉ đúng đường dẫn đầy đủ trong VARIANT_INVENTORY_FIELDS", () => {
    const p = nativeFieldPolicy(VARIANT, ["order_staff"])!;
    expect(forbiddenFields(["inventory", "inventory.location_levels", "inventory_items", "sku"], p)).toEqual(
      [],
    );
    expect(
      forbiddenFields(["product", "product.title", "prices", "inventory.variants.product", "options"], p),
    ).toEqual(["product", "product.title", "prices", "inventory.variants.product", "options"]);
  });
});
