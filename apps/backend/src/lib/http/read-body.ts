import type { MedusaRequest } from "@medusajs/framework/http";

export type BodyResult =
  | { ok: true; text: string; fileName: string | null; bytes: Buffer }
  | { ok: false; status: 413 | 415 | 422; code: string; reason: string };

async function readStream(req: MedusaRequest, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Đọc file CSV từ request: `text/csv` (thân thô), `multipart/form-data` (trường `file`, đọc bằng FormData có sẵn của
 * Node) hoặc `text/plain` (Medusa đã parse). Giới hạn kích thước trước khi giải mã; nội dung phải là UTF-8.
 */
export async function readCsvBody(req: MedusaRequest, maxBytes: number): Promise<BodyResult> {
  const ct = String(req.headers["content-type"] ?? "").toLowerCase();
  if (typeof req.body === "string") {
    const bytes = Buffer.from(req.body, "utf8");
    if (bytes.length > maxBytes)
      return { ok: false, status: 413, code: "FILE_TOO_LARGE", reason: `Tối đa ${maxBytes} byte` };
    return { ok: true, text: req.body, fileName: null, bytes };
  }
  const isMultipart = ct.startsWith("multipart/form-data");
  if (!isMultipart && !ct.startsWith("text/csv") && !ct.startsWith("application/octet-stream")) {
    return {
      ok: false,
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
      reason: "Gửi text/csv hoặc multipart/form-data (trường file)",
    };
  }
  // Thân multipart lớn hơn file một chút (ranh giới + header phần).
  const raw = await readStream(req, isMultipart ? maxBytes + 64 * 1024 : maxBytes);
  if (raw === null)
    return { ok: false, status: 413, code: "FILE_TOO_LARGE", reason: `Tối đa ${maxBytes} byte` };
  let bytes = raw;
  let fileName: string | null = null;
  if (isMultipart) {
    let form: FormData;
    try {
      form = await new Request("http://local/upload", {
        method: "POST",
        headers: { "content-type": String(req.headers["content-type"]) },
        body: raw,
      }).formData();
    } catch {
      return { ok: false, status: 422, code: "INVALID_MULTIPART", reason: "Không đọc được multipart" };
    }
    const file = form.get("file");
    if (file === null || typeof file === "string") {
      return { ok: false, status: 422, code: "FILE_MISSING", reason: "Thiếu trường file" };
    }
    bytes = Buffer.from(await file.arrayBuffer());
    fileName = file.name || null;
    if (bytes.length > maxBytes)
      return { ok: false, status: 413, code: "FILE_TOO_LARGE", reason: `Tối đa ${maxBytes} byte` };
  }
  try {
    return { ok: true, text: utf8.decode(bytes), fileName, bytes };
  } catch {
    return { ok: false, status: 422, code: "INVALID_ENCODING", reason: "File phải mã hoá UTF-8" };
  }
}
