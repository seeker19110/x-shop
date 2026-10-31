/**
 * Fixture CHỈ cho tx-network.unit.spec.ts (không được import ở mã chạy): các mẫu vi phạm DB-TX-003 mà bộ kiểm phải bắt,
 * và mẫu hợp lệ (mạng ngoài transaction) mà bộ kiểm không được báo.
 */
import type { VnpayGateway } from "../../../checkout/vnpay-gateway";

interface FakeDb {
  transaction<T>(fn: (trx: unknown) => Promise<T>): Promise<T>;
}

/** Gọi mạng gián tiếp: hàm trong repo gọi fetch. */
async function pingVendor(url: string): Promise<number> {
  const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
  return res.status;
}

export async function violationDirectFetch(db: FakeDb): Promise<void> {
  await db.transaction(async () => {
    await fetch("https://vendor.example/api", { signal: AbortSignal.timeout(1_000) });
  });
}

export async function violationGatewayInTx(db: FakeDb, gateway: VnpayGateway): Promise<void> {
  await db.transaction(async () => {
    await gateway.queryStatus({ txnRef: "PA1", amount: 1, transactionDate: new Date(0), orderInfo: "x" });
  });
}

export async function violationIndirect(db: FakeDb): Promise<void> {
  await db.transaction(async () => {
    await pingVendor("https://vendor.example/ping");
  });
}

export async function okNetworkOutsideTx(db: FakeDb, gateway: VnpayGateway): Promise<void> {
  const r = await gateway.queryStatus({
    txnRef: "PA1",
    amount: 1,
    transactionDate: new Date(0),
    orderInfo: "x",
  });
  await db.transaction(async () => r.outcome);
  await pingVendor("https://vendor.example/after-commit");
}
