import { applyProviderState, SHIPMENT_STATES, shipmentMachine, type ShipmentState } from "@x-shop/domain";

/**
 * Tiến trình vận đơn theo trạng thái hãng báo (đã đối chiếu API — S-305). Callback có thể mất bớt mốc (vd chỉ nhận
 * `delivered` khi đang `packed`) → đi qua các bước HỢP LỆ của `shipmentMachine`, từng bước áp bằng
 * `applyProviderState`. Không bao giờ lùi: mỗi bước chỉ tới trạng thái có thứ hạng ≥ hiện tại (`shipped`/`failed` cùng
 * hạng — giao lại sau khi giao lỗi là hợp lệ); mốc cũ đến muộn → `out_of_order`, giữ nguyên.
 */
const RANK: Record<ShipmentState, number> = {
  unfulfilled: 0,
  picking: 1,
  packed: 2,
  shipped: 3,
  failed: 3,
  delivered: 4,
  returning: 5,
  returned: 6,
};

const forward = (from: ShipmentState, to: ShipmentState) =>
  shipmentMachine.canTransition(from, to) && RANK[to] >= RANK[from];

/** Đường đi ngắn nhất (không gồm `current`) chỉ qua bước tiến; không có → null. */
export function forwardPath(current: ShipmentState, target: ShipmentState): ShipmentState[] | null {
  if (current === target) return [];
  const prev = new Map<ShipmentState, ShipmentState>();
  const queue: ShipmentState[] = [current];
  const seen = new Set<ShipmentState>([current]);
  while (queue.length > 0) {
    const s = queue.shift() as ShipmentState;
    for (const next of SHIPMENT_STATES) {
      if (seen.has(next) || !forward(s, next)) continue;
      seen.add(next);
      prev.set(next, s);
      if (next === target) {
        const path: ShipmentState[] = [next];
        let cur = s;
        while (cur !== current) {
          path.unshift(cur);
          cur = prev.get(cur) as ShipmentState;
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

export interface ProgressPlan {
  /** Các bước sẽ áp, theo thứ tự (rỗng = không đổi). */
  steps: Array<{ from: ShipmentState; to: ShipmentState }>;
  final: ShipmentState;
  ignored: null | "duplicate" | "out_of_order";
}

/**
 * Đã giao là mốc cuối với trạng thái HÃNG báo trên cùng vận đơn (T-045): GHN không hoàn một vận đơn đã giao — khách trả
 * hàng đi luồng đổi trả riêng. Máy vận đơn vẫn có cạnh `delivered → returning` (dùng cho luồng khác), nhưng callback mà
 * đưa vận đơn đã giao sang hoàn về sẽ kéo theo hủy đơn/hoàn tiền sai (tiền COD đã thu) → coi là sai thứ tự, giữ nguyên.
 */
const AFTER_DELIVERY_IGNORED: readonly ShipmentState[] = ["returning", "returned"];

export function planProgress(current: ShipmentState, incoming: ShipmentState): ProgressPlan {
  if (current === "delivered" && AFTER_DELIVERY_IGNORED.includes(incoming)) {
    return { steps: [], final: current, ignored: "out_of_order" };
  }
  const direct = applyProviderState(shipmentMachine, current, incoming);
  if (direct.ignored === "duplicate") return { steps: [], final: current, ignored: "duplicate" };
  if (direct.changed && RANK[incoming] >= RANK[current]) {
    return { steps: [{ from: current, to: incoming }], final: incoming, ignored: null };
  }
  const path = forwardPath(current, incoming);
  if (!path || path.length === 0) return { steps: [], final: current, ignored: "out_of_order" };
  const steps: ProgressPlan["steps"] = [];
  let cur = current;
  for (const next of path) {
    const r = applyProviderState(shipmentMachine, cur, next);
    if (!r.changed) return { steps: [], final: current, ignored: "out_of_order" };
    steps.push({ from: cur, to: next });
    cur = next;
  }
  return { steps, final: cur, ignored: null };
}

/** Vận đơn chưa được hãng lấy hàng — chỉ những trạng thái này mới "hủy" được (GHN `cancel`). */
export const PRE_PICKUP_STATES: readonly ShipmentState[] = ["unfulfilled", "picking", "packed"];

/**
 * Hãng hủy vận đơn trước khi lấy hàng (GHN `cancel`, T-045): đưa vận đơn về `unfulfilled` qua các cạnh lùi HỢP LỆ của
 * máy (packed → picking → unfulfilled) — hàng chưa rời shop. Đã ở `unfulfilled` → duplicate; đã lấy hàng (shipped trở
 * đi) → out_of_order, giữ nguyên (không lùi trạng thái đã giao cho hãng/đã giao).
 */
export function planCancel(current: ShipmentState): ProgressPlan {
  if (current === "unfulfilled") return { steps: [], final: current, ignored: "duplicate" };
  if (!PRE_PICKUP_STATES.includes(current)) return { steps: [], final: current, ignored: "out_of_order" };
  const steps: ProgressPlan["steps"] = [];
  let cur: ShipmentState = current;
  while (cur !== "unfulfilled") {
    const next: ShipmentState = cur === "packed" ? "picking" : "unfulfilled";
    if (!shipmentMachine.canTransition(cur, next))
      return { steps: [], final: current, ignored: "out_of_order" };
    steps.push({ from: cur, to: next });
    cur = next;
  }
  return { steps, final: cur, ignored: null };
}

/** Vận đơn đã được hãng nhận rồi bị hủy trước khi lấy hàng: có mã của hãng nhưng đã quay về `unfulfilled`. */
export function isCarrierCancelled(s: { state: ShipmentState; provider_order_code: string | null }): boolean {
  return s.state === "unfulfilled" && s.provider_order_code !== null;
}
