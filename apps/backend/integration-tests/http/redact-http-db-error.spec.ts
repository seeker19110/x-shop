import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import seedXShop from "../../src/scripts/seed";
import { createLogger } from "../../src/lib/log/logger";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { CATALOG_INDEX_MODULE } from "../../src/modules/catalog-index";
import type CatalogIndexModuleService from "../../src/modules/catalog-index/service";
import { adminHeaders, noThrow, storeHeaders } from "../helpers/auth";
import { createTestProduct } from "../helpers/catalog";
import { FASHION_MODULE } from "../../src/modules/fashion";
import type FashionModuleService from "../../src/modules/fashion/service";

jest.setTimeout(180 * 1000);

/**
 * T-151 (review) — đường HTTP → handler 500 → logger dự án với lỗi DB THẬT (trigger `raise exception`). Workflow Medusa ném
 * object thường (không phải Error) mang `message` của knex; `describeError` từng `JSON.stringify` trước khi che nên `\"`
 * làm mẫu SQL không khớp và toàn bộ số/chuỗi lọt log. Khẳng định: stdout của logger không còn giá trị đã chèn.
 */
const LEAKS = /(?<![\w:.])(?:180|9431|78|95)(?![\w:])|61\.5|Nguyễn|0912345678|fmm_01J/;

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    let store: Record<string, string>;
    beforeAll(async () => {
      await seedXShop({ container: getContainer() });
      store = await storeHeaders(getContainer());
      const pg = getContainer().resolve<{ raw(sql: string): Promise<unknown> }>(
        ContainerRegistrationKeys.PG_CONNECTION,
      );
      await pg.raw(
        "create table t151_http (id text, height_cm int, bust_cm int, waist_cm int, hip_cm int, note text, extra jsonb, gone text)",
      );
      await pg.raw(
        "create function t151_http_boom() returns trigger language plpgsql as $$ begin raise exception 'boom trigger'; end $$",
      );
      await pg.raw(
        "create trigger t151_http_tg before insert on t151_http for each statement execute function t151_http_boom()",
      );
    });

    it("500 từ lỗi DB thật (object thường) → log không còn số/chuỗi đã chèn, vẫn có lỗi và trace_id", async () => {
      const pg = getContainer().resolve<{ raw(sql: string): Promise<unknown> }>(
        ContainerRegistrationKeys.PG_CONNECTION,
      );
      const index = getContainer().resolve<CatalogIndexModuleService>(CATALOG_INDEX_MODULE);
      const spy = jest.spyOn(index, "categoryCounts").mockImplementation(async () => {
        try {
          await pg.raw(
            `insert into "t151_http" ("id", "height_cm", "bust_cm", "waist_cm", "hip_cm", "note", "extra", "gone") values ('fmm_01J', 180, 9431, 78, 95, 'Nguyễn Văn A 0912345678', '{"weight":61.5}', null)`,
          );
        } catch (e) {
          const err = e as Error;
          // Như workflow Medusa: lỗi bị tuần tự hoá thành object thường.
          throw { name: err.name, message: err.message, stack: err.stack };
        }
        return {} as never;
      });
      const lines: string[] = [];
      const write = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
      let res: Awaited<ReturnType<typeof api.get>>;
      try {
        res = await api.get("/store/x/categories", { headers: store, ...noThrow });
      } finally {
        write.mockRestore();
        spy.mockRestore();
      }
      expect(res.status).toBe(500);
      const logged = lines.join("");
      expect(logged).toContain("boom trigger");
      expect(logged).toContain(String(res.data.trace_id));
      expect(logged).not.toMatch(LEAKS);
    });

    /**
     * Ca V3 của review T-144: workflow thật (`POST /admin/x/products/:id/fashion`) cập nhật `fashion_product_attributes`
     * qua MikroORM, trigger làm câu UPDATE lỗi → 500 → `logServerError` → logger dự án ghi stdout. Giá trị đã chèn
     * (`image_exception_by`, lý do, id bản ghi) không được còn trong bất kỳ dòng log lỗi nào.
     */
    it("V3: lỗi UPDATE fashion_product_attributes qua workflow → 500, log không còn giá trị", async () => {
      const container = getContainer();
      const pg = container.resolve<{ raw(sql: string): Promise<unknown> }>(
        ContainerRegistrationKeys.PG_CONNECTION,
      );
      const admin = (await adminHeaders(api, container)).headers;
      const p = await createTestProduct(container);
      const url = `/admin/x/products/${p.id}/fashion`;
      const first = await api.post(
        url,
        { attributes: { kind: "apparel", material: "cotton" } },
        { headers: admin },
      );
      expect(first.status).toBe(200);
      const attributesId = String((first.data.attributes as { id?: unknown } | null)?.id ?? "");
      await pg.raw(
        "create function t151_v3_boom() returns trigger language plpgsql as $$ begin raise exception 'boom v3 %', TG_OP; end $$",
      );
      await pg.raw(
        "create trigger t151_v3_tg before update on fashion_product_attributes for each row execute function t151_v3_boom()",
      );
      const lines: string[] = [];
      const write = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
      let res: Awaited<ReturnType<typeof api.post>>;
      try {
        res = await api.post(
          url,
          {
            attributes: {
              kind: "apparel",
              material: "cotton",
              image_exception_by: "user_qa_t144",
              image_exception_reason: "Lý do riêng 9431 của Nguyễn",
            },
          },
          { headers: admin, ...noThrow },
        );
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        write.mockRestore();
        await pg.raw("drop trigger if exists t151_v3_tg on fashion_product_attributes");
        await pg.raw("drop function if exists t151_v3_boom()");
      }
      expect(res.status).toBe(500);
      const errorLines = lines.filter((l) => l.includes('"level":"error"'));
      expect(errorLines.length).toBeGreaterThan(0);
      const logged = errorLines.join("");
      expect(logged).toMatch(/update \\+"fashion_product_attributes\\+" set \[REDACTED\] - boom v3 UPDATE/);
      expect(logged).toContain(String(res.data.trace_id));
      expect(logged).not.toMatch(/user_qa_t144|9431|Nguyễn|Lý do riêng/);
      if (attributesId !== "") expect(logged).not.toContain(attributesId);
    });
    /**
     * Review T-151 vòng 3, ca A: SQL viết tay NHIỀU DÒNG của module checkout chạy qua MikroORM `execute` (`formatQuery`
     * chèn giá trị vào chuỗi) — trigger làm câu lỗi, lỗi đi qua logger dự án.
     */
    it("vòng 3 ca A: SQL nhiều dòng của checkout + CHECK/NOT NULL/unique thật qua MikroORM execute → log sạch, giữ lỗi chính", async () => {
      const c = getContainer();
      const pg = c.resolve<{ raw(sql: string): Promise<unknown> }>(ContainerRegistrationKeys.PG_CONNECTION);
      const svc = c.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
      const lines: string[] = [];
      const logger = createLogger({
        service: "t",
        version: "0",
        env: "test",
        level: "error",
        write: (l) => lines.push(l),
      });
      const finance = (orderId: string, ref: string, total: number) => ({
        order_id: orderId,
        display_ref: ref,
        checkout_attempt_id: "chk_t151_secret",
        cart_id: "cart_t151",
        total,
        payment_method: "cod" as const,
        policy_version: "v1",
        quote: { total },
        address: { name: "Nguyễn Văn Tbm" },
        contact: { name: "Nguyễn Văn Tbm" },
      });
      // Dòng order_finance `preparing` để UPDATE order_finance đầu tiên của finalizeAttempt thành công.
      await svc.insertOrderFinance(finance("order_t151_secret", "XS-T151A", 1234567));
      // Ràng buộc THẬT qua MikroORM `execute` (không qua dbErrorMapper của Medusa): CHECK, NOT NULL, unique — message có
      // `\n - detail: Failing row contains (…)`/`Key (…)=(…)`.
      const constraintErrors: unknown[] = [];
      for (const input of [
        finance("order_t151_secret3", "XS-T151C", -1234567),
        finance("order_t151_secret4", "XS-T151D", null as never),
        finance("order_t151_secret", "XS-T151E", 1234567),
      ]) {
        try {
          await svc.insertOrderFinance(input);
          constraintErrors.push(new Error("câu lệnh phải lỗi"));
        } catch (e) {
          constraintErrors.push(e);
        }
      }
      const expectedMain = [
        'violates check constraint \\"order_finance_total_nonneg\\"\\n - detail: Failing row contains ([h:',
        "violates not-null constraint\\n - detail: Failing row contains ([h:",
        'duplicate key value violates unique constraint \\"IDX_order_finance_order_id_unique\\"\\n - detail: Key (order_id)=([h:',
      ];
      constraintErrors.forEach((e, i) => {
        lines.length = 0;
        logger.error("ghi DB thất bại", e as Error);
        expect(lines[0]).toContain(`INSERT INTO order_finance [REDACTED] - `);
        expect(lines[0]).toContain(expectedMain[i]);
        expect(lines[0]).not.toMatch(/chk_t151_secret|order_t151_secret|1234567|Nguyễn/);
      });
      await pg.raw(
        "create function t151a_boom() returns trigger language plpgsql as $$ begin raise exception 'boom t151a'; end $$",
      );
      await pg.raw(
        "create trigger t151a_ca before update on checkout_attempt for each statement execute function t151a_boom()",
      );
      await pg.raw(
        "create trigger t151a_ob before update on outbox_event for each statement execute function t151a_boom()",
      );
      await pg.raw(
        "create trigger t151a_of before insert on order_finance for each statement execute function t151a_boom()",
      );
      const errors: unknown[] = [];
      const catching = async (run: () => Promise<unknown>) => {
        try {
          await run();
          errors.push(new Error("câu lệnh phải lỗi"));
        } catch (e) {
          errors.push(e);
        }
      };
      try {
        await catching(() =>
          svc.finalizeAttempt(
            {
              attempt_id: "chk_t151_secret",
              order_id: "order_t151_secret",
              cart_id: "cart_t151",
              cart_version: 1,
              order_state: "placed",
              hold_expires_at: null,
              cod_confirm_by: null,
              outbox: { event_key: "t151", type: "t", payload: {} },
            },
            { total: 1234567, recipient: "Nguyễn Văn Tbm" },
          ),
        );
        await catching(() => svc.reopenRetryableAttempt("chk_t151_secret", ["BUSY_RETRY"], new Date()));
        await catching(() =>
          svc.markOutboxFailed("obx_t151_secret", "gửi lỗi cho Nguyễn Văn Tbm, đơn 1234567", new Date()),
        );
        await catching(() => svc.insertOrderFinance(finance("order_t151_secret2", "XS-T151B", 7654321)));
      } finally {
        await pg.raw(
          "drop trigger t151a_ca on checkout_attempt; drop trigger t151a_ob on outbox_event; drop trigger t151a_of on order_finance; drop function t151a_boom();",
        );
      }
      expect(errors).toHaveLength(4);
      for (const e of errors) {
        lines.length = 0;
        logger.error("ghi DB thất bại", e as Error);
        const line = lines[0]!;
        expect(line).toContain("boom t151a");
        expect(line).toMatch(
          /(?:UPDATE checkout_attempt|UPDATE outbox_event|INSERT INTO order_finance)[^"]{0,40}\[REDACTED\]/,
        );
        expect(line).not.toMatch(/chk_t151_secret|order_t151_secret|obx_t151_secret|1234567|7654321|Nguyễn/);
      }
    });

    /**
     * Review T-151 vòng 3, ca B/C: MikroORM nối `\n - detail: …`/`\n - hint: …` vào message và chép `detail` thành trường
     * riêng; Postgres đặt cả hàng vi phạm (`Failing row contains (…)`) hoặc khoá (`Key (…)=(…)`) vào detail.
     *
     * Từ T-144/T-155 route fashion làm sạch lỗi bước thay số đo (`sanitizedError`: chỉ tên lỗi + `code`/`constraint`, không
     * `cause`) → lỗi DB thô không còn tới handler 500 qua route này. Mỗi ca kiểm HAI đường:
     *  1. route fashion thật: 500, log chỉ có `code=…`/`constraint=…`, không giá trị, không `Failing row`;
     *  2. lỗi THÔ thật lấy từ DB (module fashion → MikroORM) đi qua `xErrorHandler` → `logServerError` → logger dự án (route
     *     `/store/x/categories` ném lỗi đó) — đường mục tiêu của T-151: giữ lỗi chính, detail đã băm, không lộ giá trị.
     */
    const MEASURE = {
      image_set: "moi-t151x",
      height_cm: 173,
      chest_cm: 131,
      waist_cm: 127,
      hip_cm: 139,
      size_worn: "m",
    };
    const MEASURE_LEAK = /(?<![\w:.])(?:173|131|127|139)(?![\w:])|moi-t151x/;
    function pgOf() {
      return getContainer().resolve<{ raw(sql: string): Promise<unknown> }>(
        ContainerRegistrationKeys.PG_CONNECTION,
      );
    }
    function captureStdout() {
      const lines: string[] = [];
      const write = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
      return { lines, restore: () => write.mockRestore() };
    }

    async function postFashionWith(setup: string, teardown: string, measurements: Record<string, unknown>[]) {
      const container = getContainer();
      const admin = (await adminHeaders(api, container)).headers;
      const p = await createTestProduct(container);
      await pgOf().raw(setup);
      const out = captureStdout();
      let res: Awaited<ReturnType<typeof api.post>>;
      try {
        res = await api.post(
          `/admin/x/products/${p.id}/fashion`,
          { attributes: { kind: "apparel", material: "cotton" }, model_measurements: measurements },
          { headers: admin, ...noThrow },
        );
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        out.restore();
        await pgOf().raw(teardown);
      }
      const logged = out.lines.filter((l) => l.includes('"level":"error"')).join("");
      return { status: res.status, logged };
    }

    /** Lỗi thật khi ghi số đo qua module fashion (MikroORM; Medusa `dbErrorMapper` có thể đổi unique/NOT NULL). */
    async function rawFashionError(setup: string, teardown: string, measurements: Record<string, unknown>[]) {
      const fashion = getContainer().resolve<FashionModuleService>(FASHION_MODULE);
      const attrs = (await fashion.createFashionProductAttributes({
        kind: "apparel",
      } as never)) as unknown as {
        id: string;
      };
      await pgOf().raw(setup);
      try {
        await fashion.createModelMeasurements(
          measurements.map((m) => ({ ...m, attributes_id: attrs.id })) as never,
        );
      } catch (e) {
        return e;
      } finally {
        await pgOf().raw(teardown);
      }
      throw new Error("ghi số đo phải lỗi");
    }

    /** Ném `err` NGUYÊN VẸN từ một route thật → handler 500 → logger dự án; trả các dòng log lỗi. */
    async function logThrough500(err: unknown) {
      const index = getContainer().resolve<CatalogIndexModuleService>(CATALOG_INDEX_MODULE);
      const spy = jest.spyOn(index, "categoryCounts").mockRejectedValue(err);
      const out = captureStdout();
      let res: Awaited<ReturnType<typeof api.get>>;
      try {
        res = await api.get("/store/x/categories", { headers: store, ...noThrow });
      } finally {
        out.restore();
        spy.mockRestore();
      }
      expect(res.status).toBe(500);
      const logged = out.lines.filter((l) => l.includes('"level":"error"')).join("");
      expect(logged).toContain(String(res.data.trace_id));
      return logged;
    }

    function loggedDirect(err: unknown) {
      const lines: string[] = [];
      createLogger({
        service: "t",
        version: "0",
        env: "test",
        level: "error",
        write: (l) => lines.push(l),
      }).error(
        "ghi DB thất bại",
        err as Error, // có thể không phải Error — logger xử lý lúc chạy
      );
      return lines[0]!;
    }

    it("vòng 3 ca B: CHECK thật — route fashion chỉ log code/constraint; lỗi thô qua handler 500 băm `Failing row`", async () => {
      const setup =
        "alter table fashion_model_measurement add constraint t151_chk check (height_cm <> 173) not valid";
      const teardown = "alter table fashion_model_measurement drop constraint t151_chk";
      const route = await postFashionWith(setup, teardown, [MEASURE]);
      expect(route.status).toBe(500);
      expect(route.logged).toContain("code=23514");
      expect(route.logged).toContain("constraint=t151_chk");
      expect(route.logged).not.toContain("Failing row");
      expect(route.logged).not.toMatch(MEASURE_LEAK);

      const raw = await rawFashionError(setup, teardown, [MEASURE]);
      expect(String((raw as Error).message)).toMatch(/173/); // đối chứng: lỗi thô chứa giá trị
      const logged = await logThrough500(raw);
      expect(logged).toMatch(/violates check constraint \\+"t151_chk\\+"/);
      expect(logged).toMatch(/Failing row contains \(\[h:[0-9a-f]{8}\], \[h:[0-9a-f]{8}\]/);
      expect(logged).not.toMatch(MEASURE_LEAK);
    });

    it("vòng 3: NOT NULL thật — route fashion 500 không lộ; lỗi dbErrorMapper qua logger không lộ", async () => {
      const { chest_cm: _omit, ...withoutChest } = MEASURE;
      const setup = "alter table fashion_model_measurement alter column chest_cm set not null";
      const teardown = "alter table fashion_model_measurement alter column chest_cm drop not null";
      const route = await postFashionWith(setup, teardown, [withoutChest]);
      expect(route.status).toBe(500);
      expect(route.logged).not.toContain("Failing row");
      expect(route.logged).not.toMatch(MEASURE_LEAK);
      const line = loggedDirect(await rawFashionError(setup, teardown, [withoutChest]));
      // Medusa `dbErrorMapper` đổi NOT NULL thành thông điệp không mang giá trị.
      expect(line).toContain("Cannot set field 'chest_cm' of Fashion model measurement to null");
      expect(line).not.toMatch(MEASURE_LEAK);
    });

    it("vòng 3: unique thật — route fashion 500 không lộ; dbErrorMapper chép giá trị → logger băm", async () => {
      const setup = "create unique index t151_uq on fashion_model_measurement (height_cm, hip_cm)";
      const teardown = "drop index t151_uq";
      const twins = [MEASURE, { ...MEASURE, size_worn: "l" }];
      const route = await postFashionWith(setup, teardown, twins);
      expect(route.status).toBe(500);
      expect(route.logged).not.toMatch(MEASURE_LEAK);
      const raw = await rawFashionError(setup, teardown, twins);
      expect(String((raw as Error).message)).toMatch(/height_cm: 173/); // đối chứng
      const line = loggedDirect(raw);
      expect(line).toMatch(
        /Fashion model measurement with height_cm: \[h:[0-9a-f]{8}\], hip_cm: \[h:[0-9a-f]{8}\], already exists\./,
      );
      expect(line).not.toMatch(MEASURE_LEAK);
    });

    it("vòng 3 ca C: raise … using detail, hint — route fashion chỉ log code; lỗi thô qua handler 500 giữ lỗi, detail, hint", async () => {
      const setup =
        "create function t151c_boom() returns trigger language plpgsql as $$ begin if NEW.height_cm = 173 then " +
        "raise exception 'chiều cao vượt ngưỡng' using detail = 'giá trị gửi lên không hợp lệ', hint = 'kiểm tra dữ liệu'; " +
        "end if; return NEW; end $$; " +
        "create trigger t151c_tg before insert on fashion_model_measurement for each row execute function t151c_boom()";
      const teardown = "drop trigger t151c_tg on fashion_model_measurement; drop function t151c_boom();";
      const route = await postFashionWith(setup, teardown, [MEASURE]);
      expect(route.status).toBe(500);
      expect(route.logged).toContain("code=P0001");
      expect(route.logged).not.toMatch(MEASURE_LEAK);

      const logged = await logThrough500(await rawFashionError(setup, teardown, [MEASURE]));
      expect(logged).toContain("[REDACTED] - chiều cao vượt ngưỡng");
      expect(logged).toContain(" - detail: giá trị gửi lên không hợp lệ");
      expect(logged).toContain(" - hint: kiểm tra dữ liệu");
      expect(logged).not.toMatch(MEASURE_LEAK);
    });
  },
});
