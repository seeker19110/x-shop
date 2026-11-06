import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { SHIPPING_MODULE } from "../../src/modules/shipping";

jest.setTimeout(120 * 1000);

/**
 * T-186 (Q-22): parser int8 → number (src/lib/db/int8.ts, cài ở medusa-config.ts) có hiệu lực trong tiến trình Medusa
 * thật. Bên dưới chỉ có MỘT knex/pool chung (`__pg_connection__` — EntityManager MikroORM của module chạy trên chính knex
 * đó; `dbConnection` của runner cũng là cùng đối tượng). Hai hàng khác nhau ở LỚP GỌI: knex thô đẩy nguyên RangeError của
 * parser; MikroORM (`em.execute`, đường SQL/DML của service module) bọc thành DriverException giữ thông điệp. Không phụ
 * thuộc cột bigint nào của dự án (chỉ `select …::int8`) — bắt được trường hợp cây phụ thuộc tách `pg-types`.
 *
 * "Kết nối vẫn dùng được" kiểm ở mức KẾT NỐI, không phải pool: mỗi ca ghim một kết nối (knex `acquireConnection()` +
 * `.connection(conn)`; MikroORM `em.transactional`) và so `pg_backend_pid()` trước/sau lỗi — kết nối bị đóng/thay sau lỗi
 * parser thì ca đỏ.
 */

type Row = Record<string, unknown>;
/** Chạy một khối truy vấn trên MỘT kết nối ghim; `q` gửi SQL qua đúng kết nối đó. */
type Pinned = <T>(fn: (q: (sql: string) => Promise<Row[]>) => Promise<T>) => Promise<T>;

interface KnexLike {
  raw(sql: string): { connection(c: unknown): Promise<{ rows: Row[] }> };
  client: { acquireConnection(): Promise<unknown>; releaseConnection(c: unknown): Promise<unknown> };
}
interface MikroManager {
  transactional<T>(
    fn: (em: { execute(sql: string, p: unknown[], m: "all"): Promise<Row[]> }) => Promise<T>,
  ): Promise<T>;
}

const MAX = "9007199254740991"; // 2^53 − 1
const OVER = "9007199254740992"; // 2^53
const PARSER_ERROR = /Giá trị bigint vượt số nguyên an toàn của JavaScript: -?9007199254740992/;
const PID = "SELECT pg_backend_pid() AS pid";

medusaIntegrationTestRunner({
  testSuite: ({ getContainer }) => {
    const knex = () => getContainer().resolve<KnexLike>(ContainerRegistrationKeys.PG_CONNECTION);

    const paths: Array<[string, Pinned]> = [
      [
        "MikroORM (em.transactional của module shipping)",
        (fn) => {
          const svc = getContainer().resolve(SHIPPING_MODULE) as unknown as {
            repo_: { getFreshManager(): MikroManager };
          };
          return svc.repo_.getFreshManager().transactional((em) => fn((sql) => em.execute(sql, [], "all")));
        },
      ],
      [
        "knex của Medusa (__pg_connection__, acquireConnection)",
        async (fn) => {
          const k = knex();
          const conn = await k.client.acquireConnection();
          try {
            return await fn(async (sql) => (await k.raw(sql).connection(conn)).rows);
          } finally {
            await k.client.releaseConnection(conn);
          }
        },
      ],
    ];

    describe.each(paths)("%s", (_name, pinned) => {
      it("int8 biên an toàn → number; âm, 0, NULL, count(*) đúng", async () => {
        const rows = await pinned((q) =>
          q(
            `SELECT ${MAX}::int8 AS max, (-${MAX})::int8 AS min, 0::int8 AS zero, NULL::int8 AS nil, count(*) AS n`,
          ),
        );
        expect(rows).toEqual([
          { max: Number.MAX_SAFE_INTEGER, min: -Number.MAX_SAFE_INTEGER, zero: 0, nil: null, n: 1 },
        ]);
      });

      it("int8 vượt 2^53 − 1 → truy vấn lỗi từ parser; CÙNG kết nối (cùng PID) dùng tiếp được ngay sau đó", async () => {
        const { before, after } = await pinned(async (q) => {
          const [b] = await q(PID);
          await expect(q(`SELECT ${OVER}::int8 AS v`)).rejects.toThrow(PARSER_ERROR);
          await expect(q(`SELECT (-${OVER})::int8 AS v`)).rejects.toThrow(PARSER_ERROR);
          const [a] = await q(`SELECT pg_backend_pid() AS pid, 7::int8 AS v`);
          return { before: b, after: a };
        });
        expect(typeof before?.pid).toBe("number");
        expect(after).toEqual({ pid: before?.pid, v: 7 });
      });
    });
  },
});
