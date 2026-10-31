import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { IMPORT_COLUMNS, parseCsv } from "@x-shop/domain";
import { commitImportJob } from "../../src/lib/catalog/import";
import { IMPORT_AUDIT_ACTIONS } from "../../src/lib/catalog/import-audit";
import { loadProductSources } from "../../src/lib/catalog/product-source";
import { AUDIT_MODULE } from "../../src/modules/audit";
import type AuditModuleService from "../../src/modules/audit/service";
import { CATALOG_IMPORT_MODULE } from "../../src/modules/catalog-import";
import type CatalogImportModuleService from "../../src/modules/catalog-import/service";
import { DEMO_PRODUCTS } from "../../src/scripts/catalog-demo-data";
import seedCatalog, { type CatalogSeedResult } from "../../src/scripts/seed-catalog";
import { adminHeaders } from "../helpers/auth";
import { createTestProduct } from "../helpers/catalog";

jest.setTimeout(300 * 1000);

const HEADER = IMPORT_COLUMNS.join(",");

type Res = { status: number; data: Record<string, unknown>; headers: Record<string, string> };

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer;
    let seed: CatalogSeedResult;
    let admin: { authorization: string };
    let adminId: string;

    beforeAll(async () => {
      container = getContainer();
      seed = await seedCatalog({ container });
    });

    beforeEach(async () => {
      // Quyền tối thiểu cho nhập CSV (RBAC T-023): catalog.import + price.write (catalog_manager) + inventory.adjust
      // (warehouse) — commit ghi cả giá và tồn.
      const a = await adminHeaders(api, container, { roles: ["catalog_manager", "warehouse"] });
      admin = a.headers;
      adminId = a.userId;
    });

    const csvPost = (path: string, csv: string, contentType = "text/csv") =>
      api.post(path, csv, { headers: { ...admin, "content-type": contentType } }) as Promise<Res>;
    const fail = (p: Promise<unknown>) =>
      p.then(
        () => {
          throw new Error("lẽ ra phải lỗi");
        },
        (e: { response: Res }) => e.response,
      );
    const commit = (id: string) =>
      api.post(`/admin/x/imports/${id}/commit`, {}, { headers: admin }) as Promise<Res>;
    const productCount = async () =>
      (await container.resolve(Modules.PRODUCT).listProducts({}, { take: null })).length;

    const NEW_CSV = [
      HEADER,
      "Chân Váy Jean,Chân váy jean ngắn,apparel,vay-dam,Denim,Chân váy jean ngắn cạp cao.,CVJ-DEN-S,Đen,S,450.000,5",
      "chan-vay-jean,Chân váy jean ngắn,apparel,vay-dam,Denim,Chân váy jean ngắn cạp cao.,CVJ-DEN-M,den,m,470000,0",
      "khan-lua,Khăn lụa vuông,accessory,phu-kien,Lụa,Khăn lụa in hoạ tiết.,KHAN-DO,do,onesize,250000,",
    ].join("\n");

    describe("preview (S-206)", () => {
      it("CSV 3 dòng: dòng 2 thiếu SKU, ô bắt đầu bằng '=' → lỗi theo dòng/cột, KHÔNG ghi gì, commit bị từ chối", async () => {
        const before = await productCount();
        const csv = [
          HEADER,
          "ao-loi,Áo lỗi,apparel,ao-nu,Cotton,Mô tả,,den,s,100000,1",
          'ao-cong-thuc,=HYPERLINK("http://x"),apparel,ao-nu,Cotton,Mô tả,ACT-DEN-S,den,s,100000,1',
          "ao-tot,Áo tốt,apparel,ao-nu,Cotton,Mô tả,ATOT-DEN-S,den,s,100000,1",
        ].join("\n");
        const res = await csvPost("/admin/x/imports/preview", csv);
        expect(res.status).toBe(201);
        expect(res.data.errors).toEqual(
          expect.arrayContaining([
            { line: 2, column: "sku", message: expect.any(String) },
            { line: 3, column: "title", message: expect.stringContaining("=") },
          ]),
        );
        expect((res.data.rows as { line: number }[]).map((r) => r.line)).toEqual([4]);
        expect(res.data).toMatchObject({ can_commit: false, status: "previewed", previewed_by: adminId });
        expect(res.data.summary).toMatchObject({ rows_total: 3, rows_valid: 1 });
        expect(await productCount()).toBe(before);

        const err = await fail(commit(res.data.import_id as string));
        expect(err.status).toBe(422);
        expect(err.headers["content-type"]).toMatch(/application\/problem\+json/);
        expect(err.data).toMatchObject({ code: "IMPORT_HAS_ERRORS" });
        expect(await productCount()).toBe(before);
      });

      it("đối chiếu dữ liệu: danh mục/màu không có, SKU của sản phẩm khác, SKU mới cho sản phẩm đã có", async () => {
        const csv = [
          HEADER,
          "ao-moi,Áo mới,apparel,khong-co,Cotton,Mô tả,AMOI-DEN-S,den,s,100000,1",
          "ao-moi-2,Áo mới 2,apparel,ao-nu,Cotton,Mô tả,AMOI2-TIM-S,tim-than,s,100000,1",
          "ao-moi-3,Áo mới 3,apparel,ao-nu,Cotton,Mô tả,SMLUA-DEN-M,den,m,100000,1",
          "ao-so-mi-lua,Áo sơ mi lụa,apparel,ao-nu,Lụa,Mô tả,SMLUA-XANH-M,xanh-navy,m,100000,1",
        ].join("\n");
        const res = await csvPost("/admin/x/imports/preview", csv);
        expect(res.data.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ line: 2, column: "category" }),
            expect.objectContaining({ line: 3, column: "color" }),
            expect.objectContaining({
              line: 4,
              column: "sku",
              message: expect.stringContaining("ao-so-mi-lua"),
            }),
            expect.objectContaining({ line: 5, column: "sku" }),
          ]),
        );
        expect(res.data.rows).toEqual([]);
      });

      it("multipart (trường file) cho cùng kết quả; sai kiểu nội dung → 415; quá 2 MB → 413", async () => {
        const form = new FormData();
        form.append("file", new Blob([NEW_CSV], { type: "text/csv" }), "nhap.csv");
        const res = (await api.post("/admin/x/imports/preview", form, { headers: admin })) as Res;
        expect(res.status).toBe(201);
        expect(res.data).toMatchObject({ file_name: "nhap.csv", can_commit: true, errors: [] });
        expect((res.data.rows as unknown[]).length).toBe(3);

        expect((await fail(csvPost("/admin/x/imports/preview", "{}", "application/json"))).status).toBe(415);
        const big = `${HEADER}\n${"x".repeat(2 * 1024 * 1024 + 10)}`;
        expect((await fail(csvPost("/admin/x/imports/preview", big))).status).toBe(413);
      });
    });

    describe("commit idempotent", () => {
      it("tạo sản phẩm draft + giá + tồn; commit lần 2 cùng id trả kết quả cũ, không tạo trùng; ghi người thao tác", async () => {
        const before = await productCount();
        const preview = await csvPost("/admin/x/imports/preview", NEW_CSV);
        expect(preview.data).toMatchObject({ can_commit: true, errors: [] });
        expect(preview.data.summary).toMatchObject({ products_new: 2, variants_new: 3 });
        expect(await productCount()).toBe(before); // preview không ghi
        const id = preview.data.import_id as string;

        const first = await commit(id);
        expect(first.status).toBe(200);
        expect(first.data).toMatchObject({ status: "committed", replayed: false, committed_by: adminId });
        const result = first.data.result as { products_created: string[] };
        expect(result.products_created).toHaveLength(2);

        const second = await commit(id);
        expect(second.data).toMatchObject({ status: "committed", replayed: true, result: first.data.result });
        expect(await productCount()).toBe(before + 2);

        const [skirt] = await loadProductSources(container, { handle: "chan-vay-jean" });
        expect(skirt).toMatchObject({ status: "draft", title: "Chân váy jean ngắn" });
        expect(skirt?.attributes).toMatchObject({
          kind: "apparel",
          material: "denim",
          materialLabel: "Denim",
        });
        expect(skirt?.categories.map((c) => c.handle)).toEqual(["vay-dam"]);
        expect(skirt?.variants.map((v) => [v.sku, v.color, v.size, v.basePrice])).toEqual([
          ["CVJ-DEN-S", "den", "s", 450_000],
          ["CVJ-DEN-M", "den", "m", 470_000],
        ]);
        const query = container.resolve(ContainerRegistrationKeys.QUERY);
        const { data } = await query.graph({
          entity: "product_variant",
          fields: ["sku", "inventory_items.inventory.location_levels.stocked_quantity"],
          filters: { sku: ["CVJ-DEN-S", "CVJ-DEN-M"] },
        });
        const stock = Object.fromEntries(
          (
            data as unknown as {
              sku: string;
              inventory_items: { inventory: { location_levels: { stocked_quantity: number }[] } }[];
            }[]
          ).map((v) => [v.sku, Number(v.inventory_items[0]?.inventory.location_levels[0]?.stocked_quantity)]),
        );
        expect(stock).toEqual({ "CVJ-DEN-S": 5, "CVJ-DEN-M": 0 });

        const job = await api.get(`/admin/x/imports/${id}`, { headers: admin });
        expect(job.data).toMatchObject({ status: "committed", previewed_by: adminId, committed_by: adminId });
        const svc: CatalogImportModuleService = container.resolve(CATALOG_IMPORT_MODULE);
        const [rec] = await svc.listCatalogImportJobs({ id });
        expect(rec?.file_hash).toMatch(/^[0-9a-f]{64}$/);
      });

      it("hai commit đồng thời cùng id → đúng một lần ghi, lần kia trả kết quả đã lưu", async () => {
        const before = await productCount();
        const id = (await csvPost("/admin/x/imports/preview", NEW_CSV)).data.import_id as string;
        const [a, b] = await Promise.all([commit(id), commit(id)]);
        expect([a.data.replayed, b.data.replayed].sort()).toEqual([false, true]);
        expect(a.data.result).toEqual(b.data.result);
        expect(await productCount()).toBe(before + 2);
      });

      it("cùng file preview lại thành import mới → commit vẫn không tạo trùng (upsert theo handle/SKU)", async () => {
        const before = await productCount();
        const id1 = (await csvPost("/admin/x/imports/preview", NEW_CSV)).data.import_id as string;
        await commit(id1);
        const p2 = await csvPost("/admin/x/imports/preview", NEW_CSV);
        expect(p2.data.import_id).not.toBe(id1);
        expect(p2.data.summary).toMatchObject({
          products_new: 0,
          products_existing: 2,
          variants_existing: 3,
        });
        const second = await commit(p2.data.import_id as string);
        expect(second.data).toMatchObject({ replayed: false, result: { products_created: [] } });
        expect(await productCount()).toBe(before + 2);
      });

      it("cập nhật giá/tồn SKU đã có, ghi trước/sau; sản phẩm published vẫn published", async () => {
        const csv = [
          HEADER,
          "ao-so-mi-lua,Áo sơ mi lụa,apparel,ao-nu,Lụa,Áo sơ mi lụa tơ tằm mềm — cập nhật mô tả qua CSV.,SMLUA-DEN-M,den,m,690000,9",
        ].join("\n");
        const preview = await csvPost("/admin/x/imports/preview", csv);
        expect(preview.data).toMatchObject({
          errors: [],
          summary: { products_existing: 1, variants_existing: 1 },
        });
        const res = await commit(preview.data.import_id as string);
        expect(res.data.result).toMatchObject({
          products_updated: [seed.products["ao-so-mi-lua"]],
          price_changes: [{ sku: "SMLUA-DEN-M", before: 700_000, after: 690_000 }],
          stock_changes: [{ sku: "SMLUA-DEN-M", before: 5, after: 9 }],
        });
        const [p] = await loadProductSources(container, { handle: "ao-so-mi-lua" });
        expect(p?.status).toBe("published");
        expect(p?.variants.find((v) => v.sku === "SMLUA-DEN-M")?.basePrice).toBe(690_000);
        expect(p?.variants.find((v) => v.sku === "SMLUA-TRANG-S")?.basePrice).toBe(300_000);
        expect(p?.sizeChart?.code).toBe("ao-nu"); // thuộc tính khác giữ nguyên
      });

      it("không có import id → 404", async () => {
        expect((await fail(commit("cimp_khong_co"))).status).toBe(404);
      });
    });

    describe("audit nhập CSV (che PII)", () => {
      const auditOf = async (action: string, resourceId: string) =>
        (
          await container
            .resolve<AuditModuleService>(AUDIT_MODULE)
            .list({ action, resource_id: resourceId }, { limit: 50, offset: 0 })
        ).entries;

      it("preview → catalog.import.previewed (người làm, băm file, số đếm); không tên file/nội dung/thông điệp lỗi", async () => {
        const form = new FormData();
        const csv = [
          HEADER,
          "ao-loi,Áo lỗi 0912345678,apparel,khong-co,Cotton,Mô tả,AL-DEN-S,den,s,100000,1",
        ].join("\n");
        form.append("file", new Blob([csv], { type: "text/csv" }), "khach-an@example.test.csv");
        const res = (await api.post("/admin/x/imports/preview", form, {
          headers: { ...admin, "x-request-id": "req-import-1" },
        })) as Res;
        expect(res.status).toBe(201);
        const id = res.data.import_id as string;
        const [row, ...rest] = await auditOf(IMPORT_AUDIT_ACTIONS.previewed, id);
        expect(rest).toHaveLength(0);
        expect(row).toMatchObject({
          actor_type: "user",
          actor_id: adminId,
          resource_type: "catalog_import",
          request_id: "req-import-1",
          changes: {
            status: "previewed",
            summary: { rows_total: 1, rows_valid: 0 },
            errors_count: 1,
            error_columns: ["category"],
          },
        });
        expect(String(row?.changes.file_sha256).replace(/:/g, "")).toBe(res.data.file_hash);
        expect(row?.ip_hash).toMatch(/^[0-9a-f]{32}$/);
        const raw = JSON.stringify(row);
        for (const leak of ["khach-an", "@example.test", "0912345678", "Áo lỗi", "khong-co"]) {
          expect(raw).not.toContain(leak);
        }
      });

      it("commit → catalog.import.committed đúng MỘT lần (cả khi gọi lại và đồng thời); còn lỗi → commit_rejected", async () => {
        const id = (await csvPost("/admin/x/imports/preview", NEW_CSV)).data.import_id as string;
        const [a, b] = await Promise.all([commit(id), commit(id)]);
        expect([a.data.replayed, b.data.replayed].sort()).toEqual([false, true]);
        expect((await commit(id)).data.replayed).toBe(true);
        const committed = await auditOf(IMPORT_AUDIT_ACTIONS.committed, id);
        expect(committed).toHaveLength(1);
        expect(committed[0]).toMatchObject({
          actor_id: adminId,
          changes: {
            status: "committed",
            backfilled: false,
            errors_count: 0,
            result: { products_created: 2, products_updated: 0, price_changes: expect.any(Number) },
          },
        });

        const bad = [HEADER, "ao-loi,Áo lỗi,apparel,ao-nu,Cotton,Mô tả,,den,s,100000,1"].join("\n");
        const badId = (await csvPost("/admin/x/imports/preview", bad)).data.import_id as string;
        expect((await fail(commit(badId))).status).toBe(422);
        expect(await auditOf(IMPORT_AUDIT_ACTIONS.committed, badId)).toHaveLength(0);
        const [rejected] = await auditOf(IMPORT_AUDIT_ACTIONS.rejected, badId);
        expect(rejected).toMatchObject({
          actor_id: adminId,
          reason: "IMPORT_HAS_ERRORS",
          changes: { errors_count: 1, error_columns: ["sku"] },
        });
        // Import không tồn tại → 404, không ghi audit commit_failed.
        expect((await fail(commit("cimp_khong_co"))).status).toBe(404);
        expect(await auditOf(IMPORT_AUDIT_ACTIONS.failed, "cimp_khong_co")).toHaveLength(0);
      });

      it("commit đã ghi catalog nhưng thiếu dòng audit → lần gọi lại tự bù (backfilled), không bù lần hai", async () => {
        const id = (await csvPost("/admin/x/imports/preview", NEW_CSV)).data.import_id as string;
        // Commit ngoài HTTP, không hook audit — mô phỏng lần ghi audit sau commit bị lỗi.
        await commitImportJob(container, id, adminId);
        expect(await auditOf(IMPORT_AUDIT_ACTIONS.committed, id)).toHaveLength(0);
        expect((await commit(id)).data.replayed).toBe(true);
        expect((await commit(id)).data.replayed).toBe(true);
        const rows = await auditOf(IMPORT_AUDIT_ACTIONS.committed, id);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.changes).toMatchObject({ backfilled: true, status: "committed" });
      });

      it("vai trò thiếu catalog.import → 403, không có import/audit preview; chỉ có dòng rbac.denied", async () => {
        const acc = await adminHeaders(api, container, { roles: ["accountant"] });
        const denied = await fail(
          api.post("/admin/x/imports/preview", NEW_CSV, {
            headers: { ...acc.headers, "content-type": "text/csv" },
          }),
        );
        expect(denied.status).toBe(403);
        const audit = container.resolve<AuditModuleService>(AUDIT_MODULE);
        const mine = await audit.list({ actor_id: acc.userId }, { limit: 10, offset: 0 });
        // Sự kiện xác thực của chính lần đăng nhập tạo tài khoản (auth.login, T-091) không thuộc phạm vi kiểm ở đây.
        const nonAuth = mine.entries.map((e) => e.action).filter((a) => !a.startsWith("auth."));
        expect(nonAuth).toEqual(["rbac.denied"]);
      });
    });

    describe("export chống công thức", () => {
      it("CSV đúng cột, ô nguy hiểm có tiền tố ', xuất rồi nhập lại không lỗi", async () => {
        await createTestProduct(container, { title: "=cmd|' /C calc'!A0", handle: "doc-hai" });
        const res = (await api.get("/admin/x/exports/products.csv", { headers: admin })) as Res & {
          data: unknown;
        };
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/^text\/csv/);
        expect(res.headers["content-disposition"]).toMatch(/attachment/);
        expect(res.headers["cache-control"]).toBe("no-store");
        const text = String(res.data);
        // BOM (cho Excel) do axios bỏ khi giải mã; parseCsv cũng chấp nhận có/không BOM.
        const table = parseCsv(text);
        expect(table[0]).toEqual([...IMPORT_COLUMNS]);
        const evil = table.find((r) => r[0] === "doc-hai");
        expect(evil?.[1]).toBe("'=cmd|' /C calc'!A0");
        expect(table.filter((r) => r[0] === "ao-so-mi-lua")).toHaveLength(4);

        // Vòng nhập lại: chỉ các dòng của dữ liệu demo (bỏ sản phẩm thử thiếu thuộc tính).
        const demoHandles = new Set(DEMO_PRODUCTS.map((d) => d.handle));
        const roundTrip = [table[0]!, ...table.slice(1).filter((r) => demoHandles.has(r[0] ?? ""))]
          .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
          .join("\n");
        const preview = await csvPost("/admin/x/imports/preview", roundTrip);
        expect(preview.data.errors).toEqual([]);
        expect(preview.data.summary).toMatchObject({
          products_existing: DEMO_PRODUCTS.length,
          variants_existing: DEMO_PRODUCTS.reduce((n, d) => n + d.variants.length, 0),
          products_new: 0,
        });
      });
    });

    describe("quyền", () => {
      it("không đăng nhập → 401 ở preview, commit, export", async () => {
        const anon = (p: Promise<unknown>) => fail(p).then((r) => r.status);
        expect(
          await anon(
            api.post("/admin/x/imports/preview", NEW_CSV, { headers: { "content-type": "text/csv" } }),
          ),
        ).toBe(401);
        expect(await anon(api.post("/admin/x/imports/cimp_x/commit", {}))).toBe(401);
        expect(await anon(api.get("/admin/x/exports/products.csv"))).toBe(401);
      });
    });
  },
});
