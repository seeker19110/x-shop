import { createServer, type IncomingMessage, type Server } from "node:http";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { updateProductVariantsWorkflow } from "@medusajs/medusa/core-flows";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { catalogRevalidate as protocol } from "@x-shop/domain";
import { CURRENCY } from "../../src/lib/catalog/constants";
import { rebuildCatalogIndex } from "../../src/lib/catalog/indexer";
import { CATALOG_REVALIDATE_EVENT, CATALOG_REVALIDATE_POLICY } from "../../src/lib/catalog/revalidate";
import { dispatchOutbox } from "../../src/lib/checkout/jobs";
import { validateOutboxPayload } from "../../src/lib/outbox/payload";
import seedCatalog from "../../src/scripts/seed-catalog";
import { CATALOG_INDEX_MODULE } from "../../src/modules/catalog-index";
import type CatalogIndexModuleService from "../../src/modules/catalog-index/service";
import { storeHeaders } from "../helpers/auth";
import { pauseSourceReadAfter } from "../helpers/catalog-rebuild";

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
  /** Kết quả `state.probe` đọc NGAY lúc nhận webhook (trước khi trả lời) — storefront thật nạp lại đúng lúc này. */
  probe?: unknown;
}

/** Storefront giả: kiểm chữ ký như route thật; `status` đổi được để mô phỏng storefront lỗi. */
function fakeStorefront() {
  const received: Received[] = [];
  const state: { status: number; probe: (() => Promise<unknown>) | null } = { status: 200, probe: null };
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
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
        const at = Date.now();
        const probe = state.probe
          ? await state.probe().catch((e: unknown) => `lỗi: ${(e as Error).message}`)
          : undefined;
        received.push({ at, body: JSON.parse(raw), verified: v.ok, probe });
        res.writeHead(v.ok ? state.status : 401, { "content-type": "application/json" });
        res.end("{}");
      })();
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
    /**
     * Dòng outbox revalidate của sản phẩm tạo từ `since`; `withCatalog` thêm dòng "cả catalog" (cũng phủ sản phẩm, nhưng có
     * thể do nơi khác ghi — ca kiểm đúng dòng CỦA ca dùng `withCatalog = false`, review T-142 🟢4).
     */
    const rowsFor = async (productId: string, since: Date, withCatalog = true) =>
      (
        await db().raw(
          `SELECT event_key, state, payload FROM outbox_event
           WHERE type = ? AND aggregate_id IN (?, ?) AND created_at >= ? ORDER BY created_at`,
          [CATALOG_REVALIDATE_EVENT, productId, withCatalog ? "catalog" : productId, since],
        )
      ).rows as { event_key: string; state: string; payload: Record<string, unknown> }[];
    /** Webhook từ `since` làm mới PDP của sản phẩm: tag `product:<handle>` hoặc `catalog` (vượt trần → cả catalog). */
    const withTag = (since: number) =>
      sf.received.filter(
        (r) =>
          r.at >= since && (r.body.tags.includes(productTag) || r.body.tags.includes(protocol.CATALOG_TAG)),
      );

    beforeAll(async () => {
      await new Promise<void>((r) => sf.server.listen(PORT, "127.0.0.1", r));
      container = getContainer();
      await seedCatalog({ container });
      headers = await storeHeaders(container);
      // Seed kích rebuild + đồng bộ hàng loạt (→ cửa sổ "cả catalog"): chờ read model xả hết và webhook lặng ≥ 2 cửa sổ
      // để mỗi ca dưới chỉ thấy webhook do chính nó gây ra.
      const index = container.resolve<CatalogIndexModuleService>(CATALOG_INDEX_MODULE);
      await eventually(
        () => index.dirtyCount(),
        (n) => n === 0,
        120_000,
      );
      await eventually(
        () => Date.now() - (sf.received.at(-1)?.at ?? 0),
        (quietMs) => quietMs > 2 * CATALOG_REVALIDATE_POLICY.windowMs + 500,
        120_000,
      );
    });
    afterAll(async () => {
      await new Promise<void>((r) => sf.server.close(() => r()));
    });
    beforeEach(() => {
      sf.state.status = 200;
      sf.state.probe = null;
    });

    const productId = async () =>
      (await container.resolve(Modules.PRODUCT).listProducts({ handle: HANDLE }, { select: ["id"] }))[0]!.id;

    it("sửa giá → webhook đã ký mang tag PDP + danh sách tới storefront trong vài giây; PDP backend đã là giá mới", async () => {
      const t0 = Date.now();
      const since = new Date(t0 - 1000);
      await setPrice(455_000);
      const [hit] = await eventually(
        () => withTag(t0),
        (r) => r.length > 0,
      );
      expect(hit!.verified).toBe(true);
      expect(hit!.body.tags).toEqual(expect.arrayContaining(["catalog:list", productTag]));
      // Lượt gửi gộp cuối cửa sổ (≤ windowMs) — không phải chờ TTL 60 s hay job outbox 10 s.
      expect(hit!.at - t0).toBeLessThan(10_000);
      // Storefront nạp lại NGAY khi nhận webhook → phải đọc được giá mới tại thời điểm đó.
      expect(await pdpPrice()).toBe(455_000);
      const rows = await rowsFor(await productId(), since);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows)
        expect(validateOutboxPayload(CATALOG_REVALIDATE_EVENT, r.payload)).toEqual({ ok: true });
      await eventually(
        async () => (await rowsFor(await productId(), since)).map((r) => r.state),
        (states) => states.every((s) => s === "sent"),
      );
    });

    it("storefront lỗi (500) → ghi backend vẫn thành công, outbox giữ dòng; storefront hồi → dispatcher gửi, dòng sent", async () => {
      sf.state.status = 500;
      const t0 = Date.now();
      const since = new Date(t0 - 1000);
      await expect(setPrice(466_000)).resolves.toBeUndefined();
      expect(await pdpPrice()).toBe(466_000);
      const pid = await productId();
      // Lượt gửi gộp đã thử và nhận 500 → dòng vẫn chờ (không sent).
      await eventually(
        () => withTag(t0),
        (r) => r.length > 0,
      );
      const pending = await rowsFor(pid, since, false);
      expect(pending.length).toBeGreaterThan(0);
      expect(pending.every((r) => r.event_key.endsWith(`:${pid}`))).toBe(true);
      expect(pending.every((r) => r.state === "pending")).toBe(true);

      sf.state.status = 200;
      const before = withTag(t0).length;
      // Dòng đến hạn sau cuối cửa sổ + grace → chạy dispatcher ở "tương lai".
      const summary = await dispatchOutbox(container, { now: new Date(Date.now() + 60_000) });
      expect(summary.sent).toEqual(expect.arrayContaining(pending.map((r) => r.event_key)));
      expect(withTag(t0).length).toBeGreaterThan(before);
      expect((await rowsFor(pid, since, false)).every((r) => r.state === "sent")).toBe(true);
    });

    it("storefront từ chối chữ ký (401) → dispatcher đưa dòng vào dead ngay (không retry vô ích), ghi backend không ảnh hưởng", async () => {
      sf.state.status = 401;
      const t0 = Date.now();
      const since = new Date(t0 - 1000);
      await setPrice(477_000);
      expect(await pdpPrice()).toBe(477_000);
      const pid = await productId();
      await eventually(
        () => withTag(t0),
        (r) => r.length > 0,
      );
      const summary = await dispatchOutbox(container, { now: new Date(Date.now() + 60_000) });
      const keys = (await rowsFor(pid, since, false)).map((r) => r.event_key);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((k) => k.endsWith(`:${pid}`))).toBe(true);
      expect(summary.dead).toEqual(expect.arrayContaining(keys));
      expect((await rowsFor(pid, since, false)).every((r) => r.state === "dead")).toBe(true);
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
      const since = new Date(t0 - 1000);
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
      const rows = await rowsFor(await productId(), since);
      const windows = new Set(rows.map((r) => r.event_key.split(":")[3]));
      expect(windows.size).toBe(rows.length); // một dòng mỗi (sản phẩm, cửa sổ)
      expect(hooks).toHaveLength(rows.length); // một webhook mỗi cửa sổ
      expect(rows.length).toBeLessThan(8);
      // Số cửa sổ không vượt khoảng thời gian sửa (+ cửa sổ của lượt xả cuối).
      expect(rows.length).toBeLessThanOrEqual(Math.ceil((t1 - t0) / CATALOG_REVALIDATE_POLICY.windowMs) + 2);
      expect(rows.every((r) => r.state === "sent")).toBe(true);
    });

    it("T-167: sửa giá trong lúc rebuild đang đọc nguồn → đồng bộ không chờ rebuild; webhook `catalog` của rebuild tới SAU khi read model có giá mới", async () => {
      const pid = await productId();
      const indexPrices = async (): Promise<number[]> =>
        (await db().raw(`SELECT price FROM catalog_variant_index WHERE sku = ?`, [SKU])).rows.map(
          (r: { price: string | number }) => Number(r.price),
        );
      const NEW = 499_000;
      const isNew = (p: unknown) => Array.isArray(p) && p.length > 0 && p.every((x) => x === NEW);
      // Storefront giả đọc read model ngay lúc nhận webhook (lúc storefront thật nạp lại danh sách).
      sf.state.probe = indexPrices;

      const gate = pauseSourceReadAfter(container, pid);
      const run = rebuildCatalogIndex(container);
      try {
        await gate.reached; // rebuild đã cầm ảnh chụp với giá CŨ
        await setPrice(NEW); // workflow thật → sự kiện → dấu bẩn → lượt xả hẹn trước
        // Khoá ghi không bị rebuild giữ lúc đọc nguồn → lượt xả đồng bộ ngay (trước T-167: chờ hết rebuild).
        await eventually(indexPrices, isNew);
      } finally {
        gate.restore();
      }
      const released = Date.now();
      const result = await run;
      expect(result.superseded).toBe(false);
      expect(result.kept).toBeGreaterThanOrEqual(1);
      expect(isNew(await indexPrices())).toBe(true); // ảnh chụp cũ không ghi đè

      // Webhook "cả catalog" do rebuild ghi SAU replaceAll: lúc storefront nhận, read model đã là giá mới.
      const hooks = await eventually(
        () => sf.received.filter((r) => r.at >= released && r.body.tags.includes(protocol.CATALOG_TAG)),
        (r) => r.length > 0,
      );
      for (const h of hooks) {
        expect(h.verified).toBe(true);
        expect(h.probe).toEqual((await indexPrices()).map(() => NEW));
      }
    });
  },
});
