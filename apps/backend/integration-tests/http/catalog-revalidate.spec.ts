import { createServer, type IncomingMessage, type Server } from "node:http";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { updateProductVariantsWorkflow } from "@medusajs/medusa/core-flows";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { catalogRevalidate as protocol } from "@x-shop/domain";
import { CURRENCY } from "../../src/lib/catalog/constants";
import {
  CATALOG_REVALIDATE_EVENT,
  CATALOG_REVALIDATE_POLICY,
  windowStartMs,
} from "../../src/lib/catalog/revalidate";
import { dispatchOutbox } from "../../src/lib/checkout/jobs";
import { validateOutboxPayload } from "../../src/lib/outbox/payload";
import seedCatalog from "../../src/scripts/seed-catalog";
import { CATALOG_INDEX_MODULE } from "../../src/modules/catalog-index";
import type CatalogIndexModuleService from "../../src/modules/catalog-index/service";
import { storeHeaders } from "../helpers/auth";

/**
 * T-142 (D-070, BE-CACHE-007): sửa giá ở backend → webhook ĐÃ KÝ tới storefront (ở đây: máy chủ HTTP giả đóng vai route
 * `/api/revalidate`, kiểm chữ ký bằng đúng hàm của storefront) mang tag PDP của sản phẩm, ngay sau khi read model cập nhật;
 * storefront lỗi thì ghi backend vẫn thành công, outbox giữ việc gửi; nhiều lần sửa liên tiếp được gộp.
 * Phần storefront (route → revalidateTag hết hạn ngay → đọc PDP thấy giá mới): apps/storefront revalidate-cache.test.ts.
 */

jest.setTimeout(300 * 1000);

const SECRET = "khoa-revalidate-tich-hop-0123456789abcdef";
// Cổng cố định theo pid (biến môi trường phải có TRƯỚC khi app Medusa khởi động); hai lần chạy song song khác pid.
const PORT = 20_000 + (process.pid % 20_000);
process.env.CATALOG_REVALIDATE_SECRET = SECRET;
process.env.CATALOG_REVALIDATE_URLS = `http://127.0.0.1:${PORT}/api/revalidate`;

interface Received {
  at: number;
  body: { id: string; tags: string[] };
  verified: boolean;
}

/** Storefront giả: kiểm chữ ký như route thật; `status` đổi được để mô phỏng storefront lỗi. */
function fakeStorefront() {
  const received: Received[] = [];
  const state = { status: 200 };
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const h = (k: string) => (req.headers[k] as string | undefined) ?? null;
      const v = protocol.verifyRevalidate(
        SECRET,
        {
          timestamp: h(protocol.REVALIDATE_HEADERS.timestamp),
          nonce: h(protocol.REVALIDATE_HEADERS.nonce),
          signature: h(protocol.REVALIDATE_HEADERS.signature),
        },
        raw,
        Date.now(),
      );
      received.push({ at: Date.now(), body: JSON.parse(raw), verified: v.ok });
      res.writeHead(v.ok ? state.status : 401, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return { server, received, state };
}

async function eventually<T>(
  fn: () => Promise<T> | T,
  ok: (v: T) => boolean,
  timeoutMs = 20_000,
): Promise<T> {
  const start = Date.now();
  let last = await fn();
  while (!ok(last)) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`Hết thời gian chờ; giá trị cuối: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 100));
    last = await fn();
  }
  return last;
}

const HANDLE = "ao-so-mi-lua";
const SKU = "SMLUA-DEN-M";

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer;
    let headers: Record<string, string>;
    const sf = fakeStorefront();
    const productTag = protocol.productTag(HANDLE) as string;

    const pdpPrice = async () => {
      const r = (await api.get(`/store/x/products/${HANDLE}`, { headers })) as {
        data: { variants: { sku: string; price: number }[] };
      };
      return r.data.variants.find((v) => v.sku === SKU)?.price;
    };
    const setPrice = async (amount: number) => {
      const [variant] = await container
        .resolve(Modules.PRODUCT)
        .listProductVariants({ sku: SKU }, { select: ["id"] });
      await updateProductVariantsWorkflow(container).run({
        input: { product_variants: [{ id: variant!.id, prices: [{ amount, currency_code: CURRENCY }] }] },
      });
    };
    const db = () => container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
    /** Mốc cửa sổ gộp trong id webhook (`…:w:<mốc>`) hoặc khoá sự kiện (`…:p:<mốc>:<id>`, `…:all:<mốc>`). */
    const windowOf = (id: string) => Number(id.split(":")[2]);
    /**
     * Dòng outbox revalidate của sản phẩm thuộc cửa sổ ≥ cửa sổ chứa `t0` (thay đổi do CHÍNH ca gây ra); `withCatalog` thêm
     * dòng "cả catalog" cùng điều kiện cửa sổ. Không lọc theo created_at: dòng "all" của seed/rebuild trước ca bị loại theo
     * mốc cửa sổ (gate T-142 chập chờn: dòng all:1793141528000 của seed lọt vào ca gộp).
     */
    const rowsFor = async (productId: string, t0: number, withCatalog = true) =>
      (
        (
          await db().raw(
            `SELECT event_key, state, payload FROM outbox_event
             WHERE type = ? AND aggregate_id IN (?, ?) ORDER BY created_at`,
            [CATALOG_REVALIDATE_EVENT, productId, withCatalog ? "catalog" : productId],
          )
        ).rows as { event_key: string; state: string; payload: Record<string, unknown> }[]
      ).filter((r) => windowOf(r.event_key) >= windowStartMs(t0));
    /**
     * Webhook do thay đổi từ `t0` gây ra (mốc cửa sổ trong id ≥ cửa sổ chứa `t0`) làm mới PDP của sản phẩm: tag
     * `product:<handle>`, hoặc `catalog` (vượt trần → cả catalog) khi `orCatalog`.
     */
    const withTag = (t0: number, orCatalog = true) =>
      sf.received.filter(
        (r) =>
          windowOf(r.body.id) >= windowStartMs(t0) &&
          (r.body.tags.includes(productTag) || (orCatalog && r.body.tags.includes(protocol.CATALOG_TAG))),
      );

    /**
     * Cách ly mỗi ca: read model xả hết, KHÔNG còn dòng catalog.revalidate pending/failed (kể cả dòng "all" của seed/rebuild
     * đang chờ lượt gửi gộp hoặc dispatcher), rồi webhook lặng hơn một cửa sổ.
     */
    const quiesce = async () => {
      sf.state.status = 200;
      const index = container.resolve<CatalogIndexModuleService>(CATALOG_INDEX_MODULE);
      await eventually(
        () => index.dirtyCount(),
        (n) => n === 0,
        120_000,
      );
      const open = async () =>
        Number(
          (
            await db().raw(
              `SELECT count(*)::int AS n FROM outbox_event WHERE type = ? AND state IN ('pending', 'failed')`,
              [CATALOG_REVALIDATE_EVENT],
            )
          ).rows[0].n,
        );
      // Không "đẩy" bằng dispatcher ở tương lai: chữ ký mang mốc tương lai bị storefront từ chối (lệch giờ) → dòng dead thay
      // vì được gửi. Dòng hẹn lại (lỗi tạm/ngắt) được job outbox-dispatch thật của app gửi lại trong vài chục giây.
      try {
        await eventually(open, (n) => n === 0, 90_000);
      } catch (e) {
        const left = (
          await db().raw(
            `SELECT event_key, state, attempts, next_attempt_at, left(coalesce(last_error, ''), 160) AS err
               FROM outbox_event WHERE type = ? AND state IN ('pending', 'failed')`,
            [CATALOG_REVALIDATE_EVENT],
          )
        ).rows;
        throw new Error(`quiesce: ${(e as Error).message}; còn ${JSON.stringify(left)}`);
      }
      for (;;) {
        const n = sf.received.length;
        await new Promise((r) => setTimeout(r, CATALOG_REVALIDATE_POLICY.windowMs + 500));
        if (sf.received.length === n) break;
      }
    };

    beforeAll(async () => {
      await new Promise<void>((r) => sf.server.listen(PORT, "127.0.0.1", r));
      container = getContainer();
      await seedCatalog({ container });
      headers = await storeHeaders(container);
    });
    afterAll(async () => {
      await new Promise<void>((r) => sf.server.close(() => r()));
    });
    beforeEach(async () => {
      await quiesce();
    }, 300_000);

    const productId = async () =>
      (await container.resolve(Modules.PRODUCT).listProducts({ handle: HANDLE }, { select: ["id"] }))[0]!.id;

    it("sửa giá → webhook đã ký mang tag PDP + danh sách tới storefront trong vài giây; PDP backend đã là giá mới", async () => {
      const t0 = Date.now();
      await setPrice(455_000);
      // Webhook mang tag CỦA sản phẩm này (không lấy webhook đầu tiên bất kỳ).
      const [hit] = await eventually(
        () => withTag(t0, false),
        (r) => r.length > 0,
      );
      expect(hit!.verified).toBe(true);
      expect(hit!.body.tags).toEqual(expect.arrayContaining(["catalog:list", productTag]));
      // Lượt gửi gộp cuối cửa sổ (≤ windowMs) — không phải chờ TTL 60 s hay job outbox 10 s.
      expect(hit!.at - t0).toBeLessThan(10_000);
      // Storefront nạp lại NGAY khi nhận webhook → phải đọc được giá mới tại thời điểm đó.
      expect(await pdpPrice()).toBe(455_000);
      const rows = await rowsFor(await productId(), t0);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows)
        expect(validateOutboxPayload(CATALOG_REVALIDATE_EVENT, r.payload)).toEqual({ ok: true });
      await eventually(
        async () => (await rowsFor(await productId(), t0)).map((r) => r.state),
        (states) => states.every((s) => s === "sent"),
      );
    });

    it("storefront lỗi (500) → ghi backend vẫn thành công, outbox giữ dòng; storefront hồi → dispatcher gửi, dòng sent", async () => {
      sf.state.status = 500;
      const t0 = Date.now();
      await expect(setPrice(466_000)).resolves.toBeUndefined();
      expect(await pdpPrice()).toBe(466_000);
      const pid = await productId();
      // Lượt gửi gộp đã thử và nhận 500 → dòng vẫn chờ (không sent).
      await eventually(
        () => withTag(t0),
        (r) => r.length > 0,
      );
      const pending = await rowsFor(pid, t0, false);
      expect(pending.length).toBeGreaterThan(0);
      expect(pending.every((r) => r.event_key.endsWith(`:${pid}`))).toBe(true);
      expect(pending.every((r) => r.state === "pending")).toBe(true);

      sf.state.status = 200;
      const before = withTag(t0).length;
      // Dòng đến hạn sau cuối cửa sổ + grace → chạy dispatcher ở "tương lai".
      const summary = await dispatchOutbox(container, { now: new Date(Date.now() + 60_000) });
      expect(summary.sent).toEqual(expect.arrayContaining(pending.map((r) => r.event_key)));
      expect(withTag(t0).length).toBeGreaterThan(before);
      expect((await rowsFor(pid, t0, false)).every((r) => r.state === "sent")).toBe(true);
    });

    it("storefront từ chối chữ ký (401) → dispatcher đưa dòng vào dead ngay (không retry vô ích), ghi backend không ảnh hưởng", async () => {
      sf.state.status = 401;
      const t0 = Date.now();
      await setPrice(477_000);
      expect(await pdpPrice()).toBe(477_000);
      const pid = await productId();
      await eventually(
        () => withTag(t0),
        (r) => r.length > 0,
      );
      const summary = await dispatchOutbox(container, { now: new Date(Date.now() + 60_000) });
      const keys = (await rowsFor(pid, t0, false)).map((r) => r.event_key);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((k) => k.endsWith(`:${pid}`))).toBe(true);
      expect(summary.dead).toEqual(expect.arrayContaining(keys));
      expect((await rowsFor(pid, t0, false)).every((r) => r.state === "dead")).toBe(true);
      // Một ngoại lệ đang mở cho loại sự kiện này (không mỗi dòng một cái), ưu tiên thường (review T-142 🟠2).
      const active = (
        await db().raw(
          `SELECT priority FROM ops_exception WHERE kind = 'outbox_dead' AND state IN ('open', 'in_progress')
             AND detail->>'type' = ? AND deleted_at IS NULL`,
          [CATALOG_REVALIDATE_EVENT],
        )
      ).rows as { priority: string }[];
      expect(active).toEqual([{ priority: "normal" }]);
    });

    it("gộp: 8 lần sửa giá liên tiếp → mỗi cửa sổ một dòng + một webhook (ít hơn số lần sửa), giá cuối đúng", async () => {
      const t0 = Date.now();
      for (let i = 1; i <= 8; i++) await setPrice(480_000 + i * 1000);
      const t1 = Date.now();
      expect(await pdpPrice()).toBe(488_000);
      await eventually(
        () => withTag(t0),
        (r) => r.length > 0,
      );
      // Chờ thêm hơn một cửa sổ để mọi lượt gửi gộp đã chạy.
      await new Promise((r) => setTimeout(r, 2 * CATALOG_REVALIDATE_POLICY.windowMs + 500));
      const hooks = withTag(t0);
      const rows = await rowsFor(await productId(), t0);
      const windows = new Set(rows.map((r) => r.event_key.split(":")[3]));
      expect(windows.size).toBe(rows.length); // một dòng mỗi (sản phẩm, cửa sổ)
      expect(hooks).toHaveLength(rows.length); // một webhook mỗi cửa sổ
      expect(rows.length).toBeLessThan(8);
      // Số cửa sổ không vượt khoảng thời gian sửa (+ cửa sổ của lượt xả cuối).
      expect(rows.length).toBeLessThanOrEqual(Math.ceil((t1 - t0) / CATALOG_REVALIDATE_POLICY.windowMs) + 2);
      expect(rows.every((r) => r.state === "sent")).toBe(true);
    });
  },
});
