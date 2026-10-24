import { randomUUID } from "node:crypto";
import { vnpay } from "@x-shop/domain";
import { CHECKOUT_CONFIG, getVnpayConfig, type VnpayRuntimeConfig } from "./config";

/**
 * Adapter gọi VNPAY từ server (đặc tả §9.2: createSession / queryStatus / verifyNotification). Ở đây chỉ `queryStatus`
 * (querydr); ký/xác minh nằm ở `@x-shop/domain` vnpay.*. Kết quả mơ hồ (timeout, lỗi mạng, chữ ký sai) LUÔN là
 * `unknown` — không bao giờ suy ra "chưa trả" (§7.3, AT11).
 */
export interface QueryStatusInput {
  txnRef: string;
  amount: number;
  /** Thời điểm tạo giao dịch (vnp_TransactionDate). */
  transactionDate: Date;
  orderInfo: string;
}

export interface QueryStatusResult {
  outcome: vnpay.QueryOutcome;
  transactionNo: string | null;
  reason: string;
}

export interface VnpayGateway {
  queryStatus(input: QueryStatusInput): Promise<QueryStatusResult>;
}

/** sandbox/live: POST JSON querydr tới VNPAY_API_URL, có hạn chờ. */
export class HttpVnpayGateway implements VnpayGateway {
  constructor(
    private readonly cfg: Pick<VnpayRuntimeConfig, "tmnCode" | "hashSecret" | "apiUrl">,
    private readonly timeoutMs: number = CHECKOUT_CONFIG.queryTimeoutMs,
    private readonly serverIp = "127.0.0.1",
  ) {}

  async queryStatus(input: QueryStatusInput): Promise<QueryStatusResult> {
    const body = vnpay.buildQueryDr(this.cfg, {
      requestId: randomUUID().replace(/-/g, "").slice(0, 32),
      ipAddr: this.serverIp,
      createdAt: new Date(),
      txnRef: input.txnRef,
      transactionDate: input.transactionDate,
      orderInfo: input.orderInfo,
    });
    let json: Record<string, unknown>;
    try {
      const res = await fetch(this.cfg.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return { outcome: "unknown", transactionNo: null, reason: `http_${res.status}` };
      json = (await res.json()) as Record<string, unknown>;
    } catch (e) {
      // DOMException (TimeoutError/AbortError) có thể đến từ realm khác → đọc `name` thay vì instanceof.
      const name = typeof e === "object" && e !== null ? String((e as { name?: unknown }).name) : "error";
      return {
        outcome: "unknown",
        transactionNo: null,
        reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
      };
    }
    return vnpay.interpretQueryResponse(this.cfg, json, { txnRef: input.txnRef, amount: input.amount });
  }
}

/** mock (dev/test): cổng giả lập cùng thuật toán ký — `pay()` ghi kết quả để querydr thấy. */
export class MockModeVnpayGateway implements VnpayGateway {
  readonly mock: vnpay.MockVnpayGateway;
  constructor(private readonly cfg: Pick<VnpayRuntimeConfig, "tmnCode" | "hashSecret">) {
    this.mock = new vnpay.MockVnpayGateway(cfg);
  }
  async queryStatus(input: QueryStatusInput): Promise<QueryStatusResult> {
    const res = this.mock.query(input.txnRef, input.amount);
    return vnpay.interpretQueryResponse(this.cfg, res, { txnRef: input.txnRef, amount: input.amount });
  }
}

let override: VnpayGateway | null = null;
let cached: VnpayGateway | null = null;

/** Gateway theo VNPAY_MODE (mặc định mock ở dev/test; production bắt buộc sandbox|live — kiểm ở env.ts). */
export function getVnpayGateway(): VnpayGateway | null {
  if (override) return override;
  if (cached) return cached;
  const cfg = getVnpayConfig();
  if (!cfg) return null;
  cached = cfg.mode === "mock" ? new MockModeVnpayGateway(cfg) : new HttpVnpayGateway(cfg);
  return cached;
}

/** Chỉ cho test: thay gateway (null = trở lại theo cấu hình). */
export function setVnpayGatewayForTest(gateway: VnpayGateway | null): void {
  override = gateway;
}
