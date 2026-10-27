import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { CHECKOUT_MODULE } from "../../../modules/checkout";
import type { JobBreakerSnapshot, OutboxClaim } from "../../../modules/checkout/service";
import type { JobBreakerTripReason } from "../../../modules/checkout/models/constants";
import { windowStartMs } from "../../security/sliding-window";

/**
 * Kho giả cho test đơn vị dispatcher outbox + circuit breaker (T-097): cùng ngữ nghĩa với các câu SQL của
 * `CheckoutModuleService` (outbox_event, job_breaker, rate_limit_counter, ops_exception). Mỗi phương thức nhường lượt
 * (`await tick()`) TRƯỚC khi đọc/ghi rồi đọc-ghi đồng bộ → nguyên tử như MỘT câu SQL, còn hai dispatcher chạy song song
 * thì xen kẽ giữa các câu (như hai bản sao trên cùng Postgres). Một đối tượng = một "DB" dùng chung.
 */
export interface FakeOutboxRow {
  id: string;
  event_key: string;
  aggregate_id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  state: "pending" | "failed" | "sent" | "dead";
  next_attempt_at: Date;
  last_error: string | null;
}

interface BreakerRow extends JobBreakerSnapshot {
  last_failed_event_id: string | null;
  trip_count: number;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

export function fakeOutboxDb(events: Array<Partial<FakeOutboxRow> & { id: string; type: string }>) {
  const outbox: FakeOutboxRow[] = events.map((e) => ({
    event_key: `${e.type}:${e.id}`,
    aggregate_id: "agg_1",
    payload: {},
    attempts: 0,
    state: "pending",
    next_attempt_at: new Date(0),
    last_error: null,
    ...e,
  }));
  const breakers = new Map<string, BreakerRow>();
  const counters = new Map<string, number>();
  const exceptions: Array<Record<string, unknown>> = [];
  let failExceptionOpen = false;

  const snap = (r: BreakerRow): JobBreakerSnapshot => ({
    state: r.state,
    consecutive_failures: r.consecutive_failures,
    open_until: r.open_until,
    probe_until: r.probe_until,
    trip_reason: r.trip_reason,
  });
  const ensure = (key: string): BreakerRow => {
    let r = breakers.get(key);
    if (!r) {
      r = {
        state: "closed",
        consecutive_failures: 0,
        open_until: null,
        probe_until: null,
        trip_reason: null,
        last_failed_event_id: null,
        trip_count: 0,
      };
      breakers.set(key, r);
    }
    return r;
  };

  const service = {
    claimDueOutbox: async (now: Date, leaseMs: number): Promise<OutboxClaim | null> => {
      await tick();
      const due = outbox
        .filter((r) => (r.state === "pending" || r.state === "failed") && r.next_attempt_at <= now)
        .sort(
          (a, b) => a.next_attempt_at.getTime() - b.next_attempt_at.getTime() || a.id.localeCompare(b.id),
        )[0];
      if (!due) return null;
      due.next_attempt_at = new Date(now.getTime() + leaseMs);
      const { id, event_key, aggregate_id, type, payload, attempts } = due;
      return { id, event_key, aggregate_id, type, payload, attempts };
    },
    markOutboxSent: async (id: string) => {
      await tick();
      const r = outbox.find((x) => x.id === id)!;
      r.state = "sent";
      r.last_error = null;
    },
    markOutboxFailed: async (id: string, error: string, next: Date | null) => {
      await tick();
      const r = outbox.find((x) => x.id === id)!;
      r.attempts += 1;
      r.state = next ? "failed" : "dead";
      r.last_error = error;
      if (next) r.next_attempt_at = next;
    },
    deferOutbox: async (id: string, until: Date) => {
      await tick();
      const r = outbox.find((x) => x.id === id)!;
      if (r.state === "pending" || r.state === "failed") r.next_attempt_at = until;
    },
    openOpsException: async (input: Record<string, unknown>) => {
      await tick();
      exceptions.push({ ...input, state: "open" });
      return true;
    },
    openOpsExceptionIfNoneActive: async (input: Record<string, unknown> & { active_scope?: string[] }) => {
      await tick();
      if (failExceptionOpen) throw new Error("DB down");
      const detail = (input.detail ?? {}) as Record<string, unknown>;
      const scope = input.active_scope ?? [];
      const active = exceptions.some(
        (x) =>
          x.kind === input.kind &&
          x.state !== "resolved" &&
          scope.every((k) => ((x.detail ?? {}) as Record<string, unknown>)[k] === detail[k]),
      );
      if (active) return false;
      const { active_scope: _ignored, ...row } = input;
      exceptions.push({ ...row, state: "open" });
      return true;
    },
    readJobBreaker: async (key: string) => {
      await tick();
      const r = breakers.get(key);
      return r ? snap(r) : null;
    },
    claimJobBreakerProbe: async (key: string, now: Date, probeUntil: Date) => {
      await tick();
      const r = breakers.get(key);
      if (!r) return false;
      const expired =
        (r.state === "open" && r.open_until! <= now) || (r.state === "half_open" && r.probe_until! <= now);
      if (!expired) return false;
      r.state = "half_open";
      r.probe_until = probeUntil;
      return true;
    },
    recordJobBreakerFailure: async (key: string, eventId: string) => {
      await tick();
      const exists = breakers.has(key);
      const r = ensure(key);
      if (!exists) r.consecutive_failures = 1;
      else if (r.last_failed_event_id !== eventId) r.consecutive_failures += 1;
      r.last_failed_event_id = eventId;
      return snap(r);
    },
    recordJobBreakerSuccess: async (key: string) => {
      await tick();
      const r = breakers.get(key);
      if (!r) return false;
      const was = r.state;
      if (was === "open") return false;
      r.state = "closed";
      r.consecutive_failures = 0;
      r.last_failed_event_id = null;
      r.open_until = null;
      r.probe_until = null;
      return was === "half_open";
    },
    tripJobBreaker: async (
      key: string,
      reason: JobBreakerTripReason,
      openUntil: Date,
      from: readonly ("closed" | "half_open")[],
    ) => {
      await tick();
      if (from.includes("closed")) ensure(key);
      const r = breakers.get(key);
      if (!r || !(from as readonly string[]).includes(r.state)) return false;
      r.state = "open";
      r.open_until = openUntil;
      r.probe_until = null;
      r.trip_reason = reason;
      r.trip_count += 1;
      return true;
    },
    hitRateCounter: async (bucket: string, windowMs: number, now: Date) => {
      await tick();
      const start = windowStartMs(windowMs, now.getTime());
      const k = `${bucket}@${start}`;
      const current = (counters.get(k) ?? 0) + 1;
      counters.set(k, current);
      return {
        current,
        previous: counters.get(`${bucket}@${start - windowMs}`) ?? 0,
        elapsedMs: now.getTime() - start,
      };
    },
  };

  const logs: Array<{ level: "info" | "warn" | "error"; message: string }> = [];
  const logger = {
    info: (message: string) => logs.push({ level: "info", message }),
    warn: (message: string) => logs.push({ level: "warn", message }),
    error: (message: string) => logs.push({ level: "error", message }),
  };
  const container = {
    resolve: (key: string) => {
      if (key === CHECKOUT_MODULE) return service;
      if (key === ContainerRegistrationKeys.LOGGER) return logger;
      throw new Error(`không có ${key}`);
    },
  } as unknown as MedusaContainer;

  return {
    container,
    service,
    outbox,
    breakers,
    /** Bộ đếm ngân sách: khoá `<bucket>@<window_start ms>` → số đếm. */
    counters,
    exceptions,
    logs,
    /** Mô phỏng DB lỗi khi mở ngoại lệ. */
    failExceptionOpen: (v: boolean) => {
      failExceptionOpen = v;
    },
    /** Thêm sự kiện mới vào outbox. */
    add: (e: Partial<FakeOutboxRow> & { id: string; type: string }) => {
      outbox.push({
        event_key: `${e.type}:${e.id}`,
        aggregate_id: "agg_1",
        payload: {},
        attempts: 0,
        state: "pending",
        next_attempt_at: new Date(0),
        last_error: null,
        ...e,
      });
    },
  };
}
