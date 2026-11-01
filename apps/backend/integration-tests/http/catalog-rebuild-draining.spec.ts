import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import catalogIndexRebuildJob from "../../src/jobs/catalog-index-rebuild";
import { CURRENCY } from "../../src/lib/catalog/constants";
import { CATALOG_INDEX_LOCK, CATALOG_REBUILD_LOCK } from "../../src/lib/catalog/indexer";
import { acquireOrdered, releaseOwned } from "../../src/lib/checkout/locks";
import { resetShutdownStateForTest, shutdownState } from "../../src/lib/lifecycle/shutdown";
import seedCatalog from "../../src/scripts/seed-catalog";

jest.setTimeout(120 * 1000);

/**
 * T-237 (D-081/T-174) trên Redis/Postgres thật: job `x-catalog-index-rebuild` đang CHỜ khoá (rebuild khác giữ
 * `CATALOG_REBUILD_LOCK`, hoặc lượt xả/đồng bộ giữ `CATALOG_INDEX_LOCK`) mà tiến trình bắt đầu tắt → thôi chờ ngay, trả
 * về gọn (không ném, không log error), nhả khoá đã lấy, bảng read model cũ giữ nguyên. Trước T-237 job chờ mỗi khoá tới
 * 5 phút. Mọi bước chờ theo tín hiệu (lần giành khoá của job bị Redis báo bận), không ngủ cố định.
 */

/** Ngữ cảnh "lời gọi do job của ca khởi phát" — phân biệt với job nền của app test (cùng tiền tố ownerId `lock:`). */
const jobCtx = new AsyncLocalStorage<true>();
const runJob = (container: MedusaContainer) => jobCtx.run(true, () => catalogIndexRebuildJob(container));

/** Hạn "vài giây" cho job trả về sau khi bật cờ tắt (backoff chờ khoá ≤ ~120 ms/lần; trước T-237: tới 5 phút). */
const RETURN_WITHIN_MS = 5_000;

type Settled = { state: "done"; value: unknown; error: unknown } | { state: "pending" };

/** Chờ `p` tối đa `ms`: kết quả/lỗi, hoặc "pending" (không treo ca tới hết hạn chờ khoá 5 phút khi hồi quy). */
async function within(p: Promise<unknown>, ms: number): Promise<Settled> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Settled>((r) => {
    timer = setTimeout(() => r({ state: "pending" }), ms);
  });
  const settled = p.then(
    (value): Settled => ({ state: "done", value, error: undefined }),
    (error: unknown): Settled => ({ state: "done", value: undefined, error }),
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

medusaIntegrationTestRunner({
  testSuite: ({ getContainer }) => {
    let container: MedusaContainer;
    let db: Knex;
    let logger: Logger;
    const locking = () => container.resolve(Modules.LOCKING);

    /** Ảnh chụp bảng read model: mọi lần thay bảng (replaceAll) đổi `indexed_at`/giá → so sánh bằng nhau là "còn nguyên". */
    const snapshot = async () =>
      (
        await db.raw(
          `SELECT variant_id, sales_channel_id, price::text AS price, indexed_at::text AS indexed_at
             FROM catalog_variant_index ORDER BY variant_id, sales_channel_id`,
        )
      ).rows as Array<Record<string, string>>;

    /** Đổi giá ở NGUỒN bằng SQL (không sự kiện → không lượt xả): chỉ một rebuild trọn mới đưa giá này vào read model. */
    const setSourcePrice = (variantId: string, amount: number) =>
      db.raw(
        `UPDATE price SET amount = ?, raw_amount = jsonb_build_object('value', ?::text, 'precision', 20)
          WHERE currency_code = ? AND price_list_id IS NULL AND deleted_at IS NULL AND price_set_id IN (
            SELECT price_set_id FROM product_variant_price_set WHERE variant_id = ? AND deleted_at IS NULL)`,
        [amount, amount, CURRENCY, variantId],
      );
    const indexPrice = async (variantId: string): Promise<number[]> =>
      (await db.raw(`SELECT price FROM catalog_variant_index WHERE variant_id = ?`, [variantId])).rows.map(
        (r: { price: string | number }) => Number(r.price),
      );

    /** Chủ khác (tiến trình khác) giữ `key` trên Redis thật. */
    const holdAsOther = async (key: string) => {
      const owner = `t237-other-${key}-${Date.now()}`;
      await acquireOrdered(locking(), [key], {
        ownerId: owner,
        waitMs: 60_000,
        ttlSeconds: 30,
        scope: "test",
      });
      return { owner, release: () => releaseOwned(locking(), owner, [key]) };
    };

    /** Khoá `key` đang rảnh trên Redis thật? Thử giành bằng chủ thăm dò, không chờ; giành được thì trả ngay. */
    const isFree = async (key: string): Promise<boolean> => {
      const probe = `t237-probe-${Date.now()}-${Math.random()}`;
      try {
        await acquireOrdered(locking(), [key], { ownerId: probe, waitMs: 0, ttlSeconds: 5, scope: "test" });
      } catch (e) {
        if ((e as { code?: string }).code === "BUSY_RETRY") return false;
        throw e;
      }
      await releaseOwned(locking(), probe, [key]);
      return true;
    };

    /**
     * Tín hiệu "job của ca đang chờ `key`": `n` lần giành `key` khởi phát từ job của ca bị provider báo bận (đúng lỗi
     * Redis trả khi chủ khác giữ khoá). Không dựa vào thời gian.
     */
    const jobWaitingOn = (key: string, n = 1) => {
      const acquire = locking().acquire.bind(locking());
      let busy = 0;
      let reached!: () => void;
      const signal = new Promise<void>((r) => (reached = r));
      jest.spyOn(locking(), "acquire").mockImplementation(async (keys, args) => {
        try {
          return await acquire(keys, args);
        } catch (e) {
          const list = Array.isArray(keys) ? keys : [keys];
          if (jobCtx.getStore() === true && list.includes(key) && ++busy >= n) reached();
          throw e;
        }
      });
      return signal;
    };

    beforeAll(async () => {
      container = getContainer();
      await seedCatalog({ container }); // seed tự rebuild → bảng có dòng
      db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
      logger = container.resolve(ContainerRegistrationKeys.LOGGER);
    });

    afterEach(() => {
      resetShutdownStateForTest();
      jest.restoreAllMocks();
    });

    it("chủ khác giữ CATALOG_REBUILD_LOCK: hai job đang chờ, bật cờ tắt → cả hai trả về trong vài giây, không ném/log error; khoá vẫn của chủ kia, job không giành; bảng cũ còn nguyên", async () => {
      const before = await snapshot();
      expect(before.length).toBeGreaterThan(0);
      const info = jest.spyOn(logger, "info");
      const error = jest.spyOn(logger, "error");
      const other = await holdAsOther(CATALOG_REBUILD_LOCK);
      let jobs: Promise<unknown>[] = [];
      try {
        // Mỗi job bị báo bận ≥ 2 lần = đã vào vòng chờ (thử lại sau backoff), không chỉ lần thử đầu.
        const waiting = jobWaitingOn(CATALOG_REBUILD_LOCK, 4);
        jobs = [runJob(container), runJob(container)];
        await waiting;
        expect((await within(Promise.race(jobs), 0)).state).toBe("pending");

        shutdownState().draining = true;
        const start = Date.now();
        const r = await within(Promise.all(jobs), RETURN_WITHIN_MS);
        const elapsed = Date.now() - start;
        expect(r.state).toBe("done");
        expect(r.state === "done" ? r.error : "pending").toBeUndefined();
        expect(elapsed).toBeLessThan(RETURN_WITHIN_MS);
        expect(error).not.toHaveBeenCalled();
        expect(
          info.mock.calls.filter((a) => String(a[0]).includes("Đang tắt — thôi chờ khoá rebuild")).length,
        ).toBeGreaterThanOrEqual(2);

        expect(await isFree(CATALOG_REBUILD_LOCK)).toBe(false); // chủ kia vẫn giữ
        expect(await snapshot()).toEqual(before);
      } finally {
        await other.release();
        await within(Promise.allSettled(jobs), 60_000);
      }
      // Job đã thôi hẳn, không còn chờ để giành khoá vừa nhả.
      expect(await isFree(CATALOG_REBUILD_LOCK)).toBe(true);
      expect(await snapshot()).toEqual(before);
    });

    it("chủ khác giữ CATALOG_INDEX_LOCK: job đã giữ khoá rebuild, đọc nguồn xong và chờ khoá ghi → bật cờ tắt, trả về trong vài giây, NHẢ khoá rebuild, bảng cũ còn nguyên; không tắt thì rebuild sau đó ghi giá mới", async () => {
      const [row] = (
        await db.raw(`SELECT variant_id, price FROM catalog_variant_index
            WHERE compare_at IS NULL AND price_valid_until IS NULL ORDER BY variant_id LIMIT 1`)
      ).rows as Array<{ variant_id: string; price: string | number }>;
      const variantId = row!.variant_id;
      const OLD = Number(row!.price);
      const NEW = OLD + 17_000;
      await setSourcePrice(variantId, NEW); // rebuild trọn sẽ đổi giá trong bảng → bảng giữ giá cũ chứng minh không thay
      const before = await snapshot();
      const error = jest.spyOn(logger, "error");
      const info = jest.spyOn(logger, "info");
      const other = await holdAsOther(CATALOG_INDEX_LOCK);
      let job: Promise<unknown> = Promise.resolve();
      try {
        const waiting = jobWaitingOn(CATALOG_INDEX_LOCK, 2);
        job = runJob(container);
        await waiting;
        expect((await within(job, 0)).state).toBe("pending");
        expect(await isFree(CATALOG_REBUILD_LOCK)).toBe(false); // job đang giữ khoá rebuild trong lúc chờ khoá ghi

        shutdownState().draining = true;
        const start = Date.now();
        const r = await within(job, RETURN_WITHIN_MS);
        const elapsed = Date.now() - start;
        expect(r.state).toBe("done");
        expect(r.state === "done" ? r.error : "pending").toBeUndefined();
        expect(elapsed).toBeLessThan(RETURN_WITHIN_MS);
        expect(error).not.toHaveBeenCalled();
        expect(info.mock.calls.some((a) => String(a[0]).includes("Đang tắt — thôi chờ khoá rebuild"))).toBe(
          true,
        );

        expect(await isFree(CATALOG_REBUILD_LOCK)).toBe(true); // khoá rebuild đã nhả
        expect(await isFree(CATALOG_INDEX_LOCK)).toBe(false); // khoá ghi vẫn của chủ kia
        expect(await snapshot()).toEqual(before);
        expect(await indexPrice(variantId)).toEqual(expect.arrayContaining([OLD]));
      } finally {
        await other.release();
        await within(job, 60_000);
        resetShutdownStateForTest();
        jest.restoreAllMocks();
      }

      // Đối chứng: không tắt, khoá rảnh → job rebuild trọn, giá nguồn mới vào bảng (ảnh chụp "còn nguyên" ở trên có nghĩa).
      await runJob(container);
      const after = await indexPrice(variantId);
      expect(after.length).toBeGreaterThan(0);
      expect(after.every((p) => p === NEW)).toBe(true);
      await setSourcePrice(variantId, OLD);
      await runJob(container);
    });
  },
});
