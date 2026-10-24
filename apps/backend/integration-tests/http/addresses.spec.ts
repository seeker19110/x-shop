import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { listProvinces, listWards } from "@x-shop/domain";
import seedXShop from "../../src/scripts/seed";
import { storeHeaders } from "../helpers/auth";

jest.setTimeout(300 * 1000);

type Res = { status: number; data: Record<string, any>; headers: Record<string, string> };

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    let headers: Record<string, string>;
    const getErr = (path: string, h: Record<string, string> = headers) =>
      api.get(path, { headers: h }).then(
        () => {
          throw new Error(`${path} lẽ ra phải lỗi`);
        },
        (e: { response: Res }) => e.response,
      );

    beforeAll(async () => {
      await seedXShop({ container: getContainer() });
      headers = await storeHeaders(getContainer());
    });

    describe("GET /store/x/addresses/provinces", () => {
      it("trả đủ tỉnh/thành theo danh mục domain, cache công khai dài", async () => {
        const res = (await api.get("/store/x/addresses/provinces", { headers })) as Res;
        expect(res.status).toBe(200);
        expect(res.data.provinces).toEqual(listProvinces());
        expect(res.data.provinces.length).toBe(34);
        expect(res.headers["cache-control"]).toMatch(/^public, .*s-maxage=\d{5,}/);
      });
    });

    describe("GET /store/x/addresses/provinces/:code/wards", () => {
      it("trả phường/xã của đúng tỉnh", async () => {
        const res = (await api.get("/store/x/addresses/provinces/01/wards", { headers })) as Res;
        expect(res.status).toBe(200);
        const expected = listWards("01").map(({ code, name }) => ({ code, name }));
        expect(res.data.province_code).toBe("01");
        expect(res.data.wards).toEqual(expected);
        expect(expected.length).toBeGreaterThan(0);
        expect(res.data.wards.some((w: { code: string }) => w.code === "00004")).toBe(true);
        expect(res.headers["cache-control"]).toMatch(/^public, .*s-maxage=\d{5,}/);
      });

      it.each(["99", "abc", "0", "01%20", "1".repeat(40)])("mã tỉnh %p không có → 404 problem+json", async (code) => {
        const res = await getErr(`/store/x/addresses/provinces/${code}/wards`);
        expect(res.status).toBe(404);
        expect(res.data.code).toBe("NOT_FOUND");
        expect(res.headers["cache-control"]).toBe("no-store");
      });

      it("thiếu publishable key → bị Medusa từ chối", async () => {
        const res = await getErr("/store/x/addresses/provinces", {});
        expect([400, 401]).toContain(res.status);
      });
    });
  },
});
