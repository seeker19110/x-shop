import { ghn, isNonEmpty } from "@x-shop/domain";
import { quoteShipping } from "../checkout/shipping";
import { getGhnConfig, SHIPPING_CONFIG, type GhnRuntimeConfig } from "./config";

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
 *  - `unavailable`: lỗi mạng/5xx/401/429 — thử lại sau;
 *  - `rejected`: hãng từ chối dứt khoát (4xx nghiệp vụ);
 *  - `not_served`: báo phí cho địa chỉ hãng không phục vụ.
 */
export type GhnErrorKind = "timeout" | "unavailable" | "rejected" | "not_served";

export class GhnError extends Error {
  override readonly name = "GhnError";
  constructor(
    readonly kind: GhnErrorKind,
    message: string,
  ) {
    super(message);
  }
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

/** sandbox/live: HTTP tới GHN_BASE_URL với Token + ShopId (chỉ server), có hạn chờ. */
export class HttpGhnClient implements GhnClient {
  readonly mode: GhnRuntimeConfig["mode"];
  constructor(
    private readonly cfg: GhnRuntimeConfig,
    private readonly timeoutMs: number = SHIPPING_CONFIG.requestTimeoutMs,
  ) {
    this.mode = cfg.mode;
  }

  private async call(
    path: string,
    body: unknown,
  ): Promise<{ status: number; code: number | null; data: unknown; message: string }> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Token: this.cfg.token,
          ShopId: this.cfg.shopId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const name = typeof e === "object" && e !== null ? String((e as { name?: unknown }).name) : "error";
      if (name === "TimeoutError" || name === "AbortError")
        throw new GhnError("timeout", `GHN ${path}: timeout`);
      throw new GhnError("unavailable", `GHN ${path}: lỗi mạng`);
    }
    if (res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 429) {
      throw new GhnError("unavailable", `GHN ${path}: http_${res.status}`);
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
    const r = await this.call("/v2/shipping-order/fee", ghn.buildFeeBody(input));
    if (!this.isOk(r)) throw new GhnError("not_served", `GHN không báo được phí: ${r.message}`);
    const total = intOrNull((r.data as Record<string, unknown> | null)?.total);
    if (total === null) throw new GhnError("unavailable", "GHN trả phí không hợp lệ");
    return { fee: total, service: SHIPPING_CONFIG.service };
  }

  async createOrder(input: ghn.CreateShipmentInput): Promise<GhnCreated> {
    const r = await this.call("/v2/shipping-order/create", ghn.buildCreateOrderBody(input));
    if (!this.isOk(r)) throw new GhnError("rejected", `GHN từ chối tạo vận đơn: ${r.message}`);
    const data = (r.data ?? {}) as Record<string, unknown>;
    if (typeof data.order_code !== "string") throw new GhnError("timeout", "GHN không trả mã vận đơn");
    return { orderCode: data.order_code, fee: intOrNull(data.total_fee) };
  }

  async detail(orderCode: string): Promise<GhnDetail | null> {
    const r = await this.call("/v2/shipping-order/detail", { order_code: orderCode });
    if (!this.isOk(r)) return null;
    return toDetail((r.data ?? {}) as Record<string, unknown>);
  }

  async detailByClientCode(clientOrderCode: string): Promise<GhnDetail | null> {
    const r = await this.call("/v2/shipping-order/detail-by-client-code", {
      client_order_code: clientOrderCode,
    });
    if (!this.isOk(r)) return null;
    return toDetail((r.data ?? {}) as Record<string, unknown>);
  }

  async cancel(orderCode: string): Promise<void> {
    const r = await this.call("/v2/switch-status/cancel", { order_codes: [orderCode] });
    if (!this.isOk(r)) throw new GhnError("rejected", `GHN từ chối hủy: ${r.message}`);
  }
}

export type MockCreateFault = "timeout_after_commit" | "timeout_before_commit" | "unavailable";

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
