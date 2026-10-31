import { vnpay, isNonEmpty } from "@x-shop/domain";
import { getVnpayConfig } from "../../lib/checkout/config";

/**
 * Cổng hoàn tiền (đặc tả §9.2 refund, §6.5): mọi lần gửi/hỏi lại của MỘT refund dùng cùng `requestId` — timeout thì
 * HỎI LẠI cùng nghiệp vụ, không tạo refund mới (AT16). Kết quả mơ hồ luôn là `unknown`, không bao giờ suy ra thất bại.
 *
 * Phạm vi T-027: chỉ có bản giả lập (VNPAY_MODE=mock, dev/CI) dựng thân request bằng `vnpay.buildRefund` của domain.
 * Ủy quyền hiện tại không cho gọi refund thật → ở sandbox/live cổng bị TẮT (fail-closed): `auto` tự chọn `manual`, tạo
 * `provider` trả 409 REFUND_PROVIDER_DISABLED; yêu cầu `provider` có từ trước → `failed` chưa gửi, hủy được (T-169). Kế
 * toán hoàn `manual` có chứng từ. Bật HTTP thật là việc riêng khi có ủy quyền.
 */
export interface ProviderRefundRequest {
  requestId: string;
  txnRef: string;
  transactionNo: string;
  /** `vnp_TransactionDate` = `vnp_CreateDate` của URL thanh toán gốc (T-170, `transactionDateOf()`). */
  transactionDate: Date;
  amount: number;
  /** Hoàn toàn phần giao dịch (VNPAY `02`) hay một phần (`03`). */
  full: boolean;
  createdBy: string;
  orderInfo: string;
}

export interface ProviderRefundResult {
  outcome: "succeeded" | "failed" | "unknown";
  providerRef: string | null;
  reason: string;
}

export interface RefundGateway {
  readonly enabled: boolean;
  refund(req: ProviderRefundRequest): Promise<ProviderRefundResult>;
  /** Hỏi kết quả của CÙNG requestId; `not_found` = cổng chưa từng nhận yêu cầu này (gửi lại an toàn). */
  query(req: ProviderRefundRequest): Promise<ProviderRefundResult | { outcome: "not_found"; reason: string }>;
}

export type MockRefundFault = "timeout_after_commit" | "timeout_before_commit" | "fail";

/**
 * Cổng hoàn tiền giả lập: ghi theo requestId (gửi lại cùng mã → cùng kết quả, KHÔNG hoàn thêm), kiểm thân request đúng
 * protocol (`vnp_Command=refund`, `vnp_Amount = VND × 100`, loại 02/03), từ chối hoàn vượt số tiền giao dịch.
 */
export class MockVnpayRefundGateway implements RefundGateway {
  readonly enabled = true;
  /** Lỗi cho các lần gửi kế tiếp (FIFO). */
  readonly faults: MockRefundFault[] = [];
  /** requestId → bản ghi hoàn đã thực hiện ở "cổng". */
  readonly executed = new Map<string, { txnRef: string; amount: number; providerRef: string }>();
  /** Số tiền giao dịch gốc theo txnRef (test đặt) — để từ chối hoàn vượt như cổng thật. */
  readonly captured = new Map<string, number>();
  readonly bodies: Array<Record<string, string>> = [];
  calls = 0;
  private seq = 0;

  constructor(private readonly cfg: Pick<vnpay.VnpayConfig, "tmnCode" | "hashSecret">) {}

  /** Tổng đã hoàn thật ở "cổng" (mọi requestId). */
  totalRefunded(txnRef?: string): number {
    let total = 0;
    for (const r of this.executed.values()) if (!isNonEmpty(txnRef) || r.txnRef === txnRef) total += r.amount;
    return total;
  }

  async refund(req: ProviderRefundRequest): Promise<ProviderRefundResult> {
    this.calls += 1;
    const body = vnpay.buildRefund(this.cfg, {
      requestId: req.requestId,
      ipAddr: "127.0.0.1",
      createdAt: new Date(),
      txnRef: req.txnRef,
      amount: req.amount,
      full: req.full,
      transactionNo: req.transactionNo,
      transactionDate: req.transactionDate,
      createdBy: req.createdBy,
      orderInfo: req.orderInfo,
    });
    this.bodies.push(body);
    if (
      body.vnp_Command !== "refund" ||
      body.vnp_Amount !== String(req.amount * 100) ||
      !/^[0-9a-f]{128}$/.test(body.vnp_SecureHash ?? "")
    ) {
      return { outcome: "failed", providerRef: null, reason: "invalid_request" };
    }
    const fault = this.faults.shift();
    if (fault === "timeout_before_commit")
      return { outcome: "unknown", providerRef: null, reason: "timeout" };
    if (fault === "fail") return { outcome: "failed", providerRef: null, reason: "response_94" };
    const prior = this.executed.get(req.requestId);
    if (prior) {
      return fault === "timeout_after_commit"
        ? { outcome: "unknown", providerRef: null, reason: "timeout" }
        : { outcome: "succeeded", providerRef: prior.providerRef, reason: "duplicate_request" };
    }
    const cap = this.captured.get(req.txnRef);
    if (cap !== undefined && this.totalRefunded(req.txnRef) + req.amount > cap) {
      return { outcome: "failed", providerRef: null, reason: "exceeds_transaction" };
    }
    this.seq += 1;
    const providerRef = `MRF${String(90_000_000 + this.seq)}`;
    this.executed.set(req.requestId, { txnRef: req.txnRef, amount: req.amount, providerRef });
    if (fault === "timeout_after_commit") return { outcome: "unknown", providerRef: null, reason: "timeout" };
    return { outcome: "succeeded", providerRef, reason: "response_00" };
  }

  async query(
    req: ProviderRefundRequest,
  ): Promise<ProviderRefundResult | { outcome: "not_found"; reason: string }> {
    const r = this.executed.get(req.requestId);
    if (!r) return { outcome: "not_found", reason: "no_such_request" };
    return { outcome: "succeeded", providerRef: r.providerRef, reason: "query_00" };
  }
}

/** sandbox/live khi chưa có ủy quyền refund thật: không gọi mạng, báo tắt trước khi đổi trạng thái. */
export class DisabledRefundGateway implements RefundGateway {
  readonly enabled = false;
  async refund(): Promise<ProviderRefundResult> {
    return { outcome: "failed", providerRef: null, reason: "provider_disabled" };
  }
  async query(): Promise<{ outcome: "not_found"; reason: string }> {
    return { outcome: "not_found", reason: "provider_disabled" };
  }
}

let override: RefundGateway | null = null;
let cached: RefundGateway | null = null;

export function getRefundGateway(): RefundGateway {
  if (override) return override;
  if (cached) return cached;
  const cfg = getVnpayConfig();
  cached = cfg && cfg.mode === "mock" ? new MockVnpayRefundGateway(cfg) : new DisabledRefundGateway();
  return cached;
}

/** Chỉ cho test: thay cổng hoàn tiền (null = trở lại theo cấu hình). */
export function setRefundGatewayForTest(gateway: RefundGateway | null): void {
  override = gateway;
}
