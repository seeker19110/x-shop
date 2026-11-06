import type { MedusaContainer } from "@medusajs/framework/types";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { FASHION_MODULE } from "../../src/modules/fashion";
import type FashionModuleService from "../../src/modules/fashion/service";
import { adminHeaders } from "../helpers/auth";
import { TEST_CHART } from "../helpers/catalog";

jest.setTimeout(240 * 1000);

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer;
    let admin: { authorization: string };

    beforeAll(() => {
      container = getContainer();
    });

    beforeEach(async () => {
      admin = (await adminHeaders(api, container)).headers;
    });

    describe("revise idempotent tự nhiên (D-139)", () => {
      const versionsOf = async (code: string) =>
        (await container.resolve<FashionModuleService>(FASHION_MODULE).listSizeCharts({ code }))
          .map((c) => c.version)
          .sort();
      const reorder = (c: typeof TEST_CHART) => ({
        rows: c.rows.map((r) => ({ values: r.values, label: r.label, size: r.size })),
        columns: c.columns.map((x) => ({ basis: x.basis, label: x.label, key: x.key })),
        unit: c.unit ?? "cm",
        garment_type: c.garment_type,
        name: c.name,
      });

      it("revise cùng nội dung ×2 → 200 trả bản hiện hành, vẫn một phiên bản; khác nội dung → bản mới", async () => {
        const v1 = (
          await api.post("/admin/x/size-charts", { code: "idem-seq", ...TEST_CHART }, { headers: admin })
        ).data.size_chart;
        // Cùng nội dung (kể cả khác thứ tự khoá) → bản hiện hành, không phiên bản mới.
        for (const body of [TEST_CHART, reorder(TEST_CHART)]) {
          const same = await api.post("/admin/x/size-charts/idem-seq/revise", body, { headers: admin });
          expect(same.status).toBe(200);
          expect(same.headers["idempotent-replayed"]).toBe("true");
          expect(same.data.size_chart).toMatchObject({ id: v1.id, version: 1 });
          expect(same.data.superseded).toBeNull();
          expect(same.data.product_ids).toEqual([]);
        }
        expect(await versionsOf("idem-seq")).toEqual([1]);

        const changed = { ...TEST_CHART, name: `${TEST_CHART.name} (mới)` };
        const v2 = await api.post("/admin/x/size-charts/idem-seq/revise", changed, { headers: admin });
        expect(v2.status).toBe(201);
        expect(v2.data.size_chart).toMatchObject({ version: 2 });
        // Lặp lại nội dung v2 → trả v2; quay về nội dung v1 là thay đổi thật → v3.
        const again = await api.post("/admin/x/size-charts/idem-seq/revise", changed, { headers: admin });
        expect(again.status).toBe(200);
        expect(again.data.size_chart.id).toBe(v2.data.size_chart.id);
        const back = await api.post("/admin/x/size-charts/idem-seq/revise", TEST_CHART, { headers: admin });
        expect(back.status).toBe(201);
        expect(back.data.size_chart.version).toBe(3);
        expect(await versionsOf("idem-seq")).toEqual([1, 2, 3]);
      });

      it("revise cùng nội dung đồng thời ×4 → đúng một phiên bản mới", async () => {
        await api.post("/admin/x/size-charts", { code: "idem-par", ...TEST_CHART }, { headers: admin });
        const body = { ...TEST_CHART, name: "Đồng thời" };
        const rs = await Promise.all(
          [1, 2, 3, 4].map(() =>
            api.post("/admin/x/size-charts/idem-par/revise", body, {
              headers: admin,
              validateStatus: () => true,
            }),
          ),
        );
        const statuses = rs.map((r) => r.status);
        expect(statuses.filter((x) => x === 201)).toHaveLength(1);
        expect(statuses.filter((x) => x !== 201 && x !== 200 && x !== 409)).toEqual([]);
        expect(await versionsOf("idem-par")).toEqual([1, 2]);
      });
    });
  },
});
