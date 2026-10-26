import { getClientEnv, getServerEnv } from "../env";
import { clientIpHeader } from "../security/client-ip";

/**
 * Gọi Medusa Store API từ SERVER (publishable key chỉ gắn ở đây; trình duyệt không gọi thẳng backend). Không cache:
 * giỏ/checkout là dữ liệu riêng tư (S-505).
 */
const TIMEOUT_MS = 8000;

export class StoreApiError extends Error {
  override readonly name = "StoreApiError";
  constructor(
    readonly status: number,
    message: string,
    /** `code` của problem+json (checkout) hoặc `type` của lỗi Medusa. */
    readonly code: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface StoreRequest {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
}

export async function storeApi<T>(
  path: string,
  req: StoreRequest = {},
): Promise<{ status: number; data: T }> {
  const base = getServerEnv().MEDUSA_BACKEND_URL;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: req.method ?? "GET",
      headers: {
        accept: "application/json",
        "x-publishable-api-key": getClientEnv().NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
        ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
        // IP khách cho rate limit theo IP ở backend (chỉ khi tin header proxy — lib/security/client-ip.ts).
        ...(await clientIpHeader()),
        ...req.headers,
      },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new StoreApiError(0, "Không kết nối được máy chủ.", "NETWORK");
  }
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === "object" && parsed !== null) json = parsed as Record<string, unknown>;
  } catch {
    // thân rỗng/không phải JSON
  }
  if (!res.ok) {
    const code =
      typeof json.code === "string" ? json.code : typeof json.type === "string" ? json.type : "ERROR";
    const message =
      typeof json.detail === "string" ? json.detail : typeof json.message === "string" ? json.message : "";
    throw new StoreApiError(res.status, message, code, json);
  }
  return { status: res.status, data: json as T };
}
