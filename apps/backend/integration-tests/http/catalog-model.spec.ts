import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { createProductsWorkflow } from "@medusajs/medusa/core-flows";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import Redis from "ioredis";
import { CURRENCY, OPTION_COLOR, OPTION_SIZE } from "../../src/lib/catalog/constants";
import { loadProductSources } from "../../src/lib/catalog/product-source";
import { FASHION_MODULE } from "../../src/modules/fashion";
import type FashionModuleService from "../../src/modules/fashion/service";
import { DEMO_PRODUCTS } from "../../src/scripts/catalog-demo-data";
import seedCatalog from "../../src/scripts/seed-catalog";
import {
  type MeasurementSnapshot,
  productFashionLockKey,
  recreateMeasurements,
  type SetProductFashionInput,
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

        /** Cổng một lần, có hạn chờ — hạn vượt nghĩa là thứ tự ép không xảy ra (test đỏ thay vì treo). */
        function gate(label: string, ms = 20_000) {
          let open!: () => void;
          const opened = new Promise<void>((r) => (open = r));
          const wait = () =>
            Promise.race([
              opened,
              new Promise<void>((_, rej) => setTimeout(() => rej(new Error(`gate timeout: ${label}`)), ms)),
            ]);
          return { open, wait, opened };
        }

        const outcome = (p: Promise<unknown>) =>
          p.then(
            () => "ok",
            (e: unknown) => `err: ${String((e as Error)?.message ?? e)}`,
          );

        type Patchable = Record<string, (...args: unknown[]) => Promise<unknown>>;
        const firstOf = (args: unknown[]) =>
          ([] as { id?: string; image_set?: string }[]).concat(args[0] as never)[0];

        /**
         * Ép xen kẽ bất lợi giữa hai lượt A, B cho cùng sản phẩm: A dừng ở `pauseA` (sau khi đọc / sau khi tạo số đo mới)
         * tới khi B hoặc bị khoá chặn, hoặc đã chạy tới cùng điểm; B (nếu chạy được) dừng sau khi tạo số đo tới khi A
         * xong. Không khoá → xen kẽ xảy ra đúng như ép; có khoá → B bị chặn, A chạy hết (cả bù trừ) rồi B mới chạy.
         */
        async function interleave(
          a: SetProductFashionInput,
          b: SetProductFashionInput,
          pauseA: "list" | "create",
        ) {
          const fashion = container.resolve(FASHION_MODULE) as unknown as Patchable;
          const locking = container.resolve(Modules.LOCKING) as unknown as Patchable;
          const orig = {
            list: fashion.listModelMeasurements!,
            create: fashion.createModelMeasurements!,
            acquire: locking.acquire!,
          };
          const aPaused = gate("A tới điểm dừng");
          const bBlocked = gate("B bị khoá chặn");
          const bReached = gate("B tới điểm dừng");
          const aDone = gate("A xong");
          const lockKey = productFashionLockKey(a.product_id);
          const aSet = a.model_measurements?.[0]?.image_set;
          const bSet = b.model_measurements?.[0]?.image_set;
          let lockRefusals = 0;
          let replaceLists = 0;
          let aWaited = false;
          const waitForB = async () => {
            aWaited = true;
            aPaused.open();
            await Promise.race([bBlocked.opened, bReached.opened, gate("A chờ B").wait()]);
          };
          locking.acquire = (...args: unknown[]) =>
            orig.acquire.apply(locking, args).catch((e: unknown) => {
              if (String(args[0]).includes(lockKey)) {
                lockRefusals++;
                bBlocked.open();
              }
              throw e;
            });
          fashion.listModelMeasurements = async (...args: unknown[]) => {
            const f = args[0] as Record<string, unknown> | undefined;
            const res = await orig.list.apply(fashion, args);
            if (pauseA === "list" && f && typeof f.attributes_id === "string" && !("id" in f)) {
              const n = ++replaceLists;
              if (n === 1) await waitForB();
              else if (n === 2) bReached.open();
            }
            return res;
          };
          fashion.createModelMeasurements = async (...args: unknown[]) => {
            const res = await orig.create.apply(fashion, args);
            const set = firstOf(args)?.image_set;
            if (pauseA === "create" && set === aSet && !aWaited) {
              await waitForB();
            } else if (pauseA === "create" && set === bSet && bSet !== aSet) {
              bReached.open();
              await aDone.wait();
            } else if (pauseA === "create" && set === aSet && aWaited && bSet === aSet) {
              // A và B cùng image_set: lần tạo thứ hai là của B.
              bReached.open();
              await aDone.wait();
            }
            return res;
          };
          try {
            const runA = outcome(setProductFashionWorkflow(container).run({ input: a })).finally(() =>
              aDone.open(),
            );
            await aPaused.wait();
            const runB = outcome(setProductFashionWorkflow(container).run({ input: b }));
            const [ra, rb] = await Promise.all([runA, runB]);
            return { ra, rb, lockRefusals };
          } finally {
            fashion.listModelMeasurements = orig.list;
            fashion.createModelMeasurements = orig.create;
            locking.acquire = orig.acquire;
          }
        }

        const failing = (id: string, image_set: string): SetProductFashionInput => ({
          product_id: id,
          attributes: { kind: "apparel", material: "cotton" },
          size_chart_id: null,
          model_measurements: [{ image_set, height_cm: 171, size_worn: "m" }],
        });
        const succeeding = (id: string, image_set: string): SetProductFashionInput => ({
          product_id: id,
          attributes: { kind: "apparel", material: "cotton" },
          model_measurements: [{ image_set, height_cm: 172, size_worn: "s" }],
        });

        it("hai lượt lỗi cùng sản phẩm, ép xen kẽ → lượt sau chờ khoá; cả hai lỗi, số đo cũ còn đúng một bản", async () => {
          const { id, attributesId } = await seededPolo();
          const before = await measurementRows(attributesId);
          const r = await interleave(failing(id, "moi"), failing(id, "moi"), "create");
          expect(r.ra).toContain("SIZE_CHART_MISSING");
          expect(r.rb).toContain("SIZE_CHART_MISSING");
          expect(r.lockRefusals).toBeGreaterThan(0);
          expect(await measurementRows(attributesId, true)).toEqual(before);
          const [src] = await loadProductSources(container, { id: [id] });
          expect(src?.sizeChart?.code).toBe("ao-nam");
        });

        it("lượt A lỗi, lượt B thay số đo thành công chen vào → chỉ còn số đo của B (bù trừ A không làm sống lại bản cũ)", async () => {
          const { id, attributesId } = await seededPolo();
          const r = await interleave(failing(id, "a-set"), succeeding(id, "b-set"), "create");
          expect(r.ra).toContain("SIZE_CHART_MISSING");
          expect(r.rb).toBe("ok");
          const after = await measurementRows(attributesId, true);
          expect(after.map((m) => m.image_set)).toEqual(["b-set"]);
        });

        it("hai lượt thành công đồng thời (T-150), ép cùng đọc trước khi xoá → đúng một bộ số đo (của lượt sau)", async () => {
          const { id, attributesId } = await seededPolo();
          const r = await interleave(succeeding(id, "a-set"), succeeding(id, "b-set"), "list");
          expect([r.ra, r.rb]).toEqual(["ok", "ok"]);
          const after = await measurementRows(attributesId, true);
          expect(after.map((m) => m.image_set)).toEqual(["b-set"]);
          expect(r.lockRefusals).toBeGreaterThan(0);
        });

        it("hai request HTTP lỗi đồng thời → cả hai 400, số đo cũ còn đúng một bản", async () => {
          const { id, attributesId } = await seededPolo();
          const before = await measurementRows(attributesId);
          const errs = await Promise.all([
            removeChartWithNewModel(id, admin),
            removeChartWithNewModel(id, admin),
          ]);
          expect(errs.map(status)).toEqual([400, 400]);
          expect(await measurementRows(attributesId)).toEqual(before);
        });

        it("tạo số đo mới lỗi sau khi đã xoá bản cũ → workflow lỗi, bước tự hoàn tác, số đo cũ còn nguyên", async () => {
          const { id, attributesId } = await seededPolo();
          const before = await measurementRows(attributesId);
          const fashion = container.resolve(FASHION_MODULE) as unknown as Patchable;
          const origCreate = fashion.createModelMeasurements!;
          fashion.createModelMeasurements = async (...args: unknown[]) => {
            if (firstOf(args)?.image_set === "moi")
              throw new Error("canceling statement due to statement timeout");
            return origCreate.apply(fashion, args);
          };
          let r: string;
          try {
            r = await outcome(setProductFashionWorkflow(container).run({ input: succeeding(id, "moi") }));
          } finally {
            fashion.createModelMeasurements = origCreate;
          }
          expect(r).toContain("statement timeout");
          expect(await measurementRows(attributesId, true)).toEqual(before);
        });

        it("lệnh tạo số đo mới đã ghi nhưng báo lỗi → hoàn tác xoá cả bản không kịp nhận id, số đo cũ còn nguyên", async () => {
          const { id, attributesId } = await seededPolo();
          const before = await measurementRows(attributesId);
          const fashion = container.resolve(FASHION_MODULE) as unknown as Patchable;
          const origCreate = fashion.createModelMeasurements!;
          fashion.createModelMeasurements = async (...args: unknown[]) => {
            const res = await origCreate.apply(fashion, args);
            if (firstOf(args)?.image_set === "moi") throw new Error("connection terminated after commit");
            return res;
          };
          let r: string;
          try {
            r = await outcome(setProductFashionWorkflow(container).run({ input: succeeding(id, "moi") }));
          } finally {
            fashion.createModelMeasurements = origCreate;
          }
          expect(r).toContain("connection terminated");
          expect(await measurementRows(attributesId, true)).toEqual(before);
        });

        it("hoàn tác số đo lỗi → log error kèm attributes_id và id (không số đo), workflow báo lỗi, khoá vẫn nhả", async () => {
          const { id, attributesId } = await seededPolo();
          const before = await measurementRows(attributesId);
          const oldId = String(before[0]!.id);
          const fashion = container.resolve(FASHION_MODULE) as unknown as Patchable;
          const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as unknown as Record<
            string,
            (...args: unknown[]) => unknown
          >;
          const origCreate = fashion.createModelMeasurements!;
          const origError = logger.error!;
          const errors: string[] = [];
          fashion.createModelMeasurements = async (...args: unknown[]) => {
            if (firstOf(args)?.id === oldId) throw new Error("recreate boom");
            return origCreate.apply(fashion, args);
          };
          logger.error = (...args: unknown[]) => {
            errors.push(args.map(String).join(" "));
            return origError.apply(logger, args);
          };
          let r: string;
          try {
            r = await outcome(setProductFashionWorkflow(container).run({ input: failing(id, "moi") }));
          } finally {
            fashion.createModelMeasurements = origCreate;
            logger.error = origError;
          }
          expect(r).toMatch(/^err: /);
          const line = errors.find((l) => l.includes("Hoàn tác số đo người mẫu lỗi"));
          expect(line).toBeDefined();
          expect(line).toContain(`attributes_id=${attributesId}`);
          expect(line).toContain(oldId);
          expect(line).toContain("recreate boom");
          expect(line).not.toMatch(/Dữ liệu demo|height_cm|size_worn/);
          // Khoá đã nhả dù bù trừ lỗi: lượt kế tiếp chạy được ngay, không chờ hết lease.
          const t0 = Date.now();
          expect(
            await outcome(setProductFashionWorkflow(container).run({ input: succeeding(id, "sau") })),
          ).toBe("ok");
          expect(Date.now() - t0).toBeLessThan(4_000);
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

        it("tạo lại số đo: tạo lỗi mà id vẫn thiếu (attributes không tồn tại) → ném lại lỗi, không nuốt", async () => {
          const { attributesId } = await seededPolo();
          const fashion: FashionModuleService = container.resolve(FASHION_MODULE);
          const [row] = await measurementRows(attributesId);
          const ghost = { ...row, id: "fmm_t144_khong_ton_tai" } as unknown as MeasurementSnapshot;
          await expect(
            recreateMeasurements(fashion, "fpa_t144_khong_ton_tai", [ghost]),
          ).rejects.toBeDefined();
          expect(await fashion.listModelMeasurements({ id: [ghost.id] }, { withDeleted: true })).toEqual([]);
        });

        it("workflow không lưu lượt chạy (bản chụp số đo là PII): không có workflow_execution, không còn khoá Redis", async () => {
          const { id } = await seededPolo();
          expect(
            await outcome(setProductFashionWorkflow(container).run({ input: failing(id, "moi") })),
          ).toContain("SIZE_CHART_MISSING");
          await setProductFashionWorkflow(container).run({ input: succeeding(id, "moi") });
          const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
          const res = (await pg.raw(
            "select count(*)::int as n from workflow_execution where workflow_id = 'x-set-product-fashion'",
          )) as { rows: { n: number }[] };
          expect(res.rows[0]!.n).toBe(0);
          const redis = new Redis(process.env.REDIS_URL!);
          try {
            expect(await redis.keys("*x-set-product-fashion*")).toEqual([]);
            expect(await redis.keys(`*${productFashionLockKey(id)}*`)).toEqual([]);
          } finally {
            redis.disconnect();
          }
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
