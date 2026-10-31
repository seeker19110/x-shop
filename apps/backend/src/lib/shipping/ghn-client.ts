import { ghn, isNonEmpty, secondsToMs } from "@x-shop/domain";
import { quoteShipping } from "../checkout/shipping";
import { parseRetryAfterMs, withRetry, type RetryDecision, type RetryDeps } from "../outbox/retry";
import { getGhnConfig, GHN_RETRY_POLICY, SHIPPING_CONFIG, type GhnRuntimeConfig } from "./config";

/**
 * Adapter GHN phía server (đặc tả §6.4, §9.3): báo phí, tạo/tra/hủy vận đơn. Body/ánh xạ trạng thái nằm ở
 * `@x-shop/domain` ghn.*; ở đây chỉ vận chuyển HTTP + phân loại lỗi.
 *
 * CHƯA XÁC MINH với tài liệu GHN (developer.ghn.vn trả 403 khi nghiên cứu 2026-10-24, docs/research mục 7): đường dẫn
 * `/v2/shipping-order/{fee,create,detail,detail-by-client-code}`, `/v2/switch-status/cancel`, header `Token`/`ShopId`,
 * phong bì `{code, message, data}`. Đối chiếu khi có token sandbox (RK-006).
 *
 * Phân loại lỗi — kết quả mơ hồ KHÔNG bao giờ được coi là "chưa tạo":
 *  - `timeout`: không biết hãng đã ghi hay chưa → caller tra theo client_order_code trước khi gửi lại (S-303, AT11);
 *  - `unavailable`: lỗi mạng/5xx/401/403/408/429 — thử lại sau (`status` giữ mã HTTP, `retryAfterMs` giữ `Retry-After`
 *    đã kẹp của 429/503 để caller/outbox hẹn đúng lúc);
 *  - `rejected`: hãng từ chối dứt khoát (4xx nghiệp vụ);
 *  - `not_served`: báo phí cho địa chỉ hãng không phục vụ.
 *
 * Retry phía dịch vụ (T-093 — BE-REL-003, BE-INT-007): `withRetry` tối đa 3 lần, backoff mũ + full jitter, trần tổng
 * thời gian chờ (`GHN_RETRY_POLICY`), tôn trọng `Retry-After`. Thao tác idempotent (báo phí, tra cứu) retry lỗi tạm
 * (5xx/408/lỗi mạng/429 có `Retry-After`); tạo/hủy vận đơn (không idempotent) CHỈ retry 429 có `Retry-After` — coi là
 * hãng chưa xử lý theo ngữ nghĩa RFC 6585 §4; hành vi thật của GHN với 429 (chưa xác minh — docs/research mục 7).
 * Timeout không retry tự động mà tra lại theo client_order_code (S-303). 401/403 (sai token) và 429 không kèm
 * `Retry-After` không retry ngay.
 *
 * Idempotency-Key: tài liệu GHN đã nghiên cứu (docs/research/2026-10-24-stack.md mục 7) KHÔNG nêu header idempotency nào
 * → KHÔNG gửi `Idempotency-Key` (không bịa header). Khoá idempotency tự nhiên là `client_order_code` = `<display_ref>-S1`
 * (dẫn xuất từ đơn, giống nhau ở mọi lần thử lại/đối soát) + tra `detail-by-client-code` trước khi gửi lại.
 */
export type GhnErrorKind = "timeout" | "unavailable" | "rejected" | "not_served";

export class GhnError extends Error {
  override readonly name = "GhnError";
  /** Mã HTTP của hãng (null = không có phản hồi HTTP: timeout, lỗi mạng, phong bì nghiệp vụ). */
  readonly status: number | null;
  /** `Retry-After` của hãng (ms, đã kẹp) — null = không có/giá trị lạ. */
  readonly retryAfterMs: number | null;
  constructor(
    readonly kind: GhnErrorKind,
    message: string,
    opts: { status?: number | null; retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.status = opts.status ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }

  /** Từ chối dứt khoát (4xx nghiệp vụ / địa chỉ không phục vụ) — thử lại không đổi được kết quả. */
  get permanent(): boolean {
    return this.kind === "rejected" || this.kind === "not_served";
  }
}

/** Quyết định retry cho lỗi GHN (xem đầu file). */
export function classifyGhnError(e: unknown): RetryDecision {
  if (!(e instanceof GhnError) || e.permanent) return { retry: false };
  if (e.status === 429) {
    return e.retryAfterMs === null
      ? { retry: false }
      : { retry: true, processed: "no", retryAfterMs: e.retryAfterMs };
  }
  if (e.status === 401 || e.status === 403) return { retry: false };
  return { retry: true, processed: "maybe", retryAfterMs: e.retryAfterMs };
}

export interface GhnFee {
  fee: number;
  service: string;
}

export interface GhnCreated {
  orderCode: string;
  /** Phí hãng thu của shop cho vận đơn (null khi hãng không trả). */
  fee: number | null;
}

/** Chi tiết vận đơn do API có xác thực trả — nguồn tin duy nhất để đổi trạng thái (S-305). */
export interface GhnDetail {
  orderCode: string;
  clientOrderCode: string | null;
  status: string;
  codAmount: number | null;
}

export interface GhnClient {
  readonly mode: GhnRuntimeConfig["mode"];
  quoteFee(input: ghn.FeeInput): Promise<GhnFee>;
  createOrder(input: ghn.CreateShipmentInput): Promise<GhnCreated>;
  detail(orderCode: string): Promise<GhnDetail | null>;
  detailByClientCode(clientOrderCode: string): Promise<GhnDetail | null>;
  cancel(orderCode: string): Promise<void>;
}

const intOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

function toDetail(data: Record<string, unknown>): GhnDetail | null {
  const orderCode = typeof data.order_code === "string" ? data.order_code : null;
  const status = typeof data.status === "string" ? data.status : null;
  if (!isNonEmpty(orderCode) || !isNonEmpty(status)) return null;
  return {
    orderCode,
    clientOrderCode: typeof data.client_order_code === "string" ? data.client_order_code : null,
    status,
    codAmount: intOrNull(data.cod_amount),
  };
}

/** Ghép URL GHN; chỉ chấp nhận http(s) (cấu hình đã qua zod khi khởi động — kiểm lại tại điểm gửi). */
function ghnUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const protocol = new URL(base).protocol;
  if (protocol !== "https:" && protocol !== "http:") throw new Error("[ghn] baseUrl phải là http(s)");
  return `${base}${path}`;
}

/** sandbox/live: HTTP tới GHN_BASE_URL với Token + ShopId (chỉ server), có hạn chờ. */
export class HttpGhnClient implements GhnClient {
  readonly mode: GhnRuntimeConfig["mode"];
  constructor(
    private readonly cfg: GhnRuntimeConfig,
    private readonly timeoutMs: number = SHIPPING_CONFIG.requestTimeoutMs,
    /** Chỉ cho test: tiêm sleep/đồng hồ/RNG của retry. */
    private readonly retryDeps: RetryDeps = {},
  ) {
    this.mode = cfg.mode;
  }

  /**
   * Một lời gọi qua chính sách retry. Trần tổng thời gian chờ không vượt một lần timeout: lần gọi đã treo tới timeout thì
   * không "đốt" thêm hạn chờ của request phía trên.
   */
  private call(
    path: string,
    body: unknown,
    idempotent: boolean,
  ): Promise<{ status: number; code: number | null; data: unknown; message: string }> {
    return withRetry(() => this.callOnce(path, body), {
      policy: {
        ...GHN_RETRY_POLICY,
        totalBudgetMs: Math.min(GHN_RETRY_POLICY.totalBudgetMs, this.timeoutMs),
      },
      idempotent,
      classify: classifyGhnError,
      ...this.retryDeps,
    });
  }

  private async callOnce(
    path: string,
    body: unknown,
  ): Promise<{ status: number; code: number | null; data: unknown; message: string }> {
    let res: Response;
    try {
      res = await fetch(ghnUrl(this.cfg.baseUrl, path), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Token: this.cfg.token,
          ShopId: this.cfg.shopId,
        },
        // CodeQL js/file-access-to-http: báo nhầm. "File data" duy nhất trong luồng là bộ dữ liệu hành chính đóng gói trong
        // repo (packages/domain/data/vn-admin-units.json, readFileSync lúc nạp module) — nguồn tin cậy, không do người dùng
        // kiểm soát. Điểm đến là GHN_BASE_URL đã qua zod khi khởi động, không lấy từ file.
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const name = typeof e === "object" && e !== null ? String((e as { name?: unknown }).name) : "error";
      if (name === "TimeoutError" || name === "AbortError")
        throw new GhnError("timeout", `GHN ${path}: timeout`);
      throw new GhnError("unavailable", `GHN ${path}: lỗi mạng`);
    }
    if (
      res.status >= 500 ||
      res.status === 401 ||
      res.status === 403 ||
      res.status === 408 ||
      res.status === 429
    ) {
      const retryAfterMs =
        res.status === 429 || res.status === 503
          ? parseRetryAfterMs(res.headers.get("retry-after"), new Date(), GHN_RETRY_POLICY.maxRetryAfterMs)
          : null;
      throw new GhnError("unavailable", `GHN ${path}: http_${res.status}`, {
        status: res.status,
        retryAfterMs,
      });
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      if (res.ok) throw new GhnError("unavailable", `GHN ${path}: phản hồi không phải JSON`);
    }
    // Không đưa nguyên văn phản hồi vào lỗi (có thể chứa dữ liệu người nhận) — chỉ mã + thông điệp ngắn.
    return {
      status: res.status,
      code: typeof json.code === "number" ? json.code : null,
      data: json.data ?? null,
      message: typeof json.message === "string" ? json.message.slice(0, 200) : "",
    };
  }

  private isOk(r: { status: number; code: number | null }): boolean {
    return r.status === 200 && (r.code === null || r.code === 200);
  }

  async quoteFee(input: ghn.FeeInput): Promise<GhnFee> {
    const r = await this.call("/v2/shipping-order/fee", ghn.buildFeeBody(input), true);
    if (!this.isOk(r)) throw new GhnError("not_served", `GHN không báo được phí: ${r.message}`);
    const total = intOrNull((r.data as Record<string, unknown> | null)?.total);
    if (total === null) throw new GhnError("unavailable", "GHN trả phí không hợp lệ");
    return { fee: total, service: SHIPPING_CONFIG.service };
  }

  async createOrder(input: ghn.CreateShipmentInput): Promise<GhnCreated> {
    const r = await this.call("/v2/shipping-order/create", ghn.buildCreateOrderBody(input), false);
    if (!this.isOk(r)) throw new GhnError("rejected", `GHN từ chối tạo vận đơn: ${r.message}`);
    const data = (r.data ?? {}) as Record<string, unknown>;
    if (typeof data.order_code !== "string") throw new GhnError("timeout", "GHN không trả mã vận đơn");
    return { orderCode: data.order_code, fee: intOrNull(data.total_fee) };
  }

  async detail(orderCode: string): Promise<GhnDetail | null> {
    const r = await this.call("/v2/shipping-order/detail", { order_code: orderCode }, true);
    if (!this.isOk(r)) return null;
    return toDetail((r.data ?? {}) as Record<string, unknown>);
  }

  async detailByClientCode(clientOrderCode: string): Promise<GhnDetail | null> {
    const r = await this.call(
      "/v2/shipping-order/detail-by-client-code",
      { client_order_code: clientOrderCode },
      true,
    );
    if (!this.isOk(r)) return null;
    return toDetail((r.data ?? {}) as Record<string, unknown>);
  }

  async cancel(orderCode: string): Promise<void> {
    const r = await this.call("/v2/switch-status/cancel", { order_codes: [orderCode] }, false);
    if (!this.isOk(r)) throw new GhnError("rejected", `GHN từ chối hủy: ${r.message}`);
  }
}

export type MockCreateFault =
  "timeout_after_commit" | "timeout_before_commit" | "unavailable" | "rate_limited";

/** `Retry-After` giả lập của fault `rate_limited` (giây). */
export const MOCK_RATE_LIMIT_RETRY_AFTER_SECONDS = 30;

/**
 * mock (dev/test): bọc `MockGhn` của domain (idempotent theo client_order_code). Phí = bảng phí P0
 * (`quoteShipping`) để tổng đơn ở dev/test ổn định. Có núm điều khiển cho test: phường không phục vụ, lỗi một lần
 * khi tạo, API tra cứu sập, độ trễ.
 */
export class MockModeGhnClient implements GhnClient {
  readonly mode = "mock" as const;
  readonly mock = new ghn.MockGhn();
  readonly unservedWards = new Set<string>();
  /** Lỗi cho các lần tạo kế tiếp (FIFO, mỗi phần tử dùng một lần). */
  readonly createFaults: MockCreateFault[] = [];
  /** Số lần tra cứu kế tiếp sẽ ném `unavailable`. */
  detailFailures = 0;
  createDelayMs = 0;
  createCalls = 0;
  lastCreateBody: Record<string, unknown> | null = null;

  async quoteFee(input: ghn.FeeInput): Promise<GhnFee> {
    ghn.buildFeeBody(input);
    if (this.unservedWards.has(input.to.wardCode)) {
      throw new GhnError("not_served", "GHN không phục vụ địa chỉ này");
    }
    return { fee: quoteShipping(input.to, input.weightGrams).fee, service: SHIPPING_CONFIG.service };
  }

  async createOrder(input: ghn.CreateShipmentInput): Promise<GhnCreated> {
    this.createCalls += 1;
    const body = ghn.buildCreateOrderBody(input);
    if (this.createDelayMs > 0) await new Promise((r) => setTimeout(r, this.createDelayMs));
    const fault = this.createFaults.shift();
    if (fault === "timeout_before_commit") throw new GhnError("timeout", "GHN mock: timeout (chưa ghi)");
    if (fault === "unavailable") throw new GhnError("unavailable", "GHN mock: sập");
    if (fault === "rate_limited") {
      throw new GhnError("unavailable", "GHN mock: http_429", {
        status: 429,
        retryAfterMs: secondsToMs(MOCK_RATE_LIMIT_RETRY_AFTER_SECONDS),
      });
    }
    this.lastCreateBody = body;
    const r = this.mock.create(input);
    if (fault === "timeout_after_commit") throw new GhnError("timeout", "GHN mock: timeout (đã ghi)");
    return { orderCode: r.orderCode, fee: quoteShipping(input.to.address, input.weightGrams).fee };
  }

  private find(pred: (clientCode: string, orderCode: string) => boolean): GhnDetail | null {
    if (this.detailFailures > 0) {
      this.detailFailures -= 1;
      throw new GhnError("unavailable", "GHN mock: API tra cứu sập");
    }
    for (const [clientOrderCode, o] of this.mock.orders) {
      if (pred(clientOrderCode, o.orderCode)) {
        return { orderCode: o.orderCode, clientOrderCode, status: o.status, codAmount: o.codAmount };
      }
    }
    return null;
  }

  async detail(orderCode: string): Promise<GhnDetail | null> {
    return this.find((_, code) => code === orderCode);
  }

  async detailByClientCode(clientOrderCode: string): Promise<GhnDetail | null> {
    return this.find((client) => client === clientOrderCode);
  }

  async cancel(orderCode: string): Promise<void> {
    const found = await this.detail(orderCode);
    if (!found) throw new GhnError("rejected", "GHN mock: không có vận đơn");
    if (isNonEmpty(found.clientOrderCode)) this.mock.setStatus(found.clientOrderCode, "cancel");
  }

  /** Giả lập hãng đổi trạng thái (theo mã vận đơn của hãng). */
  setStatusByOrderCode(orderCode: string, status: string): void {
    for (const [client, o] of this.mock.orders)
      if (o.orderCode === orderCode) this.mock.setStatus(client, status);
  }
}

let override: GhnClient | null = null;
let cached: GhnClient | null = null;

/** Client theo GHN_MODE (mặc định mock ở dev/test; production bắt buộc sandbox|live — kiểm ở env.ts). */
export function getGhnClient(): GhnClient {
  if (override) return override;
  if (cached) return cached;
  const cfg = getGhnConfig();
  cached = cfg.mode === "mock" ? new MockModeGhnClient() : new HttpGhnClient(cfg);
  return cached;
}

/** Chỉ cho test: thay client (null = trở lại theo cấu hình). */
export function setGhnClientForTest(client: GhnClient | null): void {
  override = client;
}
