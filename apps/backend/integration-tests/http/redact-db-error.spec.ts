import { inspect } from "node:util";
import { knex, type Knex } from "@medusajs/framework/mikro-orm/knex";
import { createLogger } from "../../src/lib/log/logger";

jest.setTimeout(60_000);

/**
 * T-151 — lỗi DB THẬT (trigger `raise exception`) đi qua knex/pg rồi qua logger dự án: bản ghi log (message, stacktrace,
 * JSON) không được còn giá trị đã chèn — kể cả SỐ (số đo, tiền gắn người), `null`, JSON. knex chép giá trị vào
 * `err.message` khi câu lệnh được viết với literal (migration `addSql`, `knex.raw(chuỗi)`); với bind `$n` thì message chỉ
 * có `$1…` — cả hai đường đều phải sạch.
 */
describe("log lỗi DB không lộ giá trị đã chèn (T-151)", () => {
  let db: Knex;
  const lines: string[] = [];
  const logger = createLogger({
    service: "test",
    version: "0",
    env: "test",
    level: "error",
    write: (l) => lines.push(l),
  });

  beforeAll(async () => {
    // Một kết nối duy nhất: bảng/hàm TEMP chỉ sống trong phiên → không để lại gì trong DB.
    db = knex({ client: "pg", connection: process.env.DATABASE_URL as string, pool: { min: 1, max: 1 } });
    await db.raw(
      "create temp table t151_measure (id text, height_cm int, bust_cm int, waist_cm int, hip_cm int, note text, extra jsonb, gone text)",
    );
    await db.raw(
      "create function pg_temp.t151_boom() returns trigger language plpgsql as $$ begin raise exception 'boom trigger'; end $$",
    );
    await db.raw(
      "create trigger t151_tg before insert or update or delete on t151_measure for each statement execute function pg_temp.t151_boom()",
    );
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(() => {
    lines.length = 0;
  });

  // Số đứng riêng (không dính `:`/`.`/chữ-số → không trùng số dòng trong stack hay mili-giây của timestamp).
  const LEAKS = /(?<![\w:.])(?:180|9431|78|95|1500000)(?![\w:])|61\.5|Nguyễn|0912345678|fmm_01J|abc-777/;

  async function caught(run: () => PromiseLike<unknown>): Promise<Error> {
    try {
      await run();
    } catch (e) {
      return e as Error;
    }
    throw new Error("câu lệnh phải lỗi");
  }

  function assertClean(err: Error, expected = "boom trigger") {
    logger.error("ghi DB thất bại", err);
    logger.error(err);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toMatch(LEAKS);
      expect(line).toContain(expected);
      expect(JSON.parse(line)["exception.stacktrace"]).toContain(expected);
    }
    const redacted = inspect(JSON.parse(lines[0]!), { depth: 6 });
    expect(redacted).not.toMatch(LEAKS);
  }

  it("đối chứng: lỗi thật chứa giá trị nếu không che (literal trong câu lệnh)", async () => {
    const err = await caught(() =>
      db.raw(
        `insert into t151_measure (id, height_cm, bust_cm, waist_cm, hip_cm, note, extra, gone) values ('fmm_01J', 180, 9431, 78, 95, 'Nguyễn Văn A 0912345678', '{"weight":61.5}', null)`,
      ),
    );
    expect(err.message).toMatch(/180/);
    expect(err.stack).toMatch(/180/);
  });

  it("insert với literal (số, chuỗi, JSON, null)", async () => {
    const err = await caught(() =>
      db.raw(
        `insert into t151_measure (id, height_cm, bust_cm, waist_cm, hip_cm, note, extra, gone) values ('fmm_01J', 180, 9431, 78, 95, 'Nguyễn Văn A 0912345678', '{"weight":61.5}', null)`,
      ),
    );
    assertClean(err);
  });

  it("update … where với literal", async () => {
    const err = await caught(() =>
      db.raw(
        `update "t151_measure" set "height_cm" = 180, "note" = 'Nguyễn' where "id" = 'abc-777' and "hip_cm" = 95`,
      ),
    );
    assertClean(err);
  });

  it("delete … where và select … where với literal", async () => {
    assertClean(
      await caught(() => db.raw(`delete from "t151_measure" where "waist_cm" = 78 and "id" = 'abc-777'`)),
    );
    lines.length = 0;
    assertClean(
      await caught(() =>
        db.raw(`select 1 / 0 as x from "t151_measure" where "hip_cm" = 95 and "bust_cm" = 1500000`),
      ),
      "division by zero",
    );
  });

  /**
   * Review vòng 2: câu do knex query builder sinh, chạy dưới dạng chuỗi đã chèn giá trị (`toString()` — đúng dạng knex chép
   * vào message khi `compileSqlOnError`) để message lỗi thật chứa giá trị.
   */
  it("review vòng 2: select danh sách cột > 2048 ký tự (như MikroORM) vẫn che điều kiện", async () => {
    const cols = Array.from({ length: 90 }, (_, i) => `height_cm as height_alias_${i}`);
    const sql = db("t151_measure")
      .select(cols)
      .where({ height_cm: 180, id: "abc-777" })
      .andWhere("bust_cm", 9431)
      .andWhereRaw("1 / 0 = 1")
      .toString();
    const err = await caught(() => db.raw(sql));
    expect(err.message).toMatch(/9431/);
    expect(err.message.indexOf(" from ")).toBeGreaterThan(2048);
    assertClean(err, "division by zero");
  });

  it("review vòng 2: delete … using (join) và update … as alias", async () => {
    const del = db("t151_measure")
      .using(["t151_measure as m2"])
      .where("t151_measure.id", "abc-777")
      .andWhere("m2.hip_cm", 95)
      .del()
      .toString();
    expect(del).toMatch(/^delete from "t151_measure" using /);
    assertClean(await caught(() => db.raw(del)));
    lines.length = 0;
    assertClean(
      await caught(() =>
        db.raw(`update "t151_measure" as "m" set "height_cm" = 180 where "m"."id" = 'abc-777'`),
      ),
    );
  });

  it("query builder (bind $n): message không chứa giá trị", async () => {
    const err = await caught(() =>
      db("t151_measure").insert({ id: "fmm_01J", height_cm: 180, bust_cm: 9431, hip_cm: 95, note: "Nguyễn" }),
    );
    assertClean(err);
  });
});
