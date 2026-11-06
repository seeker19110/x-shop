/**
 * `smoke.mjs --expect-version <v>` (T-213, D-050, WF-REL-007): sau deploy, hỏi GET /admin/x/version (CÓ xác thực admin) và so
 * `version` với bản vừa phát hành. Chỉ ĐỌC, không dựng DB/dataset, không tạo tải — dùng được trên môi trường vừa deploy.
 * Biến: XS_SMOKE_BASE_URL (gốc URL backend, bắt buộc) · XS_SMOKE_ADMIN_TOKEN (Bearer JWT của một admin có quyền `report.read`,
 * bắt buộc; lấy từ kho bí mật của pipeline — KHÔNG đưa lên dòng lệnh, không được in ra).
 * Thoát: 0 khớp · 1 lệch/lỗi gọi (401/403/mạng/trả sai dạng) · 2 thiếu/sai cấu hình.
 */

/** Giá trị của `--expect-version <v>` hoặc `--expect-version=<v>`; không có cờ → undefined; có cờ thiếu giá trị → ném lỗi. */
export function parseExpectVersion(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--expect-version") {
      const v = argv[i + 1];
      if (v === undefined || v === "" || v.startsWith("--"))
        throw new Error("--expect-version cần một giá trị phiên bản");
      return v;
    }
    if (a.startsWith("--expect-version=")) {
      const v = a.slice("--expect-version=".length);
      if (v === "") throw new Error("--expect-version cần một giá trị phiên bản");
      return v;
    }
  }
  return undefined;
}

const isLoopback = (host) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/** URL gốc hợp lệ: https, hoặc http chỉ với loopback (không gửi token admin qua kênh không mã hoá ra ngoài máy). */
export function versionUrl(baseUrl) {
  let u;
  try {
    u = new URL(String(baseUrl));
  } catch {
    throw new Error(`XS_SMOKE_BASE_URL không hợp lệ: "${baseUrl}"`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopback(u.hostname))) {
    throw new Error(
      "XS_SMOKE_BASE_URL phải là https (http chỉ cho localhost) — token admin không đi qua kênh thường",
    );
  }
  return `${u.origin}/admin/x/version`;
}

/**
 * Trả { ok, detail }. Không ném với lỗi mạng/HTTP (trả ok=false) để gọi in rõ lý do; ném với cấu hình sai.
 * `detail` không bao giờ chứa token.
 */
export async function verifyVersion({ baseUrl, token, expected, fetchImpl = fetch, timeoutMs = 10_000 }) {
  if (!token) throw new Error("thiếu XS_SMOKE_ADMIN_TOKEN");
  if (!expected) throw new Error("thiếu phiên bản mong đợi");
  const url = versionUrl(baseUrl);
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error", // không theo chuyển hướng: tránh gửi token admin sang nơi khác
    });
  } catch (e) {
    return {
      ok: false,
      detail: `GET /admin/x/version lỗi mạng: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (res.status !== 200) {
    return {
      ok: false,
      detail: `GET /admin/x/version → ${res.status} (cần 200: token hết hạn/thiếu quyền report.read?)`,
    };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, detail: "GET /admin/x/version trả thân không phải JSON" };
  }
  if (typeof body?.version !== "string" || body.version === "") {
    return { ok: false, detail: "GET /admin/x/version thiếu trường version" };
  }
  if (body.version !== expected) {
    return { ok: false, detail: `phiên bản lệch: đang chạy "${body.version}", mong đợi "${expected}"` };
  }
  const extra = [body.commit && `commit ${body.commit}`, body.built_at && `built_at ${body.built_at}`]
    .filter(Boolean)
    .join(", ");
  return { ok: true, detail: `phiên bản khớp: ${body.version}${extra ? ` (${extra})` : ""}` };
}
