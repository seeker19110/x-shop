import { toNfc, slugify } from "../catalog/text.js";

/**
 * CSV theo RFC 4180 (dấu phẩy, ngoặc kép, xuống dòng trong ô), UTF-8, bỏ BOM. Trả mảng dòng → mảng ô.
 * Giới hạn kích thước để tránh làm treo tiến trình (ADM02).
 */
export function parseCsv(text: string, maxRows = 20_000): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") inQuotes = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (!(row.length === 1 && row[0] === "")) rows.push(row);
      row = [];
      if (rows.length > maxRows) throw new Error(`CSV vượt ${maxRows} dòng`);
    } else cell += ch;
  }
  if (inQuotes) throw new Error("CSV có ô ngoặc kép chưa đóng");
  row.push(cell);
  if (!(row.length === 1 && row[0] === "")) rows.push(row);
  return rows;
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** Ô xuất CSV an toàn: chặn CSV/formula injection (OWASP) bằng tiền tố `'`, rồi trích dẫn RFC 4180. */
export function csvCell(value: string | number | null): string {
  if (value === null) return "";
  let s = typeof value === "number" ? String(value) : value;
  if (typeof value === "string" && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: (string | number | null)[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export const IMPORT_COLUMNS = [
  "handle",
  "title",
  "kind",
  "category",
  "material",
  "description",
  "sku",
  "color",
  "size",
  "price",
  "stock",
] as const;

export interface ImportRow {
  line: number;
  handle: string;
  title: string;
  kind: "apparel" | "shoes" | "accessory";
  category: string;
  material: string | null;
  description: string | null;
  sku: string;
  color: string | null;
  size: string | null;
  price: number;
  stock: number | null;
}

export interface ImportRowError {
  line: number;
  column: string;
  message: string;
}

/**
 * Preview import (S-206): kiểm từng dòng, KHÔNG ghi gì. Lỗi nêu dòng (đánh số theo file, header = 1) + cột.
 * Ô bắt đầu bằng ký tự công thức bị từ chối ở trường văn bản để file độc không quay lại qua export.
 */
export function validateImport(text: string): { rows: ImportRow[]; errors: ImportRowError[] } {
  const errors: ImportRowError[] = [];
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (e) {
    return { rows: [], errors: [{ line: 0, column: "*", message: (e as Error).message }] };
  }
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const missing = IMPORT_COLUMNS.filter((c) => !header.includes(c) && c !== "material" && c !== "stock");
  if (missing.length)
    return { rows: [], errors: [{ line: 1, column: missing.join(","), message: "Thiếu cột" }] };
  const idx = (c: string) => header.indexOf(c);
  const rows: ImportRow[] = [];
  const skuSeen = new Map<string, number>();
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const get = (c: string) => (idx(c) >= 0 ? toNfc((cells[idx(c)] ?? "").trim()) : "");
    const rowErrors: ImportRowError[] = [];
    const text = (c: string, required: boolean, max = 255): string | null => {
      const v = get(c);
      if (v === "") {
        if (required) rowErrors.push({ line, column: c, message: "Bắt buộc" });
        return null;
      }
      if (FORMULA_START.test(v))
        rowErrors.push({ line, column: c, message: "Không được bắt đầu bằng = + - @" });
      if (v.length > max) rowErrors.push({ line, column: c, message: `Tối đa ${max} ký tự` });
      return v;
    };
    const handle = slugify(get("handle"));
    if (handle === "") rowErrors.push({ line, column: "handle", message: "Bắt buộc" });
    const title = text("title", true) ?? "";
    const kindRaw = get("kind");
    const kind = (["apparel", "shoes", "accessory"] as const).find((k) => k === kindRaw);
    if (!kind) rowErrors.push({ line, column: "kind", message: "apparel | shoes | accessory" });
    const category = slugify(get("category"));
    if (category === "") rowErrors.push({ line, column: "category", message: "Bắt buộc" });
    const sku = get("sku").toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(sku)) {
      rowErrors.push({ line, column: "sku", message: "Chỉ chữ, số, - và _ (tối đa 64)" });
    } else if (skuSeen.has(sku)) {
      rowErrors.push({ line, column: "sku", message: `Trùng với dòng ${skuSeen.get(sku)}` });
    } else skuSeen.set(sku, line);
    const priceRaw = get("price").replace(/[.\s]/g, "");
    if (!/^\d{1,12}$/.test(priceRaw) || Number(priceRaw) <= 0) {
      rowErrors.push({ line, column: "price", message: "Số nguyên VND > 0" });
    }
    const stockRaw = get("stock");
    if (stockRaw !== "" && !/^\d{1,7}$/.test(stockRaw)) {
      rowErrors.push({ line, column: "stock", message: "Số nguyên ≥ 0" });
    }
    const color = get("color") === "" ? null : slugify(get("color"));
    const size = get("size") === "" ? null : slugify(get("size"));
    if (kind && kind !== "accessory" && (color === null || size === null)) {
      rowErrors.push({ line, column: "color,size", message: "Quần áo/giày cần màu và size" });
    }
    const material = text("material", false);
    const description = text("description", false, 5000);
    if (rowErrors.length) {
      errors.push(...rowErrors);
      return;
    }
    rows.push({
      line,
      handle,
      title,
      kind: kind as ImportRow["kind"],
      category,
      material: material === null ? null : slugify(material),
      description,
      sku,
      color,
      size,
      price: Number(priceRaw),
      stock: stockRaw === "" ? null : Number(stockRaw),
    });
  });
  return { rows, errors };
}
