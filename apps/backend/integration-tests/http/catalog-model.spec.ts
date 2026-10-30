import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { createProductsWorkflow } from "@medusajs/medusa/core-flows";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import Redis from "ioredis";
import { isNonEmpty } from "@x-shop/domain";
import { kindLabel } from "../../src/admin/lib/labels";
import { CURRENCY, OPTION_COLOR, OPTION_SIZE } from "../../src/lib/catalog/constants";
import { loadProductSources } from "../../src/lib/catalog/product-source";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import {
  OPS_EXCEPTION_LOCK_NS,
  OPS_EXCEPTION_LOCK_TIMEOUT_MS,
  OPS_EXCEPTION_STATEMENT_TIMEOUT_MS,
  opsExceptionLockKey,
} from "../../src/modules/checkout/service";
import { OPS_EXCEPTION_KINDS } from "../../src/modules/checkout/models/constants";
import { FASHION_MODULE } from "../../src/modules/fashion";
import type FashionModuleService from "../../src/modules/fashion/service";
import { DEMO_PRODUCTS } from "../../src/scripts/catalog-demo-data";
import seedCatalog from "../../src/scripts/seed-catalog";
import {
  type MeasurementSnapshot,
  openCompensationException,
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
        expect(
          shirt.images.every(
            (i) => isNonEmpty(i.alt) && isNonEmpty(i.color) && i.width === 800 && i.height === 1000,
          ),
        ).toBe(true);

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
          expect(r).toContain("Thay số đo người mẫu lỗi");
          expect(r).not.toContain("statement timeout"); // lỗi thô không ra khỏi bước
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
          expect(r).toContain("Thay số đo người mẫu lỗi");
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
          expect(line).toContain("Error"); // chỉ tên lỗi — message thô không được log (có thể chứa PII)
          expect(line).not.toContain("recreate boom");
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

        it("lỗi DB thật khi tạo mới và khi hoàn tác → log lỗi gốc + lỗi hoàn tác, không chứa số đo/câu SQL", async () => {
          const { id, attributesId } = await seededPolo();
          const before = await measurementRows(attributesId);
          const oldId = String(before[0]!.id);
          const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
          const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as unknown as Record<
            string,
            (...args: unknown[]) => unknown
          >;
          const origError = logger.error!;
          const errors: string[] = [];
          logger.error = (...args: unknown[]) => {
            errors.push(args.map(String).join(" "));
            return origError.apply(logger, args);
          };
          // Trigger raise ở mọi INSERT số đo của sản phẩm này: bản mới → "boom create", tạo lại bản cũ → "boom recreate".
          await pg.raw(`
            create or replace function t144_boom() returns trigger language plpgsql as $$
            begin
              if new.id = '${oldId}' then raise exception 'boom recreate'; end if;
              if new.image_set = 'moi' then raise exception 'boom create'; end if;
              return new;
            end $$;
            create trigger t144_boom before insert on fashion_model_measurement
              for each row execute function t144_boom();
          `);
          let r: string;
          try {
            r = await outcome(setProductFashionWorkflow(container).run({ input: succeeding(id, "moi") }));
          } finally {
            await pg.raw("drop trigger if exists t144_boom on fashion_model_measurement");
            await pg.raw("drop function if exists t144_boom()");
            logger.error = origError;
          }
          expect(r).toMatch(/^err: /);
          const undoLine = errors.find((l) => l.includes("Hoàn tác số đo người mẫu lỗi"));
          const origLine = errors.find((l) => l.includes("lỗi gốc trước khi hoàn tác lỗi"));
          expect(undoLine).toContain("code=P0001");
          expect(undoLine).toContain(oldId);
          expect(origLine).toContain("code=P0001");
          expect(origLine).toContain(`attributes_id=${attributesId}`);
          for (const line of [undoLine!, origLine!]) {
            expect(line).not.toMatch(/insert into|values|\b(180|94|78|95|170)\b|Dữ liệu demo/i);
          }
        });

        describe("lỗi DB thật qua HTTP không lộ số đo vào log 500", () => {
          const MODEL = {
            image_set: "moi",
            height_cm: 173,
            chest_cm: 91,
            waist_cm: 77,
            hip_cm: 99,
            size_worn: "m",
          };
          /** Chuỗi log đầy đủ như handler ghi: message, stack và cả chuỗi `cause`. */
          const render = (x: unknown): string => {
            if (typeof x === "string") return x;
            if (x instanceof Error)
              return `${x.name}: ${x.message}\n${x.stack ?? ""}\ncause: ${render(x.cause)}`;
            try {
              return JSON.stringify(x) ?? String(x);
            } catch {
              return String(x);
            }
          };

          async function postWithTrigger(cond: string) {
            const { id, attributesId } = await seededPolo();
            const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
            const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as unknown as Record<
              string,
              (...args: unknown[]) => unknown
            >;
            const orig = { error: logger.error!, warn: logger.warn! };
            const lines: string[] = [];
            for (const level of ["error", "warn"] as const) {
              logger[level] = (...args: unknown[]) => {
                lines.push(`${level} ${args.map(render).join(" ")}`);
                return orig[level].apply(logger, args);
              };
            }
            await pg.raw(`
              create or replace function t144_leak() returns trigger language plpgsql as $$
              begin
                if ${cond} then raise exception 'boom %', tg_op; end if;
                return new;
              end $$;
              create trigger t144_leak before insert on fashion_model_measurement
                for each row execute function t144_leak();
            `);
            let err: unknown;
            try {
              err = await api
                .post(
                  `/admin/x/products/${id}/fashion`,
                  { attributes: { kind: "apparel", material: "cotton" }, model_measurements: [MODEL] },
                  { headers: admin },
                )
                .catch((e: unknown) => e);
            } finally {
              await pg.raw("drop trigger if exists t144_leak on fashion_model_measurement");
              await pg.raw("drop function if exists t144_leak()");
              Object.assign(logger, orig);
            }
            return { err, lines, attributesId };
          }

          // Số đo dạng phần tử danh sách giá trị SQL (`, 180,`) — không bắt nhầm số dòng/cột trong stack (`:91:52`).
          const LEAK = /insert into|values\s*\(|[(,]\s*'?(173|91|77|99|180|94|78|95)'?\s*[,)]|Dữ liệu demo/i;

          it("V1: chỉ insert số đo mới lỗi → 500, log không chứa SQL/số đo, số đo cũ được khôi phục", async () => {
            const { attributesId } = await seededPolo();
            const before = await measurementRows(attributesId);
            const { err, lines } = await postWithTrigger("new.image_set = 'moi'");
            expect(status(err)).toBe(500);
            expect(JSON.stringify(body(err))).not.toMatch(LEAK);
            expect(lines.some((l) => l.includes("Thay số đo người mẫu lỗi"))).toBe(true);
            expect(lines.filter((l) => LEAK.test(l))).toEqual([]);
            expect(await measurementRows(attributesId)).toEqual(before);
          });

          it("V2: insert mới và khôi phục bản cũ cùng lỗi → 500, log không chứa SQL/số đo (kể cả của người mẫu cũ)", async () => {
            const { attributesId } = await seededPolo();
            const [old] = await measurementRows(attributesId);
            const { err, lines } = await postWithTrigger(
              `new.image_set = 'moi' or new.id = '${String(old!.id)}'`,
            );
            expect(status(err)).toBe(500);
            expect(JSON.stringify(body(err))).not.toMatch(LEAK);
            expect(lines.some((l) => l.includes("Hoàn tác số đo người mẫu lỗi"))).toBe(true);
            expect(lines.filter((l) => LEAK.test(l))).toEqual([]);
          });
        });

        describe("bù trừ thuộc tính/bảng size lỗi phải để lại dấu vết (T-155)", () => {
          /** Gỡ bảng size (SIZE_CHART_MISSING → workflow bù trừ) kèm đổi chất liệu sang giá trị khác bản gốc. */
          const BODY = { attributes: { kind: "apparel", material: "lua" }, size_chart_id: null };
          const LEAK = /insert into|update\s+"|values\s*\(|\blua\b|Cotton|Việt Nam|user_[a-z0-9_]+/i;

          async function runWithTrigger(sql: string, drop: string, payload: unknown = BODY) {
            const { id, attributesId } = await seededPolo();
            const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
            const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as unknown as Record<
              string,
              (...args: unknown[]) => unknown
            >;
            const orig = { error: logger.error!, warn: logger.warn! };
            const lines: string[] = [];
            for (const level of ["error", "warn"] as const) {
              logger[level] = (...args: unknown[]) => {
                lines.push(
                  `${level} ${args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`,
                );
                return orig[level].apply(logger, args);
              };
            }
            await pg.raw(sql);
            let err: unknown;
            try {
              err = await api
                .post(`/admin/x/products/${id}/fashion`, payload, { headers: admin })
                .catch((e: unknown) => e);
            } finally {
              await pg.raw(drop);
              Object.assign(logger, orig);
            }
            return { err, lines, id, attributesId };
          }

          it("khôi phục thuộc tính lỗi → có log chỉ id + mã lỗi, không giá trị/PII; API vẫn 400", async () => {
            const { err, lines, attributesId } = await runWithTrigger(
              `create or replace function t155_boom() returns trigger language plpgsql as $$
               begin if new.material = 'cotton' then raise exception 'boom restore'; end if; return new; end $$;
               create trigger t155_boom before update on fashion_product_attributes
                 for each row execute function t155_boom();`,
              "drop trigger if exists t155_boom on fashion_product_attributes; drop function if exists t155_boom();",
            );
            expect(status(err)).toBe(400);
            const line = lines.find((l) => l.includes("Hoàn tác thuộc tính thời trang lỗi"));
            expect(line).toBeDefined();
            expect(line).toContain(`attributes_id=${attributesId}`);
            expect(line).toContain("code=P0001");
            expect(lines.filter((l) => LEAK.test(l))).toEqual([]);
          });

          it("CHECK thật chặn khôi phục thuộc tính (23514) → log/lỗi không chứa giá trị cột (detail của PG)", async () => {
            const { err, lines } = await runWithTrigger(
              `alter table fashion_product_attributes add constraint t155_chk check (material <> 'cotton') not valid;`,
              "alter table fashion_product_attributes drop constraint if exists t155_chk;",
            );
            expect(status(err)).toBe(400);
            const line = lines.find((l) => l.includes("Hoàn tác thuộc tính thời trang lỗi"));
            expect(line).toBeDefined();
            expect(line).toContain("code=23514");
            expect(line).toContain("constraint=t155_chk");
            expect(lines.filter((l) => /Failing row|detail:|cotton|Cotton|100%/i.test(l))).toEqual([]);
            expect(JSON.stringify(body(err))).not.toMatch(/Failing row|detail:|cotton/i);
          });

          it("CHECK thật chặn tạo lại số đo cũ (23514) → log/lỗi không chứa số đo", async () => {
            const MODEL = {
              image_set: "moi",
              height_cm: 173,
              chest_cm: 91,
              waist_cm: 77,
              hip_cm: 99,
              size_worn: "m",
            };
            const { err, lines } = await runWithTrigger(
              `alter table fashion_model_measurement add constraint t155_chk2 check (height_cm <> 180) not valid;`,
              "alter table fashion_model_measurement drop constraint if exists t155_chk2;",
              { ...BODY, model_measurements: [MODEL] },
            );
            expect(status(err)).toBeGreaterThanOrEqual(400);
            const line = lines.find((l) => l.includes("Hoàn tác số đo người mẫu lỗi"));
            expect(line).toBeDefined();
            expect(line).toContain("code=23514");
            expect(line).toContain("constraint=t155_chk2");
            expect(
              lines.filter((l) => /Failing row|detail:|\b(180|94|78|95)\b|Dữ liệu demo/i.test(l)),
            ).toEqual([]);
            expect(JSON.stringify(body(err))).not.toMatch(
              /Failing row|detail:|\b(180|94|78|95)\b|Dữ liệu demo/i,
            );
          });

          it("giá trị nhiều dòng chứa ' - ' (care/composition/note) không lọt vào log hay lỗi", async () => {
            const { attributesId } = await seededPolo();
            const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
            const orig = (
              (await pg.raw(
                `select a.composition, a.care, (select m.note from fashion_model_measurement m where m.attributes_id = a.id order by m.id limit 1) as note from fashion_product_attributes a where a.id = ?`,
                [attributesId],
              )) as { rows: { composition: string | null; care: string | null; note: string | null }[] }
            ).rows[0]!;
            await pg.raw(
              `update fashion_product_attributes set composition = '95% cotton - 5% spandex', care = E'Giat tay\\nKhong say - phoi rieng' where id = ?`,
              [attributesId],
            );
            await pg.raw(
              `update fashion_model_measurement set note = E'Ghi chu mot - dong\\nhai - ba' where attributes_id = ?`,
              [attributesId],
            );
            const LEAKY = /spandex|Giat tay|Khong say|phoi rieng|Ghi chu|dong|hai - ba|Failing row|detail:/;
            try {
              const a = await runWithTrigger(
                `alter table fashion_product_attributes add constraint t155_chk3 check (material <> 'cotton') not valid;`,
                "alter table fashion_product_attributes drop constraint if exists t155_chk3;",
              );
              const la = a.lines.find((l) => l.includes("Hoàn tác thuộc tính thời trang lỗi"));
              expect(la).toContain("code=23514");
              expect(la).toContain("constraint=t155_chk3");
              expect(a.lines.filter((l) => LEAKY.test(l))).toEqual([]);
              expect(JSON.stringify(body(a.err))).not.toMatch(LEAKY);

              const m = await runWithTrigger(
                `alter table fashion_model_measurement add constraint t155_chk4 check (height_cm <> 180) not valid;`,
                "alter table fashion_model_measurement drop constraint if exists t155_chk4;",
                {
                  ...BODY,
                  model_measurements: [{ image_set: "moi", height_cm: 173, size_worn: "m" }],
                },
              );
              const lm = m.lines.find((l) => l.includes("Hoàn tác số đo người mẫu lỗi"));
              expect(lm).toContain("code=23514");
              expect(lm).toContain("constraint=t155_chk4");
              expect(m.lines.filter((l) => LEAKY.test(l))).toEqual([]);
              expect(JSON.stringify(body(m.err))).not.toMatch(LEAKY);
            } finally {
              await pg.raw(`update fashion_product_attributes set composition = ?, care = ? where id = ?`, [
                orig.composition,
                orig.care,
                attributesId,
              ]);
              await pg.raw(`update fashion_model_measurement set note = ? where attributes_id = ?`, [
                orig.note,
                attributesId,
              ]);
            }
          });

          it("gắn lại bảng size lỗi → có log chỉ id + mã lỗi, không giá trị/PII", async () => {
            const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
            const { rows } = (await pg.raw(
              `select c.table_name from information_schema.columns c
                 where c.table_schema = 'public' and c.column_name = 'size_chart_id'
                   and c.table_name like '%product%' and c.table_name not like 'fashion\\_%'`,
            )) as { rows: { table_name: string }[] };
            expect(rows).toHaveLength(1);
            const table = rows[0]!.table_name;
            const { err, lines, id } = await runWithTrigger(
              `create or replace function t155_boom2() returns trigger language plpgsql as $$
               begin if new.deleted_at is null then raise exception 'boom relink'; end if; return new; end $$;
               create trigger t155_boom2 before insert or update on "${table}"
                 for each row execute function t155_boom2();`,
              `drop trigger if exists t155_boom2 on "${table}"; drop function if exists t155_boom2();`,
            );
            expect(status(err)).toBe(400);
            const line = lines.find((l) => l.includes("Hoàn tác bảng size lỗi"));
            expect(line).toBeDefined();
            expect(line).toContain(`product_id=${id}`);
            expect(lines.filter((l) => LEAK.test(l))).toEqual([]);
          });

          describe("bù trừ lỗi → ngoại lệ vận hành catalog_compensation_failed (T-156, D-095)", () => {
            const KIND = "catalog_compensation_failed";
            const pgc = () => container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
            /** Trigger PG thật: khôi phục chất liệu về `cotton` (bản gốc của polo seed) lỗi. */
            const ATTR_TRIGGER = [
              `create or replace function t156_boom() returns trigger language plpgsql as $$
               begin if new.material = 'cotton' then raise exception 'boom restore'; end if; return new; end $$;
               create trigger t156_boom before update on fashion_product_attributes
                 for each row execute function t156_boom();`,
              "drop trigger if exists t156_boom on fashion_product_attributes; drop function if exists t156_boom();",
            ] as const;
            /** Giá trị thuộc tính/số đo của polo seed, câu SQL, message thô của PG — không được có trong detail. */
            const VALUE_LEAK =
              /cotton|\blua\b|Việt Nam|\b(170|173|180|91|94|77|78|95|99)\b|insert|update|values|Failing row|boom/i;
            const ATTR_COLS = [
              "kind",
              "material",
              "material_label",
              "composition",
              "stretch",
              "fit",
              "care",
              "origin",
              "image_exception_by",
              "image_exception_reason",
            ] as const;

            const sorted = (xs: Iterable<string>) => [...xs].sort();
            type Row = { id: string; state: string; priority: string; detail: Record<string, unknown> };
            async function exceptions(): Promise<Row[]> {
              const { rows } = (await pgc().raw(
                `select id, state, priority, detail from ops_exception
                  where kind = ? and deleted_at is null order by created_at, id`,
                [KIND],
              )) as { rows: Row[] };
              return rows;
            }
            async function attrRow(attributesId: string) {
              const { rows } = (await pgc().raw(
                `select ${ATTR_COLS.map((c) => `"${c}"`).join(", ")} from fashion_product_attributes where id = ?`,
                [attributesId],
              )) as { rows: Record<string, string | null>[] };
              return rows[0]!;
            }
            /** Đưa thuộc tính về bản gốc (bù trừ lượt trước đã lỗi nên còn giá trị mới) — để lượt sau lỗi y như lượt đầu. */
            async function putAttrRow(attributesId: string, row: Record<string, string | null>) {
              await pgc().raw(
                `update fashion_product_attributes set ${ATTR_COLS.map((c) => `"${c}" = ?`).join(", ")} where id = ?`,
                [...ATTR_COLS.map((c) => row[c] ?? null), attributesId],
              );
            }

            it("khôi phục thuộc tính lỗi → đúng 1 ngoại lệ, detail chỉ id + mã lỗi; lặp lại không trùng; xử lý xong mà tái diễn thì mở lại", async () => {
              const { id, attributesId } = await seededPolo();
              const original = await attrRow(attributesId);
              expect(await exceptions()).toEqual([]);

              const first = await runWithTrigger(...ATTR_TRIGGER);
              expect(status(first.err)).toBe(400);
              const rows = await exceptions();
              expect(rows).toHaveLength(1);
              expect(rows[0]).toMatchObject({ state: "open", priority: "high" });
              expect(Object.keys(rows[0]!.detail).sort()).toEqual([
                "attributes_id",
                "created",
                "error",
                "product_id",
                "step",
              ]);
              expect(rows[0]!.detail).toMatchObject({
                step: "attributes",
                product_id: id,
                attributes_id: attributesId,
                created: "false",
              });
              expect(String(rows[0]!.detail.error)).toContain("code=P0001");
              expect(JSON.stringify(rows[0]!.detail)).not.toMatch(VALUE_LEAK);

              // Lỗi lặp lại y hệt → vẫn đúng 1 ngoại lệ đang hoạt động (log vẫn ghi lượt thứ hai).
              await putAttrRow(attributesId, original);
              const second = await runWithTrigger(...ATTR_TRIGGER);
              expect(second.lines.some((l) => l.includes("Hoàn tác thuộc tính thời trang lỗi"))).toBe(true);
              expect((await exceptions()).map((r) => r.id)).toEqual([rows[0]!.id]);

              // Ngoại lệ đã xử lý xong mà lỗi tái diễn → mở ngoại lệ mới.
              await pgc().raw(`update ops_exception set state = 'resolved' where id = ?`, [rows[0]!.id]);
              await putAttrRow(attributesId, original);
              await runWithTrigger(...ATTR_TRIGGER);
              const after = await exceptions();
              expect(after).toHaveLength(2);
              expect(after.filter((r) => r.state === "open")).toHaveLength(1);
            });

            it("dashboard: kind mới hiện đúng nhãn admin + owner 'owner', lọc được; vai trò không có exception.read → 403", async () => {
              await runWithTrigger(...ATTR_TRIGGER);
              const res = await api.get(`/admin/x/reports/exceptions?kind=${KIND}`, { headers: admin });
              expect(res.status).toBe(200);
              expect(res.data.items).toEqual([
                expect.objectContaining({
                  source: "ops",
                  kind: KIND,
                  priority: "high",
                  state: "open",
                  owner_role: "owner",
                }),
              ]);
              expect(kindLabel(res.data.items[0].kind)).toBe("Hoàn tác dữ liệu sản phẩm lỗi");
              expect(res.data.items[0].reference).toBe((await seededPolo()).id);
              expect(JSON.stringify(res.data.items)).not.toMatch(/cotton|Việt Nam|boom|Failing row/i);

              const warehouse = (await adminHeaders(api, container, { roles: ["warehouse"] })).headers;
              const denied = await api
                .get(`/admin/x/reports/exceptions?kind=${KIND}`, { headers: warehouse })
                .catch((e: unknown) => e);
              expect(status(denied)).toBe(403);
              expect(JSON.stringify(body(denied))).not.toContain(KIND);
            });

            it("gắn lại bảng size lỗi → ngoại lệ bước size_chart, chỉ id", async () => {
              const { rows: tables } = (await pgc().raw(
                `select c.table_name from information_schema.columns c
                   where c.table_schema = 'public' and c.column_name = 'size_chart_id'
                     and c.table_name like '%product%' and c.table_name not like 'fashion\\_%'`,
              )) as { rows: { table_name: string }[] };
              const table = tables[0]!.table_name;
              const { err, id } = await runWithTrigger(
                `create or replace function t156_boom2() returns trigger language plpgsql as $$
                 begin if new.deleted_at is null then raise exception 'boom relink'; end if; return new; end $$;
                 create trigger t156_boom2 before insert or update on "${table}"
                   for each row execute function t156_boom2();`,
                `drop trigger if exists t156_boom2 on "${table}"; drop function if exists t156_boom2();`,
              );
              expect(status(err)).toBe(400);
              const rows = await exceptions();
              expect(rows).toHaveLength(1);
              expect(Object.keys(rows[0]!.detail).sort()).toEqual([
                "error",
                "from",
                "product_id",
                "step",
                "to",
              ]);
              expect(rows[0]!.detail).toMatchObject({ step: "size_chart", product_id: id, from: null });
              expect(String(rows[0]!.detail.to)).toMatch(/^[A-Za-z0-9_]+$/);
              expect(String(rows[0]!.detail.error)).toContain("code=P0001");
              expect(JSON.stringify(rows[0]!.detail)).not.toMatch(VALUE_LEAK);
            });

            it("bù trừ số đo lỗi (CHECK thật chặn tạo lại bản cũ) → ngoại lệ bước measurements, không số đo", async () => {
              const { err, id, attributesId } = await runWithTrigger(
                `alter table fashion_model_measurement add constraint t156_chk check (height_cm <> 180) not valid;`,
                "alter table fashion_model_measurement drop constraint if exists t156_chk;",
                {
                  ...BODY,
                  model_measurements: [{ image_set: "moi", height_cm: 173, chest_cm: 91, size_worn: "m" }],
                },
              );
              expect(status(err)).toBeGreaterThanOrEqual(400);
              const rows = await exceptions();
              expect(rows).toHaveLength(1);
              expect(Object.keys(rows[0]!.detail).sort()).toEqual([
                "attributes_id",
                "error",
                "product_id",
                "step",
              ]);
              expect(rows[0]!.detail).toMatchObject({
                step: "measurements",
                product_id: id,
                attributes_id: attributesId,
              });
              expect(String(rows[0]!.detail.error)).toContain("code=23514");
              expect(String(rows[0]!.detail.error)).toContain("constraint=t156_chk");
              expect(JSON.stringify(rows[0]!.detail)).not.toMatch(VALUE_LEAK);
            });

            it("tự hoàn tác trong bước số đo lỗi (tạo mới lỗi, tạo lại bản cũ cũng lỗi) → ngoại lệ bước measurements", async () => {
              const { id, attributesId } = await seededPolo();
              const [old] = await measurementRows(attributesId);
              const { err } = await runWithTrigger(
                `create or replace function t156_boom3() returns trigger language plpgsql as $$
                 begin
                   if new.image_set = 'moi' or new.id = '${String(old!.id)}' then raise exception 'boom %', tg_op; end if;
                   return new;
                 end $$;
                 create trigger t156_boom3 before insert on fashion_model_measurement
                   for each row execute function t156_boom3();`,
                "drop trigger if exists t156_boom3 on fashion_model_measurement; drop function if exists t156_boom3();",
                {
                  attributes: { kind: "apparel", material: "cotton" },
                  model_measurements: [{ image_set: "moi", height_cm: 173, size_worn: "m" }],
                },
              );
              expect(status(err)).toBe(500);
              const rows = await exceptions();
              expect(rows).toHaveLength(1);
              expect(rows[0]!.detail).toMatchObject({
                step: "measurements",
                product_id: id,
                attributes_id: attributesId,
              });
              expect(String(rows[0]!.detail.error)).toContain("code=P0001");
              expect(JSON.stringify(rows[0]!.detail)).not.toMatch(VALUE_LEAK);
            });

            it("mở ngoại lệ lỗi → không che lỗi bù trừ gốc: API như cũ, lỗi bù trừ vẫn là lỗi gốc, log lỗi mở an toàn", async () => {
              const { id, attributesId } = await seededPolo();
              const original = await attrRow(attributesId);
              // Đối chứng: cùng ca, mở ngoại lệ chạy bình thường.
              const baseline = await runWithTrigger(...ATTR_TRIGGER);
              const [opened] = await exceptions();
              await pgc().raw(`update ops_exception set state = 'resolved' where id = ?`, [opened!.id]);
              await putAttrRow(attributesId, original);

              const checkout = container.resolve(CHECKOUT_MODULE) as unknown as Record<string, unknown>;
              const orig = checkout.openOpsExceptionIfNoneActive;
              let calls = 0;
              checkout.openOpsExceptionIfNoneActive = async () => {
                calls++;
                throw Object.assign(new Error(`insert into "ops_exception" values ('cotton') - boom`), {
                  code: "57014",
                });
              };
              let r: Awaited<ReturnType<typeof runWithTrigger>>;
              let errors: string[];
              try {
                r = await runWithTrigger(...ATTR_TRIGGER);
                // Chạy thẳng workflow để thấy lỗi bù trừ engine ghi nhận (`run.errors`/HTTP chỉ có lỗi INVOKE).
                await putAttrRow(attributesId, original);
                await pgc().raw(ATTR_TRIGGER[0]);
                try {
                  const run = await setProductFashionWorkflow(container).run({
                    input: { product_id: id, ...BODY } as SetProductFashionInput,
                    throwOnError: false,
                  });
                  type TxError = { action?: string; handlerType?: string; error?: unknown };
                  errors = (run.transaction as unknown as { getErrors(): TxError[] })
                    .getErrors()
                    .filter((x) => x.handlerType === "compensate")
                    .map(
                      (x) => `${x.action}: ${String((x.error as Error)?.message ?? JSON.stringify(x.error))}`,
                    );
                } finally {
                  await pgc().raw(ATTR_TRIGGER[1]);
                }
              } finally {
                checkout.openOpsExceptionIfNoneActive = orig;
              }
              expect(calls).toBe(2);
              expect(status(r.err)).toBe(status(baseline.err));
              const noTrace = (x: Record<string, unknown>) => ({ ...x, trace_id: undefined });
              expect(noTrace(body(r.err))).toEqual(noTrace(body(baseline.err)));
              expect(errors).toEqual(
                expect.arrayContaining([
                  expect.stringMatching(/Hoàn tác thuộc tính thời trang lỗi: .*code=P0001/),
                ]),
              );
              expect(errors.filter((m) => /57014|ops_exception|cotton|boom/.test(m))).toEqual([]);
              const compLine = r.lines.find((l) => l.includes("Hoàn tác thuộc tính thời trang lỗi"));
              expect(compLine).toContain("code=P0001");
              const openLine = r.lines.find((l) => l.includes(`Không mở được ngoại lệ ${KIND}`));
              expect(openLine).toContain("bước attributes");
              expect(openLine).toContain("code=57014");
              expect(r.lines.filter((l) => /cotton|insert into|boom/i.test(l))).toEqual([]);
              expect((await exceptions()).map((x) => [x.id, x.state])).toEqual([[opened!.id, "resolved"]]);
            });

            it("10 lời gọi song song cho 2 sản phẩm → đúng 1 ngoại lệ đang mở MỖI sản phẩm (khoá tuần tự hoá INSERT … WHERE NOT EXISTS)", async () => {
              const perRound: string[][] = [];
              for (let round = 0; round < 5; round++) {
                await pgc().raw(`delete from ops_exception where kind = ?`, [KIND]);
                await Promise.all(
                  Array.from({ length: 10 }, (_, i) =>
                    openCompensationException(
                      container,
                      i % 3 === 0 ? "measurements" : "attributes",
                      { product_id: `prod_t156_${round}_${i % 2}`, attributes_id: null },
                      Object.assign(new Error("boom"), { code: "P0001" }),
                    ),
                  ),
                );
                perRound.push(sorted((await exceptions()).map((r) => String(r.detail.product_id))));
              }
              expect(perRound).toEqual(
                Array.from({ length: 5 }, (_, round) => [`prod_t156_${round}_0`, `prod_t156_${round}_1`]),
              );
            });

            it("D-101: hai sản phẩm lệch → hai ngoại lệ; lặp lại ở A không trùng; đóng của A thì của B vẫn mở; dashboard hiện product_id", async () => {
              const all = await container
                .resolve(Modules.PRODUCT)
                .listProducts({ status: "published" } as never, { take: 200 });
              const srcs = await loadProductSources(container, { id: all.map((p) => p.id) });
              const withChart = srcs.filter((s) => s.sizeChart && s.attributes);
              const a = withChart.find((s) => s.handle === "ao-polo-nam")!;
              const b = withChart.find((s) => s.handle !== "ao-polo-nam")!;
              expect(b).toBeDefined();
              const originals = new Map<string, Record<string, string | null>>();
              for (const p of [a, b]) originals.set(p.attributes!.id, await attrRow(p.attributes!.id));
              // Mọi lần khôi phục thuộc tính (về giá trị khác 't156x') đều lỗi — bước đầu (đặt 't156x') thì qua.
              const trigger = [
                `create or replace function t156_two() returns trigger language plpgsql as $$
                 begin if new.material is distinct from 't156x' then raise exception 'boom two'; end if; return new; end $$;
                 create trigger t156_two before update on fashion_product_attributes
                   for each row execute function t156_two();`,
                "drop trigger if exists t156_two on fashion_product_attributes; drop function if exists t156_two();",
              ] as const;
              const payload = { attributes: { kind: "apparel", material: "t156x" }, size_chart_id: null };
              const failOnce = async (ids: string[]) => {
                await pgc().raw(trigger[0]);
                try {
                  for (const id of ids) {
                    const err = await api
                      .post(`/admin/x/products/${id}/fashion`, payload, { headers: admin })
                      .catch((e: unknown) => e);
                    expect(status(err)).toBe(400);
                  }
                } finally {
                  await pgc().raw(trigger[1]);
                }
                for (const [attrId, row] of originals) await putAttrRow(attrId, row);
              };

              await failOnce([a.id, b.id]);
              const rows = await exceptions();
              expect(sorted(rows.map((r) => String(r.detail.product_id)))).toEqual(sorted([a.id, b.id]));
              expect(rows.every((r) => r.state === "open" && r.detail.step === "attributes")).toBe(true);

              // Dashboard: reference = id sản phẩm lệch (tìm ra sản phẩm mà không cần mở detail).
              const res = await api.get(`/admin/x/reports/exceptions?kind=${KIND}`, { headers: admin });
              expect(res.status).toBe(200);
              expect(sorted((res.data.items as { reference: string }[]).map((i) => i.reference))).toEqual(
                sorted([a.id, b.id]),
              );

              // A lỗi lại → vẫn một ngoại lệ đang mở cho A.
              await failOnce([a.id]);
              expect((await exceptions()).map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());

              // Đóng ngoại lệ của A → của B vẫn mở (không mất dấu B); A lỗi lại sau đó → mở ngoại lệ mới cho A.
              const rowA = rows.find((r) => r.detail.product_id === a.id)!;
              const rowB = rows.find((r) => r.detail.product_id === b.id)!;
              await pgc().raw(`update ops_exception set state = 'resolved' where id = ?`, [rowA.id]);
              expect((await exceptions()).find((r) => r.id === rowB.id)?.state).toBe("open");
              await failOnce([a.id]);
              const open = (await exceptions()).filter((r) => r.state === "open");
              expect(sorted(open.map((r) => String(r.detail.product_id)))).toEqual(sorted([a.id, b.id]));
              expect(open.map((r) => r.id)).toContain(rowB.id);
              expect(open.map((r) => r.id)).not.toContain(rowA.id);
            });

            it("tương thích indexer: kind không phạm vi → một ngoại lệ đang mở cho cả kind dù detail khác; kind có phạm vi → theo product_id", async () => {
              const checkout = container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
              const MISMATCH = "catalog_index_mismatch";
              const opened = [];
              for (const pid of ["prod_x1", "prod_x2"]) {
                opened.push(
                  await checkout.openOpsExceptionIfNoneActive({
                    kind: MISMATCH,
                    dedupe_key: `${MISMATCH}:compat-${pid}`,
                    detail: { product_id: pid },
                  }),
                );
              }
              expect(opened).toEqual([true, false]);
              // Có active_scope → phạm vi theo product_id: prod_x2 được mở, rồi prod_x2 lần nữa thì không (đã có).
              const scoped = [];
              for (const pid of ["prod_x1", "prod_x2", "prod_x2"]) {
                scoped.push(
                  await checkout.openOpsExceptionIfNoneActive({
                    kind: KIND,
                    dedupe_key: `${KIND}:scoped-${pid}-${scoped.length}`,
                    detail: { product_id: pid },
                    active_scope: ["product_id"],
                  }),
                );
              }
              expect(scoped).toEqual([true, true, false]);
            });

            it("hàng rào: CHECK ops_exception.kind trên DB thật = OPS_EXCEPTION_KINDS", async () => {
              const { rows } = (await pgc().raw(
                `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'ops_exception_kind_check'`,
              )) as { rows: { def: string }[] };
              expect(rows).toHaveLength(1);
              const kinds = [...rows[0]!.def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!);
              expect(sorted(kinds)).toEqual(sorted(OPS_EXCEPTION_KINDS));
            });

            it("Redis lỗi → vẫn mở (không mất dấu): mở ngoại lệ không dùng khoá Redis (T-158 — khoá advisory PG)", async () => {
              const locking = container.resolve(Modules.LOCKING) as unknown as Record<string, unknown>;
              const origAcquire = locking.acquire;
              let acquires = 0;
              locking.acquire = async () => {
                acquires++;
                throw new Error("ECONNRESET giả lập");
              };
              try {
                await openCompensationException(
                  container,
                  "size_chart",
                  { product_id: "prod_t156_redis", from: null, to: null },
                  Object.assign(new Error("boom"), { code: "P0001" }),
                );
              } finally {
                locking.acquire = origAcquire;
              }
              const rows = await exceptions();
              expect(rows).toHaveLength(1);
              expect(rows[0]!.detail).toMatchObject({
                step: "size_chart",
                product_id: "prod_t156_redis",
              });
              expect(acquires).toBe(0);
            });

            describe("openOpsExceptionIfNoneActive tự tuần tự hoá (T-158, D-099)", () => {
              const MISMATCH = "catalog_index_mismatch";
              const svc = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
              const openScoped = (product_id: string | undefined, tag: string) =>
                svc().openOpsExceptionIfNoneActive({
                  kind: KIND,
                  dedupe_key: `${KIND}:t158-${tag}-${randomUUID()}`,
                  detail:
                    product_id === undefined ? { step: "attributes" } : { step: "attributes", product_id },
                  active_scope: ["product_id"],
                });
              const openKind = (tag: string) =>
                svc().openOpsExceptionIfNoneActive({
                  kind: MISMATCH,
                  dedupe_key: `${MISMATCH}:t158-${tag}-${randomUUID()}`,
                  priority: "high",
                  detail: { op: "sync", tag },
                });
              async function activeOf(kind: string) {
                const { rows } = (await pgc().raw(
                  `select id, detail from ops_exception
                    where kind = ? and state in ('open', 'in_progress') and deleted_at is null order by id`,
                  [kind],
                )) as { rows: { id: string; detail: Record<string, unknown> }[] };
                return rows;
              }
              /** Giữ khoá advisory y như helper trong một giao dịch riêng tới khi gọi `release`. */
              async function holdLock(kind: string, scope: Record<string, string | null> | null) {
                const trx = await pgc().transaction();
                await trx.raw(`select pg_advisory_xact_lock(hashtext(?), hashtext(?))`, [
                  OPS_EXCEPTION_LOCK_NS,
                  opsExceptionLockKey(kind, scope),
                ]);
                return { release: () => trx.commit() };
              }
              /** Bắt log warn của logger mà service checkout thật sự dùng (logger của container module). */
              async function captureWarns<T>(fn: () => Promise<T>): Promise<{ value: T; warns: string[] }> {
                const logger = (
                  svc() as unknown as { logger_: Record<string, (...args: unknown[]) => unknown> }
                ).logger_;
                const origWarn = logger.warn!;
                const warns: string[] = [];
                logger.warn = (...args: unknown[]) => {
                  warns.push(args.map(String).join(" "));
                  return origWarn.apply(logger, args);
                };
                try {
                  return { value: await fn(), warns };
                } finally {
                  logger.warn = origWarn;
                }
              }
              const PENDING = Symbol("pending");
              const settledWithin = <T>(p: Promise<T>, ms: number) =>
                Promise.race([p, new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), ms))]);

              it("10 lời gọi song song × 5 vòng, kind không phạm vi (indexer) → đúng 1 ngoại lệ đang mở mỗi vòng", async () => {
                const perRound: number[][] = [];
                for (let round = 0; round < 5; round++) {
                  await pgc().raw(`delete from ops_exception where kind = ?`, [MISMATCH]);
                  const opened = await Promise.all(
                    Array.from({ length: 10 }, (_, i) => openKind(`${round}-${i}`)),
                  );
                  perRound.push([opened.filter(Boolean).length, (await activeOf(MISMATCH)).length]);
                }
                expect(perRound).toEqual(Array.from({ length: 5 }, () => [1, 1]));
              });

              it("10 lời gọi song song × 5 vòng, kind có phạm vi (fashion) gọi thẳng helper, 2 sản phẩm → đúng 1 mỗi sản phẩm", async () => {
                const perRound: string[][] = [];
                for (let round = 0; round < 5; round++) {
                  await pgc().raw(`delete from ops_exception where kind = ?`, [KIND]);
                  await Promise.all(
                    Array.from({ length: 10 }, (_, i) =>
                      openScoped(`prod_t158_${round}_${i % 2}`, `${round}-${i}`),
                    ),
                  );
                  perRound.push(sorted((await activeOf(KIND)).map((r) => String(r.detail.product_id))));
                }
                expect(perRound).toEqual(
                  Array.from({ length: 5 }, (_, round) => [`prod_t158_${round}_0`, `prod_t158_${round}_1`]),
                );
              });

              it("hai phạm vi khác nhau không chờ nhau; cùng phạm vi thì chờ tới khi khoá nhả", async () => {
                const held = await holdLock(KIND, { product_id: "prod_t158_a" });
                let sameScope: Promise<boolean> | undefined;
                let elapsedOther = Number.NaN;
                let other: boolean | undefined;
                let pendingSame: unknown;
                try {
                  // Khoá của A đang bị giữ vô thời hạn: nếu B phải chờ thì sẽ quá lock_timeout và ném 55P03.
                  const t0 = Date.now();
                  other = await openScoped("prod_t158_b", "b");
                  elapsedOther = Date.now() - t0;
                  sameScope = openScoped("prod_t158_a", "a");
                  pendingSame = await settledWithin(sameScope, 500);
                } finally {
                  await held.release();
                }
                expect(other).toBe(true);
                expect(elapsedOther).toBeLessThan(OPS_EXCEPTION_LOCK_TIMEOUT_MS / 2);
                expect(pendingSame).toBe(PENDING);
                expect(await sameScope).toBe(true);
                expect(sorted((await activeOf(KIND)).map((r) => String(r.detail.product_id)))).toEqual([
                  "prod_t158_a",
                  "prod_t158_b",
                ]);
              });

              it("hàng rào D-107: kind chưa khai hoặc active_scope khác dạng đã khai → ném lỗi, không ghi dòng", async () => {
                const calls: [string, Record<string, unknown>][] = [
                  ["có phạm vi nhưng không truyền", { kind: KIND, detail: { product_id: "p" } }],
                  [
                    "có phạm vi nhưng truyền []",
                    { kind: KIND, detail: { product_id: "p" }, active_scope: [] },
                  ],
                  [
                    "thêm khoá",
                    {
                      kind: KIND,
                      detail: { product_id: "p", step: "x" },
                      active_scope: ["product_id", "step"],
                    },
                  ],
                  ["khoá khác", { kind: KIND, detail: { step: "x" }, active_scope: ["step"] }],
                  [
                    "trùng khoá",
                    { kind: KIND, detail: { product_id: "p" }, active_scope: ["product_id", "product_id"] },
                  ],
                  [
                    "không phạm vi nhưng truyền",
                    { kind: MISMATCH, detail: { op: "x" }, active_scope: ["op"] },
                  ],
                  ["kind chưa khai", { kind: "late_payment", detail: { order_id: "o" } }],
                ];
                const results: [string, string][] = [];
                for (const [label, extra] of calls) {
                  const err = await svc()
                    .openOpsExceptionIfNoneActive({
                      dedupe_key: `t158-fence-${randomUUID()}`,
                      ...extra,
                    } as Parameters<CheckoutModuleService["openOpsExceptionIfNoneActive"]>[0])
                    .then(
                      () => "không ném",
                      (e: Error) => e.message,
                    );
                  results.push([label, err]);
                }
                for (const [label, message] of results) {
                  expect({ label, message }).toEqual({
                    label,
                    message: expect.stringMatching(/chưa khai dạng phạm vi|khai phạm vi \[/),
                  });
                }
                const { rows } = (await pgc().raw(
                  `select count(*)::int as n from ops_exception where dedupe_key like 't158-fence-%'`,
                )) as { rows: { n: number }[] };
                expect(rows[0]!.n).toBe(0);
                // Dạng đúng (thứ tự không quan trọng với một khoá) → chạy.
                expect(await openScoped("prod_t158_fence", "ok")).toBe(true);
              });

              it("chờ khoá quá lock_timeout → warn (không giá trị) + ghi dự phòng không khoá đúng 1 dòng; lời gọi sau dedupe với dòng đó", async () => {
                const held = await holdLock(KIND, { product_id: "prod_t158_secret" });
                const t0 = Date.now();
                let r: { value: boolean; warns: string[] };
                try {
                  r = await captureWarns(() => openScoped("prod_t158_secret", "timeout"));
                } finally {
                  await held.release();
                }
                const elapsed = Date.now() - t0;
                expect(r.value).toBe(true);
                expect(elapsed).toBeGreaterThanOrEqual(OPS_EXCEPTION_LOCK_TIMEOUT_MS - 200);
                expect(elapsed).toBeLessThan(OPS_EXCEPTION_STATEMENT_TIMEOUT_MS);
                const rows = await activeOf(KIND);
                expect(rows.map((x) => x.detail)).toEqual([
                  { step: "attributes", product_id: "prod_t158_secret" },
                ]);
                const fallback = r.warns.filter((w) => w.includes("ghi dự phòng không khoá"));
                expect(fallback).toHaveLength(1);
                expect(fallback[0]).toContain(`kind=${KIND}`);
                expect(fallback[0]).toContain("scope=[product_id]");
                expect(fallback[0]).toContain("code=55P03");
                expect(r.warns.filter((w) => /prod_t158_secret|attributes/.test(w))).toEqual([]);
                // Khoá đã nhả: lời gọi kế tiếp chạy bình thường (có khoá, không warn) và dedupe với dòng dự phòng.
                const next = await captureWarns(() => openScoped("prod_t158_secret", "after"));
                expect(next.value).toBe(false);
                expect(next.warns.filter((w) => w.includes("ghi dự phòng"))).toEqual([]);
                expect((await activeOf(KIND)).map((x) => x.id)).toEqual(rows.map((x) => x.id));
              });

              it("dự phòng sau lock_timeout cũng lỗi → warn mã lỗi của lần dự phòng (chỉ mã), ném lỗi 55P03 gốc, không ghi dòng", async () => {
                const repo = (
                  svc() as unknown as { repo_: { transaction: (...a: unknown[]) => Promise<unknown> } }
                ).repo_;
                const origTx = repo.transaction;
                let txCalls = 0;
                repo.transaction = function (this: unknown, ...args: unknown[]) {
                  txCalls++;
                  if (txCalls === 2) {
                    return Promise.reject(
                      Object.assign(new Error(`insert into "ops_exception" values ('prod_leak') - boom`), {
                        code: "53300",
                      }),
                    );
                  }
                  return origTx.apply(this, args);
                };
                const held = await holdLock(MISMATCH, null);
                let r: { value: unknown; warns: string[] };
                try {
                  r = await captureWarns(() => openKind("fallback-fails").catch((e: unknown) => e));
                } finally {
                  await held.release();
                  repo.transaction = origTx;
                }
                expect(txCalls).toBe(2);
                expect((r.value as { code?: string }).code).toBe("55P03");
                const failed = r.warns.filter((w) => w.includes("Ghi dự phòng không khoá cũng lỗi"));
                expect(failed).toHaveLength(1);
                expect(failed[0]).toContain(`kind=${MISMATCH}`);
                expect(failed[0]).toContain("scope=[]");
                expect(failed[0]).toContain("code=53300");
                expect(r.warns.filter((w) => /prod_leak|insert into|boom|fallback-fails/.test(w))).toEqual(
                  [],
                );
                expect(await activeOf(MISMATCH)).toEqual([]);
                expect(await openKind("after")).toBe(true);
              });

              it("PROBE pool: timeout đặt cục bộ giao dịch — sau nhánh thường và nhánh 55P03, mọi kết nối pool về mặc định", async () => {
                type Probe = { pid: number; lt: string; st: string };
                /** Chiếm nhiều kết nối cùng lúc (pg_sleep) để đọc setting của từng kết nối trong pool dùng chung. */
                const probe = async (): Promise<Probe[]> =>
                  (
                    await Promise.all(
                      Array.from({ length: 10 }, () =>
                        pgc().raw(
                          `select pg_backend_pid() as pid, current_setting('lock_timeout') as lt,
                                  current_setting('statement_timeout') as st, pg_sleep(0.3)`,
                        ),
                      ),
                    )
                  ).map((x: { rows: Probe[] }) => {
                    const { pid, lt, st } = x.rows[0]!;
                    return { pid, lt, st };
                  });
                const before = await probe();
                const base = [...new Set(before.map((x) => `${x.lt}|${x.st}`))];
                expect(base).toHaveLength(1);
                // Mặc định khác giá trị helper đặt — nếu không, test không phân biệt được rò rỉ.
                expect(base[0]).not.toMatch(/(?:^5s\|)|(?:\|10s$)/);

                // Nhánh thường: nhiều lời gọi song song (không phạm vi lẫn có phạm vi) trải qua nhiều kết nối.
                await Promise.all([
                  ...Array.from({ length: 10 }, (_, i) => openKind(`probe-${i}`)),
                  ...Array.from({ length: 10 }, (_, i) => openScoped(`prod_probe_${i % 5}`, `probe-${i}`)),
                ]);
                // Nhánh 55P03 → ghi dự phòng.
                const held = await holdLock(KIND, { product_id: "prod_probe_timeout" });
                try {
                  expect(await openScoped("prod_probe_timeout", "probe-timeout")).toBe(true);
                } finally {
                  await held.release();
                }

                const after = await probe();
                expect(new Set(after.map((x) => x.pid)).size).toBeGreaterThan(1);
                expect(after.filter((x) => `${x.lt}|${x.st}` !== base[0])).toEqual([]);
              });

              it("khoá phạm vi thiếu trong detail → ghi null vào detail, lần gọi sau dedupe được (🟢b review T-156)", async () => {
                expect([await openScoped(undefined, "m1"), await openScoped(undefined, "m2")]).toEqual([
                  true,
                  false,
                ]);
                const rows = await activeOf(KIND);
                expect(rows).toHaveLength(1);
                expect(rows[0]!.detail).toEqual({ step: "attributes", product_id: null });
                // detail null + active_scope → cùng phạm vi null.
                expect(
                  await svc().openOpsExceptionIfNoneActive({
                    kind: KIND,
                    dedupe_key: `${KIND}:t158-nulldetail`,
                    detail: null,
                    active_scope: ["product_id"],
                  }),
                ).toBe(false);
                // Song song: 10 lời gọi thiếu khoá → vẫn 1.
                await pgc().raw(`delete from ops_exception where kind = ?`, [KIND]);
                await Promise.all(Array.from({ length: 10 }, (_, i) => openScoped(undefined, `p${i}`)));
                expect(await activeOf(KIND)).toHaveLength(1);
                // Giá trị phạm vi không vô hướng (`@>` = "chứa", không phải "bằng") → lỗi lập trình, không ghi.
                await expect(
                  svc().openOpsExceptionIfNoneActive({
                    kind: KIND,
                    dedupe_key: `${KIND}:t158-obj`,
                    detail: { product_id: ["a", "b"] },
                    active_scope: ["product_id"],
                  }),
                ).rejects.toThrow(TypeError);
                expect(await activeOf(KIND)).toHaveLength(1);
              });

              it("khoá phạm vi không phụ thuộc thứ tự active_scope", () => {
                expect(opsExceptionLockKey(KIND, { b: "1", a: "2" })).toEqual(
                  opsExceptionLockKey(KIND, { a: "2", b: "1" }),
                );
                expect(opsExceptionLockKey(KIND, { a: "1" })).not.toEqual(
                  opsExceptionLockKey(KIND, { a: "2" }),
                );
                expect(opsExceptionLockKey(KIND, null)).not.toEqual(opsExceptionLockKey(KIND, { a: null }));
              });
            });
            it("hai lượt song song cùng sản phẩm, bù trừ lỗi → không treo (khoá sản phẩm → khoá ngoại lệ), 1 ngoại lệ đang mở", async () => {
              const { id } = await seededPolo();
              await pgc().raw(ATTR_TRIGGER[0]);
              let results: unknown[];
              try {
                results = await Promise.all(
                  [0, 1].map(() =>
                    api
                      .post(`/admin/x/products/${id}/fashion`, BODY, { headers: admin })
                      .catch((e: unknown) => e),
                  ),
                );
              } finally {
                await pgc().raw(ATTR_TRIGGER[1]);
              }
              for (const res of results) expect([400, 409]).toContain(status(res));
              expect((await exceptions()).filter((r) => r.state === "open")).toHaveLength(1);
            });
          });
        });

        describe("khoá theo sản phẩm qua HTTP", () => {
          const BODY = {
            attributes: { kind: "apparel", material: "cotton" },
            model_measurements: [{ image_set: "moi", height_cm: 170, size_worn: "m" }],
          };
          const header = (e: unknown, name: string) =>
            (e as { response?: { headers?: Record<string, string> } }).response?.headers?.[name];

          it("chủ khác đang giữ khoá → 409 BUSY_RETRY + Retry-After, số đo không đổi", async () => {
            const { id, attributesId } = await seededPolo();
            const before = await measurementRows(attributesId);
            const locking = container.resolve(Modules.LOCKING);
            await locking.acquire(productFashionLockKey(id), { ownerId: "t144-holder", expire: 30 });
            let err: unknown;
            try {
              err = await api
                .post(`/admin/x/products/${id}/fashion`, BODY, { headers: admin })
                .catch((e: unknown) => e);
            } finally {
              await locking.release(productFashionLockKey(id), { ownerId: "t144-holder" });
            }
            expect(status(err)).toBe(409);
            expect(body(err)).toMatchObject({ code: "BUSY_RETRY" });
            expect(header(err, "retry-after")).toBe("1");
            expect(header(err, "content-type")).toMatch(/application\/problem\+json/);
            expect(await measurementRows(attributesId)).toEqual(before);
          });

          it("Redis lỗi khi lấy khoá → 503 LOCK_UNAVAILABLE + Retry-After, số đo không đổi", async () => {
            const { id, attributesId } = await seededPolo();
            const before = await measurementRows(attributesId);
            const locking = container.resolve(Modules.LOCKING) as unknown as Record<string, unknown>;
            const origAcquire = locking.acquire;
            locking.acquire = async () => {
              throw new Error("ECONNRESET giả lập");
            };
            let err: unknown;
            try {
              err = await api
                .post(`/admin/x/products/${id}/fashion`, BODY, { headers: admin })
                .catch((e: unknown) => e);
            } finally {
              locking.acquire = origAcquire;
            }
            expect(status(err)).toBe(503);
            expect(body(err)).toMatchObject({ code: "LOCK_UNAVAILABLE" });
            expect(header(err, "retry-after")).toBe("60");
            expect(await measurementRows(attributesId)).toEqual(before);
          });

          it("khoá rảnh → 200 (đường được phép vẫn chạy)", async () => {
            const { id, attributesId } = await seededPolo();
            const res = await api.post(`/admin/x/products/${id}/fashion`, BODY, { headers: admin });
            expect(res.status).toBe(200);
            expect((await measurementRows(attributesId)).map((m) => m.image_set)).toEqual(["moi"]);
          });
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
        // Nội dung khác bản hiện hành để vào nhánh tạo bản mới + relink (cùng nội dung chỉ là no-op, D-139).
        const changed = { ...TEST_CHART, name: `${TEST_CHART.name} (song song)` };
        const results = await Promise.allSettled([
          api.post("/admin/x/size-charts/song-song/revise", changed, { headers: admin }),
          api.post("/admin/x/size-charts/song-song/revise", changed, { headers: admin }),
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
