import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkRefundAllowed,
  codAmount,
  ledgerTotals,
  overpaidAmount,
  type LedgerEntry,
} from "../ledger/ledger.js";
import {
  applyProviderState,
  orderMachine,
  paymentMachine,
  refundMachine,
  returnMachine,
  settlementMachine,
  shipmentMachine,
  type Machine,
  type RefundState,
} from "./machine.js";

/** Seed cố định → tái lập được; đổi seed chỉ khi cần tái hiện counterexample. */
const SEED = 20260101;
const RUNS = 1000;
const cfg = { seed: SEED, numRuns: RUNS };

const machines = [
  orderMachine,
  paymentMachine,
  shipmentMachine,
  returnMachine,
  refundMachine,
  settlementMachine,
] as unknown as Machine<string>[];

/** Chuỗi sự kiện "đích" ngẫu nhiên (cả hợp lệ lẫn không) cho máy m, bắt đầu từ trạng thái khai báo đầu tiên. */
const eventsFor = (m: Machine<string>) => fc.array(fc.constantFrom(...m.states), { maxLength: 40 });

describe.each(machines.map((m) => [m.name, m] as const))("property — máy %s", (_n, m) => {
  const initial = m.states[0] as string;

  it("transition: chỉ chuyển hợp lệ; chuyển sai bị từ chối và không đổi trạng thái", () => {
    fc.assert(
      fc.property(eventsFor(m), (events) => {
        let cur = initial;
        for (const to of events) {
          const before = cur;
          const r = m.transition(cur, to);
          if (m.canTransition(cur, to)) {
            expect(r.ok).toBe(true);
            cur = to;
          } else {
            expect(r.ok).toBe(false);
            expect(cur).toBe(before);
          }
          expect(m.states).toContain(cur);
        }
      }),
      cfg,
    );
  });

  it("không rời trạng thái cuối (transition và applyProviderState đều từ chối)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...m.terminal), eventsFor(m), (term, events) => {
        let cur = term;
        for (const to of events) {
          expect(m.transition(cur, to).ok).toBe(false);
          const r = applyProviderState(m, cur, to);
          expect(r.state).toBe(term);
          expect(r.changed).toBe(false);
          cur = r.state;
        }
      }),
      cfg,
    );
  });

  it("applyProviderState: idempotent khi áp lại cùng sự kiện; bước đổi nào cũng hợp lệ", () => {
    fc.assert(
      fc.property(eventsFor(m), (events) => {
        let cur = initial;
        for (const to of events) {
          const first = applyProviderState(m, cur, to);
          const second = applyProviderState(m, first.state, to);
          expect(second.state).toBe(first.state);
          expect(second.changed).toBe(false);
          if (first.changed) expect(m.canTransition(cur, first.state)).toBe(true);
          else expect(first.state).toBe(cur);
          cur = first.state;
        }
      }),
      cfg,
    );
  });

  it("chuỗi sự kiện ngẫu nhiên: lịch sử trạng thái luôn là đường đi hợp lệ từ trạng thái đầu", () => {
    fc.assert(
      fc.property(eventsFor(m), (events) => {
        let cur = initial;
        const path = [initial];
        for (const to of events) {
          const r = applyProviderState(m, cur, to);
          if (r.changed) path.push(r.state);
          cur = r.state;
        }
        for (let i = 1; i < path.length; i++) {
          expect(m.canTransition(path[i - 1] as string, path[i] as string)).toBe(true);
        }
      }),
      cfg,
    );
  });
});

describe("property — thanh toán đơn điệu", () => {
  it("đã captured thì không bao giờ lùi (pending/authorized/failed/unknown/created)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...paymentMachine.states), { maxLength: 40 }),
        fc.constantFrom(...paymentMachine.states),
        (events, start) => {
          let cur = start;
          let everCaptured = cur === "captured";
          for (const to of events) {
            cur = applyProviderState(paymentMachine, cur, to).state;
            if (cur === "captured") everCaptured = true;
            if (everCaptured) expect(cur).toBe("captured");
          }
        },
      ),
      cfg,
    );
  });

  it("ca cố định: callback sai thứ tự không lùi captured, không hồi sinh failed", () => {
    expect(applyProviderState(paymentMachine, "captured", "pending")).toEqual({
      state: "captured",
      changed: false,
      ignored: "out_of_order",
    });
    expect(applyProviderState(paymentMachine, "failed", "captured").state).toBe("failed");
  });
});

describe("property — sổ cái: hoàn tiền và COD", () => {
  type Cmd =
    | { t: "capture"; amount: number }
    | { t: "request"; amount: number }
    | { t: "advance"; idx: number; to: RefundState };

  const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
    fc.record({ t: fc.constant("capture" as const), amount: fc.integer({ min: 1, max: 5_000_000 }) }),
    fc.record({ t: fc.constant("request" as const), amount: fc.integer({ min: -10, max: 6_000_000 }) }),
    fc.record({
      t: fc.constant("advance" as const),
      idx: fc.nat(20),
      to: fc.constantFrom(...refundMachine.states),
    }),
  );

  it("mọi chuỗi lệnh: Σ hoàn thành công + giữ ≤ Σ đã thu; COD nhất quán; refund chỉ đi qua chuyển hợp lệ", () => {
    fc.assert(
      fc.property(
        fc.array(cmdArb, { maxLength: 60 }),
        fc.integer({ min: 0, max: 20_000_000 }),
        (cmds, orderTotal) => {
          const entries: LedgerEntry[] = [];
          let seq = 0;
          for (const c of cmds) {
            if (c.t === "capture") {
              entries.push({ kind: "capture", amount: c.amount, providerTxnId: `tx${seq++}` });
            } else if (c.t === "request") {
              const before = ledgerTotals(entries);
              const r = checkRefundAllowed(entries, c.amount);
              if (r.ok) {
                expect(c.amount).toBeGreaterThan(0);
                entries.push({
                  kind: "refund",
                  amount: c.amount,
                  refundId: `rf${seq++}`,
                  state: "requested",
                });
              } else {
                expect(ledgerTotals(entries)).toEqual(before); // từ chối không đổi sổ
              }
            } else {
              const refundIdx = entries.flatMap((e, i) => (e.kind === "refund" ? [i] : []));
              if (refundIdx.length === 0) continue;
              const i = refundIdx[c.idx % refundIdx.length] as number;
              const e = entries[i] as Extract<LedgerEntry, { kind: "refund" }>;
              const res = applyProviderState(refundMachine, e.state, c.to);
              if (!res.changed) expect(res.state).toBe(e.state);
              entries[i] = { ...e, state: res.state };
            }
            const t = ledgerTotals(entries);
            expect(t.refundSucceeded + t.refundHeld).toBeLessThanOrEqual(t.captured);
            expect(t.net).toBe(t.captured - t.refundSucceeded);
            expect(t.net).toBeGreaterThanOrEqual(0);
            const cod = codAmount(orderTotal, entries);
            expect(cod).toBeGreaterThanOrEqual(0);
            expect(cod).toBe(Math.max(0, orderTotal - t.net));
            expect(t.net + cod).toBeGreaterThanOrEqual(orderTotal);
            expect(cod === 0 || overpaidAmount(orderTotal, entries) === 0).toBe(true);
          }
        },
      ),
      cfg,
    );
  });

  it("hoàn vượt đã thu (đúng +1) bị từ chối; hoàn đúng phần còn lại được chấp nhận", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9_000_000 }), (captured) => {
        const e: LedgerEntry[] = [{ kind: "capture", amount: captured, providerTxnId: "t" }];
        expect(checkRefundAllowed(e, captured + 1).ok).toBe(false);
        expect(checkRefundAllowed(e, captured).ok).toBe(true);
      }),
      cfg,
    );
  });
});
