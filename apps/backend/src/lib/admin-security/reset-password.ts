import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import type { ConfigModule, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { performance } from "node:perf_hooks";
import { generateResetPasswordTokenWorkflow } from "@medusajs/medusa/core-flows";
import { clientIpOf } from "../security/config";
import { sendRateLimited, storeOf } from "./guard";
import { registerAttempt } from "./rate-limit";

/**
 * `POST /auth/:actor_type/:auth_provider/reset-password` (T-143, BE-AUTH-003) — yêu cầu email đặt lại mật khẩu.
 *
 * Route gốc Medusa 2.22.1: chạy `generateResetPasswordTokenWorkflow` (throwOnError: false) rồi `sendStatus(201)` — cùng
 * phản hồi cho email có/không có, nhưng CHỜ workflow xong mới trả: email có identity thì thêm vô hiệu token cũ + ghi token
 * mới + ký JWT + phát sự kiện `auth.password_reset`; email lạ thì dừng ngay ở bước tra identity. Đo qua HTTP (T-143): trung
 * vị ~12,5 ms so với ~9 ms (tỷ lệ theo cặp ~1,37×) → dò được email tồn tại. Route cũng không có rate limit → dội thư.
 *
 * Ở đây (middleware chạy SAU validator gốc `ResetPasswordRequest`, thay handler gốc):
 *  1. rate limit theo (email chuẩn hoá + IP), email, IP — IP gộp IPv6 /64 (`ipRateKey`, T-148); KHÔNG hoàn lượt (mọi lượt
 *     đều 201, không có "thành công" để phân biệt) → vượt ngưỡng 429 + `Retry-After`, như cho mọi email;
 *  2. khởi chạy workflow gốc với đúng đầu vào của route gốc (không chờ), trả `201 Created` (đúng thân/kiểu của
 *     `res.sendStatus(201)`) đúng `RESET_RESPONSE_MS` sau khi nhận request — thời gian phản hồi không phụ thuộc email có
 *     tồn tại. Lỗi workflow vẫn bị nuốt như bản gốc (`throwOnError: false`); lỗi bất ngờ chỉ ghi log không PII.
 */
const MAX_IDENTIFIER = 320;

interface ResetBody {
  identifier: string;
  metadata?: Record<string, unknown>;
}

function validatedResetBody(req: MedusaRequest): ResetBody | null {
  const body = (req as MedusaRequest & { validatedBody?: unknown }).validatedBody;
  if (typeof body !== "object" || body === null) return null;
  const { identifier, metadata } = body as { identifier?: unknown; metadata?: unknown };
  if (typeof identifier !== "string") return null;
  return {
    identifier,
    ...(typeof metadata === "object" &&
      metadata !== null && { metadata: metadata as Record<string, unknown> }),
  };
}

/** Định danh rate limit = `identifier` (email) — chuẩn hoá trim + chữ thường trong `rate-limit.ts`. */
export function resetIdentity(req: MedusaRequest): string | null {
  const raw =
    validatedResetBody(req)?.identifier ?? (req.body as { identifier?: unknown } | undefined)?.identifier;
  return typeof raw === "string" ? raw.slice(0, MAX_IDENTIFIER) : null;
}

/** Đúng lời gọi của route gốc (`@medusajs/medusa` 2.22.1 `auth/[actor_type]/[auth_provider]/reset-password`). */
async function issueResetToken(
  scope: MedusaContainer,
  input: { actorType: string; provider: string; body: ResetBody },
): Promise<void> {
  const { http } = scope.resolve<ConfigModule>(ContainerRegistrationKeys.CONFIG_MODULE).projectConfig;
  await generateResetPasswordTokenWorkflow(scope).run({
    input: {
      entityId: input.body.identifier,
      actorType: input.actorType,
      provider: input.provider,
      secret: http.jwtSecret,
      jwtOptions: http.jwtOptions,
      metadata: input.body.metadata,
    },
    // Như bản gốc: không ném lỗi — identity không tồn tại không được lộ ra.
    throwOnError: false,
  });
}

/**
 * Thời gian phản hồi CỐ ĐỊNH (tính từ lúc middleware nhận request) cho mọi yêu cầu được chấp nhận. Workflow chạy song song
 * và KHÔNG được chờ: phản hồi không phụ thuộc email có tồn tại kể cả khi workflow chậm. Đủ dài để workflow (vài–vài chục
 * ms) xong TRONG khoảng này → việc nền của email có thật không làm chậm request kế tiếp (kênh phụ "probe rồi canary" —
 * trả 201 ngay rồi chạy nền thì request ngay sau chậm hơn ~3 ms khi email tồn tại, đo ở T-143).
 */
export const RESET_RESPONSE_MS = 250;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function resetPasswordGuard(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const startedAt = performance.now();
  const ip = clientIpOf(req).ip ?? "unknown";
  const attempt = await registerAttempt(storeOf(req), "reset", resetIdentity(req), ip);
  if (!attempt.allowed) return sendRateLimited(res, attempt.retryAfterSeconds);

  const body = validatedResetBody(req);
  // Validator gốc không chạy trước (đổi thứ tự middleware khi nâng Medusa) → để route gốc xử lý (vẫn có rate limit).
  if (body === null) return next();

  const scope = req.scope;
  issueResetToken(scope, {
    actorType: String(req.params.actor_type),
    provider: String(req.params.auth_provider),
    body,
  }).catch((e: unknown) => {
    // Không ghi thông điệp lỗi — có thể chứa email (PII).
    scope
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(`[auth] Tạo token đặt lại mật khẩu lỗi: ${e instanceof Error ? e.name : "unknown"}`);
  });
  await sleep(Math.max(0, RESET_RESPONSE_MS - (performance.now() - startedAt)));
  res.sendStatus(201);
}
