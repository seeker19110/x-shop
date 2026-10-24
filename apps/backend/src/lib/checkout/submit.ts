import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { decideIdempotency, payloadHash, type AddressSnapshot } from "@x-shop/domain";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type { PaymentMethod } from "../../modules/checkout/models/constants";
import type CheckoutModuleService from "../../modules/checkout/service";
import { submitCheckoutWorkflow } from "../../workflows/checkout/submit-checkout";
import type { CheckoutContact } from "../../workflows/checkout/steps";
import { CHECKOUT_CONFIG } from "./config";
import {
  CheckoutError,
  readCheckoutError,
  RETRYABLE_CODES,
  type CheckoutErrorCode,
  type CheckoutErrorDetail,
} from "./errors";

/**
 * Điều phối submit (docs/design/checkout-flow.md §3 bước 1–3 + gọi workflow): idempotency theo (phạm vi giỏ, key) và
 * một attempt hoạt động cho mỗi phiên bản giỏ — cả hai là UNIQUE ở DB, ở đây chỉ đọc lại kết quả của bên thắng.
 */
export interface SubmitRequest {
  idempotency_key: string;
  cart_id: string;
  cart_version: number;
  quote_id: string;
  payment_method: PaymentMethod;
  contact: CheckoutContact;
  address: AddressSnapshot;
  customer_id: string | null;
  ip: string;
}

export interface AttemptView {
  checkout_attempt_id: string;
  state: "preparing" | "ready" | "failed" | "compensated";
  cart_id: string;
  cart_version: number;
  payment_method: string;
  order: null | {
    id: string;
    display_ref: string;
    state: string;
    total: number;
    payment_method: string;
    hold_expires_at: string | null;
    cod_confirm_by: string | null;
  };
  payment_url: string | null;
  error: null | { code: string; message: string };
}

export type SubmitOutcome =
  | { kind: "ok"; view: AttemptView }
  | { kind: "pending"; view: AttemptView }
  | { kind: "error"; error: CheckoutError; attemptId: string | null };

const service = (c: MedusaContainer) => c.resolve<CheckoutModuleService>(CHECKOUT_MODULE);

export const idempotencyScope = (cartId: string) => `checkout.submit:cart:${cartId}`;

/** Payload chuẩn hóa để băm (DATA01): đúng các trường quyết định đơn; không gồm IP/khách. */
export function submitPayloadHash(r: SubmitRequest): string {
  return payloadHash({
    cart_id: r.cart_id,
    cart_version: r.cart_version,
    quote_id: r.quote_id,
    payment_method: r.payment_method,
    contact: r.contact,
    address: { province_code: r.address.provinceCode, ward_code: r.address.wardCode, line: r.address.line },
  });
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export async function presentAttempt(
  container: MedusaContainer,
  attemptId: string,
): Promise<AttemptView | null> {
  const s = service(container);
  const [a] = await s.listCheckoutAttempts({ id: attemptId });
  if (!a) return null;
  let order: AttemptView["order"] = null;
  let paymentUrl: string | null = null;
  if (a.order_id) {
    const [fin] = await s.listOrderFinances({ order_id: a.order_id });
    if (fin) {
      order = {
        id: fin.order_id,
        display_ref: fin.display_ref,
        state: fin.state,
        total: fin.total,
        payment_method: fin.payment_method,
        hold_expires_at: iso(fin.hold_expires_at),
        cod_confirm_by: iso(fin.cod_confirm_by),
      };
    }
    const [pay] = await s.listPaymentAttempts({ order_id: a.order_id, state: ["pending", "created"] });
    paymentUrl = pay?.payment_url ?? null;
  }
  const detail = (a.error_detail ?? null) as { message?: string } | null;
  return {
    checkout_attempt_id: a.id,
    state: a.state,
    cart_id: a.cart_id,
    cart_version: a.cart_version,
    payment_method: a.payment_method,
    order,
    payment_url: paymentUrl,
    error: a.error_code ? { code: a.error_code, message: detail?.message ?? "" } : null,
  };
}

/** Lỗi đã lưu của attempt → đúng CheckoutError ban đầu (replay trả cùng kết quả). */
function storedError(code: string | null, detail: unknown): CheckoutError {
  const d = (detail ?? {}) as { message?: string; field?: string; detail?: CheckoutErrorDetail };
  const known = readCheckoutError({ x_checkout_error: true, code: code ?? "INTERNAL", ...d });
  return known ?? new CheckoutError("INTERNAL");
}

async function waitWhilePreparing(container: MedusaContainer, attemptId: string): Promise<void> {
  const deadline = Date.now() + CHECKOUT_CONFIG.replayWaitMs;
  while (Date.now() < deadline) {
    const [a] = await service(container).listCheckoutAttempts({ id: attemptId }, { select: ["id", "state"] });
    if (!a || a.state !== "preparing") return;
    await new Promise((r) => setTimeout(r, CHECKOUT_CONFIG.replayPollMs));
  }
}

/** Trả kết quả của một attempt đã có (replay/hai tab): chờ ngắn nếu đang chạy. */
async function outcomeOf(container: MedusaContainer, attemptId: string): Promise<SubmitOutcome> {
  await waitWhilePreparing(container, attemptId);
  const [a] = await service(container).listCheckoutAttempts({ id: attemptId });
  if (!a) return { kind: "error", error: new CheckoutError("INTERNAL"), attemptId };
  if (a.state === "failed")
    return { kind: "error", error: storedError(a.error_code, a.error_detail), attemptId };
  if (a.state === "compensated")
    return { kind: "error", error: new CheckoutError("ATTEMPT_ABORTED"), attemptId };
  const view = (await presentAttempt(container, attemptId)) as AttemptView;
  return a.state === "ready" ? { kind: "ok", view } : { kind: "pending", view };
}

/** Lỗi native (ngoài CheckoutError) được ánh xạ về mã ổn định khi rõ nghĩa. */
function classify(error: unknown): CheckoutError {
  const known = readCheckoutError(error);
  if (known) return known;
  const message =
    typeof error === "object" && error !== null ? String((error as { message?: unknown }).message) : "";
  if (/Not enough stock available|is not stocked at location/.test(message)) {
    return new CheckoutError("INSUFFICIENT_STOCK");
  }
  if (/Failed to acquire lock|Timed-out acquiring lock/.test(message)) return new CheckoutError("BUSY_RETRY");
  return new CheckoutError("INTERNAL");
}

async function runAttempt(
  container: MedusaContainer,
  attemptId: string,
  r: SubmitRequest,
): Promise<SubmitOutcome> {
  const { errors } = await submitCheckoutWorkflow(container).run({
    input: {
      attempt_id: attemptId,
      cart_id: r.cart_id,
      cart_version: r.cart_version,
      quote_id: r.quote_id,
      payment_method: r.payment_method,
      contact: r.contact,
      address: r.address,
      customer_id: r.customer_id,
      ip: r.ip,
    },
    throwOnError: false,
  });
  if (!errors || errors.length === 0) return outcomeOf(container, attemptId);
  const raw = errors[0]?.error;
  const error = classify(raw);
  if (error.code === "INTERNAL") {
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(`[checkout] attempt ${attemptId} lỗi hệ thống: ${JSON.stringify(raw)}`);
  }
  const stored = { message: error.message, field: error.field, detail: error.detail };
  const failedNow = await service(container).failAttempt(attemptId, error.code, stored);
  // Không chuyển được (vd job đối chiếu đã xử lý) → trả trạng thái thật của attempt.
  if (!failedNow) return outcomeOf(container, attemptId);
  return { kind: "error", error, attemptId };
}

export async function submitCheckout(container: MedusaContainer, r: SubmitRequest): Promise<SubmitOutcome> {
  const s = service(container);
  const scope = idempotencyScope(r.cart_id);
  const hash = submitPayloadHash(r);
  const leaseUntil = () => new Date(Date.now() + CHECKOUT_CONFIG.attemptLeaseMs);

  // Vòng nhỏ: mỗi lần va UNIQUE nghĩa là đã có bên thắng — vòng sau chắc chắn đọc thấy nó.
  for (let round = 0; round < 3; round++) {
    const [byKey] = await s.listCheckoutAttempts({
      idempotency_scope: scope,
      idempotency_key: r.idempotency_key,
    });
    if (byKey) {
      const decision = decideIdempotency({ payloadHash: byKey.payload_hash }, hash);
      if (decision === "conflict") {
        return { kind: "error", error: new CheckoutError("IDEMPOTENCY_CONFLICT"), attemptId: byKey.id };
      }
      if (
        byKey.state === "failed" &&
        RETRYABLE_CODES.includes(byKey.error_code as CheckoutErrorCode) &&
        (await s.reopenRetryableAttempt(byKey.id, RETRYABLE_CODES, leaseUntil()))
      ) {
        return runAttempt(container, byKey.id, r);
      }
      return outcomeOf(container, byKey.id);
    }

    // DATA02: phiên bản giỏ đã có checkout hoạt động (tab khác, key khác) → trả attempt đó, không tạo đơn thứ hai.
    const activeId = await s.findActiveAttemptId(r.cart_id, r.cart_version);
    if (activeId) return outcomeOf(container, activeId);

    const insertedId = await s.insertAttemptIfAbsent({
      cart_id: r.cart_id,
      cart_version: r.cart_version,
      idempotency_scope: scope,
      idempotency_key: r.idempotency_key,
      payload_hash: hash,
      quote_id: r.quote_id,
      payment_method: r.payment_method,
      lease_until: leaseUntil(),
    });
    if (insertedId) return runAttempt(container, insertedId, r);
  }
  return { kind: "error", error: new CheckoutError("BUSY_RETRY"), attemptId: null };
}
