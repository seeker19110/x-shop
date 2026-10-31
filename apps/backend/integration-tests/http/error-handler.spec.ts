import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import seedXShop from "../../src/scripts/seed";
import { CATALOG_INDEX_MODULE } from "../../src/modules/catalog-index";
import type CatalogIndexModuleService from "../../src/modules/catalog-index/service";
import { noThrow, storeHeaders } from "../helpers/auth";

jest.setTimeout(180 * 1000);

/**
 * T-088 — handler lỗi toàn cục qua HTTP thật (BASE-ERR-002/003): lỗi ném ra khỏi route → problem+json có `trace_id`, 500 không
 * lộ stack/đường dẫn/SQL/phiên bản, app vẫn phục vụ sau lỗi; lỗi body-parser → 4xx; lỗi nghiệp vụ giữ mã cũ.
 */
const BLUEPRINT_LEAK = /(Traceback|at .*\.(js|py|java)|SELECT |\/home\/|\/var\/)/;
const VERSION_LEAK = /medusa|express|node\/|v\d+\.\d+\.\d+/i;

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    let store: Record<string, string>;

    beforeAll(async () => {
      await seedXShop({ container: getContainer() });
      store = await storeHeaders(getContainer());
    });

    it("ngoại lệ chưa bắt trong route → 500 problem+json chung có trace_id; app vẫn phục vụ request sau", async () => {
      const index = getContainer().resolve<CatalogIndexModuleService>(CATALOG_INDEX_MODULE);
      const spy = jest
        .spyOn(index, "categoryCounts")
        .mockRejectedValue(
          new Error(
            `select "handle" from "x_catalog_index" - relation does not exist at /home/app/src/x.ts:1:1`,
          ),
        );
      try {
        const res = await api.get("/store/x/categories", { headers: store, ...noThrow });
        expect(res.status).toBe(500);
        expect(String(res.headers["content-type"])).toMatch(/^application\/problem\+json/);
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(res.headers["x-powered-by"]).toBeUndefined();
        expect(res.data).toMatchObject({ type: "about:blank", status: 500, code: "INTERNAL" });
        expect(String(res.data.trace_id)).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
        const text = JSON.stringify(res.data);
        expect(text).not.toMatch(BLUEPRINT_LEAK);
        expect(text).not.toMatch(VERSION_LEAK);
        expect(text).not.toContain("x_catalog_index");
      } finally {
        spy.mockRestore();
      }
      expect((await api.get("/store/x/categories", { headers: store, ...noThrow })).status).toBe(200);
    });

    it("x-request-id hợp lệ → trace_id trùng (tra log theo mã client gửi); mã xấu → bị thay", async () => {
      const index = getContainer().resolve<CatalogIndexModuleService>(CATALOG_INDEX_MODULE);
      const spy = jest.spyOn(index, "categoryCounts").mockRejectedValue(new Error("boom"));
      try {
        const ok = await api.get("/store/x/categories", {
          headers: { ...store, "x-request-id": "req-it-123" },
          ...noThrow,
        });
        expect(ok.data.trace_id).toBe("req-it-123");
        const bad = await api.get("/store/x/categories", {
          headers: { ...store, "x-request-id": "<script>alert(1)</script>" },
          ...noThrow,
        });
        expect(bad.status).toBe(500);
        expect(String(bad.data.trace_id)).toMatch(/^[0-9a-f-]{36}$/);
      } finally {
        spy.mockRestore();
      }
    });

    it("JSON hỏng → 400 problem+json có trace_id (body-parser), không 500, không phản chiếu thân", async () => {
      const res = await api.post("/store/x/checkout/quote", '{"cart_id": "c1",,}', {
        headers: { ...store, "content-type": "application/json" },
        ...noThrow,
      });
      expect(res.status).toBe(400);
      expect(String(res.headers["content-type"])).toMatch(/^application\/problem\+json/);
      expect(res.data).toMatchObject({ status: 400, detail: "Thân yêu cầu không phải JSON hợp lệ" });
      expect(typeof res.data.trace_id).toBe("string");
      expect(JSON.stringify(res.data)).not.toContain("cart_id");
    });

    it("lỗi nghiệp vụ của route giữ mã cũ (422 VALIDATION checkout) và có thêm trace_id", async () => {
      const res = await api.post("/store/x/checkout/quote", {}, { headers: store, ...noThrow });
      expect(res.status).toBe(422);
      expect(res.data).toMatchObject({ code: "VALIDATION", field: "cart_id" });
      expect(typeof res.data.trace_id).toBe("string");
    });

    it("lỗi native ném ra (route Medusa, 404) → problem+json, `message` giữ cho client Medusa", async () => {
      const res = await api.get("/store/carts/cart_khong_ton_tai", { headers: store, ...noThrow });
      expect(res.status).toBe(404);
      expect(String(res.headers["content-type"])).toMatch(/^application\/problem\+json/);
      expect(res.data).toMatchObject({ status: 404, code: "NOT_FOUND" });
      expect(typeof res.data.message).toBe("string");
      expect(res.data.message).toBe(res.data.detail);
      expect(typeof res.data.trace_id).toBe("string");
    });
  },
});
