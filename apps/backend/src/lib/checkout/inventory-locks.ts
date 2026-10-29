import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { randomUUID } from "node:crypto";
import { CHECKOUT_CONFIG } from "./config";
import { CheckoutError } from "./errors";
import { acquireOrdered, lockKeys, releaseOwnedOrWarn } from "./locks";

/**
 * Khóa `inventory_item:<id>` cho đường NHẢ giữ hàng ngoài checkout (T-224, hậu kiểm T-185): hết hạn giữ
 * (`cancelNativeOrder`), bù trừ attempt chết (`reconcileAttempts`), khách/nhân viên hủy (`releaseReservations`).
 *
 * Vì sao cần: các bước reservation của Medusa (`createReservationsStep`, `deleteReservations*Step`) chỉ khóa id THÔ
 * (`<inventory_item_id>`) quanh lời gọi module; còn đường tồn của dự án (checkout kiểm tồn rồi giữ, xuất kho trả lại
 * reservation bằng `restoreReservationItems` gọi thẳng module, điều chỉnh tồn) khóa id CÓ TIỀN TỐ (`inventory_item:<id>`,
 * lib/checkout/locks.ts). Hai họ khóa không loại trừ nhau: một lần nhả chỉ giữ khóa thô chạy chen giữa "đọc reserved" và
 * "ghi reserved tuyệt đối" (Medusa 2.22.1 ghi `reserved = đọc + Δ`) của một đường chỉ giữ khóa tiền tố → phiên commit sau
 * ghi đè số giữ, bị hàng rào DB từ chối vế `drift` (23514 → BUSY_RETRY / lỗi job). Nhả dưới khóa tiền tố → mọi đường
 * ghi tồn của dự án tuần tự theo SKU.
 *
 * THỨ TỰ KHÓA TOÀN CỤC (mọi đường lấy theo lớp, mỗi lớp một lời gọi `acquireOrdered`, trong lớp sắp tăng dần):
 *   `cart:` → `order:` → `inventory_item:` → `promotion:` → (khóa id thô của Medusa, luôn trong cùng — chỉ do step native
 *   lấy quanh lời gọi module, không giữ qua bước khác).
 * Hàm này chỉ lấy lớp `inventory_item:` — caller có thể đang giữ `cart:` (reconcile) hoặc `order:` (hết hạn, hủy, đổi trả)
 * nhưng KHÔNG được đang giữ `inventory_item:`/`promotion:` (chủ khóa khác nhau → tự chờ chính mình tới hết hạn). KHÔNG
 * trộn lớp vào một lời gọi `acquireOrdered`: sắp theo mã ký tự đặt `inventory_item:` trước `order:` — sai thứ tự lớp.
 *
 * Tập SKU đọc TRƯỚC khi có khóa (cần biết khóa nào) rồi đọc lại SAU khi có: thêm SKU mới (reservation sinh giữa hai lần
 * đọc) → nhả hết, lấy lại tập hợp lớn hơn, tối đa `RELEASE_LOCK_ROUNDS` vòng rồi BUSY_RETRY. Không có reservation → chạy
 * `fn` không khóa (không có gì để nhả; reservation của đơn/attempt chỉ sinh trong submit của chính nó).
 */
export const RELEASE_LOCK_ROUNDS = 3;

export interface InventoryLockOptions {
  /** Đường job (T-174): đang tắt thì thôi chờ khóa bận, báo BUSY_RETRY (đơn vị để lượt sau). HTTP: mặc định tắt. */
  abortWhenDraining?: boolean;
  /** Nhãn log khi nhả khóa lỗi. */
  label: string;
}

export async function withInventoryItemLocks<T>(
  container: MedusaContainer,
  itemsOf: () => Promise<readonly string[]>,
  fn: () => Promise<T>,
  opts: InventoryLockOptions,
): Promise<T> {
  const want = new Set(await itemsOf());
  if (want.size === 0) return fn();
  const locking = container.resolve(Modules.LOCKING);
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  for (let round = 0; round < RELEASE_LOCK_ROUNDS; round++) {
    const owner = `release:${randomUUID()}`;
    await acquireOrdered(
      locking,
      [...want].map((id) => lockKeys.inventoryItem(id)),
      {
        ownerId: owner,
        waitMs: CHECKOUT_CONFIG.lockWaitMs,
        ttlSeconds: CHECKOUT_CONFIG.lockTtlSeconds,
        scope: "inventory",
        abortWhenDraining: opts.abortWhenDraining === true,
      },
    );
    try {
      const missing = (await itemsOf()).filter((id) => !want.has(id));
      if (missing.length === 0) return await fn();
      for (const id of missing) want.add(id);
    } finally {
      await releaseOwnedOrWarn(locking, owner, logger, opts.label);
    }
  }
  throw new CheckoutError("BUSY_RETRY", undefined, { detail: { lock_scope: "inventory" } });
}

const uniqueItems = (rows: ReadonlyArray<{ inventory_item_id: string }>) => [
  ...new Set(rows.map((r) => r.inventory_item_id)),
];

/** SKU (inventory item) của các reservation còn sống trong `ids`. */
export async function inventoryItemsOfReservations(
  container: MedusaContainer,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await container
    .resolve(Modules.INVENTORY)
    .listReservationItems({ id: [...ids] }, { select: ["id", "inventory_item_id"] });
  return uniqueItems(rows);
}

/** Reservation còn sống theo các dòng của đơn native. */
export async function reservationsOfOrder(
  container: MedusaContainer,
  orderId: string,
): Promise<Array<{ id: string; inventory_item_id: string }>> {
  const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: "order",
    fields: ["id", "items.id"],
    filters: { id: orderId },
  });
  const lineIds = (data as Array<{ items?: Array<{ id: string } | null> }>).flatMap((o) =>
    (o.items ?? []).flatMap((i) => (i ? [i.id] : [])),
  );
  if (lineIds.length === 0) return [];
  const rows = await container
    .resolve(Modules.INVENTORY)
    .listReservationItems({ line_item_id: lineIds }, { select: ["id", "inventory_item_id"] });
  return rows.map((r) => ({ id: r.id, inventory_item_id: r.inventory_item_id }));
}

/** SKU của các reservation còn sống theo dòng của đơn native. */
export async function inventoryItemsOfOrder(container: MedusaContainer, orderId: string): Promise<string[]> {
  return uniqueItems(await reservationsOfOrder(container, orderId));
}
