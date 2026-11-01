/**
 * Dò rò rỉ trên thân phản hồi / dòng log mà KHÔNG khớp nhầm ID ngẫu nhiên.
 *
 * Vì sao có file này (đã đỏ giả HAI lần): các test dò LEAK bằng regex có chuỗi chữ số ("5432", "6379", "9431", …).
 * `trace_id` (UUID v4) và `span_id` (16 hex) do máy sinh nên thỉnh thoảng chứa đúng chuỗi đó:
 *   1. UUID `…-6379ab058693` làm gate đỏ giả ở health/default-credentials (regex `5432|6379`);
 *   2. cùng lớp lỗi ở redact-http-db-error (LEAKS có nhóm "9431" khớp UUID/span_id trong dòng log).
 * Cách sửa KHÔNG được là "bỏ im lặng" trường ID (đột biến `trace_id: String(err)` vẫn xanh). Quy tắc: tầng 1 TÁCH
 * ID ra và KIỂM ĐỊNH DẠNG (sai → ném lỗi, test đỏ); tầng 2 chỉ dò regex trên phần còn lại.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/; // randomUUID luôn chữ thường
const SPAN_ID = /^(?!0{16}$)[0-9a-f]{16}$/; // như docs/ops/log-schema.json: không toàn số 0

export interface ProblemProbeOptions {
  /** Giá trị `x-request-id` test đã gửi: khi có, `trace_id` phải đúng bằng giá trị này (thay cho UUID v4). */
  readonly expectedTraceId?: string;
  /** Mặc định `true`: thiếu `trace_id` là lỗi (mọi problem+json đều có). `false` cho thân thành công (không có). */
  readonly requireTraceId?: boolean;
}

export interface ProblemProbe {
  /** `trace_id` đã kiểm định dạng; `undefined` chỉ khi `requireTraceId: false` và thân không có. */
  readonly traceId: string | undefined;
  /** Thân (JSON) đã bỏ `trace_id` — chuỗi để đưa vào `expect(...).not.toMatch(LEAK)`. */
  readonly rest: string;
}

function checkTraceId(value: unknown, expected: string | undefined): string {
  if (typeof value !== "string") throw new Error(`trace_id không phải chuỗi: ${typeof value}`);
  if (expected !== undefined) {
    if (value !== expected) throw new Error(`trace_id=${JSON.stringify(value)} khác x-request-id đã gửi`);
  } else if (!UUID_V4.test(value)) {
    throw new Error(`trace_id sai định dạng UUID v4: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Thân phản hồi problem+json: tách + kiểm `trace_id` ở tầng 1, trả phần còn lại để dò. */
export function probeProblemBody(data: unknown, opts: ProblemProbeOptions = {}): ProblemProbe {
  const { expectedTraceId, requireTraceId = true } = opts;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    if (requireTraceId) throw new Error("thân problem+json không phải object");
    return { traceId: undefined, rest: JSON.stringify(data ?? "") };
  }
  const { trace_id, ...rest } = data as Record<string, unknown>;
  if (trace_id === undefined && !requireTraceId) return { traceId: undefined, rest: JSON.stringify(rest) };
  return { traceId: checkTraceId(trace_id, expectedTraceId), rest: JSON.stringify(rest) };
}

export interface LogProbeOptions {
  /** `trace_id` của phản hồi (hoặc `x-request-id` đã gửi): mọi bản ghi có `trace_id` phải đúng giá trị này. */
  readonly expectedTraceId?: string;
}

export interface LogProbe {
  readonly traceIds: readonly string[];
  readonly spanIds: readonly string[];
  /** Log đã bỏ `trace_id`/`span_id`/`parent_span_id` (và mọi lần xuất hiện nguyên văn của trace_id trong thông điệp). */
  readonly rest: string;
}

/** Dòng log JSON (stdout của logger dự án, nhiều dòng nối nhau): tách + kiểm `trace_id`/`span_id`, trả phần còn lại. */
export function probeLogLines(logged: string | readonly string[], opts: LogProbeOptions = {}): LogProbe {
  const text = typeof logged === "string" ? logged : logged.join("");
  const traceIds: string[] = [];
  const spanIds: string[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    let parsed: unknown;
    // Ghi chú: JSON.parse giữ khoá cuối khi trùng khoá; logger dự án dùng JSON.stringify(object) nên không sinh khoá trùng.
    try {
      parsed = JSON.parse(line);
    } catch {
      kept.push(line); // không phải bản ghi JSON (dòng rỗng, stdout khác) → giữ nguyên để dò
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      kept.push(line);
      continue;
    }
    const { trace_id, span_id, parent_span_id, ...rest } = parsed as Record<string, unknown>;
    if (trace_id !== undefined) traceIds.push(checkTraceId(trace_id, opts.expectedTraceId));
    for (const [k, v] of [
      ["span_id", span_id],
      ["parent_span_id", parent_span_id],
    ] as const) {
      if (v === undefined) continue;
      if (typeof v !== "string" || !SPAN_ID.test(v)) {
        throw new Error(`${k} sai định dạng (16 hex): ${JSON.stringify(v)}`);
      }
      spanIds.push(v);
    }
    kept.push(JSON.stringify(rest));
  }
  let rest = kept.join("\n");
  // Chỉ cắt ID đủ dài khỏi message: x-request-id ngắn (vd "9431") cắt đi sẽ che đúng chuỗi cần dò.
  const MIN_SCRUB_LEN = 16;
  const expected =
    opts.expectedTraceId !== undefined && opts.expectedTraceId.length >= MIN_SCRUB_LEN
      ? [opts.expectedTraceId]
      : [];
  for (const id of new Set([...traceIds, ...expected])) {
    if (id.length < MIN_SCRUB_LEN) continue;
    rest = rest.split(id).join("<trace_id>");
  }
  return { traceIds, spanIds, rest };
}
