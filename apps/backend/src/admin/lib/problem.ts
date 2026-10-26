/**
 * Lỗi API Admin (`application/problem+json`, đặc tả §9.1) → thông điệp tiếng Việt cho người dùng + lỗi theo dòng/cột
 * của file CSV. Thuần (không React/fetch) để test đơn vị.
 */
export interface RowError {
  /** Dòng trong file (1 = header); `null` khi server không nêu. */
  line: number | null;
  column: string;
  message: string;
}

export interface ProblemBody {
  title?: string;
  code?: string;
  errors?: Array<{ param?: unknown; reason?: unknown }>;
  rows?: unknown;
  row_errors?: unknown;
  [key: string]: unknown;
}

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: ProblemBody = {},
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

/** Dựng lỗi từ status + thân JSON (thân không phải problem+json → mã `HTTP_<status>`). */
export function toApiError(status: number, json: unknown): AdminApiError {
  const body: ProblemBody =
    json && typeof json === "object" && !Array.isArray(json) ? (json as ProblemBody) : {};
  const code = typeof body.code === "string" && body.code ? body.code : `HTTP_${status}`;
  const title = typeof body.title === "string" && body.title ? body.title : `Lỗi ${status}`;
  return new AdminApiError(status, code, title, body);
}

export type ProblemAction = "reauth" | "login" | "none";

export interface ProblemView {
  message: string;
  /** `reauth`: cần đăng nhập lại + TOTP; `login`: phiên hết hạn. UI hiển thị hướng dẫn tương ứng. */
  action: ProblemAction;
}

const MESSAGES: Record<string, string> = {
  SELF_APPROVAL:
    "Bạn là người tạo yêu cầu này nên không được tự duyệt. Cần một người khác có quyền duyệt hoàn tiền (nguyên tắc hai người).",
  REFUND_NOT_APPROVED: "Yêu cầu hoàn tiền chưa được duyệt nên chưa thực hiện được.",
  REFUND_EXCEEDS_CAPTURED: "Số tiền hoàn vượt quá số đã thu (kể cả các yêu cầu đang giữ).",
  REFUND_IN_PROGRESS: "Đang có một lần hoàn tiền xử lý cho yêu cầu này. Thử lại sau vài giây.",
  REFUND_PROVIDER_DISABLED: "Cổng thanh toán hoàn tiền đang tắt. Hoàn ngoài hệ thống kèm mã chứng từ.",
  REFUND_METHOD_UNAVAILABLE: "Phương thức hoàn tiền này chưa dùng được cho đơn.",
  REFUND_SPLIT_REQUIRED: "Đơn thanh toán bằng nhiều khoản — cần tách yêu cầu hoàn theo từng khoản.",
  REFUND_RETRY_EXHAUSTED:
    "Yêu cầu hoàn này đã hết lượt thử. Hủy yêu cầu (ghi lý do) rồi tạo yêu cầu mới, thường là hoàn ngoài hệ thống.",
  REFUND_PROVIDER_UNCONFIRMED:
    "Chưa xác nhận được với cổng thanh toán là yêu cầu chưa được hoàn — chưa hủy được. Thử lại sau ít phút.",
  BUSY_RETRY: "Hệ thống đang bận xử lý đơn này. Thử lại sau vài giây.",
  INVALID_STATE: "Trạng thái hiện tại không cho phép thao tác này. Tải lại để xem trạng thái mới nhất.",
  NOT_FOUND: "Không tìm thấy bản ghi.",
  IDEMPOTENCY_CONFLICT: "Yêu cầu trùng khoá nhưng khác nội dung. Tải lại trang rồi thử lại.",
  BATCH_CONFLICT: "Mã batch của hãng đã nhập với nội dung khác.",
  EMPTY_FILE: "File rỗng.",
  EMPTY_BATCH: "File không có dòng dữ liệu nào.",
  IMPORT_HAS_ERRORS: "File nhập còn lỗi — sửa file rồi xem trước lại.",
  UNSUPPORTED_MEDIA_TYPE: "File phải là CSV văn bản (.csv hoặc .txt).",
  RATE_LIMITED: "Thử quá nhiều lần, vui lòng thử lại sau.",
  INTERNAL: "Hệ thống gặp lỗi, thử lại sau. Nếu lặp lại, báo kỹ thuật.",
  HTTP_502:
    "Cổng thanh toán báo lỗi khi hoàn tiền. Yêu cầu được giữ nguyên — có thể thử lại (cùng mã yêu cầu).",
  NETWORK: "Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.",
  TIMEOUT:
    "Máy chủ không phản hồi kịp — kết quả CHƯA RÕ. Tải lại để xem trạng thái mới nhất trước khi thử lại.",
};

const minutes = (seconds: unknown): number | null =>
  typeof seconds === "number" && seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : null;

/** Lỗi theo trường `[{param, reason}]` → "param: reason". */
export function fieldErrorsOf(error: AdminApiError): string[] {
  const list = Array.isArray(error.body.errors) ? error.body.errors : [];
  return list
    .filter((e) => typeof e?.reason === "string")
    .map((e) =>
      typeof e.param === "string" && e.param !== "*" ? `${e.param}: ${String(e.reason)}` : String(e.reason),
    );
}

/** Thông điệp tiếng Việt cho lỗi API; mã lạ → dùng `title` server trả (đã là tiếng Việt). */
export function describeProblem(error: AdminApiError): ProblemView {
  switch (error.code) {
    case "REAUTH_REQUIRED": {
      const m = minutes(error.body.max_age_seconds);
      return {
        action: "reauth",
        message: `Thao tác nhạy cảm cần xác thực lại: đăng xuất, đăng nhập lại và nhập mã TOTP${m ? ` (hiệu lực ${m} phút)` : ""}, rồi thực hiện lại.`,
      };
    }
    case "MFA_REQUIRED":
      return {
        action: "reauth",
        message:
          "Thao tác này cần xác thực hai lớp. Bật và xác minh TOTP cho tài khoản (hoặc đăng nhập lại kèm mã TOTP) rồi thử lại.",
      };
    case "UNAUTHORIZED":
    case "SESSION_EXPIRED":
    case "SESSION_IDLE":
      return { action: "login", message: "Phiên đăng nhập đã hết hạn. Đăng nhập lại rồi thử lại." };
    case "FORBIDDEN": {
      const p = typeof error.body.permission === "string" ? ` (cần quyền ${error.body.permission})` : "";
      return { action: "none", message: `Bạn không có quyền thực hiện thao tác này${p}.` };
    }
    case "VALIDATION": {
      const detail = fieldErrorsOf(error);
      return {
        action: "none",
        message: detail.length ? `Dữ liệu không hợp lệ: ${detail.join("; ")}` : "Dữ liệu không hợp lệ.",
      };
    }
    default:
      return { action: "none", message: MESSAGES[error.code] ?? error.message };
  }
}

const LINE_PARAM = /^line (\d+):\s*(.*)$/;

/** Chuẩn hoá danh sách lỗi dòng/cột (`{line,column,message}`) từ server; bỏ phần tử sai hình dạng. */
export function normalizeRowErrors(list: unknown): RowError[] {
  if (!Array.isArray(list)) return [];
  const out: RowError[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.message !== "string") continue;
    out.push({
      line: typeof e.line === "number" && Number.isInteger(e.line) ? e.line : null,
      column: typeof e.column === "string" && e.column ? e.column : "*",
      message: e.message,
    });
  }
  return out;
}

/**
 * Lỗi theo dòng/cột của một phản hồi lỗi: `rows` (commit catalog 422), `row_errors` (đối soát 422); không có thì suy từ
 * `errors[].param = "line N: cột"`.
 */
export function rowErrorsOf(error: AdminApiError): RowError[] {
  for (const source of [error.body.rows, error.body.row_errors]) {
    const rows = normalizeRowErrors(source);
    if (rows.length) return rows;
  }
  const fallback: RowError[] = [];
  for (const e of Array.isArray(error.body.errors) ? error.body.errors : []) {
    if (typeof e?.param !== "string" || typeof e.reason !== "string") continue;
    const m = LINE_PARAM.exec(e.param);
    if (m) fallback.push({ line: Number(m[1]), column: m[2] || "*", message: e.reason });
  }
  return fallback;
}
