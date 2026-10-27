import { catalogRevalidate as protocol } from "@x-shop/domain";
import { secondsToMs } from "../units";

/**
 * Nhận webhook vô hiệu hoá cache catalog từ backend (T-142, D-070, BE-CACHE-007) — route `app/api/revalidate/route.ts`.
 * Giao thức (chuỗi ký, header, tag) ở `@x-shop/domain` `catalogRevalidate`, dùng chung với backend.
 *
 * Thứ tự kiểm: cấu hình → cỡ thân → chữ ký + mốc thời gian (trên thân THÔ) → nonce chưa dùng → schema thân → revalidate.
 * Nonce chỉ được ghi nhớ SAU khi chữ ký đúng: kẻ không có khoá không làm đầy được bộ nhớ nonce.
 *
 * Bộ nhớ nonce nằm trong tiến trình: chặn phát lại tới CHÍNH bản này trong cửa sổ lệch giờ; phát lại sang bản storefront
 * khác (nhiều bản) chỉ làm một lần revalidate thừa — vô hại (revalidate idempotent, không đổi dữ liệu).
 */

/** Tag dữ liệu gộp nhiều sản phẩm (danh sách, tìm kiếm, danh mục). */
export const LIST_TAGS: readonly string[] = [protocol.CATALOG_TAG, protocol.CATALOG_LIST_TAG];

/** Tag dữ liệu PDP theo handle (handle không dựng được tag → chỉ `catalog`, vẫn bị làm mới khi cả catalog đổi). */
export function productTags(handle: string): string[] {
  const tag = protocol.productTag(handle);
  return tag === null ? [protocol.CATALOG_TAG] : [protocol.CATALOG_TAG, tag];
}

/**
 * Hết hạn NGAY (không stale-while-revalidate): `revalidateTag(tag, { expire: 0 })` của Next 16 — lần đọc kế tiếp nạp
 * lại từ backend chặn, không phát bản cũ thêm lần nào (`"max"` thì phát bản cũ một lần rồi mới làm mới nền).
 */
export const REVALIDATE_PROFILE = { expire: 0 } as const;

/** Trần số nonce nhớ cùng lúc (mỗi nonce ~ 50 byte); đầy mà không dọn được → 503 tạm, backend thử lại. */
export const NONCE_STORE_MAX = 10_000;

export type NonceVerdict = "fresh" | "replay" | "full";

/** Nonce đã thấy, nhớ tới hết cửa sổ lệch giờ của mốc đi kèm (sau đó chữ ký đã bị từ chối vì quá hạn). */
export class NonceStore {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly max: number = NONCE_STORE_MAX,
    private readonly toleranceS: number = protocol.REVALIDATE_TOLERANCE_S,
  ) {}

  /** Kiểm rồi ghi nhớ trong cùng một bước đồng bộ (hai request trùng nonce đồng thời: đúng một cái "fresh"). */
  checkAndRemember(nonce: string, timestampS: number, nowMs: number): NonceVerdict {
    const until = this.seen.get(nonce);
    if (until !== undefined && until >= nowMs) return "replay";
    if (this.seen.size >= this.max) this.prune(nowMs);
    if (this.seen.size >= this.max) return "full";
    this.seen.set(nonce, secondsToMs(timestampS + this.toleranceS));
    return "fresh";
  }

  get size(): number {
    return this.seen.size;
  }

  private prune(nowMs: number): void {
    for (const [nonce, until] of this.seen) if (until < nowMs) this.seen.delete(nonce);
  }
}

export interface RevalidateDeps {
  /** Khoá HMAC; `undefined` = webhook tắt (503). */
  secret: string | undefined;
  nonces: NonceStore;
  /** Gọi cho từng tag (route truyền `revalidateTag(tag, REVALIDATE_PROFILE)`). */
  revalidate: (tag: string) => void;
  now?: () => number;
}

const problem = (status: number, code: string, headers: Record<string, string> = {}): Response =>
  Response.json({ code }, { status, headers: { "Cache-Control": "no-store", ...headers } });

const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/** Thân hợp lệ: `{ id, tags }`, 1..REVALIDATE_MAX_TAGS tag đúng dạng giao thức. */
function parseBody(text: string): { id: string; tags: string[] } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { id, tags } = raw as { id?: unknown; tags?: unknown };
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return null;
  if (!Array.isArray(tags) || tags.length === 0 || tags.length > protocol.REVALIDATE_MAX_TAGS) return null;
  if (!tags.every((t) => protocol.isRevalidateTag(t))) return null;
  return { id, tags: [...new Set(tags as string[])] };
}

/**
 * 200 `{ revalidated }` · 400 thân sai · 401 thiếu/sai chữ ký hoặc mốc quá hạn (một mã chung, không lộ lý do) ·
 * 409 phát lại (nonce đã dùng) · 413 thân quá lớn · 503 webhook tắt / bộ nhớ nonce đầy.
 */
export async function handleRevalidate(req: Request, deps: RevalidateDeps): Promise<Response> {
  if (deps.secret === undefined) return problem(503, "REVALIDATE_DISABLED");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > protocol.REVALIDATE_MAX_BODY_BYTES)
    return problem(413, "TOO_LARGE");
  const body = await req.text();
  if (utf8Length(body) > protocol.REVALIDATE_MAX_BODY_BYTES) return problem(413, "TOO_LARGE");
  const now = (deps.now ?? Date.now)();
  const verdict = protocol.verifyRevalidate(
    deps.secret,
    {
      timestamp: req.headers.get(protocol.REVALIDATE_HEADERS.timestamp),
      nonce: req.headers.get(protocol.REVALIDATE_HEADERS.nonce),
      signature: req.headers.get(protocol.REVALIDATE_HEADERS.signature),
    },
    body,
    now,
  );
  if (!verdict.ok) return problem(401, "INVALID_SIGNATURE");
  const seen = deps.nonces.checkAndRemember(verdict.nonce, verdict.timestamp, now);
  if (seen === "replay") return problem(409, "REPLAYED");
  if (seen === "full") return problem(503, "BUSY", { "Retry-After": "5" });
  const parsed = parseBody(body);
  if (parsed === null) return problem(400, "INVALID_BODY");
  for (const tag of parsed.tags) deps.revalidate(tag);
  return Response.json({ revalidated: parsed.tags.length }, { headers: { "Cache-Control": "no-store" } });
}
