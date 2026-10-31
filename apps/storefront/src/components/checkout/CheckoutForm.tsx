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
import { clientFetch } from "../../lib/client-fetch";
import { isNonEmpty } from "../../lib/presence";
import { safePaymentUrl } from "../../lib/safe-url";
import { t } from "../../lib/i18n";

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
    // Nguồn lỗi tạm thời (route trả 503, hoặc lỗi mạng) tự thử lại có backoff; 404 (mã tỉnh sai) trả ngay (FE-STATE-005).
    clientFetch(`/api/address/wards?province=${encodeURIComponent(code)}`, { signal })
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
          setAnnounce(t("checkout.form.totalUpdated", { total: formatVnd(r.quote.total) }));
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
    const timer = setTimeout(
      () => {
        setExpiredId(quote.id);
        setTick((n) => n + 1);
      },
      Math.max(ms, 0) + 50,
    );
    return () => clearTimeout(timer);
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
      setAnnounce(t("checkout.form.waitQuote"));
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
      } else setAnnounce(t("checkout.form.stillProcessing"));
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
  const titleOf = (id: string) => lines.find((l) => l.id === id)?.title ?? t("checkout.form.defaultTitle");
  const submitLabel = confirmFrom !== null ? t("checkout.form.submitConfirm") : t("checkout.form.submit");

  return (
    <form noValidate onSubmit={onSubmit} className={styles.layout} aria-busy={busy || undefined}>
      <div className={styles.main}>
        <h1 className={styles.title}>{t("checkout.form.title")}</h1>
        <p className={styles.guest}>
          <strong>{t("checkout.form.guestStrong")}</strong> {t("checkout.form.guestRest")}
        </p>

        <section className={styles.mobileSummary} aria-label={t("checkout.form.summaryLabel")}>
          <button
            type="button"
            className={styles.summaryToggle}
            aria-expanded={summaryOpen}
            aria-controls="tom-tat-don-hang"
            onClick={() => setSummaryOpen((o) => !o)}
          >
            <span>
              {t("checkout.form.summaryToggle", {
                action: summaryOpen ? t("checkout.form.summaryHide") : t("checkout.form.summaryShow"),
                count: itemCount,
              })}
            </span>
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
                      ? t("checkout.banner.changedNew", {
                          to: formatVnd(banner.to),
                          from: formatVnd(banner.from),
                        })
                      : t("checkout.banner.changedSame", { to: formatVnd(banner.to) })}
                  </p>
                ) : (
                  <p>{t("checkout.banner.changedPending")}</p>
                )}
                {banner.cart ? <Link href="/gio-hang">{t("checkout.banner.reviewCart")}</Link> : null}
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
                        ? t("checkout.banner.stockSome", {
                            title: titleOf(s.lineItemId),
                            available: s.available,
                            requested: s.requested,
                          })
                        : t("checkout.banner.stockNone", {
                            title: titleOf(s.lineItemId),
                            requested: s.requested,
                          })}
                    </li>
                  ))}
                </ul>
                <Link href="/gio-hang">{t("checkout.banner.fixCart")}</Link>
              </>
            ) : null}
            {banner.kind === "error" ? (
              <>
                <p>{banner.message}</p>
                {banner.cart ? <Link href="/gio-hang">{t("checkout.banner.backToCart")}</Link> : null}
              </>
            ) : null}
            {banner.kind === "network" ? <p>{t("checkout.banner.network")}</p> : null}
            {banner.kind === "unavailable" ? (
              <>
                <p>{t("checkout.banner.unavailable")}</p>
                <p>{t("checkout.banner.kept")}</p>
                <Button type="submit" variant="secondary" loading={busy}>
                  {t("checkout.banner.retry")}
                </Button>
              </>
            ) : null}
            {banner.kind === "busy" ? <p>{t("checkout.banner.busy")}</p> : null}
            {banner.kind === "processing" ? (
              <>
                <p>
                  <strong>{t("checkout.banner.processingStrong")}</strong>{" "}
                  {t("checkout.banner.processingRest")}
                </p>
                <p>{t("checkout.banner.reference", { id: banner.attemptId })}</p>
                <Button type="button" variant="secondary" onClick={recheck} loading={busy}>
                  {t("checkout.banner.recheck")}
                </Button>
              </>
            ) : null}
          </div>
        ) : null}

        <fieldset className={styles.group}>
          <legend>{t("checkout.contact.legend")}</legend>
          <Field name="name" label={t("checkout.contact.name")} required error={errors.name}>
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
            label={t("checkout.contact.phone")}
            required
            hint={t("checkout.contact.phoneHint")}
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
          <Field
            name="email"
            label={t("checkout.contact.email")}
            hint={t("checkout.contact.emailHint")}
            error={errors.email}
          >
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
          <legend>{t("checkout.shipping.legend")}</legend>
          <Field name="province" label={t("checkout.shipping.province")} required error={errors.province}>
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
                <option value="">{t("checkout.shipping.chooseProvince")}</option>
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
            label={t("checkout.shipping.ward")}
            required
            hint={
              wardsView.status === "ready" && wardsView.list.length === 0
                ? t("checkout.shipping.wardsEmpty")
                : undefined
            }
            error={
              errors.ward ?? (wardsView.status === "error" ? t("checkout.shipping.wardsError") : undefined)
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
                      ? t("checkout.shipping.chooseProvinceFirst")
                      : wardsView.status === "loading"
                        ? t("checkout.shipping.loading")
                        : t("checkout.shipping.chooseWard")}
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
                    {t("checkout.shipping.reloadWards")}
                  </Button>
                ) : null}
              </>
            )}
          </Field>
          <Field
            name="line"
            label={t("checkout.shipping.line")}
            required
            hint={t("checkout.shipping.lineHint")}
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
          <legend>{t("checkout.paymentStep.legend")}</legend>
          <div role="radiogroup" aria-label={t("checkout.paymentStep.groupLabel")} className={styles.radios}>
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
            {payment === "cod" ? t("checkout.paymentStep.codHint") : t("checkout.paymentStep.vnpayHint")}
          </p>
          <Field name="discount" label={t("checkout.paymentStep.discount")} error={errors.discount}>
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
                  {t("checkout.paymentStep.apply")}
                </Button>
              </div>
            )}
          </Field>
          {isNonEmpty(appliedCode) ? (
            <p className={styles.hint}>
              {t("checkout.paymentStep.applied", { code: appliedCode })}
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  setAppliedCode(null);
                  setDiscountInput("");
                }}
              >
                {t("checkout.paymentStep.remove")}
              </button>
            </p>
          ) : null}
        </fieldset>

        <section aria-label={t("checkout.form.totalsLabel")} className={styles.confirm}>
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
            {phase === "redirecting" ? t("checkout.form.redirecting") : submitLabel}
          </Button>
          <p className={styles.hint}>{t("checkout.form.policyNote")}</p>
        </section>
      </div>

      <aside className={styles.sideSummary} aria-label={t("checkout.form.summaryLabel")}>
        <h2>{t("checkout.form.sideTitle")}</h2>
        <OrderLines lines={lines} />
        <p>
          <Link href="/gio-hang">{t("checkout.form.editCart")}</Link>
        </p>
      </aside>
    </form>
  );
}
