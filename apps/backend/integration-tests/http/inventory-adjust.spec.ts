import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { lockKeys } from "../../src/lib/checkout/locks";
import { AUDIT_MODULE } from "../../src/modules/audit";
import type AuditModuleService from "../../src/modules/audit/service";
import { createAdmin, noThrow, type AdminAccount } from "../helpers/auth";

jest.setTimeout(300 * 1000);

type Res = { status: number; data: Record<string, unknown>; headers: Record<string, string> };
interface Api {
  request(config: Record<string, unknown>): Promise<Res>;
}

const URL = "/admin/x/inventory/adjustments";
const newKey = () => `adj-${randomUUID()}`;

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let warehouse: AdminAccount;
    let catalog: AdminAccount;
    let itemId: string;
    let locationId: string;

    // Tồn 10, đang giữ 4 (reservation) — tạo trong beforeAll để nằm trong bản chụp DB khôi phục trước mỗi test.
    beforeAll(async () => {
      container = getContainer();
      warehouse = await createAdmin(rawApi, container, { roles: ["warehouse"] });
      catalog = await createAdmin(rawApi, container, { roles: ["catalog_manager"] });
      const [location] = await container
        .resolve(Modules.STOCK_LOCATION)
        .createStockLocations([{ name: "Kho thử điều chỉnh" }]);
      const inventory = container.resolve(Modules.INVENTORY);
      const [item] = await inventory.createInventoryItems([{ sku: `ADJ-${randomUUID().slice(0, 8)}` }]);
      itemId = item!.id;
      locationId = location!.id;
      await inventory.createInventoryLevels([
        { inventory_item_id: itemId, location_id: locationId, stocked_quantity: 10 },
      ]);
      await inventory.createReservationItems([
        { inventory_item_id: itemId, location_id: locationId, quantity: 4 },
      ]);
    });

    const adjust = (body: Record<string, unknown>, key: string | null = newKey(), who = warehouse) =>
      api.request({
        method: "POST",
        url: URL,
        data: body,
        headers: { ...who.headers, ...(key ? { "idempotency-key": key } : {}) },
        ...noThrow,
      });

    const level = async () => {
      const [l] = await container
        .resolve(Modules.INVENTORY)
        .listInventoryLevels({ inventory_item_id: itemId, location_id: locationId });
      return { stocked: Number(l!.stocked_quantity), reserved: Number(l!.reserved_quantity) };
    };

    const body = (delta: number, reason = delta > 0 ? "receiving" : "damaged") => ({
      inventory_item_id: itemId,
      location_id: locationId,
      delta,
      reason,
    });

    it("bối cảnh: tồn 10, đang giữ 4", async () => {
      expect(await level()).toEqual({ stocked: 10, reserved: 4 });
    });

    // S-404 (SPEC-admin): điều chỉnh tồn bắt buộc lý do/actor/trước-sau/idempotency, không giảm dưới số đã giữ (các test trong describe này).
    it("tăng tồn có lý do → 201 ghi trước/sau/actor + audit; gửi lại cùng khóa → 200 kết quả cũ, không cộng lần hai", async () => {
      const key = newKey();
      const res = await adjust({ ...body(5), note: "Nhập lô 24/10" }, key);
      expect(res.status).toBe(201);
      expect(res.data.adjustment).toMatchObject({
        idempotency_key: key,
        actor_id: warehouse.userId,
        delta: 5,
        reason: "receiving",
        note: "Nhập lô 24/10",
        stocked_before: 10,
        stocked_after: 15,
        reserved_quantity: 4,
      });
      expect(res.data.adjustment).not.toHaveProperty("payload_hash");
      expect(await level()).toEqual({ stocked: 15, reserved: 4 });

      const again = await adjust({ ...body(5), note: "Nhập lô 24/10" }, key);
      expect(again.status).toBe(200);
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(again.data.adjustment).toEqual(res.data.adjustment);
      expect(await level()).toEqual({ stocked: 15, reserved: 4 });

      const conflict = await adjust(body(6), key);
      expect(conflict).toMatchObject({ status: 409, data: { code: "IDEMPOTENCY_CONFLICT" } });

      const audit = container.resolve<AuditModuleService>(AUDIT_MODULE);
      const { entries } = await audit.list({ action: "inventory.adjusted" }, { limit: 10, offset: 0 });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actor_type: "user",
        actor_id: warehouse.userId,
        resource_type: "inventory_level",
        resource_id: `${itemId}:${locationId}`,
        reason: "receiving",
        changes: { delta: 5, stocked_before: 10, stocked_after: 15, reserved_quantity: 4 },
      });
    });

    it("giảm xuống dưới số đang giữ → 409 BELOW_RESERVED (kèm mức giảm tối đa); giảm đúng tới số giữ → được", async () => {
      const below = await adjust(body(-7));
      expect(below).toMatchObject({
        status: 409,
        data: { code: "BELOW_RESERVED", stocked_quantity: 10, reserved_quantity: 4, max_decrease: 6 },
      });
      expect(below.headers["content-type"]).toContain("application/problem+json");
      expect(await level()).toEqual({ stocked: 10, reserved: 4 });
      const exact = await adjust(body(-6, "cycle_count"));
      expect(exact.status).toBe(201);
      expect(await level()).toEqual({ stocked: 4, reserved: 4 });
      expect((await adjust(body(-1, "lost"))).data.code).toBe("BELOW_RESERVED");
    });

    it("kiểm đầu vào: thiếu/sai Idempotency-Key, thiếu/sai lý do, sai chiều lý do, delta 0/lẻ, trường lạ → 422; SKU/kho lạ → 404", async () => {
      expect((await adjust(body(1), null)).status).toBe(422);
      expect((await adjust(body(1), "ngan")).status).toBe(422);
      const { reason: _r, ...noReason } = body(1);
      expect((await adjust(noReason)).status).toBe(422);
      expect((await adjust(body(1, "vui-thi-sua"))).status).toBe(422);
      expect((await adjust(body(3, "damaged"))).status).toBe(422);
      expect((await adjust(body(-3, "receiving"))).status).toBe(422);
      expect((await adjust(body(0, "correction"))).status).toBe(422);
      expect((await adjust({ ...body(1), delta: 1.5 })).status).toBe(422);
      expect((await adjust({ ...body(1), delta: "1" })).status).toBe(422);
      expect((await adjust({ ...body(1), stocked_quantity: 99 })).status).toBe(422);
      expect((await adjust({ ...body(1), delta: 2_000_000 })).status).toBe(422);
      expect((await adjust({ ...body(1), inventory_item_id: "iitem_khong_co" })).status).toBe(404);
      expect((await adjust({ ...body(1), location_id: "sloc_khong_co" })).status).toBe(404);
      expect(await level()).toEqual({ stocked: 10, reserved: 4 });
    });

    it("quyền: catalog_manager (không có inventory.adjust) → 403; user chưa có vai trò → 403", async () => {
      expect((await adjust(body(1), newKey(), catalog)).status).toBe(403);
      const none = await createAdmin(rawApi, container, { roles: [] });
      expect((await adjust(body(1), newKey(), none)).status).toBe(403);
      expect(await level()).toEqual({ stocked: 10, reserved: 4 });
    });

    it("đồng thời: hai lần giảm 6 khác khóa song song (tồn 10, giữ 4) → đúng một thành công, một BELOW_RESERVED", async () => {
      const results = await Promise.all([adjust(body(-6)), adjust(body(-6))]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)?.data.code).toBe("BELOW_RESERVED");
      expect(await level()).toEqual({ stocked: 4, reserved: 4 });
    });

    it("đồng thời: cùng khóa gửi 5 lần song song → áp đúng một lần, các lần khác trả lại cùng kết quả", async () => {
      const key = newKey();
      const results = await Promise.all(Array.from({ length: 5 }, () => adjust(body(3), key)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
      const ids = new Set(results.map((r) => (r.data.adjustment as { id: string }).id));
      expect(ids.size).toBe(1);
      expect(await level()).toEqual({ stocked: 13, reserved: 4 });
    });

    it("dùng chung khóa `inventory_item:<id>` với checkout: đang có người giữ khóa → chờ, nhả khóa → mới ghi", async () => {
      const locking = container.resolve(Modules.LOCKING);
      const owner = `test-checkout-${randomUUID()}`;
      await locking.acquire(lockKeys.inventoryItem(itemId), { ownerId: owner, expire: 30 });
      const pending = adjust(body(2));
      await new Promise((r) => setTimeout(r, 500));
      expect(await level()).toEqual({ stocked: 10, reserved: 4 });
      await locking.release(lockKeys.inventoryItem(itemId), { ownerId: owner });
      const res = await pending;
      expect(res.status).toBe(201);
      expect(await level()).toEqual({ stocked: 12, reserved: 4 });
    });

    it("sổ điều chỉnh chỉ ghi thêm: UPDATE/DELETE bị DB chặn", async () => {
      expect((await adjust(body(1))).status).toBe(201);
      const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
      await expect(pg.raw(`UPDATE inventory_adjustment SET delta = 100`)).rejects.toThrow(/append-only/);
      await expect(pg.raw(`DELETE FROM inventory_adjustment`)).rejects.toThrow(/append-only/);
    });
  },
});
