import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { IMPORT_COLUMNS } from "@x-shop/domain";
import orderAccessCleanupJob from "../../src/jobs/order-access-cleanup";
import { loadProductSources } from "../../src/lib/catalog/product-source";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import { FASHION_MODULE } from "../../src/modules/fashion";
import type FashionModuleService from "../../src/modules/fashion/service";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { MockVnpayRefundGateway, setRefundGatewayForTest } from "../../src/workflows/returns/refund-gateway";
import { createMfaAdmin, loginWithMfa, totp, type HttpClient, type MfaAdmin } from "../helpers/auth";
import { TEST_CHART } from "../helpers/catalog";
import { CONTACT, DEV_VNPAY, type Api, type Res } from "../helpers/checkout-api";
import { countOrders, inventoryLevel, seedCatalog, type CatalogFixture } from "../helpers/checkout-fixtures";
import { key, newIp, returnsFlow, type J, type PlacedOrder } from "../helpers/returns-flow";

jest.setTimeout(600 * 1000);

/**
 * T-187 — idempotency của route ghi (ARC-INT-001, BE-API-008; Q-06/Q-07 của PLAN-2):
 *  (a) route nhận `Idempotency-Key`: cùng khoá + cùng nội dung → cùng phản hồi, không tác dụng lần hai; cùng khoá khác
 *      nội dung → 409 IDEMPOTENCY_CONFLICT (Q-07: giữ hợp đồng đang chạy — mẫu khung là 422); thiếu khoá → 422 (mẫu
 *      khung 400); cùng khoá ×2 song song → một lần xử lý (bên sau chờ rồi trả kết quả bên thắng, hoặc 202/409 BUSY_RETRY).
 *      `POST /admin/x/orders/{id}/cancel-unverified` cần kịch bản cổng riêng — phủ ở cancel-unverified.spec.ts.
 *  (b) khoá lưu ≥ 24 giờ: các bảng giữ khoá không có cột hết hạn, không mã nào xoá; bản ghi 25 giờ tuổi vẫn trả lại.
 *  (c) route trong scripts/idempotency-allowlist.json chưa có test song song ở spec khác: gọi ×2 song song → trạng
 *      thái cuối như gọi một lần.
 */
medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let fx: CatalogFixture;
    let ghn: MockModeGhnClient;
    let ip: string;
    const gateway = new MockModeVnpayGateway(DEV_VNPAY);
    const staff = {} as Record<"owner" | "accountant" | "warehouse" | "support", MfaAdmin>;
    const A = (role: keyof typeof staff) => staff[role].headers;

    const flow = returnsFlow(api, {
      fx: () => fx,
      gateway: () => gateway,
      ghn: () => ghn,
      staff: () => staff.owner.headers,
      ip: () => ip,
    });
    const service = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const pg = () => container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
    const rowsOf = async (table: string, where: Record<string, unknown>) =>
      ((await pg()(table).where(where)) as unknown[]).length;
    const outboxOf = async (orderId: string, type: string) =>
      (await service().listOutboxEvents({ aggregate_id: orderId })).filter((e) => e.type === type);
    const fin = async (orderId: string) => (await service().listOrderFinances({ order_id: orderId }))[0]!;
    const quarantine = async (variantKey: string) => {
      const [lv] = await container.resolve(Modules.INVENTORY).listInventoryLevels({
        inventory_item_id: fx.variants[variantKey]!.inventoryItemId,
        location_id: fx.quarantineLocationId,
      });
      return lv ? Number(lv.stocked_quantity) : 0;
    };
    const lineOf = async (orderId: string, variantKey: string) => {
      const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
        entity: "order",
        fields: ["id", "items.id", "items.variant_id"],
        filters: { id: orderId },
      });
      const items = (data[0] as { items: Array<{ id: string; variant_id: string }> }).items;
      return items.find((i) => i.variant_id === fx.variants[variantKey]!.id)!.id;
    };
    /** Bỏ trường cấp mới mỗi lần trả (token phiên đơn có hạn tính theo lúc trả) trước khi so hai phản hồi. */
    const stable = (data: J) => {
      const { order_access: _a, order_access_expires_at: _e, ...rest } = data;
      return rest;
    };
    const statusOf = (r: Res<J>) =>
      r.status < 300 ? String(r.status) : `${r.status}:${String(r.data.code)}`;
    const withKey = (k: string | null): Record<string, string> => (k ? { "Idempotency-Key": k } : {});

    beforeAll(async () => {
      container = getContainer();
      for (const role of ["owner", "accountant", "warehouse", "support"] as const) {
        staff[role] = await createMfaAdmin(rawApi as unknown as HttpClient, container, { roles: [role] });
      }
      setVnpayGatewayForTest(gateway);
    });
    afterAll(() => {
      setVnpayGatewayForTest(null);
      setGhnClientForTest(null);
      setRefundGatewayForTest(null);
    });
    beforeEach(async () => {
      container = getContainer();
      fx = await seedCatalog(container, {
        stock: { "Đen/S": 30, "Đen/M": 30, "Trắng/S": 30, "Trắng/M": 30 },
      });
      ghn = new MockModeGhnClient();
      setGhnClientForTest(ghn);
      setRefundGatewayForTest(new MockVnpayRefundGateway(DEV_VNPAY));
      ip = newIp();
    });

    // ------------------------------------------------------------------------------------------------ (a) khoá
    type Variant = "a" | "b";
    interface Keyed {
      send(k: string | null, v: Variant): Promise<Res<J>>;
      /** `count` = số bản ghi tác dụng (đơn, yêu cầu, lệnh, điều chỉnh); trường khác = tiền/tồn liên quan. */
      effect(): Promise<{ count: number } & Record<string, unknown>>;
      /** Bản ghi mà phản hồi trỏ tới — hai phản hồi của cùng khoá phải cùng bản ghi. */
      idOf(r: Res<J>): unknown;
      /** Mã trạng thái lần đầu (lần gửi lại cùng khoá: 200). */
      created: number;
    }

    const storeCfg = (extra: Record<string, string>) => flow.client.cfg({ "x-forwarded-for": ip, ...extra });

    async function deliveredTwoLines(): Promise<{ o: PlacedOrder; black: string; white: string }> {
      const o = await flow.deliveredOrder(
        [
          ["Đen/M", 1],
          ["Trắng/S", 1],
        ],
        "cod",
      );
      return { o, black: await lineOf(o.orderId, "Đen/M"), white: await lineOf(o.orderId, "Trắng/S") };
    }

    const KEYED: Record<string, () => Promise<Keyed>> = {
      "POST /store/x/checkout/submit": async () => {
        const cartId = await flow.client.createCart([["Đen/M", 1]]);
        const q = await flow.client.quote(cartId);
        return {
          created: 200,
          send: (k, v) =>
            api.post(
              "/store/x/checkout/submit",
              {
                ...flow.client.submitBody(q),
                contact: v === "a" ? CONTACT : { ...CONTACT, name: "Trần Thị Bình" },
              },
              storeCfg(withKey(k)),
            ) as Promise<Res<J>>,
          effect: async () => ({
            count: await countOrders(container),
            reserved: (await inventoryLevel(container, fx, "Đen/M")).reserved,
          }),
          idOf: (r) => r.data.checkout_attempt_id,
        };
      },
      "POST /store/x/orders/{display_ref}/returns": async () => {
        const { o, black, white } = await deliveredTwoLines();
        return {
          created: 201,
          send: (k, v) =>
            api.post(
              `/store/x/orders/${o.ref}/returns`,
              {
                kind: "return",
                reason: "changed_mind",
                lines: [{ line_id: v === "a" ? white : black, quantity: 1 }],
              },
              storeCfg({ "x-order-access": o.access, ...withKey(k) }),
            ) as Promise<Res<J>>,
          effect: async () => ({ count: await rowsOf("x_return", { order_id: o.orderId }) }),
          idOf: (r) => r.data.return.id,
        };
      },
      "POST /admin/x/returns": async () => {
        const { o, black, white } = await deliveredTwoLines();
        return {
          created: 201,
          send: (k, v) =>
            flow.admin(
              "/admin/x/returns",
              A("owner"),
              {
                order_id: o.orderId,
                kind: "return",
                reason: "changed_mind",
                lines: [{ line_id: v === "a" ? white : black, quantity: 1 }],
              },
              withKey(k),
            ),
          effect: async () => ({ count: await rowsOf("x_return", { order_id: o.orderId }) }),
          idOf: (r) => r.data.return.id,
        };
      },
      "POST /admin/x/refunds": async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        return {
          created: 201,
          send: (k, v) =>
            flow.admin(
              "/admin/x/refunds",
              A("accountant"),
              {
                order_id: o.orderId,
                reason: "other",
                amount: v === "a" ? 50_000 : 60_000,
                note: "Bồi hoàn phí giao chậm",
              },
              withKey(k),
            ),
          effect: async () => {
            const refunds = (await pg()("x_refund").where({ order_id: o.orderId })) as Array<{
              amount: unknown;
            }>;
            return { count: refunds.length, amount: refunds.reduce((s, r) => s + Number(r.amount), 0) };
          },
          idOf: (r) => r.data.refund.id,
        };
      },
      "POST /admin/x/orders/{id}/cancel": async () => {
        const o = await flow.place([["Đen/M", 1]], "cod");
        return {
          created: 200,
          send: (k, v) =>
            flow.admin(
              `/admin/x/orders/${o.orderId}/cancel`,
              A("owner"),
              { reason: v === "a" ? "Khách gọi điện hủy đơn" : "Kho báo thiếu hàng" },
              withKey(k),
            ),
          effect: async () => ({
            count: await rowsOf("x_order_cancel", { order_id: o.orderId }),
            cancelled_events: (await outboxOf(o.orderId, "order.cancelled")).length,
            reserved: (await inventoryLevel(container, fx, "Đen/M")).reserved,
          }),
          idOf: (r) => r.data.order_id,
        };
      },
      "POST /admin/x/inventory/adjustments": async () => {
        const item = fx.variants["Trắng/M"]!.inventoryItemId;
        return {
          created: 201,
          send: (k, v) =>
            flow.admin(
              "/admin/x/inventory/adjustments",
              A("warehouse"),
              {
                inventory_item_id: item,
                location_id: fx.sellableLocationId,
                delta: v === "a" ? 5 : 6,
                reason: "receiving",
              },
              withKey(k),
            ),
          effect: async () => ({
            count: await rowsOf("inventory_adjustment", { inventory_item_id: item }),
            stocked: (await inventoryLevel(container, fx, "Trắng/M")).stocked,
          }),
          idOf: (r) => r.data.adjustment.id,
        };
      },
    };

    describe("(a) Idempotency-Key — gửi lại, khác nội dung, song song (BE-API-008, Q-07)", () => {
      for (const [route, make] of Object.entries(KEYED)) {
        it(`${route}: thiếu khoá → 422; cùng khoá + cùng nội dung → cùng phản hồi, không tác dụng lần hai; khác nội dung → 409 IDEMPOTENCY_CONFLICT`, async () => {
          const s = await make();
          const before = await s.effect();

          const missing = await s.send(null, "a");
          expect(statusOf(missing)).toBe("422:VALIDATION");
          expect(await s.effect()).toEqual(before);

          const k = key();
          const first = await s.send(k, "a");
          expect(first.status).toBe(s.created);
          const afterFirst = await s.effect();
          expect(afterFirst.count).toBe(before.count + 1);

          const replay = await s.send(k, "a");
          expect(replay.status).toBe(200);
          expect(stable(replay.data)).toEqual(stable(first.data));
          expect(s.idOf(replay)).toBe(s.idOf(first));
          expect(await s.effect()).toEqual(afterFirst);

          const conflict = await s.send(k, "b");
          expect(statusOf(conflict)).toBe("409:IDEMPOTENCY_CONFLICT");
          expect(conflict.headers["content-type"]).toContain("application/problem+json");
          expect(await s.effect()).toEqual(afterFirst);
        });

        it(`${route}: cùng khoá ×2 song song → một lần xử lý, mọi phản hồi thành công trỏ cùng bản ghi`, async () => {
          const s = await make();
          const before = await s.effect();
          const k = key();
          const both = await Promise.all([s.send(k, "a"), s.send(k, "a")]);
          // Bên sau chờ bên thắng rồi trả cùng kết quả; checkout còn đang chạy → 202 (poll); chờ quá hạn → 409 BUSY_RETRY.
          for (const r of both) expect(["200", "201", "202", "409:BUSY_RETRY"]).toContain(statusOf(r));
          const ok = both.filter((r) => r.status < 300);
          expect(ok.length).toBeGreaterThan(0);
          expect(new Set(ok.map((r) => s.idOf(r))).size).toBe(1);
          expect((await s.effect()).count).toBe(before.count + 1);
          // Gửi lại sau khi xong → cùng bản ghi, không thêm tác dụng.
          const after = await s.effect();
          const replay = await s.send(k, "a");
          expect(replay.status).toBe(200);
          expect(s.idOf(replay)).toBe(s.idOf(ok[0]!));
          expect(await s.effect()).toEqual(after);
        });
      }
    });

    // ------------------------------------------------------------------------------------------------ (b) TTL
    describe("(b) thời gian lưu khoá idempotency ≥ 24 giờ", () => {
      const KEY_TABLES = [
        "checkout_attempt",
        "x_return",
        "x_refund",
        "x_order_cancel",
        "inventory_adjustment",
      ];

      it("TTL ≥ 24 giờ: bảng giữ khoá không có cột hết hạn, mã không xoá, inventory_adjustment chặn xoá ở DB", async () => {
        const cols = (await pg()
          .select("table_name", "column_name")
          .from("information_schema.columns")
          .whereIn("table_name", KEY_TABLES)) as Array<{ table_name: string; column_name: string }>;
        for (const t of KEY_TABLES) {
          const names = cols.filter((c) => c.table_name === t).map((c) => c.column_name);
          expect({ t, key: names.includes("idempotency_key") }).toEqual({ t, key: true });
          // `checkout_attempt.hold_expires_at` là hạn GIỮ HÀNG của lần đặt, không phải hạn của khoá.
          const expiry = names.filter(
            (n) => /expir|ttl|valid_until|purge/i.test(n) && n !== "hold_expires_at",
          );
          expect({ t, expiry }).toEqual({
            t,
            expiry: [],
          });
        }

        // Không đường mã nào (job dọn, service, workflow) xoá bản ghi giữ khoá — lưu vĩnh viễn ⇒ ≥ 24 giờ.
        const src = join(__dirname, "../../src");
        const files: string[] = [];
        const walk = (d: string) => {
          for (const n of readdirSync(d)) {
            const p = join(d, n);
            if (statSync(p).isDirectory()) {
              if (n !== "__tests__" && n !== "migrations") walk(p);
            } else if (p.endsWith(".ts")) files.push(p);
          }
        };
        walk(src);
        const tables = KEY_TABLES.join("|");
        const deletes = [
          new RegExp(`DELETE\\s+FROM\\s+"?(${tables})\\b`, "i"),
          new RegExp(`\\(\\s*["'\`](${tables})["'\`]\\s*\\)[\\s\\S]{0,200}?\\.(del|delete)\\(`),
          /\b(soft)?[dD]elete(CheckoutAttempts|InventoryAdjustments)\b/,
        ];
        const hits = files.flatMap((f) => {
          const text = readFileSync(f, "utf8");
          return deletes.filter((re) => re.test(text)).map((re) => `${f}: ${re.source}`);
        });
        expect(hits).toEqual([]);

        // inventory_adjustment là sổ chỉ ghi thêm: DB từ chối xoá (trigger) kể cả khi mã muốn xoá.
        const res = await KEYED["POST /admin/x/inventory/adjustments"]!().then((s) => s.send(key(), "a"));
        expect(res.status).toBe(201);
        await expect(
          pg()("inventory_adjustment").where({ id: res.data.adjustment.id }).del(),
        ).rejects.toThrow();
        expect(await rowsOf("inventory_adjustment", { id: res.data.adjustment.id })).toBe(1);
      });

      it("TTL ≥ 24 giờ: bản ghi khoá 25 giờ tuổi (checkout, yêu cầu trả, lệnh hủy) sau job dọn vẫn trả lại kết quả cũ, không xử lý lần hai", async () => {
        const cases: Array<[string, string]> = [
          ["POST /store/x/checkout/submit", "checkout_attempt"],
          ["POST /store/x/orders/{display_ref}/returns", "x_return"],
          ["POST /admin/x/orders/{id}/cancel", "x_order_cancel"],
        ];
        for (const [route, table] of cases) {
          const s = await KEYED[route]!();
          const k = key();
          const first = await s.send(k, "a");
          expect(first.status).toBe(s.created);
          const afterFirst = await s.effect();
          // Khoá lưu có thể kèm tiền tố phạm vi (`staff:`, `<order_id>:`) — so theo hậu tố.
          const aged = await pg()(table)
            .whereLike("idempotency_key", `%${k}`)
            .update({ created_at: pg().raw("created_at - interval '25 hours'") });
          expect({ route, aged }).toEqual({ route, aged: 1 });
          await orderAccessCleanupJob(container);

          const replay = await s.send(k, "a");
          expect({ route, status: replay.status }).toEqual({ route, status: 200 });
          expect(s.idOf(replay)).toBe(s.idOf(first));
          expect(await s.effect()).toEqual(afterFirst);
          expect(statusOf(await s.send(k, "b"))).toBe("409:IDEMPOTENCY_CONFLICT");
        }
      });
    });

    // ------------------------------------------------------------------------------------- (c) theo trạng thái
    describe("(c) route idempotent theo trạng thái/khoá tự nhiên — gọi song song = gọi một lần (Q-06)", () => {
      it("confirm-cod ×2 song song → một lần chuyển confirmed (changed true + false), một sự kiện order.confirmed", async () => {
        const o = await flow.client.placeOrder([["Đen/M", 1]], "cod");
        expect((await fin(o.orderId)).state).toBe("placed");
        const both = await Promise.all(
          [1, 2].map(() => flow.admin(`/admin/x/orders/${o.orderId}/confirm-cod`, A("owner"))),
        );
        expect(both.map((r) => r.status)).toEqual([200, 200]);
        expect(both.map((r) => r.data.changed).sort()).toEqual([false, true]);
        expect((await fin(o.orderId)).state).toBe("confirmed");
        expect(await outboxOf(o.orderId, "order.confirmed")).toHaveLength(1);
      });

      it("tạo vận đơn lần đầu ×2 song song → một vận đơn, một fulfillment, trừ tồn một lần", async () => {
        const o = await flow.place([["Đen/M", 1]], "cod");
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 30, reserved: 1 });
        const both = await Promise.all(
          [1, 2].map(() => flow.admin(`/admin/x/orders/${o.orderId}/shipments`, A("owner"))),
        );
        for (const r of both) expect(["200", "201", "409:BUSY_RETRY"]).toContain(statusOf(r));
        const ok = both.filter((r) => r.status < 300);
        expect(ok.map((r) => r.status)).toContain(201);
        expect(new Set(ok.map((r) => r.data.shipment.provider_order_code)).size).toBe(1);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 29, reserved: 0 });
        const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
          entity: "order",
          fields: ["id", "fulfillments.id"],
          filters: { id: o.orderId },
        });
        expect((data[0] as { fulfillments: unknown[] }).fulfillments).toHaveLength(1);
      });

      it("duyệt hoàn tiền ×2 song song → một lần duyệt (changed true + false), trạng thái approved", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const created = await flow.admin(
          "/admin/x/refunds",
          A("support"), // CSKH tạo được, không tự duyệt → yêu cầu ở `requested`
          { order_id: o.orderId, reason: "other", amount: 40_000, note: "Bồi hoàn phí giao chậm" },
          { "Idempotency-Key": key() },
        );
        expect(created.data.refund.state).toBe("requested");
        const id = created.data.refund.id as string;
        const both = await Promise.all(
          [1, 2].map(() => flow.admin(`/admin/x/refunds/${id}/approve`, A("owner"))),
        );
        expect(both.map((r) => r.status)).toEqual([200, 200]);
        expect(both.map((r) => r.data.changed).sort()).toEqual([false, true]);
        expect(both.map((r) => r.data.refund.state)).toEqual(["approved", "approved"]);
      });

      it("từ chối hoàn tiền ×2 song song → một lần từ chối, số tiền giữ được nhả, trạng thái rejected", async () => {
        const o = await flow.place([["Đen/M", 1]], "vnpay");
        const created = await flow.admin(
          "/admin/x/refunds",
          A("support"), // CSKH tạo được, không tự duyệt → yêu cầu ở `requested`
          { order_id: o.orderId, reason: "other", amount: 40_000, note: "Bồi hoàn phí giao chậm" },
          { "Idempotency-Key": key() },
        );
        const id = created.data.refund.id as string;
        const both = await Promise.all(
          [1, 2].map(() =>
            flow.admin(`/admin/x/refunds/${id}/reject`, A("owner"), { reason: "Không đủ căn cứ hoàn" }),
          ),
        );
        // Bên sau thấy đã từ chối: 200 trả nguyên hoặc 409 INVALID_STATE — trạng thái cuối như gọi một lần.
        for (const r of both) expect(["200", "409:INVALID_STATE"]).toContain(statusOf(r));
        expect(both.filter((r) => r.status === 200).length).toBeGreaterThan(0);
        const summary = await flow.adminGet(`/admin/x/refunds?order_id=${o.orderId}`, A("accountant"));
        expect(summary.data).toMatchObject({ held: 0, refunded: 0 });
        const rows = (await pg()("x_refund").where({ order_id: o.orderId })) as Array<{ state: string }>;
        expect(rows.map((r) => r.state)).toEqual(["rejected"]);
      });

      it("đổi size: duyệt ×2 song song → một đơn thay thế, giữ hàng một lần; nhận ×2 song song → cách ly cộng một lần; kiểm định ×2 song song → về kho bán một lần", async () => {
        const o = await flow.deliveredOrder([["Đen/S", 1]], "cod");
        const line = await lineOf(o.orderId, "Đen/S");
        const req = await flow.requestReturn(o, {
          kind: "exchange",
          reason: "wrong_size",
          lines: [{ line_id: line, quantity: 1, exchange_variant_id: fx.variants["Đen/M"]!.id }],
        });
        expect(req.status).toBe(201);
        const retId = req.data.return.id as string;
        const ordersBefore = await countOrders(container);
        const reservedBefore = (await inventoryLevel(container, fx, "Đen/M")).reserved;

        const approved = await Promise.all(
          [1, 2].map(() => flow.admin(`/admin/x/returns/${retId}/approve`, A("support"))),
        );
        for (const r of approved) expect(["200", "409:BUSY_RETRY"]).toContain(statusOf(r));
        expect(approved.filter((r) => r.status === 200).map((r) => r.data.changed)).toContain(true);
        expect(await countOrders(container)).toBe(ordersBefore + 1);
        expect((await inventoryLevel(container, fx, "Đen/M")).reserved).toBe(reservedBefore + 1);

        const sellableBefore = (await inventoryLevel(container, fx, "Đen/S")).stocked;
        const received = await Promise.all(
          [1, 2].map(() => flow.admin(`/admin/x/returns/${retId}/receive`, A("warehouse"))),
        );
        for (const r of received) expect(["200", "409:BUSY_RETRY"]).toContain(statusOf(r));
        expect(received.filter((r) => r.status === 200).map((r) => r.data.changed)).toContain(true);
        expect(await quarantine("Đen/S")).toBe(1);

        const inspect = { lines: [{ line_id: line, restock_quantity: 1, damaged_quantity: 0 }] };
        const inspected = await Promise.all(
          [1, 2].map(() => flow.admin(`/admin/x/returns/${retId}/inspect`, A("warehouse"), inspect)),
        );
        for (const r of inspected) expect(["200", "409:BUSY_RETRY"]).toContain(statusOf(r));
        expect(inspected.filter((r) => r.status === 200).map((r) => r.data.changed)).toContain(true);
        expect(await quarantine("Đen/S")).toBe(0);
        expect((await inventoryLevel(container, fx, "Đen/S")).stocked).toBe(sellableBefore + 1);
        const replacement = (await pg()("x_return").where({ id: retId }).first()) as {
          state: string;
          replacement_order_id: string;
        };
        expect(replacement.state).toBe("closed");
        expect((await fin(replacement.replacement_order_id)).state).toBe("confirmed");
        expect(await countOrders(container)).toBe(ordersBefore + 1);
      });

      it("trả hàng: kiểm định ×2 song song → nhập lại tồn một lần, đúng một yêu cầu hoàn theo giá thực trả", async () => {
        const o = await flow.deliveredOrder([["Trắng/S", 1]], "vnpay");
        const line = await lineOf(o.orderId, "Trắng/S");
        const retId = (
          await flow.requestReturn(o, {
            kind: "return",
            reason: "changed_mind",
            lines: [{ line_id: line, quantity: 1 }],
          })
        ).data.return.id as string;
        expect((await flow.admin(`/admin/x/returns/${retId}/approve`, A("support"))).status).toBe(200);
        expect((await flow.admin(`/admin/x/returns/${retId}/receive`, A("warehouse"))).status).toBe(200);
        const sellableBefore = (await inventoryLevel(container, fx, "Trắng/S")).stocked;
        const inspect = { lines: [{ line_id: line, restock_quantity: 1, damaged_quantity: 0 }] };
        const both = await Promise.all(
          [1, 2].map(() => flow.admin(`/admin/x/returns/${retId}/inspect`, A("warehouse"), inspect)),
        );
        for (const r of both) expect(["200", "409:BUSY_RETRY"]).toContain(statusOf(r));
        const ok = both.filter((r) => r.status === 200);
        expect(new Set(ok.map((r) => r.data.refund.id)).size).toBe(1);
        expect((await inventoryLevel(container, fx, "Trắng/S")).stocked).toBe(sellableBefore + 1);
        const refunds = (await pg()("x_refund").where({ order_id: o.orderId })) as Array<{ amount: unknown }>;
        expect(refunds.map((r) => Number(r.amount))).toEqual([300_000]);
      });

      it("từ chối yêu cầu trả ×2 song song → một lần từ chối, trạng thái rejected, không mở hoàn", async () => {
        const o = await flow.deliveredOrder([["Trắng/M", 1]], "cod");
        const line = await lineOf(o.orderId, "Trắng/M");
        const retId = (
          await flow.requestReturn(o, {
            kind: "return",
            reason: "changed_mind",
            lines: [{ line_id: line, quantity: 1 }],
          })
        ).data.return.id as string;
        const both = await Promise.all(
          [1, 2].map(() =>
            flow.admin(`/admin/x/returns/${retId}/reject`, A("support"), { reason: "Quá hạn đổi trả" }),
          ),
        );
        for (const r of both) expect(["200", "409:INVALID_STATE", "409:BUSY_RETRY"]).toContain(statusOf(r));
        expect(both.filter((r) => r.status === 200).length).toBeGreaterThan(0);
        expect(((await pg()("x_return").where({ id: retId }).first()) as { state: string }).state).toBe(
          "rejected",
        );
        expect(await rowsOf("x_refund", { order_id: o.orderId })).toBe(0);
      });

      it("đặt thuộc tính thời trang ×2 song song cùng nội dung → đúng một bộ số đo, như gọi một lần", async () => {
        const body = {
          attributes: { kind: "apparel", material: "cotton" },
          model_measurements: [{ image_set: "idem", height_cm: 170, size_worn: "m" }],
        };
        const both = await Promise.all(
          [1, 2].map(() => flow.admin(`/admin/x/products/${fx.productId}/fashion`, A("owner"), body)),
        );
        for (const r of both) expect(["200", "409:BUSY_RETRY"]).toContain(statusOf(r));
        expect(both.filter((r) => r.status === 200).length).toBeGreaterThan(0);
        const [src] = await loadProductSources(container, { id: [fx.productId] });
        const rows = await container
          .resolve<FashionModuleService>(FASHION_MODULE)
          .listModelMeasurements({ attributes_id: src!.attributes!.id });
        expect(rows.map((m) => m.image_set)).toEqual(["idem"]);
      });

      it("tạo bảng size cùng mã ×2 song song → đúng một bảng phiên bản 1, lần kia bị từ chối 4xx", async () => {
        const code = `idem-${Math.random().toString(36).slice(2, 8)}`;
        const both = await Promise.all(
          [1, 2].map(() => flow.admin("/admin/x/size-charts", A("owner"), { code, ...TEST_CHART })),
        );
        const statuses = both.map((r) => r.status).sort();
        expect(statuses[0]).toBe(201);
        expect(statuses[1]).toBeGreaterThanOrEqual(400);
        expect(statuses[1]).toBeLessThan(500);
        expect(await rowsOf("size_chart", { code })).toBe(1);
      });

      it("preview CSV ×2 song song → hai bản nháp riêng, catalog không đổi (không tác dụng nghiệp vụ)", async () => {
        const products = async () =>
          (await container.resolve(Modules.PRODUCT).listAndCountProducts({}, { take: 1 }))[1];
        const before = await products();
        const csv = [
          IMPORT_COLUMNS.join(","),
          "ao-thu-idem,Áo thử idem,apparel,ao-nu,Cotton,Mô tả,IDEM-DEN-S,den,s,100000,1",
        ].join("\n");
        const both = await Promise.all(
          [1, 2].map(
            () =>
              api.post("/admin/x/imports/preview", csv, {
                headers: { ...A("owner"), "content-type": "text/csv" },
                validateStatus: () => true,
              }) as Promise<Res<J>>,
          ),
        );
        expect(both.map((r) => r.status)).toEqual([201, 201]);
        expect(both[0]!.data.import_id).not.toBe(both[1]!.data.import_id);
        expect(await products()).toBe(before);
      });

      it("báo giá ×2 song song → hai báo giá cùng tổng và cart_version, không giữ hàng (không tác dụng nghiệp vụ)", async () => {
        const cartId = await flow.client.createCart([["Đen/M", 2]]);
        const both = await Promise.all([1, 2].map(() => flow.client.quote(cartId)));
        expect(both[0]!.id).not.toBe(both[1]!.id);
        expect(both[0]!.total).toBe(both[1]!.total);
        expect(both[0]!.cart_version).toBe(both[1]!.cart_version);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 30, reserved: 0 });
        expect(await countOrders(container)).toBe(0);
      });

      it("recheck lần đặt ×2 song song → một lần hỏi cổng (200 + 429), đơn xác nhận đúng một khoản thu", async () => {
        const o = await flow.client.placeOrder([["Đen/M", 1]], "vnpay");
        gateway.mock.pay(o.paymentUrl, "success");
        const both = (await Promise.all(
          [1, 2].map(() =>
            api.post(
              `/store/x/checkout/attempts/${o.attemptId}/recheck?cart_id=${o.cartId}`,
              {},
              storeCfg({}),
            ),
          ),
        )) as Array<Res<J>>;
        expect(both.map(statusOf).sort()).toEqual(["200", "429:RATE_LIMITED"]);
        expect((await fin(o.orderId)).state).toBe("confirmed");
        expect(await service().listPaymentLedgers({ order_id: o.orderId, kind: "capture" })).toHaveLength(1);
      });

      it("recheck trang đơn ×2 song song → một lần hỏi cổng (200 + 429), đơn xác nhận đúng một khoản thu", async () => {
        const cartId = await flow.client.createCart([["Trắng/M", 1]]);
        const q = await flow.client.quote(cartId, { payment_method: "vnpay" });
        const res = (await flow.client.submit(q)) as unknown as Res<J>;
        expect(res.status).toBe(200);
        gateway.mock.pay(res.data.payment_url as string, "success");
        const ref = res.data.order.display_ref as string;
        const both = (await Promise.all(
          [1, 2].map(() =>
            api.post(
              `/store/x/orders/${ref}/recheck`,
              {},
              storeCfg({ "x-order-access": res.data.order_access }),
            ),
          ),
        )) as Array<Res<J>>;
        expect(both.map(statusOf).sort()).toEqual(["200", "429:RATE_LIMITED"]);
        const orderId = res.data.order.id as string;
        expect((await fin(orderId)).state).toBe("confirmed");
        expect(await service().listPaymentLedgers({ order_id: orderId, kind: "capture" })).toHaveLength(1);
      });

      it("thu hồi cùng vai trò ×2 song song → một lần thu hồi (changed true + false), một dòng audit", async () => {
        const target = await createMfaAdmin(rawApi as unknown as HttpClient, container, {
          roles: ["support"],
        });
        // Route đòi xác thực lại ≤ 5 phút (map quyền `reauth`): owner đăng nhập lại ngay trước khi gọi.
        const fresh = await loginWithMfa(rawApi as unknown as HttpClient, staff.owner, {
          method: "totp",
          code: totp(staff.owner.secret),
        });
        const url = `/admin/x/users/${target.userId}/roles`;
        const both = (await Promise.all(
          [1, 2].map(() =>
            rawApi.delete(url, {
              headers: fresh,
              data: { role: "support", reason: "nghỉ việc" },
              validateStatus: () => true,
            }),
          ),
        )) as unknown as Array<Res<J>>;
        expect(both.map((r) => r.status)).toEqual([200, 200]);
        expect(both.map((r) => r.data.changed).sort()).toEqual([false, true]);
        expect(both.map((r) => r.data.roles)).toEqual([[], []]);
        const audit = (await pg()("audit_log").where({
          action: "rbac.role_revoked",
          resource_id: target.userId,
        })) as unknown[];
        expect(audit).toHaveLength(1);
      });

      it("POST /auth/session ×2 song song cùng token → cả hai 200 cùng danh tính, không ghi dữ liệu nghiệp vụ", async () => {
        const both = (await Promise.all(
          [1, 2].map(() =>
            api.post("/auth/session", {}, { headers: A("owner"), validateStatus: () => true }),
          ),
        )) as Array<Res<J>>;
        expect(both.map((r) => r.status)).toEqual([200, 200]);
        expect(both[0]!.data.user).toEqual(both[1]!.data.user);
        expect((both[0]!.data.user as J).actor_id).toBe(staff.owner.userId);
      });
    });
  },
});
