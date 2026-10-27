import {
  forbiddenFields,
  nativeReadFieldPolicy,
  PII_FIELD_SEGMENTS,
  requestedFields,
  VARIANT_INVENTORY_FIELDS,
} from "../field-policy";

/** T-147 review: chính sách `?fields=` cho route đọc admin native. */

const VARIANT = "/admin/products/p1/variants/v1";

describe("nativeReadFieldPolicy", () => {
  it("vai trò có order.read (+ catalog.read) → không giới hạn; thiếu order.read → cấm đoạn PII", () => {
    expect(nativeReadFieldPolicy("/admin/regions", ["owner"])).toBeNull();
    expect(nativeReadFieldPolicy("/admin/regions", ["order_staff"])).toBeNull();
    expect(nativeReadFieldPolicy("/admin/regions", ["accountant"])).toBeNull();
    for (const role of ["support", "warehouse", "catalog_manager"] as const) {
      const p = nativeReadFieldPolicy("/admin/regions", [role]);
      expect(p?.allowed).toBeNull();
      expect(p?.disallowed).toEqual(expect.arrayContaining([...PII_FIELD_SEGMENTS]));
    }
    // User chưa có vai trò (route `self`: /admin/users/me) cũng bị cấm đi tiếp qua quan hệ.
    expect(nativeReadFieldPolicy("/admin/users/me", [])?.disallowed).toContain("users");
  });

  it("route biến thể kèm tồn: thiếu catalog.read → chỉ trường tồn kho; có catalog.read → không allowlist", () => {
    expect(nativeReadFieldPolicy(VARIANT, ["order_staff"])).toEqual({
      disallowed: [],
      allowed: [...VARIANT_INVENTORY_FIELDS],
    });
    expect(nativeReadFieldPolicy(VARIANT, ["warehouse"])?.allowed).toBeNull();
    expect(nativeReadFieldPolicy(VARIANT, ["owner"])).toBeNull();
    // Chỉ đúng route đó — danh sách biến thể vẫn là catalog.read ở tầng path.
    expect(nativeReadFieldPolicy("/admin/products/p1/variants", ["order_staff"])).toBeNull();
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
  const support = nativeReadFieldPolicy("/admin/regions", ["support"])!;

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
    const p = nativeReadFieldPolicy(VARIANT, ["order_staff"])!;
    expect(forbiddenFields(["inventory", "inventory.location_levels", "inventory_items", "sku"], p)).toEqual(
      [],
    );
    expect(
      forbiddenFields(["product", "product.title", "prices", "inventory.variants.product", "options"], p),
    ).toEqual(["product", "product.title", "prices", "inventory.variants.product", "options"]);
  });
});
