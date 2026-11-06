import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { vnpay } from "@x-shop/domain";
import { resolveTransactionDate, transactionDateOf } from "../vnpay-transaction-date";

const cfg = {
  tmnCode: "XSHOPTEST",
  hashSecret: "unit-test-secret-0123456789abcdef0123",
};
const common = {
  requestId: "REQ1",
  ipAddr: "127.0.0.1",
  createdAt: new Date("2026-10-28T01:00:00Z"),
};

function scopeWith(warn: jest.Mock) {
  return {
    resolve: (key: string) => {
      if (key !== ContainerRegistrationKeys.LOGGER) throw new Error(`không mong đợi ${key}`);
      return { warn };
    },
  } as unknown as Parameters<typeof transactionDateOf>[0];
}
/** Thân querydr + refund dựng từ mốc đã chọn — đúng như adapter gửi đi. */
function sentDates(date: Date) {
  const q = vnpay.buildQueryDr(cfg, {
    ...common,
    txnRef: "PA_1",
    transactionDate: date,
    orderInfo: "x",
  });
  const r = vnpay.buildRefund(cfg, {
    ...common,
    txnRef: "PA_1",
    amount: 1_000,
    full: true,
    transactionNo: "14000001",
    transactionDate: date,
    createdBy: "ke-toan",
    orderInfo: "x",
  });
  return [q.vnp_TransactionDate, r.vnp_TransactionDate];
}

describe("vnp_TransactionDate từ attempt (T-170)", () => {
  it("có vnp_create_date → gửi đúng chuỗi đó cho querydr và refund, bỏ qua created_at lệch; không WARN", () => {
    const warn = jest.fn();
    const d = transactionDateOf(
      scopeWith(warn),
      {
        id: "payatt_1",
        txn_ref: "PA_1",
        vnp_create_date: "20261028080000",
        created_at: "2026-10-28T01:00:01.330Z",
      },
      "querydr",
    );
    expect(sentDates(d)).toEqual(["20261028080000", "20261028080000"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("biên GMT+7 qua nửa đêm UTC: chuỗi lưu 00:00:00 giờ VN (UTC còn ngày trước) giữ nguyên ngày", () => {
    for (const [stored, utc] of [
      ["20261028000000", "2026-10-27T17:00:00.000Z"],
      ["20261027235959", "2026-10-27T16:59:59.000Z"],
      ["20270101000000", "2026-12-31T17:00:00.000Z"],
      ["20280229065959", "2028-02-28T23:59:59.000Z"],
    ] as const) {
      const r = resolveTransactionDate({
        id: "p",
        txn_ref: "PA_1",
        vnp_create_date: stored,
        created_at: new Date(0),
      });
      expect({
        source: r.source,
        iso: r.date.toISOString(),
        sent: sentDates(r.date),
      }).toEqual({
        source: "vnp_create_date",
        iso: utc,
        sent: [stored, stored],
      });
    }
  });

  it("dữ liệu cũ (NULL/thiếu/rỗng) → fallback created_at (cả biên nửa đêm UTC) + WARN có id, txn_ref, mục đích", () => {
    for (const vnp_create_date of [null, undefined, ""]) {
      const warn = jest.fn();
      const d = transactionDateOf(
        scopeWith(warn),
        {
          id: "payatt_old",
          txn_ref: "PA_OLD",
          vnp_create_date,
          created_at: "2026-10-27T17:00:00.250Z",
        },
        "refund",
      );
      expect(sentDates(d)).toEqual(["20261028000000", "20261028000000"]);
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0]![0]);
      expect(msg).toContain("payatt_old");
      expect(msg).toContain("txn_ref=PA_OLD");
      expect(msg).toContain("refund dùng created_at");
      expect(msg).toContain("vnp_TransactionDate=20261028000000");
    }
  });

  it("chuỗi lưu sai dạng (DB đã CHECK — phòng hờ) → không gửi giá trị hỏng: fallback + WARN", () => {
    for (const bad of ["20261332000000", "2026102800000", "2026-10-28T00:00", "20261028240000"]) {
      const warn = jest.fn();
      const d = transactionDateOf(
        scopeWith(warn),
        {
          id: "p",
          txn_ref: "PA_1",
          vnp_create_date: bad,
          created_at: new Date("2026-10-28T01:00:00Z"),
        },
        "querydr",
      );
      expect(vnpay.toVnpDate(d)).toBe("20261028080000");
      expect(warn).toHaveBeenCalledTimes(1);
    }
  });

  it("logger hỏng không chặn querydr/hoàn tiền", () => {
    const broken = {
      resolve: () => {
        throw new Error("không có logger");
      },
    } as unknown as Parameters<typeof transactionDateOf>[0];
    const d = transactionDateOf(
      broken,
      { id: "p", txn_ref: "PA_1", created_at: "2026-10-28T01:00:00Z" },
      "querydr",
    );
    expect(vnpay.toVnpDate(d)).toBe("20261028080000");
  });
});
