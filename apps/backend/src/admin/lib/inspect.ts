/**
 * Kiểm định hàng trả theo D-019: mỗi dòng đã nhận chia thành đạt (nhập lại tồn bán) / lỗi (ở kho cách ly) / không đạt
 * (= phần còn lại, trả lại khách). UI chỉ kiểm hợp lệ số lượng — mọi hệ quả tồn/tiền do server quyết.
 */
export interface InspectableLine {
  line_id: string;
  received_quantity: number | null;
}

/** Số người dùng nhập, giữ chuỗi để phân biệt "chưa nhập" với 0. */
export interface InspectDraft {
  restock: string;
  damaged: string;
  note: string;
}

export interface InspectLinePayload {
  line_id: string;
  restock_quantity: number;
  damaged_quantity: number;
  note?: string;
}

export type InspectCheck =
  | { ok: true; lines: InspectLinePayload[]; rejected: Record<string, number> }
  | { ok: false; errors: Record<string, string> };

const INT = /^\d{1,2}$/;

/**
 * Kiểm bản nháp: chỉ các dòng ĐÃ NHẬN (received > 0) cần kết quả, và mọi dòng đó phải được nhập rõ cả "đạt" lẫn
 * "lỗi" (không mặc định — tránh vô tình trả hàng tốt cho khách). Đạt + lỗi ≤ đã nhận; không đạt = phần còn lại.
 */
export function checkInspection(
  lines: readonly InspectableLine[],
  drafts: Readonly<Record<string, InspectDraft | undefined>>,
): InspectCheck {
  const errors: Record<string, string> = {};
  const payload: InspectLinePayload[] = [];
  const rejected: Record<string, number> = {};
  for (const line of lines) {
    const received = line.received_quantity ?? 0;
    if (received <= 0) continue;
    const d = drafts[line.line_id];
    const restockText = d?.restock.trim() ?? "";
    const damagedText = d?.damaged.trim() ?? "";
    if (!INT.test(restockText) || !INT.test(damagedText)) {
      errors[line.line_id] = "Nhập số lượng đạt và lỗi (số nguyên ≥ 0, nhập 0 nếu không có).";
      continue;
    }
    const restock = Number(restockText);
    const damaged = Number(damagedText);
    if (restock + damaged > received) {
      errors[line.line_id] = `Đạt + lỗi (${restock + damaged}) vượt số đã nhận (${received}).`;
      continue;
    }
    rejected[line.line_id] = received - restock - damaged;
    const note = d?.note.trim() ?? "";
    payload.push({
      line_id: line.line_id,
      restock_quantity: restock,
      damaged_quantity: damaged,
      ...(note && { note: note.slice(0, 500) }),
    });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (payload.length === 0) return { ok: false, errors: { "*": "Chưa có dòng nào được nhận để kiểm định." } };
  return { ok: true, lines: payload, rejected };
}
