import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import type { ConfigModule, IAuthModuleService, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { generateResetPasswordTokenWorkflow } from "@medusajs/medusa/core-flows";
import { randomInt } from "node:crypto";
import { sendProblem } from "../http/problem";
import { isDraining } from "../lifecycle/shutdown";
import { clientIpOf } from "../security/config";
import { sendRateLimited, storeOf } from "./guard";
import { registerAttempt } from "./rate-limit";
import type { SecurityStore } from "./store";
import { secondsToMs } from "@x-shop/domain";
import { AuthRouteParams, readParams } from "../http/request-input";

/**
 * `POST /auth/:actor_type/:auth_provider/reset-password` (T-143, BE-AUTH-003, D-085, D-086) — yêu cầu email đặt lại mật
 * khẩu.
 *
 * Route gốc Medusa 2.22.1: chạy `generateResetPasswordTokenWorkflow` (throwOnError: false) rồi `sendStatus(201)` — cùng
 * phản hồi cho email có/không có, nhưng CHỜ workflow xong mới trả: email có identity thì thêm vô hiệu token cũ + ghi token
 * mới + ký JWT + phát sự kiện `auth.password_reset`; email lạ thì dừng ngay ở bước tra identity. Đo qua HTTP (T-143): trung
 * vị ~12,5 ms so với ~9 ms (tỷ lệ theo cặp ~1,37×) → dò được email tồn tại. Route cũng không có rate limit → dội thư.
 *
 * Ở đây (middleware chạy SAU validator gốc `ResetPasswordRequest`, thay handler gốc):
 *  1. rate limit TRÊN ĐƯỜNG REQUEST chỉ theo IP và (email chuẩn hoá + IP) — IP gộp IPv6 /64 (`ipRateKey`, T-148); không
 *     hoàn lượt (mọi lượt đều 201); bộ đếm kẹp ở ngưỡng + 1 nên dồn request không kéo dài khoá. KHÔNG có ngưỡng theo email
 *     trên đường request (D-085): kẻ khác gửi biến thể hoa/thường email nạn nhân từ IP của họ không khoá được nạn nhân;
 *  2. trả `201 Created` (đúng thân/kiểu của `res.sendStatus(201)`) đúng `RESET_RESPONSE_MS` sau khi nhận request — không
 *     có việc gì phụ thuộc email trong khoảng đó;
 *  3. việc nền bắt đầu sau độ trễ ngẫu nhiên đều 0–`RESET_WORK_MAX_DELAY_MS` (D-086, timer `unref`, bỏ khi tiến trình đang
 *     tắt): tra identity; có thật → ngưỡng theo email (`perIdentity`, chỉ đếm cho identity có thật) → vượt thì bỏ âm thầm,
 *     còn lại chạy workflow gốc với đúng đầu vào của route gốc. Email lạ → không làm gì thêm (workflow gốc cũng chỉ thất
 *     bại ở bước tra identity). `metadata` của thân bị BỎ (dashboard chỉ gửi `identifier`, dự án không có subscriber đọc
 *     nó) — không cho kẻ dò khuếch đại việc nền bằng thân lớn.
 *
 * Rủi ro còn lại (docs/ops/THREAT-MODEL.md R-07): việc nền của email có thật vẫn tốn CPU/DB trong cùng tiến trình — request
 * khác chạy CÙNG LÚC với nó chậm đi đôi chút; độ trễ ngẫu nhiên trải việc đó trên cửa sổ 5 s nên kẻ dò không biết đo lúc
 * nào, phải lặp rất nhiều lần (và bị rate limit theo IP chặn trước).
 */
const MAX_IDENTIFIER = 320;

/** Thời gian phản hồi CỐ ĐỊNH (tính từ lúc middleware nhận request) cho mọi yêu cầu được chấp nhận. */
export const RESET_RESPONSE_MS = 250;
/** Trần độ trễ ngẫu nhiên trước khi bắt đầu việc nền (tra identity + workflow). */
export const RESET_WORK_MAX_DELAY_MS = secondsToMs(5);

/** Thân hợp lệ chung (không phân biệt lý do) khi không có thân đã validate — không nhường handler gốc (lộ thời gian). */
export const RESET_INVALID = { status: 400, code: "INVALID_REQUEST", title: "Yêu cầu không hợp lệ" } as const;

interface ResetInput {
  identifier: string;
  actorType: string;
  provider: string;
}

function validatedIdentifier(req: MedusaRequest): string | null {
  const body = (req as MedusaRequest & { validatedBody?: unknown }).validatedBody;
  if (typeof body !== "object" || body === null) return null;
  const { identifier } = body as { identifier?: unknown };
  return typeof identifier === "string" ? identifier : null;
}

/** Định danh rate limit = `identifier` (email) — chuẩn hoá trim + chữ thường trong `rate-limit.ts`. */
export function resetIdentity(req: MedusaRequest): string | null {
  const raw = validatedIdentifier(req) ?? (req.body as { identifier?: unknown } | undefined)?.identifier;
  return typeof raw === "string" ? raw.slice(0, MAX_IDENTIFIER) : null;
}

/** Độ trễ ngẫu nhiên đều trong [0, RESET_WORK_MAX_DELAY_MS] (CSPRNG). */
export const resetWorkDelayMs = (): number => randomInt(0, RESET_WORK_MAX_DELAY_MS + 1);

/**
 * Việc nền của một yêu cầu đã được chấp nhận. Trả lý do để test kiểm; không ném lỗi ra ngoài nơi gọi.
 * Đầu vào workflow = đúng lời gọi của route gốc (`@medusajs/medusa` 2.22.1), trừ `metadata` (bỏ — xem đầu file).
 */
export async function processResetRequest(
  scope: MedusaContainer,
  store: SecurityStore,
  input: ResetInput,
): Promise<"no_identity" | "identity_limited" | "issued"> {
  const auth = scope.resolve<IAuthModuleService>(Modules.AUTH);
  const found = await auth.listProviderIdentities(
    { entity_id: input.identifier, provider: input.provider },
    { take: 1 },
  );
  if (found.length === 0) return "no_identity";
  // Ngưỡng theo email chỉ cho identity có thật, ngoài đường request: vượt → bỏ âm thầm (phản hồi đã là 201).
  const quota = await registerAttempt(store, "reset", input.identifier, "", new Date(), ["id"]);
  if (!quota.allowed) return "identity_limited";
  const { http } = scope.resolve<ConfigModule>(ContainerRegistrationKeys.CONFIG_MODULE).projectConfig;
  await generateResetPasswordTokenWorkflow(scope).run({
    input: {
      entityId: input.identifier,
      actorType: input.actorType,
      provider: input.provider,
      secret: http.jwtSecret,
      jwtOptions: http.jwtOptions,
      metadata: {},
    },
    // Như bản gốc: không ném lỗi.
    throwOnError: false,
  });
  return "issued";
}

function scheduleResetWork(scope: MedusaContainer, store: SecurityStore, input: ResetInput): void {
  const timer = setTimeout(() => {
    if (isDraining()) return;
    processResetRequest(scope, store, input).catch((e: unknown) => {
      // Không ghi thông điệp lỗi — có thể chứa email (PII).
      scope
        .resolve(ContainerRegistrationKeys.LOGGER)
        .warn(`[auth] Việc nền đặt lại mật khẩu lỗi: ${e instanceof Error ? e.name : "unknown"}`);
    });
  }, resetWorkDelayMs());
  timer.unref();
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function resetPasswordGuard(req: MedusaRequest, res: MedusaResponse) {
  const startedAt = Date.now();
  const store = storeOf(req);
  const ip = clientIpOf(req).ip ?? "unknown";
  const attempt = await registerAttempt(store, "reset", resetIdentity(req), ip, new Date(), ["ip", "idip"]);
  if (!attempt.allowed) return sendRateLimited(res, attempt.retryAfterSeconds);

  const identifier = validatedIdentifier(req);
  // Validator gốc không chạy trước (đổi thứ tự middleware khi nâng Medusa) → từ chối an toàn, KHÔNG nhường handler gốc
  // (handler gốc chờ workflow → lộ thời gian theo email).
  if (identifier === null) {
    return sendProblem(res, RESET_INVALID.status, RESET_INVALID.code, RESET_INVALID.title);
  }

  const params = readParams(req, AuthRouteParams);
  scheduleResetWork(req.scope, store, {
    identifier,
    actorType: params.ok ? params.data.actor_type : "",
    provider: params.ok ? params.data.auth_provider : "",
  });
  await sleep(Math.max(0, RESET_RESPONSE_MS - (Date.now() - startedAt)));
  res.sendStatus(201);
}
