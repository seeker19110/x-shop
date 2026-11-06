import { bytesToMib, mibToBytes } from "./units";

/** Kiểm file CSV phía trình duyệt trước khi gửi (server vẫn kiểm lại — đây chỉ để báo sớm). */
export const MAX_CATALOG_CSV_BYTES = mibToBytes(2);
export const MAX_SETTLEMENT_CSV_BYTES = mibToBytes(1);

/** Trả thông báo lỗi tiếng Việt, hoặc `null` nếu file dùng được. */
export function checkCsvFile(file: { name: string; size: number }, maxBytes: number): string | null {
  if (!/\.(csv|txt)$/i.test(file.name)) return "File phải có đuôi .csv hoặc .txt.";
  if (file.size === 0) return "File rỗng.";
  if (file.size > maxBytes) return `File lớn hơn ${Math.round(bytesToMib(maxBytes))} MB.`;
  return null;
}
