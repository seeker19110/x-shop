import { recordEvent } from "../../../lib/analytics/stats";
import { validateEvent } from "../../../lib/analytics/validate";

export const dynamic = "force-dynamic";

const MAX_BODY = 8 * 1024;

function problem(status: number, code: string): Response {
  return Response.json({ code }, { status, headers: { "Cache-Control": "no-store" } });
}

/** 204 khi hợp lệ; 400 JSON/schema sai hoặc dữ liệu giống PII; 413 quá lớn. Chưa lưu gì — chỉ đếm. */
export async function POST(req: Request): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_BODY) {
    recordEvent(null);
    return problem(413, "TOO_LARGE");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    recordEvent(null);
    return problem(400, "INVALID_JSON");
  }
  const r = validateEvent(raw);
  if (!r.ok) {
    recordEvent(null);
    return problem(400, r.reason === "pii" ? "PII_REJECTED" : "INVALID_EVENT");
  }
  recordEvent(r.event.event);
  return new Response(null, { status: 204 });
}
