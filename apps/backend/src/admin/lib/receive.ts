/**
 * Nhận hàng trả từng phần (POST /admin/x/returns/:id/receive): mỗi dòng nhận 0…số yêu cầu, ít nhất một dòng > 0. Nhận
 * là MỘT lần (server từ chối nhận lại với số khác) nên UI kiểm kỹ trước khi gửi; hệ quả tồn do server quyết.
 */
export interface ReceivableLine {
  line_id: string;
  quantity: number;
}

export interface ReceiveLinePayload {
  line_id: string;
  quantity: number;
}

export type ReceiveCheck =
  | { ok: true; lines: ReceiveLinePayload[]; total: number; full: boolean }
  | { ok: false; errors: Record<string, string> };

const INT = /^\d{1,2}$/;

/** Bản nháp ban đầu: nhận đủ số yêu cầu từng dòng (người dùng sửa xuống khi thiếu). */
export function initialReceiveDrafts(lines: readonly ReceivableLine[]): Record<string, string> {
  return Object.fromEntries(lines.map((l) => [l.line_id, String(l.quantity)]));
}

/** Kiểm bản nháp: số nguyên 0…số yêu cầu (bắt buộc nhập, kể cả 0), tổng > 0. `full` = nhận đủ mọi dòng. */
export function checkReceive(
  lines: readonly ReceivableLine[],
  drafts: Readonly<Record<string, string | undefined>>,
): ReceiveCheck {
  const errors: Record<string, string> = {};
  const payload: ReceiveLinePayload[] = [];
  let total = 0;
  let full = true;
  for (const line of lines) {
    const text = drafts[line.line_id]?.trim() ?? "";
    if (!INT.test(text)) {
      errors[line.line_id] = "Nhập số lượng đã nhận (số nguyên ≥ 0, nhập 0 nếu chưa nhận).";
      continue;
    }
    const q = Number(text);
    if (q > line.quantity) {
      errors[line.line_id] = `Số nhận (${q}) vượt số yêu cầu (${line.quantity}).`;
      continue;
    }
    if (q < line.quantity) full = false;
    total += q;
    payload.push({ line_id: line.line_id, quantity: q });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (total === 0) return { ok: false, errors: { "*": "Chưa nhận sản phẩm nào." } };
  return { ok: true, lines: payload, total, full };
}
