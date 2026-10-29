import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { SHIPPING_MODULE } from "../../src/modules/shipping";

jest.setTimeout(120 * 1000);

/**
 * T-186 (Q-22): parser int8 → number (src/lib/db/int8.ts, cài ở medusa-config.ts) có hiệu lực trong tiến trình Medusa
 * thật, trên CẢ HAI đường truy vấn: MikroORM (EntityManager của module — đường service DML/SQL của module đi qua) và
 * knex của Medusa (`__pg_connection__`, cùng loại với kết nối của runner). Không phụ thuộc cột bigint nào của dự án (chỉ
 * `select …::int8`) — bắt được trường hợp cây phụ thuộc tách `pg-types` (pg của MikroORM/knex không thấy parser).
 */

interface RawKnex {
  raw(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}
interface MikroManager {
  execute(sql: string, params: unknown[], method: "all"): Promise<Array<Record<string, unknown>>>;
}

const MAX = "9007199254740991"; // 2^53 − 1
const OVER = "9007199254740992"; // 2^53
const PARSER_ERROR = /Giá trị bigint vượt số nguyên an toàn của JavaScript: -?9007199254740992/;

medusaIntegrationTestRunner({
  testSuite: ({ dbConnection, getContainer }) => {
    const paths: Array<[string, (sql: string) => Promise<Array<Record<string, unknown>>>]> = [
      [
        "MikroORM (EntityManager của module shipping)",
        (sql) => {
          const svc = getContainer().resolve(SHIPPING_MODULE) as unknown as {
            repo_: { getFreshManager(): MikroManager };
          };
          return svc.repo_.getFreshManager().execute(sql, [], "all");
        },
      ],
      [
        "knex của Medusa (__pg_connection__)",
        async (sql) =>
          (await getContainer().resolve<RawKnex>(ContainerRegistrationKeys.PG_CONNECTION).raw(sql)).rows,
      ],
      [
        "knex của runner (dbConnection)",
        async (sql) => (await (dbConnection as unknown as RawKnex).raw(sql)).rows,
      ],
    ];

    describe.each(paths)("%s", (_name, query) => {
      it("int8 biên an toàn → number; âm, 0, NULL đúng", async () => {
        const rows = await query(
          `SELECT ${MAX}::int8 AS max, (-${MAX})::int8 AS min, 0::int8 AS zero, NULL::int8 AS nil, count(*) AS n`,
        );
        expect(rows).toEqual([
          { max: Number.MAX_SAFE_INTEGER, min: -Number.MAX_SAFE_INTEGER, zero: 0, nil: null, n: 1 },
        ]);
      });

      // knex đẩy nguyên RangeError của parser; MikroORM bọc thành DriverException giữ thông điệp → so thông điệp.
      it("int8 vượt 2^53 − 1 → truy vấn lỗi từ parser, kết nối/pool vẫn dùng được ngay sau đó", async () => {
        await expect(query(`SELECT ${OVER}::int8 AS v`)).rejects.toThrow(PARSER_ERROR);
        await expect(query(`SELECT (-${OVER})::int8 AS v`)).rejects.toThrow(PARSER_ERROR);
        expect(await query(`SELECT 7::int8 AS v`)).toEqual([{ v: 7 }]);
      });
    });
  },
});
