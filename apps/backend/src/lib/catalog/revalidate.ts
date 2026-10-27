import { randomBytes } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { catalogRevalidate as protocol, msToSecondsFloor } from "@x-shop/domain";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import type { OutboxClaim } from "../../modules/checkout/service";
import { parseEnv } from "../env";
import { isDraining } from "../lifecycle/shutdown";
import { isTransientStatus, parseRetryAfterMs } from "../outbox/retry";

/**
 * Vô hiệu hoá cache catalog của storefront theo sự kiện (T-142, D-070, BE-CACHE-007).
 *
 * Luồng: workflow ghi sản phẩm/giá/tồn → sự kiện → subscriber `catalog-index-sync` đánh dấu sản phẩm bẩn → lượt xả
 * (`lib/catalog/indexer.ts`) đồng bộ read model → `enqueueCatalogRevalidation` ghi outbox `catalog.revalidate`. Gọi SAU
 * khi read model đã cập nhật để danh sách/tìm kiếm storefront nạp lại đọc được bản mới (PDP đọc nguồn trực tiếp).
 * Lỗi ở đây không bao giờ chặn ghi backend: workflow đã commit từ trước; outbox giữ việc gửi tới khi thành công.
 *
 * Gộp + trần tần suất (theo tiến trình): thời gian chia thành cửa sổ `windowMs`. Mỗi (sản phẩm, cửa sổ) đúng MỘT dòng
 * outbox (khoá sự kiện chứa mốc cửa sổ, `ON CONFLICT DO NOTHING` — idempotent khi nhiều lượt xả/tiến trình ghi trùng).
 * Một cửa sổ quá `maxProductsPerWindow` sản phẩm → thay bằng MỘT dòng "cả catalog". Cuối cửa sổ, tiến trình gửi MỘT
 * webhook gộp mọi dòng của cửa sổ rồi đánh dấu chúng `sent`; gửi lỗi/tiến trình chết → dòng đến hạn sau
 * `dispatchGraceMs` và job `outbox-dispatch` gửi từng dòng (retry/backoff/dead như mọi sự kiện outbox).
 */

export const CATALOG_REVALIDATE_EVENT = "catalog.revalidate";

export const CATALOG_REVALIDATE_POLICY = {
  /** Độ rộng cửa sổ gộp: mọi thay đổi trong cửa sổ đi chung một webhook ở cuối cửa sổ. */
  windowMs: 2_000,
  /** Quá số sản phẩm này trong một cửa sổ → một dòng "cả catalog" thay vì từng sản phẩm. */
  maxProductsPerWindow: 20,
  /** Dòng outbox đến hạn cho dispatcher sau cuối cửa sổ + khoảng này (lượt gửi gộp chạy trước, đánh dấu sent). */
  dispatchGraceMs: 10_000,
  /** Hạn một lần POST tới storefront — ngắn vì bộ xử lý chạy trong khe outbox-dispatch dùng chung (D-081). */
  requestTimeoutMs: 2_000,
  /**
   * Storefront không trả lời (timeout/lỗi kết nối) → trong khoảng này mọi lần gửi của tiến trình thất bại NGAY (tạm thời,
   * hẹn lại sau phần còn lại), không chờ mạng: một lượt dispatcher chỉ mất tối đa một `requestTimeoutMs` cho cả loạt dòng
   * catalog, sự kiện khác (thanh toán, thông báo) không xếp hàng sau chúng.
   */
  unavailableCooldownMs: 30_000,
  /** Trần chờ theo `Retry-After` của storefront. */
  maxRetryAfterMs: 3600_000,
} as const;

export interface RevalidateConfig {
  secret: string;
  urls: string[];
}

let cachedConfig: { value: RevalidateConfig | null } | null = null;

/** Cấu hình webhook (đã kiểm khi khởi động ở medusa-config); null = tắt (không ghi outbox). */
export function getRevalidateConfig(): RevalidateConfig | null {
  if (cachedConfig) return cachedConfig.value;
  const parsed = parseEnv(process.env);
  if (!parsed.ok)
    throw new Error("[catalog-revalidate] Cấu hình môi trường không hợp lệ (đã báo khi khởi động)");
  cachedConfig = { value: parsed.env.catalogRevalidate };
  return cachedConfig.value;
}

export type RevalidateTarget = { all: true } | { all?: false; productIds: string[] };

export const windowStartMs = (nowMs: number, windowMs: number = CATALOG_REVALIDATE_POLICY.windowMs): number =>
  Math.floor(nowMs / windowMs) * windowMs;

export const revalidateEventKey = (windowStart: number, productId: string | null): string =>
  productId === null
    ? `${CATALOG_REVALIDATE_EVENT}:all:${windowStart}`
    : `${CATALOG_REVALIDATE_EVENT}:p:${windowStart}:${productId}`;

export interface WindowState {
  productIds: Set<string>;
  all: boolean;
}

/**
 * Kế hoạch thuần cho một lần ghi vào cửa sổ: dòng "cả catalog" (khi đã có thì không cần gì thêm, khi vượt trần thì thay
 * phần còn lại) và các sản phẩm MỚI (chưa có dòng trong cửa sổ).
 */
export function planWindow(
  state: WindowState,
  target: RevalidateTarget,
  maxProducts: number = CATALOG_REVALIDATE_POLICY.maxProductsPerWindow,
): { all: boolean; productIds: string[] } {
  if (state.all) return { all: false, productIds: [] };
  if (target.all === true) return { all: true, productIds: [] };
  const fresh = [...new Set(target.productIds.filter((id) => id !== "" && !state.productIds.has(id)))];
  if (fresh.length === 0) return { all: false, productIds: [] };
  if (state.productIds.size + fresh.length > maxProducts) return { all: true, productIds: [] };
  return { all: false, productIds: fresh };
}

interface OpenWindow extends WindowState {
  keys: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Cửa sổ ĐANG MỞ theo mốc. Lượt gửi gộp gỡ cửa sổ khỏi map (đồng bộ, trước mọi `await`) rồi làm việc trên bản chụp; dòng
 * ghi xong SAU đó (lượt xả có `await insertOutbox` vắt qua lúc gửi) được ghi nhận vào cửa sổ MỚI cùng mốc với lượt gửi
 * riêng — không bao giờ bị đánh dấu `sent` bởi webhook không mang tag của nó (review T-142).
 */
const windows = new Map<number, OpenWindow>();

function windowFor(start: number): OpenWindow {
  let w = windows.get(start);
  if (!w) {
    w = { productIds: new Set(), all: false, keys: new Set(), timer: null };
    windows.set(start, w);
  }
  return w;
}

export interface EnqueueOptions {
  now?: Date;
  /** Tiêm cấu hình (test); vắng → từ env. */
  config?: RevalidateConfig | null;
  /** false = không hẹn lượt gửi gộp cuối cửa sổ (test gọi `flushRevalidationWindow` tay). Mặc định true. */
  schedule?: boolean;
  /** Tiêm `fetch` cho lượt gửi gộp (test). */
  fetch?: typeof fetch;
}

/**
 * Ghi outbox cho thay đổi catalog (xem đầu file). Trả các khoá sự kiện vừa ghi (rỗng khi tắt hoặc đã có trong cửa sổ).
 * Lỗi ghi DB được ném cho người gọi — `notifyCatalogChanged` bọc để không làm hỏng lượt đồng bộ index.
 */
export async function enqueueCatalogRevalidation(
  container: MedusaContainer,
  target: RevalidateTarget,
  opts: EnqueueOptions = {},
): Promise<string[]> {
  const config = opts.config === undefined ? getRevalidateConfig() : opts.config;
  if (config === null) return [];
  const { windowMs, dispatchGraceMs } = CATALOG_REVALIDATE_POLICY;
  const nowMs = (opts.now ?? new Date()).getTime();
  const start = windowStartMs(nowMs, windowMs);
  const plan = planWindow(windowFor(start), target);
  const outbox = container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
  const dueAt = new Date(start + windowMs + dispatchGraceMs);
  const written: string[] = [];
  /** Ghi nhận SAU khi dòng đã ghi, vào cửa sổ đang mở của mốc này (lấy lại sau `await` — có thể đã được gửi). */
  const record = (key: string, productId: string | null) => {
    const w = windowFor(start);
    if (productId === null) w.all = true;
    else w.productIds.add(productId);
    w.keys.add(key);
    written.push(key);
    if (opts.schedule !== false && w.timer === null) {
      const fetchImpl = opts.fetch;
      w.timer = setTimeout(
        () => {
          void flushRevalidationWindow(container, start, { config, fetch: fetchImpl });
        },
        Math.max(0, start + windowMs - Date.now()),
      );
      w.timer.unref?.();
    }
  };
  try {
    if (plan.all) {
      const key = revalidateEventKey(start, null);
      await outbox.insertOutbox(key, "catalog", CATALOG_REVALIDATE_EVENT, { scope: "all" }, undefined, dueAt);
      record(key, null);
    }
    for (const id of plan.productIds) {
      const key = revalidateEventKey(start, id);
      await outbox.insertOutbox(
        key,
        id,
        CATALOG_REVALIDATE_EVENT,
        { scope: "product", product_id: id },
        undefined,
        dueAt,
      );
      // Lỗi giữa chừng → sản phẩm chưa ghi không được ghi nhận, lần sau trong cửa sổ ghi lại.
      record(key, id);
    }
  } finally {
    const w = windows.get(start);
    if (w && w.keys.size === 0 && w.timer === null) windows.delete(start);
  }
  return written;
}

/** Như `enqueueCatalogRevalidation` nhưng không bao giờ ném: lỗi chỉ ghi log (dòng chưa ghi = storefront dựa TTL). */
export async function notifyCatalogChanged(
  container: MedusaContainer,
  target: RevalidateTarget,
  opts: EnqueueOptions = {},
): Promise<void> {
  try {
    await enqueueCatalogRevalidation(container, target, opts);
  } catch (e) {
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(`[catalog-revalidate] Không ghi được outbox: ${(e as Error).message}`);
  }
}

/**
 * Tag cần làm mới cho các sản phẩm: `catalog:list` + `product:<handle>` mỗi sản phẩm (đọc handle HIỆN TẠI từ nguồn, kể cả
 * sản phẩm đã xoá). Handle không dựng được tag hoặc quá nhiều tag → `catalog` (làm mới cả catalog, không bỏ sót).
 */
export async function tagsForProducts(container: MedusaContainer, productIds: string[]): Promise<string[]> {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return [protocol.CATALOG_LIST_TAG];
  const products = await container
    .resolve(Modules.PRODUCT)
    .listProducts({ id: ids }, { select: ["id", "handle"], withDeleted: true, take: null });
  const tags = new Set<string>([protocol.CATALOG_LIST_TAG]);
  for (const p of products) {
    const tag = protocol.productTag(p.handle ?? "");
    if (tag === null) return [protocol.CATALOG_TAG];
    tags.add(tag);
  }
  return tags.size > protocol.REVALIDATE_MAX_TAGS ? [protocol.CATALOG_TAG] : [...tags];
}

/** Phản hồi không 2xx của storefront: `status` để `retryInfoOf` phân loại (4xx vĩnh viễn, 408/429/5xx tạm). */
export class RevalidateHttpError extends Error {
  override readonly name = "RevalidateHttpError";
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
  }
}

/** Mốc (Date.now) tới đó storefront coi như không trả lời — xem `unavailableCooldownMs`. Theo tiến trình. */
let unavailableUntil = 0;

/** Ngắt gửi khi storefront không trả lời: lỗi tạm thời (không `status`), `retryAfterMs` = thời gian ngắt còn lại. */
export class RevalidateUnavailableError extends Error {
  override readonly name = "RevalidateUnavailableError";
  constructor(readonly retryAfterMs: number) {
    super(`[catalog-revalidate] Storefront không trả lời gần đây — tạm ngưng gửi ${retryAfterMs} ms`);
  }
}

export interface SendDeps {
  fetch?: typeof fetch;
  now?: Date;
  nonce?: () => string;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "(url lỗi)";
  }
};

/**
 * POST webhook đã ký tới MỌI URL cấu hình (mỗi bản storefront một URL — cache của Next nằm trong từng tiến trình). Mỗi URL
 * một nonce/chữ ký riêng. Thành công khi mọi URL trả 2xx; không thì ném: còn URL lỗi tạm thời → ném lỗi tạm (retry gửi lại
 * cả lô — revalidate idempotent), chỉ còn lỗi vĩnh viễn → ném lỗi vĩnh viễn (outbox `dead`).
 */
export async function sendRevalidation(
  config: RevalidateConfig,
  input: { id: string; tags: string[] },
  deps: SendDeps = {},
): Promise<void> {
  const remaining = unavailableUntil - Date.now();
  if (remaining > 0) throw new RevalidateUnavailableError(remaining);
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? new Date();
  const makeNonce = deps.nonce ?? (() => randomBytes(18).toString("base64url"));
  const body = JSON.stringify({ id: input.id, tags: input.tags });
  const results = await Promise.allSettled(
    config.urls.map(async (url) => {
      const timestamp = String(msToSecondsFloor(now.getTime()));
      const nonce = makeNonce();
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [protocol.REVALIDATE_HEADERS.timestamp]: timestamp,
            [protocol.REVALIDATE_HEADERS.nonce]: nonce,
            [protocol.REVALIDATE_HEADERS.signature]: protocol.signRevalidate(
              config.secret,
              timestamp,
              nonce,
              body,
            ),
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(CATALOG_REVALIDATE_POLICY.requestTimeoutMs),
        });
      } catch (e) {
        // Mạng/timeout: không có status → `retryInfoOf` coi là tạm thời.
        throw new Error(`[catalog-revalidate] Không gửi được tới ${hostOf(url)}: ${(e as Error).message}`);
      }
      if (res.ok) return;
      throw new RevalidateHttpError(
        `[catalog-revalidate] ${hostOf(url)} trả ${res.status}`,
        res.status,
        parseRetryAfterMs(res.headers.get("retry-after"), now, CATALOG_REVALIDATE_POLICY.maxRetryAfterMs),
      );
    }),
  );
  const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason as Error] : []));
  // Chỉ lỗi KHÔNG có phản hồi (timeout, từ chối kết nối) mới ngắt: 4xx/5xx trả về nhanh, không giữ khe dispatcher.
  if (errors.some((e) => !(e instanceof RevalidateHttpError))) {
    unavailableUntil = Date.now() + CATALOG_REVALIDATE_POLICY.unavailableCooldownMs;
  } else if (errors.length === 0) unavailableUntil = 0;
  if (errors.length === 0) return;
  throw errors.find((e) => !(e instanceof RevalidateHttpError) || isTransientStatus(e.status)) ?? errors[0];
}

/**
 * Lượt gửi gộp cuối cửa sổ: một webhook cho mọi dòng của cửa sổ, thành công → đánh dấu các dòng `sent`. Lỗi → chỉ log;
 * dòng vẫn chờ dispatcher (đến hạn sau `dispatchGraceMs`). Đang tắt tiến trình → không gửi.
 */
export async function flushRevalidationWindow(
  container: MedusaContainer,
  start: number,
  deps: SendDeps & { config?: RevalidateConfig | null } = {},
): Promise<boolean> {
  // Gỡ + chụp ĐỒNG BỘ (trước mọi await): chỉ các khoá trong bản chụp được đánh dấu sent, và tag dựng từ đúng bản chụp đó.
  const win = windows.get(start);
  windows.delete(start);
  if (win?.timer) clearTimeout(win.timer);
  if (!win || win.keys.size === 0 || isDraining()) return false;
  const snap = { keys: [...win.keys], productIds: [...win.productIds], all: win.all };
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  try {
    const config = deps.config === undefined ? getRevalidateConfig() : deps.config;
    if (config === null) return false;
    const tags = snap.all ? [protocol.CATALOG_TAG] : await tagsForProducts(container, snap.productIds);
    await sendRevalidation(config, { id: `${CATALOG_REVALIDATE_EVENT}:w:${start}`, tags }, deps);
    const outbox = container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    for (const key of snap.keys) await outbox.markOutboxSentByKey(key);
    return true;
  } catch (e) {
    logger.warn(
      `[catalog-revalidate] Gửi gộp cửa sổ lỗi, ${snap.keys.length} sự kiện chờ outbox-dispatch: ${(e as Error).message}`,
    );
    return false;
  }
}

/**
 * Bộ xử lý outbox `catalog.revalidate` (đường dự phòng của dispatcher; khớp kiểu `OutboxHandler` của lib/checkout/jobs.ts —
 * không nhập kiểu đó để không tạo vòng phụ thuộc, jobs.ts nhập file này): gửi tag của MỘT dòng. Webhook đã tắt (bỏ khoá sau
 * khi dòng được ghi) → không còn gì để làm, coi như xong (storefront dựa TTL).
 */
export const catalogRevalidateHandler = async (
  container: MedusaContainer,
  event: OutboxClaim,
  ctx: { now: Date },
): Promise<void> => {
  const config = getRevalidateConfig();
  if (config === null) return;
  const tags =
    event.payload.scope === "all"
      ? [protocol.CATALOG_TAG]
      : await tagsForProducts(container, [String(event.payload.product_id)]);
  await sendRevalidation(config, { id: event.event_key, tags }, { now: ctx.now });
};

/** Chỉ cho test: xoá trạng thái cửa sổ + cấu hình đã nạp. */
export function resetRevalidateStateForTests(): void {
  for (const w of windows.values()) if (w.timer) clearTimeout(w.timer);
  windows.clear();
  cachedConfig = null;
  unavailableUntil = 0;
}
