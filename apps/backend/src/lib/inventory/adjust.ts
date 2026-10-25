import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { updateInventoryLevelsWorkflow } from "@medusajs/medusa/core-flows";
import { decideIdempotency, payloadHash } from "@x-shop/domain";
import { z } from "zod";
import { AUDIT_MODULE } from "../../modules/audit";
import type AuditModuleService from "../../modules/audit/service";
import { isUniqueViolation, type InventoryAdjustment } from "../../modules/audit/service";
import type { AuditEntryInput } from "../../modules/audit/service";
import { CHECKOUT_CONFIG } from "../checkout/config";
import { acquireOrdered, lockKeys, releaseOwned } from "../checkout/locks";

/**
 * Điều chỉnh tồn có kiểm soát (T-025, INV03, SPEC-admin S-404): lý do trong danh mục, người làm, trước/sau, khóa chống
 * trùng; không giảm dưới số đang giữ (reserved_quantity). Chạy dưới khóa `inventory_item:<id>` — CÙNG tiền tố khóa của
 * checkout (lib/checkout/locks.ts) nên không xen giữa lúc checkout đọc tồn/giữ hàng của cùng SKU.
 */
export const ADJUST_REASONS = {
  cycle_count: "either",
  correction: "either",
  receiving: "increase",
  found: "increase",
  damaged: "decrease",
  lost: "decrease",
  return_to_supplier: "decrease",
  quarantine: "decrease",
  /* Hàng trả (T-027, INV04) — luồng tự động của module returns, khóa chống trùng theo dòng trả:
   * nhận → kho cách ly (không cấp bán); đạt kiểm định → chuyển cách ly → kho bán; không đạt → trả lại khách. */
  return_received: "increase",
  return_restock: "either",
  return_rejected: "decrease",
} as const;
export type AdjustReason = keyof typeof ADJUST_REASONS;

/** |delta| tối đa mỗi lần — chặn gõ nhầm số lớn và tràn cột integer. */
export const MAX_ADJUST_DELTA = 1_000_000;

export const AdjustmentBody = z
  .object({
    inventory_item_id: z.string().trim().min(1).max(128),
    location_id: z.string().trim().min(1).max(128),
    delta: z
      .number()
      .int({ message: "phải là số nguyên" })
      .refine((n) => n !== 0, { message: "khác 0" })
      .refine((n) => Math.abs(n) <= MAX_ADJUST_DELTA, { message: `|delta| ≤ ${MAX_ADJUST_DELTA}` }),
    reason: z.enum(Object.keys(ADJUST_REASONS) as [AdjustReason, ...AdjustReason[]], {
      message: `phải là một trong ${Object.keys(ADJUST_REASONS).join("|")}`,
    }),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    const dir = ADJUST_REASONS[b.reason];
    if ((dir === "increase" && b.delta < 0) || (dir === "decrease" && b.delta > 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["delta"],
        message: dir === "increase" ? "lý do này chỉ cho tăng tồn" : "lý do này chỉ cho giảm tồn",
      });
    }
  });
export type AdjustmentInput = z.output<typeof AdjustmentBody>;

export class AdjustError extends Error {
  constructor(
    readonly status: number,
    readonly code: "NOT_FOUND" | "BELOW_RESERVED" | "IDEMPOTENCY_CONFLICT",
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type Audit = Pick<AuditEntryInput, "actor_type" | "actor_id" | "request_id" | "ip_hash">;

function replayOrConflict(existing: InventoryAdjustment, hash: string): InventoryAdjustment {
  if (decideIdempotency({ payloadHash: existing.payload_hash }, hash) === "conflict") {
    throw new AdjustError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key đã dùng cho một điều chỉnh khác");
  }
  return existing;
}

async function setStocked(scope: MedusaContainer, input: AdjustmentInput, stocked: number) {
  await updateInventoryLevelsWorkflow(scope).run({
    input: {
      updates: [
        {
          inventory_item_id: input.inventory_item_id,
          location_id: input.location_id,
          stocked_quantity: stocked,
        },
      ],
    },
  });
}

export async function adjustInventory(
  scope: MedusaContainer,
  key: string,
  input: AdjustmentInput,
  audit: Audit,
): Promise<{ replayed: boolean; adjustment: InventoryAdjustment }> {
  const ledger = scope.resolve<AuditModuleService>(AUDIT_MODULE);
  const hash = payloadHash(input);
  const prior = await ledger.findAdjustmentByKey(key);
  if (prior) return { replayed: true, adjustment: replayOrConflict(prior, hash) };

  const locking = scope.resolve(Modules.LOCKING);
  const ownerId = `inventory-adjust:${randomUUID()}`;
  await acquireOrdered(locking, [lockKeys.inventoryItem(input.inventory_item_id)], {
    ownerId,
    waitMs: CHECKOUT_CONFIG.lockWaitMs,
    ttlSeconds: CHECKOUT_CONFIG.lockTtlSeconds,
    scope: "inventory",
  });
  try {
    // Kiểm lại dưới khóa: request trùng khóa cùng SKU đã chạy xong trong lúc chờ.
    const again = await ledger.findAdjustmentByKey(key);
    if (again) return { replayed: true, adjustment: replayOrConflict(again, hash) };

    const [level] = await scope
      .resolve(Modules.INVENTORY)
      .listInventoryLevels({ inventory_item_id: input.inventory_item_id, location_id: input.location_id });
    if (!level) throw new AdjustError(404, "NOT_FOUND", "Không thấy tồn của SKU tại kho này");
    const before = Number(level.stocked_quantity);
    const reserved = Number(level.reserved_quantity);
    const after = before + input.delta;
    if (after < reserved) {
      throw new AdjustError(409, "BELOW_RESERVED", "Không thể giảm tồn xuống dưới số đang giữ cho đơn", {
        stocked_quantity: before,
        reserved_quantity: reserved,
        max_decrease: Math.max(0, before - reserved),
      });
    }

    await setStocked(scope, input, after);
    try {
      const adjustment = await ledger.recordAdjustment(
        {
          idempotency_key: key,
          payload_hash: hash,
          actor_id: audit.actor_id,
          inventory_item_id: input.inventory_item_id,
          location_id: input.location_id,
          delta: input.delta,
          reason: input.reason,
          note: input.note ?? null,
          stocked_before: before,
          stocked_after: after,
          reserved_quantity: reserved,
        },
        audit,
      );
      return { replayed: false, adjustment };
    } catch (e) {
      // Không ghi được sổ → hoàn tồn về trước (vẫn đang giữ khóa nên không ai đổi tồn ở giữa).
      await setStocked(scope, input, before);
      if (isUniqueViolation(e)) {
        // Cùng khóa, SKU khác chạy song song đã ghi trước → trả theo bản đã ghi.
        const winner = await ledger.findAdjustmentByKey(key);
        if (winner) return { replayed: true, adjustment: replayOrConflict(winner, hash) };
      }
      throw e;
    }
  } finally {
    await releaseOwned(locking, ownerId, null);
  }
}
