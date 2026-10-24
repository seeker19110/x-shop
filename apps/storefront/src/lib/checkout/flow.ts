import type {
  ChangedCode,
  PlacedOrder,
  PollResult,
  QuoteView,
  StockShortage,
  SubmitInput,
  SubmitResult,
} from "./types";

/**
 * Điều phối một lần bấm "Đặt hàng": gửi submit, thử lại có giới hạn khi BUSY_RETRY (CÙNG khóa), poll khi 202, và quy
 * mọi kết cục về một giá trị để UI hiển thị. Không phụ thuộc React/mạng (deps được truyền vào) → test được bằng giờ giả.
 */
export interface FlowDeps {
  submit(input: SubmitInput): Promise<SubmitResult>;
  poll(attemptId: string): Promise<PollResult>;
  sleep(ms: number): Promise<void>;
}

export interface FlowOptions {
  /** Số lần thử lại tối đa khi server báo bận (cùng khóa). */
  maxBusyRetries: number;
  pollIntervalMs: number;
  /** Số lần poll tối đa khi 202 trước khi báo "đang xử lý, đừng đặt lại". */
  maxPolls: number;
  /** Số lần poll liên tiếp gặp lỗi mạng trước khi dừng. */
  maxPollNetworkErrors: number;
}

export const DEFAULT_FLOW: FlowOptions = {
  maxBusyRetries: 3,
  pollIntervalMs: 1500,
  maxPolls: 20,
  maxPollNetworkErrors: 3,
};

export type FlowOutcome =
  | ({ kind: "placed" } & PlacedOrder)
  | { kind: "changed"; code: ChangedCode; message: string; quote: QuoteView | null }
  | { kind: "stock"; message: string; lines: StockShortage[] }
  | { kind: "error"; code: string; message: string; field?: string; newKey: boolean }
  /** Hết lượt thử vì bận: giữ khóa, khách bấm lại. */
  | { kind: "busy" }
  /** Mất kết nối: giữ khóa và dữ liệu, bấm lại an toàn (không tạo đơn trùng). */
  | { kind: "network" }
  /** Đơn vẫn đang được xử lý sau khi poll hết lượt: có mã tham chiếu, KHÔNG đặt lại. */
  | { kind: "processing"; attemptId: string };

export async function runSubmit(
  deps: FlowDeps,
  input: SubmitInput,
  options: Partial<FlowOptions> = {},
): Promise<FlowOutcome> {
  const opt = { ...DEFAULT_FLOW, ...options };
  let r: SubmitResult = await deps.submit(input);
  for (let retry = 0; r.kind === "busy"; retry++) {
    if (retry >= opt.maxBusyRetries) return { kind: "busy" };
    await deps.sleep(r.retryAfterMs);
    r = await deps.submit(input); // cùng Idempotency-Key
  }
  switch (r.kind) {
    case "placed":
    case "changed":
    case "stock":
    case "error":
    case "network":
      return r;
    case "pending":
      return pollUntilDone(deps, r.attemptId, opt);
    default:
      return { kind: "network" };
  }
}

async function pollUntilDone(deps: FlowDeps, attemptId: string, opt: FlowOptions): Promise<FlowOutcome> {
  let networkErrors = 0;
  for (let i = 0; i < opt.maxPolls; i++) {
    await deps.sleep(opt.pollIntervalMs);
    const p = await deps.poll(attemptId);
    if (p.kind === "placed") return p;
    if (p.kind === "failed") return { kind: "error", code: p.code, message: p.message, newKey: true };
    if (p.kind === "network") {
      networkErrors++;
      if (networkErrors >= opt.maxPollNetworkErrors) return { kind: "processing", attemptId };
    } else networkErrors = 0;
  }
  return { kind: "processing", attemptId };
}
