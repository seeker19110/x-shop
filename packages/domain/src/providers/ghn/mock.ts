import type { CreateShipmentInput } from "./ghn.js";

/** Giả lập GHN cho dev/CI: tạo vận đơn idempotent theo client_order_code, tra cứu, đổi trạng thái, phí cố định. */
export class MockGhn {
  private seq = 0;
  readonly orders = new Map<string, { orderCode: string; status: string; codAmount: number }>();
  /** Số lần thực sự tạo mới — test S-303 kiểm không tạo trùng. */
  created = 0;

  fee(weightGrams: number): number {
    return 22_000 + Math.max(0, Math.ceil((weightGrams - 500) / 500)) * 5_000;
  }

  create(input: CreateShipmentInput): { orderCode: string; duplicate: boolean } {
    const found = this.orders.get(input.clientOrderCode);
    if (found) return { orderCode: found.orderCode, duplicate: true };
    this.seq += 1;
    this.created += 1;
    const orderCode = `GHNMOCK${String(this.seq).padStart(6, "0")}`;
    this.orders.set(input.clientOrderCode, {
      orderCode,
      status: "ready_to_pick",
      codAmount: input.codAmount,
    });
    return { orderCode, duplicate: false };
  }

  detailByClientCode(clientOrderCode: string) {
    return this.orders.get(clientOrderCode) ?? null;
  }

  setStatus(clientOrderCode: string, status: string): void {
    const o = this.orders.get(clientOrderCode);
    if (o) o.status = status;
  }
}
