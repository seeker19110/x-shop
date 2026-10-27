import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import seedXShop from "../../src/scripts/seed";
import { CATALOG_INDEX_MODULE } from "../../src/modules/catalog-index";
import type CatalogIndexModuleService from "../../src/modules/catalog-index/service";
import { noThrow, storeHeaders } from "../helpers/auth";

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
  },
});
