import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { createProductsWorkflow } from "@medusajs/medusa/core-flows";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { CURRENCY, OPTION_COLOR, OPTION_SIZE } from "../../src/lib/catalog/constants";
import { loadProductSources } from "../../src/lib/catalog/product-source";
import { FASHION_MODULE } from "../../src/modules/fashion";
import type FashionModuleService from "../../src/modules/fashion/service";
import { DEMO_PRODUCTS } from "../../src/scripts/catalog-demo-data";
import seedCatalog from "../../src/scripts/seed-catalog";
import {
  type MeasurementSnapshot,
  recreateMeasurements,
  setProductFashionWorkflow,
} from "../../src/workflows/fashion/set-product-fashion";
import { adminHeaders } from "../helpers/auth";
import { createTestProduct, TEST_CHART } from "../helpers/catalog";

jest.setTimeout(240 * 1000);

type Headers = { authorization: string };

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer;
    let admin: Headers;

    beforeAll(async () => {
      container = getContainer();
      await seedCatalog({ container });
    });

    beforeEach(async () => {
      // DB được khôi phục về bản chụp sau seed trước mỗi test → tạo admin mới mỗi lần.
      admin = (await adminHeaders(api, container)).headers;
    });

    const status = (e: unknown) => (e as { response?: { status?: number } }).response?.status;
    const body = (e: unknown) =>
      (e as { response?: { data?: Record<string, unknown> } }).response?.data ?? {};

    describe("seed demo (idempotent)", () => {
      it("24 sản phẩm published, chạy lại không tạo thêm; có ca AT01/AT31 và SKU hết hàng", async () => {
        const again = await seedCatalog({ container });
        expect(again.created).toBe(0);
        expect(Object.keys(again.products)).toHaveLength(DEMO_PRODUCTS.length);
        expect(DEMO_PRODUCTS.length).toBeGreaterThanOrEqual(24);

        const products = await loadProductSources(container, { id: Object.values(again.products) });
        expect(products).toHaveLength(DEMO_PRODUCTS.length);
        expect(products.every((p) => p.status === "published")).toBe(true);

        const shirt = products.find((p) => p.handle === "ao-so-mi-lua")!;
        const price = (c: string, s: string) =>
          shirt.variants.find((v) => v.color === c && v.size === s)?.basePrice;
        expect(price("den", "m")).toBe(700_000);
        expect(price("trang", "s")).toBe(300_000);
        expect(shirt.attributes).toMatchObject({ kind: "apparel", material: "lua", materialLabel: "Lụa" });
        expect(shirt.sizeChart).toMatchObject({ code: "ao-nu", version: 1, unit: "cm" });
        expect(shirt.attributes?.modelMeasurements[0]).toMatchObject({ imageSet: "den", heightCm: 168 });
        expect(shirt.images.every((i) => i.alt && i.color && i.width === 800 && i.height === 1000)).toBe(
          true,
        );

        const tee = products.find((p) => p.handle === "ao-thun-gan-tam")!;
        expect(tee.variants.map((v) => `${v.color}-${v.size}`).sort()).toEqual(["den-s", "trang-m"]);

        // Tồn ở Kho chính; có SKU hết hàng.
        const query = container.resolve(ContainerRegistrationKeys.QUERY);
        const { data: levels } = await query.graph({
          entity: "inventory_level",
          fields: ["stocked_quantity", "location_id"],
          filters: { location_id: again.base.sellableLocationId },
        });
        expect(levels.length).toBeGreaterThan(80);
        expect(levels.some((l: { stocked_quantity: number }) => Number(l.stocked_quantity) === 0)).toBe(true);
      });

      it("hai lần seed song song → khoá tuần tự hoá, không trùng", async () => {
        const [a, b] = await Promise.all([seedCatalog({ container }), seedCatalog({ container })]);
        expect(b.products).toEqual(a.products);
        const all = await container.resolve(Modules.PRODUCT).listProducts({}, { take: null });
        expect(all.length).toBe(DEMO_PRODUCTS.length);
      });
    });

    describe("kiểm trước xuất bản (ADM03, S-207)", () => {
      async function chart(code: string) {
        const res = await api.post("/admin/x/size-charts", { code, ...TEST_CHART }, { headers: admin });
        return res.data.size_chart.id as string;
      }

      it("đủ dữ liệu → publish qua Admin API thành công", async () => {
        const p = await createTestProduct(container);
        await setProductFashionWorkflow(container).run({
          input: {
            product_id: p.id,
            attributes: { kind: "apparel", material: "cotton", material_label: "Cotton" },
            size_chart_id: await chart("thu-du"),
          },
        });
        const res = await api.post(`/admin/products/${p.id}`, { status: "published" }, { headers: admin });
        expect(res.status).toBe(200);
        expect(res.data.product.status).toBe("published");
        const check = await api.get(`/admin/x/products/${p.id}/publish-check`, { headers: admin });
        expect(check.data).toMatchObject({ ready: true, issues: [] });
      });

      it("thiếu dữ liệu → bị chặn kèm danh sách vấn đề, sản phẩm vẫn draft", async () => {
        const p = await createTestProduct(container, {
          description: "ngắn",
          variants: [
            { color: "den", size: "s", price: 300_000 },
            { color: "trang", size: "m", price: null },
          ],
          images: [
            ["den", "Mặt trước"],
            ["den", null],
          ],
        });
        await setProductFashionWorkflow(container).run({
          input: { product_id: p.id, attributes: { kind: "apparel" } },
        });

        const err = await api
          .post(`/admin/products/${p.id}`, { status: "published" }, { headers: admin })
          .catch((e: unknown) => e);
        expect(status(err)).toBe(400);
        const message = String(body(err).message);
        expect(message).toMatch(/^PUBLISH_BLOCKED/);
        for (const code of [
          "DESCRIPTION_MISSING",
          "PRICE_MISSING",
          "IMAGES_TOO_FEW (2/3)",
          "IMAGE_ALT_MISSING",
          "COLOR_WITHOUT_IMAGE (trang)",
          "SIZE_CHART_MISSING",
        ]) {
          expect(message).toContain(code);
        }

        const [after] = await loadProductSources(container, { id: [p.id] });
        expect(after?.status).toBe("draft");

        const check = await api.get(`/admin/x/products/${p.id}/publish-check`, { headers: admin });
        expect(check.data.ready).toBe(false);
        expect(check.data.issues.map((i: { issue: string }) => i.issue)).toEqual(
          expect.arrayContaining([
            "DESCRIPTION_MISSING",
            "PRICE_MISSING",
            "IMAGES_TOO_FEW",
            "IMAGE_ALT_MISSING",
            "COLOR_WITHOUT_IMAGE",
            "SIZE_CHART_MISSING",
          ]),
        );
      });

      it("chưa có thuộc tính thời trang → xét như hàng may mặc (luật chặt nhất)", async () => {
        const p = await createTestProduct(container);
        const check = await api.get(`/admin/x/products/${p.id}/publish-check`, { headers: admin });
        expect(check.data.issues).toEqual([{ issue: "SIZE_CHART_MISSING" }]);
      });

      it("tạo thẳng published khi thiếu dữ liệu → workflow lỗi và bù trừ, không còn bản ghi", async () => {
        await expect(
          createTestProduct(container, { handle: "khong-du-du-lieu", status: "published" }),
        ).rejects.toMatchObject({
          message: expect.stringMatching(/^PUBLISH_BLOCKED/),
        });
        const found = await container.resolve(Modules.PRODUCT).listProducts({ handle: "khong-du-du-lieu" });
        expect(found).toHaveLength(0);
      });

      it("ngoại lệ ảnh có người chịu trách nhiệm → 2 ảnh vẫn xuất bản được (PDP02)", async () => {
        const p = await createTestProduct(container, {
          images: [
            ["den", "Mặt trước"],
            ["den", "Mặt sau"],
          ],
        });
        const sizeChartId = await chart("thu-ngoai-le");
        const blocked = await api
          .post(`/admin/products/${p.id}`, { status: "published" }, { headers: admin })
          .catch((e: unknown) => e);
        expect(status(blocked)).toBe(400);
        await api.post(
          `/admin/x/products/${p.id}/fashion`,
          {
            attributes: {
              kind: "apparel",
              image_exception_by: "user_qa",
              image_exception_reason: "Hàng mẫu",
            },
            size_chart_id: sizeChartId,
          },
          { headers: admin },
        );
        const ok = await api.post(`/admin/products/${p.id}`, { status: "published" }, { headers: admin });
        expect(ok.data.product.status).toBe("published");
      });

      it("phụ kiện: 1 ảnh, không bảng size vẫn xuất bản được", async () => {
        const p = await createTestProduct(container, {
          variants: [{ color: "den", size: "onesize", price: 200_000 }],
          images: [["den", "Túi màu đen"]],
        });
        await setProductFashionWorkflow(container).run({
          input: { product_id: p.id, attributes: { kind: "accessory" } },
        });
        const ok = await api.post(`/admin/products/${p.id}`, { status: "published" }, { headers: admin });
        expect(ok.data.product.status).toBe("published");
      });

      it("gỡ bảng size khỏi sản phẩm đang published → từ chối và hoàn tác", async () => {
        const seeded = await container.resolve(Modules.PRODUCT).listProducts({ handle: "ao-polo-nam" });
        const id = seeded[0]!.id;
        const err = await api
          .post(
            `/admin/x/products/${id}/fashion`,
            { attributes: { kind: "apparel", material: "cotton" }, size_chart_id: null },
            { headers: admin },
          )
          .catch((e: unknown) => e);
        expect(status(err)).toBe(400);
        expect(String(body(err).message)).toContain("SIZE_CHART_MISSING");
        const [after] = await loadProductSources(container, { id: [id] });
        expect(after?.sizeChart?.code).toBe("ao-nam");
        // Bù trừ khôi phục thuộc tính cũ.
        expect(after?.attributes).toMatchObject({
          material: "cotton",
          materialLabel: "Cotton",
          origin: "Việt Nam",
        });
      });

      describe("bù trừ số đo người mẫu (T-144)", () => {
        const NEW_MODEL = { image_set: "moi", height_cm: 170, size_worn: "m", note: "Số đo mới" };
        const MEASUREMENT_FIELDS = [
          "id",
          "image_set",
          "color",
          "height_cm",
          "chest_cm",
          "waist_cm",
          "hip_cm",
          "size_worn",
          "note",
        ] as const;

        async function seededPolo() {
          const seeded = await container.resolve(Modules.PRODUCT).listProducts({ handle: "ao-polo-nam" });
          const id = seeded[0]!.id;
          const [src] = await loadProductSources(container, { id: [id] });
          const attributesId = src!.attributes!.id;
          return { id, attributesId };
        }

        async function measurementRows(attributesId: string, withDeleted = false) {
          const fashion: FashionModuleService = container.resolve(FASHION_MODULE);
          const rows = await fashion.listModelMeasurements(
            { attributes_id: attributesId },
            withDeleted ? { withDeleted: true } : {},
          );
          return rows
            .map((m) => Object.fromEntries(MEASUREMENT_FIELDS.map((k) => [k, m[k]])))
            .sort((a, b) => String(a.id).localeCompare(String(b.id)));
        }

        const removeChartWithNewModel = (id: string, headers?: Headers) =>
          api
            .post(
              `/admin/x/products/${id}/fashion`,
              {
                attributes: { kind: "apparel", material: "cotton" },
                size_chart_id: null,
                model_measurements: [NEW_MODEL],
              },
              headers ? { headers } : {},
            )
            .catch((e: unknown) => e);

        it("published + size_chart_id null + số đo mới → lỗi xuất bản, số đo cũ còn nguyên (cả id)", async () => {
          const { id, attributesId } = await seededPolo();
          const before = await measurementRows(attributesId);
          expect(before).toHaveLength(1);
          expect(before[0]).toMatchObject({ height_cm: 180, chest_cm: 94, size_worn: "l" });
          const [srcBefore] = await loadProductSources(container, { id: [id] });

          const err = await removeChartWithNewModel(id, admin);
          expect(status(err)).toBe(400);
          expect(String(body(err).message)).toContain("SIZE_CHART_MISSING");

          expect(await measurementRows(attributesId)).toEqual(before);
          const [srcAfter] = await loadProductSources(container, { id: [id] });
          expect(srcAfter?.attributes?.modelMeasurements).toEqual(srcBefore?.attributes?.modelMeasurements);
          expect(srcAfter?.sizeChart?.code).toBe("ao-nam");
        });

        it("hai request lỗi đồng thời → cả hai 400, số đo cũ còn đúng một bản", async () => {
          const { id, attributesId } = await seededPolo();
          const before = await measurementRows(attributesId);
          const errs = await Promise.all([
            removeChartWithNewModel(id, admin),
            removeChartWithNewModel(id, admin),
          ]);
          expect(errs.map(status)).toEqual([400, 400]);
          expect(await measurementRows(attributesId)).toEqual(before);
        });

        it("thay thành công → chỉ còn số đo mới, bản cũ bị xoá hẳn (không giữ PII người mẫu)", async () => {
          const { id, attributesId } = await seededPolo();
          const before = await measurementRows(attributesId);
          const res = await api.post(
            `/admin/x/products/${id}/fashion`,
            { attributes: { kind: "apparel", material: "cotton" }, model_measurements: [NEW_MODEL] },
            { headers: admin },
          );
          expect(res.status).toBe(200);
          const after = await measurementRows(attributesId, true);
          expect(after).toHaveLength(1);
          expect(after[0]).toMatchObject({ height_cm: 170, size_worn: "m", note: "Số đo mới" });
          expect(after[0]!.id).not.toBe(before[0]!.id);
        });

        it("tạo lại số đo idempotent: đã có → không đổi; hai lần bù trừ song song → đúng một bản, không ném lỗi", async () => {
          const { attributesId } = await seededPolo();
          const fashion: FashionModuleService = container.resolve(FASHION_MODULE);
          const before = await measurementRows(attributesId);
          const snapshot = before as unknown as MeasurementSnapshot[];
          await recreateMeasurements(fashion, attributesId, snapshot);
          expect(await measurementRows(attributesId)).toEqual(before);

          await fashion.deleteModelMeasurements(snapshot.map((m) => m.id));
          expect(await measurementRows(attributesId, true)).toEqual([]);
          await Promise.all([
            recreateMeasurements(fashion, attributesId, snapshot),
            recreateMeasurements(fashion, attributesId, snapshot),
          ]);
          expect(await measurementRows(attributesId)).toEqual(before);
        });

        it("không đăng nhập → 401, số đo không đổi", async () => {
          const { id, attributesId } = await seededPolo();
          const before = await measurementRows(attributesId);
          const err = await removeChartWithNewModel(id);
          expect(status(err)).toBe(401);
          expect(await measurementRows(attributesId)).toEqual(before);
        });
      });

      it("body sai → 422 problem+json", async () => {
        const p = await createTestProduct(container);
        const err = await api
          .post(`/admin/x/products/${p.id}/fashion`, { attributes: { kind: "shirt" } }, { headers: admin })
          .catch((e: unknown) => e);
        expect(status(err)).toBe(422);
        expect(
          (err as { response: { headers: Record<string, string> } }).response.headers["content-type"],
        ).toMatch(/application\/problem\+json/);
        expect(body(err)).toMatchObject({ code: "VALIDATION", errors: [{ param: "attributes.kind" }] });
      });

      it("không đăng nhập → 401 ở route admin", async () => {
        const p = await createTestProduct(container);
        const err = await api.get(`/admin/x/products/${p.id}/publish-check`).catch((e: unknown) => e);
        expect(status(err)).toBe(401);
        const err2 = await api
          .post("/admin/x/size-charts", { code: "x", ...TEST_CHART })
          .catch((e: unknown) => e);
        expect(status(err2)).toBe(401);
      });
    });

    describe("bảng size có phiên bản", () => {
      it("revise tạo phiên bản mới, bản cũ giữ nguyên, sản phẩm chuyển sang bản mới", async () => {
        const created = await api.post(
          "/admin/x/size-charts",
          { code: "Áo Thử", ...TEST_CHART },
          { headers: admin },
        );
        expect(created.status).toBe(201);
        const v1 = created.data.size_chart;
        expect(v1).toMatchObject({ code: "ao-thu", version: 1, unit: "cm" });

        const p = await createTestProduct(container);
        await setProductFashionWorkflow(container).run({
          input: { product_id: p.id, attributes: { kind: "apparel" }, size_chart_id: v1.id },
        });

        const rows2 = [...TEST_CHART.rows, { size: "L", label: "L", values: { nguc: [88, 92] } }];
        const revised = await api.post(
          "/admin/x/size-charts/ao-thu/revise",
          { ...TEST_CHART, rows: rows2 },
          { headers: admin },
        );
        expect(revised.status).toBe(201);
        expect(revised.data.size_chart).toMatchObject({ code: "ao-thu", version: 2 });
        expect(revised.data.product_ids).toEqual([p.id]);

        const fashion: FashionModuleService = container.resolve(FASHION_MODULE);
        const old = await fashion.retrieveSizeChart(v1.id);
        expect(old.superseded_at).not.toBeNull();
        expect(old.rows).toEqual(v1.rows); // bản cũ không bị sửa — đơn cũ vẫn trỏ đúng
        const [after] = await loadProductSources(container, { id: [p.id] });
        expect(after?.sizeChart).toMatchObject({ id: revised.data.size_chart.id, version: 2 });
        expect((after?.sizeChart?.rows as unknown[]).length).toBe(3);

        const list = await api.get("/admin/x/size-charts?code=ao-thu", { headers: admin });
        expect(list.data.size_charts.map((c: { version: number }) => c.version)).toEqual([2, 1]);

        // Gắn bản đã bị thay → từ chối.
        const q = await createTestProduct(container);
        await expect(
          setProductFashionWorkflow(container).run({
            input: { product_id: q.id, attributes: { kind: "apparel" }, size_chart_id: v1.id },
          }),
        ).rejects.toMatchObject({ message: expect.stringMatching(/phiên bản mới hơn/) });
      });

      it("trùng code khi tạo → 422; nội dung sai → 422; code chưa có → 404", async () => {
        await api.post("/admin/x/size-charts", { code: "trung", ...TEST_CHART }, { headers: admin });
        const dup = await api
          .post("/admin/x/size-charts", { code: "trung", ...TEST_CHART }, { headers: admin })
          .catch((e: unknown) => e);
        expect(status(dup)).toBe(422);
        const bad = await api
          .post(
            "/admin/x/size-charts",
            { code: "sai", ...TEST_CHART, rows: [{ size: "s", label: "S", values: { nguc: [90, 80] } }] },
            { headers: admin },
          )
          .catch((e: unknown) => e);
        expect(status(bad)).toBe(422);
        const missing = await api
          .post("/admin/x/size-charts/khong-co/revise", TEST_CHART, { headers: admin })
          .catch((e: unknown) => e);
        expect(status(missing)).toBe(404);
      });

      it("hai lần revise đồng thời → phiên bản không trùng, đúng một bản hiện hành, sản phẩm trỏ bản hiện hành", async () => {
        const v1 = (
          await api.post("/admin/x/size-charts", { code: "song-song", ...TEST_CHART }, { headers: admin })
        ).data.size_chart;
        const p = await createTestProduct(container);
        await setProductFashionWorkflow(container).run({
          input: { product_id: p.id, attributes: { kind: "apparel" }, size_chart_id: v1.id },
        });
        const results = await Promise.allSettled([
          api.post("/admin/x/size-charts/song-song/revise", TEST_CHART, { headers: admin }),
          api.post("/admin/x/size-charts/song-song/revise", TEST_CHART, { headers: admin }),
        ]);
        expect(results.some((r) => r.status === "fulfilled")).toBe(true);
        const fashion: FashionModuleService = container.resolve(FASHION_MODULE);
        const all = await fashion.listSizeCharts({ code: "song-song" });
        const versions = all.map((c) => c.version).sort();
        expect(new Set(versions).size).toBe(versions.length);
        const current = all.filter((c) => !c.superseded_at);
        expect(current).toHaveLength(1);
        const [after] = await loadProductSources(container, { id: [p.id] });
        expect(after?.sizeChart?.id).toBe(current[0]!.id);
      });
    });

    describe("option Màu/Size native", () => {
      it("giá trị option là slug, SKU nhận giá VND nguyên theo từng biến thể", async () => {
        const { result } = await createProductsWorkflow(container).run({
          input: {
            products: [
              {
                title: "Áo option",
                options: [
                  { title: OPTION_COLOR, values: ["den", "trang"] },
                  { title: OPTION_SIZE, values: ["s"] },
                ],
                variants: [
                  {
                    title: "Đen / S",
                    sku: "OPT-DEN-S",
                    options: { [OPTION_COLOR]: "den", [OPTION_SIZE]: "s" },
                    prices: [{ amount: 700_000, currency_code: CURRENCY }],
                  },
                  {
                    title: "Trắng / S",
                    sku: "OPT-TRANG-S",
                    options: { [OPTION_COLOR]: "trang", [OPTION_SIZE]: "s" },
                    prices: [{ amount: 300_000, currency_code: CURRENCY }],
                  },
                ],
              },
            ],
          },
        });
        const [p] = await loadProductSources(container, { id: [(result[0] as { id: string }).id] });
        expect(p?.variants.map((v) => [v.sku, v.color, v.size, v.basePrice]).sort()).toEqual([
          ["OPT-DEN-S", "den", "s", 700_000],
          ["OPT-TRANG-S", "trang", "s", 300_000],
        ]);
      });
    });
  },
});
