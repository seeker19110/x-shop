"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { track } from "../../lib/analytics/track";
import { finishCheckout, pollCheckout, quoteCheckout, submitCheckout } from "../../lib/checkout/actions";
import { runSubmit, type FlowDeps, type FlowOutcome } from "../../lib/checkout/flow";
import { createKeyKeeper } from "../../lib/checkout/idempotency";
import type { PaymentMethod, QuoteView, StockShortage } from "../../lib/checkout/types";
import {
  addressComplete,
  firstErrorField,
  normalizePhone,
  normalizeText,
  validateForm,
  type FieldErrors,
  type FieldName,
} from "../../lib/checkout/validate";
import { formatVnd } from "../../lib/format-vnd";
import { Button } from "../ui/Button";
import styles from "./Checkout.module.css";
import { Field } from "./Field";
import { OrderLines, type CheckoutLine } from "./OrderLines";
import { PAYMENT_LABEL, Totals } from "./Totals";
import { fetchWithRetry } from "../../lib/http/retry";
import { isNonEmpty } from "../../lib/presence";

export interface CheckoutFormProps {
  lines: readonly CheckoutLine[];
  /** Tiền hàng của giỏ do server trả. */
  subtotal: number;
  provinces: readonly { code: string; name: string }[];
}

type WardsState =
  | { code: string; status: "idle" | "loading" | "error"; list: [] }
  | { code: string; status: "ready"; list: { code: string; name: string }[] };

type Banner =
  | { kind: "changed"; message: string; from: number | null; to: number | null; cart: boolean }
  | { kind: "stock"; message: string; lines: StockShortage[] }
  | { kind: "error"; message: string; cart: boolean }
  | { kind: "network" }
  | { kind: "busy" }
  | { kind: "unavailable" }
  | { kind: "processing"; attemptId: string };

const QUOTE_DEBOUNCE_MS = 500;
const REAL_SLEEP = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Chỉ chuyển hướng tới http(s) — URL thanh toán do server cấp nhưng vẫn không tin tuyệt đối. */
export function safePaymentUrl(url: string | null): string | null {
  if (!isNonEmpty(url)) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Checkout MỘT trang (CHK02–CHK06, S-504): liên hệ → giao hàng → thanh toán; mua không cần tài khoản; tổng tiền do
 * server báo giá và luôn thấy ngay trước nút đặt hàng; đặt hàng với Idempotency-Key một lần cho mỗi lần xác nhận.
 * Dữ liệu form chỉ ở state của trang (không localStorage); lỗi mạng giữ nguyên dữ liệu và khóa để thử lại an toàn.
 */
export function CheckoutForm({ lines, subtotal, provinces }: CheckoutFormProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [provinceCode, setProvinceCode] = useState("");
  const [wardCode, setWardCode] = useState("");
  const [line, setLine] = useState("");
  const [payment, setPayment] = useState<PaymentMethod>("cod");
  const [discountInput, setDiscountInput] = useState("");
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  const [wards, setWards] = useState<WardsState | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [quoteSig, setQuoteSig] = useState<string | null>(null);
  const [failedSig, setFailedSig] = useState<string | null>(null);
  const [wardsTick, setWardsTick] = useState(0);
  const [tick, setTick] = useState(0);
  const [phase, setPhase] = useState<"idle" | "submitting" | "redirecting">("idle");
  const [banner, setBanner] = useState<Banner | null>(null);
  const [confirm, setConfirm] = useState<{ from: number | null; sig: string } | null>(null);
  const [expiredId, setExpiredId] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [summaryOpen, setSummaryOpen] = useState(false);

  const keeper = useRef(createKeyKeeper());
  const inFlight = useRef(false);
  const quoteSeq = useRef(0);
  const bannerRef = useRef<HTMLDivElement>(null);
  const fieldEls = useRef<Partial<Record<FieldName, HTMLElement | null>>>({});
  const lastTotal = useRef<number | null>(null);

  const address = useMemo(() => ({ provinceCode, wardCode, line }), [provinceCode, wardCode, line]);
  const addrOk = addressComplete(address);
  const sig = `${payment}|${provinceCode}|${wardCode}|${normalizeText(line)}|${appliedCode ?? ""}`;
  const expired = quote !== null && quote.id === expiredId;
  const confirmFrom = confirm !== null && confirm.sig === sig ? confirm.from : null;
  const quoteFresh = quote !== null && quoteSig === sig && !expired;
  const quoting = addrOk && !quoteFresh && failedSig !== sig;
  const wardsView: WardsState =
    provinceCode === ""
      ? { code: "", status: "idle", list: [] }
      : wards?.code === provinceCode
        ? wards
        : { code: provinceCode, status: "loading", list: [] };
  const itemCount = lines.reduce((s, l) => s + l.quantity, 0);
  const trackItems = useMemo(
    () =>
      lines
        .flatMap((l) => (isNonEmpty(l.itemId) ? [{ item_id: l.itemId, quantity: l.quantity }] : []))
        .slice(0, 50),
    [lines],
  );

  /* ---------------------------------------------------------------- telemetry (không PII: chỉ id/giá trị) */
  useEffect(() => {
    track({ event: "begin_checkout", value: subtotal, items: trackItems });
    // Một lần mỗi lần mở trang thanh toán.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ chạy lại theo khoá ổn định đã liệt kê; thêm phụ thuộc còn lại gây lặp/gửi trùng sự kiện
  }, []);
  const shippingSent = useRef(false);
  useEffect(() => {
    if (!addrOk || shippingSent.current) return;
    shippingSent.current = true;
    track({ event: "add_shipping_info", value: subtotal, items: trackItems });
  }, [addrOk, subtotal, trackItems]);
  const paymentSent = useRef(new Set<PaymentMethod>());
  const choosePayment = (m: PaymentMethod) => {
    setPayment(m);
    if (paymentSent.current.has(m)) return;
    paymentSent.current.add(m);
    track({ event: "add_payment_info", value: subtotal, items: trackItems, payment_type: m });
  };

  /* ---------------------------------------------------------------- tỉnh → phường/xã */
  const loadWards = useCallback((code: string, signal?: AbortSignal) => {
    // Lỗi tạm thời (mạng/5xx/429) tự thử lại có backoff; 404 (mã sai) trả ngay (FE-STATE-005).
    fetchWithRetry(`/api/address/wards?province=${encodeURIComponent(code)}`, { signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ wards?: { code: string; name: string }[] }>) : null))
      .then((j) => {
        if (signal?.aborted === true) return;
        setWards(
          j && Array.isArray(j.wards)
            ? { code, status: "ready", list: j.wards }
            : { code, status: "error", list: [] },
        );
      })
      .catch(() => {
        if (signal?.aborted !== true) setWards({ code, status: "error", list: [] });
      });
  }, []);

  useEffect(() => {
    if (provinceCode === "") return;
    const ctrl = new AbortController();
    loadWards(provinceCode, ctrl.signal);
    return () => ctrl.abort();
  }, [provinceCode, wardsTick, loadWards]);

  /* ---------------------------------------------------------------- báo giá (server tính) */
  useEffect(() => {
    if (!addrOk) {
      quoteSeq.current++; // bỏ kết quả đang chờ
      return;
    }
    const mySeq = ++quoteSeq.current;
    const timer = setTimeout(async () => {
      const r = await quoteCheckout({
        paymentMethod: payment,
        address: { provinceCode, wardCode, line: normalizeText(line) },
        discountCode: appliedCode,
      });
      if (mySeq !== quoteSeq.current) return; // kết quả cũ
      if (r.ok) {
        if (lastTotal.current !== null && lastTotal.current !== r.quote.total) {
          setAnnounce(`Tổng tiền đã cập nhật: ${formatVnd(r.quote.total)}.`);
        }
        lastTotal.current = r.quote.total;
        setQuote(r.quote);
        setQuoteSig(sig);
        return;
      }
      setQuote(null);
      setQuoteSig(null);
      setFailedSig(sig);
      if (r.code === "DISCOUNT_NOT_APPLICABLE" || r.code === "DISCOUNT_EXHAUSTED") {
        setErrors((e) => ({ ...e, discount: r.message }));
        setAppliedCode(null);
      } else if (r.code === "ADDRESS_NOT_SERVED" || r.field === "line" || r.field === "ward") {
        setErrors((e) => ({ ...e, [r.field ?? "line"]: r.message }));
      } else {
        setBanner(
          r.code === "CART_EMPTY" || r.code === "NOT_FOUND" || r.code === "INSUFFICIENT_STOCK"
            ? { kind: "error", message: r.message, cart: true }
            : { kind: "error", message: r.message, cart: false },
        );
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sig` đã gồm mọi đầu vào của báo giá
  }, [sig, addrOk, tick]);

  // Báo giá hết hạn → tự lấy báo giá mới (khách thấy tổng mới trước khi bấm, không thu ngầm).
  useEffect(() => {
    if (!quote) return;
    const ms = Date.parse(quote.expiresAt) - Date.now();
    if (!Number.isFinite(ms)) return;
    const t = setTimeout(
      () => {
        setExpiredId(quote.id);
        setTick((n) => n + 1);
      },
      Math.max(ms, 0) + 50,
    );
    return () => clearTimeout(t);
  }, [quote]);

  useEffect(() => {
    if (banner) bannerRef.current?.focus();
  }, [banner]);

  /* ---------------------------------------------------------------- đặt hàng */
  const focusField = (f: FieldName) => fieldEls.current[f]?.focus();
  const setEl = (f: FieldName) => (el: HTMLElement | null) => {
    fieldEls.current[f] = el;
  };
  const clearError = (f: FieldName) => setErrors((e) => (isNonEmpty(e[f]) ? { ...e, [f]: undefined } : e));

  const deps: FlowDeps = useMemo(
    () => ({ submit: submitCheckout, poll: pollCheckout, sleep: REAL_SLEEP }),
    [],
  );

  const complete = async (o: { ref: string; paymentUrl: string | null }) => {
    setPhase("redirecting");
    track({ event: "order_placed", order_id: o.ref, value: quote?.total ?? subtotal, items: trackItems });
    try {
      await finishCheckout(); // bỏ cookie giỏ: giỏ đã gắn với đơn
    } catch {
      // không chặn chuyển trang nếu xóa cookie lỗi
    }
    const url = payment === "vnpay" ? safePaymentUrl(o.paymentUrl) : null;
    if (isNonEmpty(url)) window.location.assign(url);
    else router.push(`/don-hang/${encodeURIComponent(o.ref)}`);
  };

  const handleOutcome = async (out: FlowOutcome) => {
    switch (out.kind) {
      case "placed":
        await complete(out);
        return;
      case "changed": {
        keeper.current.reset();
        const from = quote?.total ?? null;
        if (out.quote) {
          setQuote(out.quote);
          setQuoteSig(sig);
          lastTotal.current = out.quote.total;
          setConfirm({ from, sig });
        } else {
          setTick((n) => n + 1);
        }
        setBanner({
          kind: "changed",
          message: out.message,
          from,
          to: out.quote?.total ?? null,
          cart: out.code === "CART_CHANGED",
        });
        return;
      }
      case "stock":
        keeper.current.reset();
        setBanner({ kind: "stock", message: out.message, lines: out.lines });
        return;
      case "error": {
        if (out.newKey) keeper.current.reset();
        if (out.code === "DISCOUNT_EXHAUSTED") {
          setErrors((e) => ({ ...e, discount: out.message }));
          setAppliedCode(null);
          return;
        }
        if (isNonEmpty(out.field)) {
          const f = out.field as FieldName;
          setErrors((e) => ({ ...e, [f]: out.message }));
          focusField(f);
          return;
        }
        setBanner({ kind: "error", message: out.message, cart: out.code === "NOT_FOUND" });
        return;
      }
      case "busy":
        setBanner({ kind: "busy" });
        return;
      case "unavailable":
        // Giữ khóa idempotency (retry_same_key) và dữ liệu form; không tự gửi lại.
        setBanner({ kind: "unavailable" });
        return;
      case "network":
        setBanner({ kind: "network" });
        return;
      case "processing":
        setBanner({ kind: "processing", attemptId: out.attemptId });
        return;
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (inFlight.current || phase !== "idle") return;
    const found = validateForm({ name, phone, email, provinceCode, wardCode, line });
    setErrors(found);
    const first = firstErrorField(found);
    if (first) {
      focusField(first);
      return;
    }
    if (!quote || !quoteFresh || quoting) {
      setTick((n) => n + 1);
      setAnnounce("Đang tính tổng tiền. Vui lòng đợi trong giây lát rồi bấm Đặt hàng.");
      return;
    }
    setBanner(null);
    const contact = {
      name: normalizeText(name),
      phone: normalizePhone(phone) as string,
      email: email.trim(),
    };
    const input = {
      idempotencyKey: "",
      quoteId: quote.id,
      cartVersion: quote.cartVersion,
      paymentMethod: payment,
      contact,
      address: { provinceCode, wardCode, line: normalizeText(line) },
      discountCode: appliedCode,
    };
    // Khóa theo NỘI DUNG xác nhận: retry cùng nội dung dùng lại khóa; đổi quote/thông tin → khóa mới.
    input.idempotencyKey = keeper.current.keyFor(JSON.stringify({ ...input, idempotencyKey: undefined }));
    inFlight.current = true;
    setPhase("submitting");
    try {
      const out = await runSubmit(deps, input);
      await handleOutcome(out);
    } finally {
      inFlight.current = false;
      setPhase((p) => (p === "redirecting" ? p : "idle"));
    }
  };

  const recheck = async () => {
    if (banner?.kind !== "processing" || inFlight.current) return;
    inFlight.current = true;
    setPhase("submitting");
    try {
      const p = await pollCheckout(banner.attemptId);
      if (p.kind === "placed") await complete(p);
      else if (p.kind === "failed") {
        keeper.current.reset();
        setBanner({ kind: "error", message: p.message, cart: false });
      } else setAnnounce("Đơn vẫn đang được xử lý. Vui lòng đợi và kiểm tra lại sau ít giây.");
    } finally {
      inFlight.current = false;
      setPhase((p) => (p === "redirecting" ? p : "idle"));
    }
  };

  const applyCode = () => {
    const code = discountInput.trim();
    clearError("discount");
    setAppliedCode(code === "" ? null : code);
  };

  const busy = phase !== "idle";
  const titleOf = (id: string) => lines.find((l) => l.id === id)?.title ?? "Sản phẩm";
  const submitLabel = confirmFrom !== null ? "Xác nhận tổng mới và đặt hàng" : "Đặt hàng";

  return (
    <form noValidate onSubmit={onSubmit} className={styles.layout} aria-busy={busy || undefined}>
      <div className={styles.main}>
        <h1 className={styles.title}>Thanh toán</h1>
        <p className={styles.guest}>
          <strong>Mua không cần tài khoản.</strong> Bạn không cần đăng nhập hay tạo tài khoản để đặt hàng.
        </p>

        <section className={styles.mobileSummary} aria-label="Tóm tắt đơn hàng">
          <button
            type="button"
            className={styles.summaryToggle}
            aria-expanded={summaryOpen}
            aria-controls="tom-tat-don-hang"
            onClick={() => setSummaryOpen((o) => !o)}
          >
            <span>{`${summaryOpen ? "Ẩn" : "Xem"} đơn hàng (${itemCount} sản phẩm)`}</span>
            <span>{quote ? formatVnd(quote.total) : formatVnd(subtotal)}</span>
          </button>
          <div id="tom-tat-don-hang" className={styles.summaryPanel} data-open={summaryOpen}>
            <OrderLines lines={lines} />
          </div>
        </section>

        <p role="status" aria-live="polite" className="visually-hidden">
          {announce}
        </p>

        {banner ? (
          <div
            ref={bannerRef}
            tabIndex={-1}
            role="alert"
            className={styles.banner}
            data-kind={banner.kind}
            data-testid="checkout-banner"
          >
            {banner.kind === "changed" ? (
              <>
                <p>
                  <strong>{banner.message}</strong>
                </p>
                {banner.to !== null ? (
                  <p>
                    {banner.from !== null && banner.from !== banner.to
                      ? `Tổng tiền mới: ${formatVnd(banner.to)} (trước đó ${formatVnd(banner.from)}). `
                      : `Tổng tiền: ${formatVnd(banner.to)}. `}
                    Vui lòng kiểm tra rồi bấm “Xác nhận tổng mới và đặt hàng” — chúng tôi không thu thêm khi
                    bạn chưa đồng ý.
                  </p>
                ) : (
                  <p>Đang cập nhật tổng tiền mới. Vui lòng kiểm tra rồi bấm Đặt hàng lại.</p>
                )}
                {banner.cart ? <Link href="/gio-hang">Xem lại giỏ hàng</Link> : null}
              </>
            ) : null}
            {banner.kind === "stock" ? (
              <>
                <p>
                  <strong>{banner.message}</strong>
                </p>
                <ul>
                  {banner.lines.map((s) => (
                    <li key={`${s.lineItemId}-${s.variantId}`}>
                      {s.available > 0
                        ? `${titleOf(s.lineItemId)}: chỉ còn ${s.available} (bạn chọn ${s.requested}).`
                        : `${titleOf(s.lineItemId)}: đã hết hàng (bạn chọn ${s.requested}).`}
                    </li>
                  ))}
                </ul>
                <Link href="/gio-hang">Sửa giỏ hàng</Link>
              </>
            ) : null}
            {banner.kind === "error" ? (
              <>
                <p>{banner.message}</p>
                {banner.cart ? <Link href="/gio-hang">Quay lại giỏ hàng</Link> : null}
              </>
            ) : null}
            {banner.kind === "network" ? (
              <p>
                Mất kết nối khi đặt hàng. Thông tin của bạn vẫn được giữ nguyên — hãy bấm “Đặt hàng” lại để
                thử tiếp. Đơn sẽ không bị tạo trùng.
              </p>
            ) : null}
            {banner.kind === "unavailable" ? (
              <>
                <p>Hệ thống tạm thời không nhận đơn, vui lòng thử lại sau ít phút</p>
                <p>Thông tin của bạn vẫn được giữ nguyên; đơn sẽ không bị tạo trùng.</p>
                <Button type="submit" variant="secondary" loading={busy}>
                  Thử lại
                </Button>
              </>
            ) : null}
            {banner.kind === "busy" ? (
              <p>
                Hệ thống đang bận xử lý nhiều đơn. Vui lòng bấm “Đặt hàng” lại sau giây lát; đơn sẽ không bị
                tạo trùng.
              </p>
            ) : null}
            {banner.kind === "processing" ? (
              <>
                <p>
                  <strong>Đơn của bạn vẫn đang được xử lý.</strong> Vui lòng KHÔNG đặt lại.
                </p>
                <p>{`Mã tham chiếu: ${banner.attemptId}`}</p>
                <Button type="button" variant="secondary" onClick={recheck} loading={busy}>
                  Kiểm tra lại
                </Button>
              </>
            ) : null}
          </div>
        ) : null}

        <fieldset className={styles.group}>
          <legend>1. Liên hệ</legend>
          <Field name="name" label="Họ và tên" required error={errors.name}>
            {(c) => (
              <input
                {...c}
                ref={setEl("name")}
                className={styles.input}
                type="text"
                name="name"
                autoComplete="name"
                aria-required="true"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  clearError("name");
                }}
              />
            )}
          </Field>
          <Field
            name="phone"
            label="Số điện thoại"
            required
            hint="Dùng để xác nhận đơn và giao hàng."
            error={errors.phone}
          >
            {(c) => (
              <input
                {...c}
                ref={setEl("phone")}
                className={styles.input}
                type="tel"
                inputMode="tel"
                name="tel"
                autoComplete="tel"
                aria-required="true"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  clearError("phone");
                }}
              />
            )}
          </Field>
          <Field name="email" label="Email" hint="Nhận thông báo đơn hàng qua email." error={errors.email}>
            {(c) => (
              <input
                {...c}
                ref={setEl("email")}
                className={styles.input}
                type="email"
                inputMode="email"
                name="email"
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  clearError("email");
                }}
              />
            )}
          </Field>
        </fieldset>

        <fieldset className={styles.group}>
          <legend>2. Giao hàng</legend>
          <Field name="province" label="Tỉnh/thành phố" required error={errors.province}>
            {(c) => (
              <select
                {...c}
                ref={setEl("province")}
                className={styles.input}
                name="province"
                autoComplete="address-level1"
                aria-required="true"
                value={provinceCode}
                onChange={(e) => {
                  setProvinceCode(e.target.value);
                  setWardCode("");
                  clearError("province");
                  clearError("ward");
                }}
              >
                <option value="">Chọn tỉnh/thành phố</option>
                {provinces.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            name="ward"
            label="Phường/xã"
            required
            error={
              errors.ward ??
              (wardsView.status === "error" ? "Không tải được danh sách phường/xã." : undefined)
            }
          >
            {(c) => (
              <>
                <select
                  {...c}
                  ref={setEl("ward")}
                  className={styles.input}
                  name="ward"
                  autoComplete="address-level2"
                  aria-required="true"
                  disabled={provinceCode === "" || wardsView.status === "loading"}
                  value={wardCode}
                  onChange={(e) => {
                    setWardCode(e.target.value);
                    clearError("ward");
                  }}
                >
                  <option value="">
                    {provinceCode === ""
                      ? "Chọn tỉnh/thành phố trước"
                      : wardsView.status === "loading"
                        ? "Đang tải…"
                        : "Chọn phường/xã"}
                  </option>
                  {wardsView.list.map((w) => (
                    <option key={w.code} value={w.code}>
                      {w.name}
                    </option>
                  ))}
                </select>
                {wardsView.status === "error" ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setWards(null);
                      setWardsTick((n) => n + 1);
                    }}
                  >
                    Thử tải lại
                  </Button>
                ) : null}
              </>
            )}
          </Field>
          <Field
            name="line"
            label="Số nhà, tên đường"
            required
            hint="Ví dụ: 12 Phố Điện Biên Phủ, tòa A, căn 305."
            error={errors.line}
          >
            {(c) => (
              <input
                {...c}
                ref={setEl("line")}
                className={styles.input}
                type="text"
                name="address-line1"
                autoComplete="address-line1"
                aria-required="true"
                value={line}
                onChange={(e) => {
                  setLine(e.target.value);
                  clearError("line");
                }}
              />
            )}
          </Field>
        </fieldset>

        <fieldset className={styles.group}>
          <legend>3. Thanh toán</legend>
          <div role="radiogroup" aria-label="Phương thức thanh toán" className={styles.radios}>
            {(Object.keys(PAYMENT_LABEL) as PaymentMethod[]).map((m) => (
              <label key={m} className={styles.radio}>
                <input
                  type="radio"
                  name="payment"
                  value={m}
                  checked={payment === m}
                  onChange={() => choosePayment(m)}
                />
                <span>{PAYMENT_LABEL[m]}</span>
              </label>
            ))}
          </div>
          <p className={styles.hint}>
            {payment === "cod"
              ? "Bạn trả tiền mặt cho nhân viên giao hàng khi nhận hàng."
              : "Bạn sẽ được chuyển sang cổng VNPAY để thanh toán. Đơn được giữ hàng trong thời gian có hạn."}
          </p>
          <Field name="discount" label="Mã giảm giá" error={errors.discount}>
            {(c) => (
              <div className={styles.discountRow}>
                <input
                  {...c}
                  ref={setEl("discount")}
                  className={styles.input}
                  type="text"
                  name="discount"
                  autoComplete="off"
                  value={discountInput}
                  maxLength={64}
                  onChange={(e) => setDiscountInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      applyCode();
                    }
                  }}
                />
                <Button type="button" variant="secondary" onClick={applyCode}>
                  Áp dụng
                </Button>
              </div>
            )}
          </Field>
          {isNonEmpty(appliedCode) ? (
            <p className={styles.hint}>
              {`Đang áp dụng mã ${appliedCode}. `}
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  setAppliedCode(null);
                  setDiscountInput("");
                }}
              >
                Bỏ mã
              </button>
            </p>
          ) : null}
        </fieldset>

        <section aria-label="Tổng tiền" className={styles.confirm}>
          <Totals
            cartSubtotal={subtotal}
            quote={quoteFresh ? quote : null}
            quoting={quoting}
            method={payment}
          />
          <Button
            type="submit"
            size="lg"
            fullWidth
            loading={phase === "submitting"}
            disabled={phase === "redirecting"}
          >
            {phase === "redirecting" ? "Đang chuyển…" : submitLabel}
          </Button>
          <p className={styles.hint}>
            Bằng việc đặt hàng, bạn đồng ý với chính sách giao hàng và đổi trả của cửa hàng.
          </p>
        </section>
      </div>

      <aside className={styles.sideSummary} aria-label="Tóm tắt đơn hàng">
        <h2>Đơn hàng của bạn</h2>
        <OrderLines lines={lines} />
        <p>
          <Link href="/gio-hang">Chỉnh sửa giỏ hàng</Link>
        </p>
      </aside>
    </form>
  );
}
