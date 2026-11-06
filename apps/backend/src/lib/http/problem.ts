import type { MedusaResponse } from "@medusajs/framework/http";
import { traceIdOf } from "../errors/trace";

/**
 * Lỗi HTTP dạng RFC 9457 (application/problem+json) với `code` ổn định và danh sách lỗi theo trường (đặc tả §9.1).
 * Mọi thân lỗi có `trace_id` (mã request, cùng mã trong log — BASE-ERR-003, lib/errors/trace.ts).
 */
export interface ProblemError {
  param: string;
  reason: string;
}

export function sendProblem(
  res: MedusaResponse,
  status: number,
  code: string,
  title: string,
  errors: ProblemError[] = [],
  extra: Record<string, unknown> = {},
): void {
  res
    .status(status)
    .setHeader("Content-Type", "application/problem+json; charset=utf-8")
    .setHeader("Cache-Control", "no-store")
    .send(
      JSON.stringify({
        type: "about:blank",
        title,
        status,
        code,
        errors,
        ...extra,
        trace_id: traceIdOf(res.req),
      }),
    );
}

/** Chuyển lỗi zod (v4) thành danh sách {param, reason}. */
export function zodErrors(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): ProblemError[] {
  return issues.map((i) => ({ param: i.path.map(String).join(".") || "*", reason: i.message }));
}
