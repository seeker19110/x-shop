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

export function planProgress(current: ShipmentState, incoming: ShipmentState): ProgressPlan {
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
