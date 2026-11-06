// Chia suite tích hợp http thành N shard cân theo thời lượng (T-198, QA-COV-001) — dùng bởi `list.mjs --http-shard I/N`
// cho job `integration-coverage` của CI. LPT (longest processing time first): suite dài trước, mỗi suite vào shard đang
// nhẹ nhất (hoà → shard số nhỏ hơn); tất định với cùng đầu vào. Trọng số lấy từ http-durations.json; suite chưa có số đo
// nhận trung vị của các số đo (không có số đo nào → 1) để suite mới vẫn được rải đều, không dồn vào một shard.

/** Đọc "I/N" (1 ≤ I ≤ N ≤ 64, số nguyên thập phân không có số 0 đầu); sai → ném lỗi. */
export function parseShard(text) {
  const m = /^([1-9][0-9]?)\/([1-9][0-9]?)$/.exec(String(text ?? ""));
  if (!m) throw new Error(`shard phải dạng I/N (vd 1/8), nhận ${JSON.stringify(text)}`);
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (total > 64 || index > total) throw new Error(`shard ${text}: cần 1 ≤ I ≤ N ≤ 64`);
  return { index, total };
}

/** Trung vị các trọng số dương hợp lệ của `seconds` (rỗng → 1). */
export function medianWeight(seconds) {
  const v = Object.values(seconds ?? {})
    .filter((x) => typeof x === "number" && Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  if (v.length === 0) return 1;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Chia `names` (tên suite, không trùng) thành `total` nhóm. Trả mảng `total` phần tử
 * `{names: string[] (đã sắp xếp), weight: number}`. Nhóm có thể rỗng khi total > số suite.
 */
export function assign(names, seconds, total) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`total phải là số nguyên ≥ 1 (nhận ${total})`);
  if (new Set(names).size !== names.length) throw new Error("danh sách suite có tên trùng");
  const fallback = medianWeight(seconds);
  const weightOf = (n) => {
    const w = seconds?.[n];
    return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : fallback;
  };
  const order = [...names].sort((a, b) => weightOf(b) - weightOf(a) || (a < b ? -1 : a > b ? 1 : 0));
  const bins = Array.from({ length: total }, () => ({ names: [], weight: 0 }));
  for (const n of order) {
    let k = 0;
    for (let i = 1; i < total; i++) if (bins[i].weight < bins[k].weight) k = i;
    bins[k].names.push(n);
    bins[k].weight += weightOf(n);
  }
  for (const b of bins) b.names.sort();
  return bins;
}
