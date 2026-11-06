import { hmacSha512, QUERY_RESPONSE_FIELDS, signData, toVnpDate, type VnpayConfig } from "./vnpay.js";

export type MockOutcome = "success" | "cancelled" | "failed";

/**
 * Giả lập VNPAY cho dev/CI theo cùng thuật toán ký (SPEC-payment §4) — không gọi mạng. Sinh query IPN/return đã ký,
 * phản hồi querydr đã ký; cho phép giả chữ ký sai/số tiền sai để test AT07.
 */
export class MockVnpayGateway {
  private seq = 0;
  private readonly results = new Map<string, { status: string; transactionNo: string; amount: number }>();

  constructor(private readonly cfg: Pick<VnpayConfig, "tmnCode" | "hashSecret">) {}

  /** Khách "trả" trên trang giả lập: ghi kết quả để querydr thấy, trả query IPN đã ký. */
  pay(
    paymentUrl: string,
    outcome: MockOutcome,
    opts: { payDate?: Date; tamperAmount?: number; badSignature?: boolean } = {},
  ): URLSearchParams {
    const url = new URL(paymentUrl);
    const txnRef = url.searchParams.get("vnp_TxnRef") ?? "";
    const amountRaw = Number(url.searchParams.get("vnp_Amount") ?? "0");
    this.seq += 1;
    const transactionNo = String(14_000_000 + this.seq);
    const status = outcome === "success" ? "00" : "02";
    const responseCode = outcome === "success" ? "00" : outcome === "cancelled" ? "24" : "51";
    this.results.set(txnRef, { status, transactionNo, amount: amountRaw / 100 });
    const params: Record<string, string> = {
      vnp_Amount: String(opts.tamperAmount !== undefined ? opts.tamperAmount * 100 : amountRaw),
      vnp_BankCode: "NCB",
      vnp_CardType: "ATM",
      vnp_OrderInfo: url.searchParams.get("vnp_OrderInfo") ?? "",
      vnp_PayDate: toVnpDate(opts.payDate ?? new Date()),
      vnp_ResponseCode: responseCode,
      vnp_TmnCode: this.cfg.tmnCode,
      vnp_TransactionNo: transactionNo,
      vnp_TransactionStatus: status,
      vnp_TxnRef: txnRef,
    };
    const sig = hmacSha512(opts.badSignature === true ? "sai-khoa" : this.cfg.hashSecret, signData(params));
    return new URLSearchParams({ ...params, vnp_SecureHash: sig });
  }

  /** Phản hồi querydr đã ký; giao dịch chưa có → status 01 (chưa hoàn tất). */
  query(txnRef: string, amount: number): Record<string, string> {
    const r = this.results.get(txnRef);
    const res: Record<string, string> = {
      vnp_ResponseId: `R${this.seq}`,
      vnp_Command: "querydr",
      vnp_ResponseCode: "00",
      vnp_Message: "QueryDR Success",
      vnp_TmnCode: this.cfg.tmnCode,
      vnp_TxnRef: txnRef,
      vnp_Amount: String((r?.amount ?? amount) * 100),
      vnp_BankCode: "NCB",
      vnp_PayDate: "",
      vnp_TransactionNo: r?.transactionNo ?? "",
      vnp_TransactionType: "01",
      vnp_TransactionStatus: r?.status ?? "01",
      vnp_OrderInfo: "",
      vnp_PromotionCode: "",
      vnp_PromotionAmount: "",
    };
    const data = QUERY_RESPONSE_FIELDS.map((k) => res[k] ?? "").join("|");
    return { ...res, vnp_SecureHash: hmacSha512(this.cfg.hashSecret, data) };
  }
}
