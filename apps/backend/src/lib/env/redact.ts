/**
 * Đánh dấu trường bí mật của cấu hình và che chúng khi in/dump (BASE-CFG-005; SEC-SECRET-007).
 *
 * `SECRET_ENV_KEYS` là danh sách TÊN BIẾN bí mật (khoá ký, khoá mã hoá, token, URL kèm mật khẩu). `SECRET_CONFIG_FIELDS`
 * là tên trường của đối tượng cấu hình đã dựng (camelCase / lồng nhau) mang cùng giá trị. Thêm biến bí mật mới = thêm vào
 * đây; test `env-redact.unit.spec.ts` có hàng rào bắt trường tên "giống bí mật" mà chưa đăng ký.
 */

export const SECRET_ENV_KEYS = [
  // URL chứa user:mật-khẩu
  "DATABASE_URL",
  "REDIS_URL",
  "JWT_SECRET",
  "COOKIE_SECRET",
  "AUTH_MFA_ENCRYPTION_KEY",
  "ORDER_LOOKUP_SECRET",
  "VNPAY_HASH_SECRET",
  "VNPAY_HASH_SECRET_PREVIOUS",
  "GHN_TOKEN",
] as const;

export const SECRET_CONFIG_FIELDS = [
  "orderLookupSecret",
  "hashSecret",
  "hashSecretPrevious",
  "token",
] as const;

export const REDACTED = "***";

const SECRET_NAMES: ReadonlySet<string> = new Set<string>([...SECRET_ENV_KEYS, ...SECRET_CONFIG_FIELDS]);

/** Tên trường trông như bí mật (dùng cho hàng rào trong test, không dùng để quyết định che). */
export const SECRET_LOOKING_NAME =
  /secret|token|password|passwd|private[_-]?key|encryption[_-]?key|_key$|credential/i;

export const isSecretName = (name: string): boolean => SECRET_NAMES.has(name);

/**
 * Bản sao sâu của cấu hình với mọi trường bí mật (khớp tên) thay bằng `***`. `null`/`undefined` giữ nguyên (cho biết
 * "chưa đặt" mà không lộ giá trị). Vòng tham chiếu được cắt. Không sửa đối tượng gốc.
 */
export function redactConfig<T>(value: T): T {
  return walk(value, new WeakSet()) as T;
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, seen));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = isSecretName(key) && v !== null && v !== undefined ? REDACTED : walk(v, seen);
  }
  return out;
}

/** Cấu hình hiệu lực dạng văn bản (JSON, đã che) cho `--print-config`/log khởi động/trang debug. */
export function formatEffectiveConfig(config: unknown): string {
  return JSON.stringify(redactConfig(config), null, 2);
}
