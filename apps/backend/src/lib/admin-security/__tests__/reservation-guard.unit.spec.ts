import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import {
  changesReservationLocation,
  RESERVATION_LOCATION_CHANGE,
  reservationLocationGuard,
} from "../reservation-guard";

/** T-224 — route native POST /admin/reservations/:id không được đổi kho (lỗi gốc Medusa 2.22.1 lệch số giữ ở kho cũ). */
describe("changesReservationLocation", () => {
  it.each([
    ["không có thân", undefined, false],
    ["thân null", null, false],
    ["thân không phải object", "sloc_a", false],
    ["không gửi location_id", { quantity: 2 }, false],
    ["location_id undefined", { location_id: undefined }, false],
    ["cùng kho", { location_id: "sloc_a", quantity: 2 }, false],
    ["kho khác", { location_id: "sloc_b" }, true],
    ["null (fail-closed)", { location_id: null }, true],
    ["chuỗi rỗng", { location_id: "" }, true],
    ["không phải chuỗi", { location_id: 1 }, true],
    ["khác hoa/thường (id phân biệt hoa thường)", { location_id: "SLOC_A" }, true],
  ])("%s", (_name, body, expected) => {
    expect(changesReservationLocation("sloc_a", body)).toBe(expected);
  });
});

describe("reservationLocationGuard", () => {
  function run(opts: { id?: string; body?: unknown; current?: { id: string; location_id: string } | null }) {
    const listReservationItems = jest.fn(async () => (opts.current ? [opts.current] : []));
    const req = {
      params: opts.id === undefined ? {} : { id: opts.id },
      body: opts.body,
      scope: {
        resolve: (key: string) => {
          if (key === Modules.INVENTORY) return { listReservationItems };
          throw new Error(`không có ${key}`);
        },
      },
      headers: {},
    } as unknown as MedusaRequest;
    const sent: { status?: number; body?: string; headers: Record<string, string> } = { headers: {} };
    const res = {
      req,
      status(code: number) {
        sent.status = code;
        return this;
      },
      setHeader(k: string, v: string) {
        sent.headers[k.toLowerCase()] = v;
        return this;
      },
      send(b: string) {
        sent.body = b;
        return this;
      },
    } as unknown as MedusaResponse;
    const next = jest.fn();
    return { exec: () => reservationLocationGuard(req, res, next), next, sent, listReservationItems };
  }

  it("đổi kho → 400 problem+json RESERVATION_LOCATION_CHANGE_UNSUPPORTED, không gọi tiếp route", async () => {
    const t = run({
      id: "resitem_1",
      body: { location_id: "sloc_b" },
      current: { id: "resitem_1", location_id: "sloc_a" },
    });
    await t.exec();
    expect(t.next).not.toHaveBeenCalled();
    expect(t.sent.status).toBe(400);
    expect(t.sent.headers["content-type"]).toContain("application/problem+json");
    const body = JSON.parse(t.sent.body!);
    expect(body).toMatchObject({
      status: 400,
      code: RESERVATION_LOCATION_CHANGE.code,
      errors: [{ param: "location_id", reason: "location_change_unsupported" }],
      detail: { reservation_id: "resitem_1", location_id: "sloc_a" },
    });
  });

  it("cùng kho / không gửi location_id → đi tiếp; không gửi thì không đọc DB", async () => {
    const same = run({
      id: "resitem_1",
      body: { location_id: "sloc_a", quantity: 3 },
      current: { id: "resitem_1", location_id: "sloc_a" },
    });
    await same.exec();
    expect(same.next).toHaveBeenCalledTimes(1);
    expect(same.sent.status).toBeUndefined();

    const none = run({
      id: "resitem_1",
      body: { quantity: 3 },
      current: { id: "resitem_1", location_id: "sloc_a" },
    });
    await none.exec();
    expect(none.next).toHaveBeenCalledTimes(1);
    expect(none.listReservationItems).not.toHaveBeenCalled();
  });

  it("reservation không tồn tại → đi tiếp (route gốc trả 404)", async () => {
    const t = run({ id: "resitem_x", body: { location_id: "sloc_b" }, current: null });
    await t.exec();
    expect(t.next).toHaveBeenCalledTimes(1);
    expect(t.sent.status).toBeUndefined();
  });
});
