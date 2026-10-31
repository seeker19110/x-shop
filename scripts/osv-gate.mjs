#!/usr/bin/env node
// Cổng lỗ hổng phụ thuộc (BASE-DEP-004, SEC-SUPPLY-006): đọc JSON của `osv-scanner scan source --format json` (đã áp
// `osv-scanner.toml`, nên lỗ hổng đang có ngoại lệ còn hạn không xuất hiện) và đỏ khi còn lỗ hổng CVSS >= 7.0
// (high/critical). Medium/low chỉ cảnh báo (SLA ở docs/ops/VULN-SLA.md). Kiểm luôn file ngoại lệ: mỗi khối
// `[[IgnoredVulns]]` phải có `id`, `reason`, `ignoreUntil` (YYYY-MM-DD, chưa quá hạn, <= 90 ngày kể từ hôm nay) và dòng
// chú thích `# approved_by: <tên>`; thiếu/quá hạn = đỏ. CLI: node scripts/osv-gate.mjs <osv.json> [osv-scanner.toml]
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const HIGH = 7.0;
export const MAX_EXCEPTION_DAYS = 90;
const DAY = 86_400_000;

/** Gom finding từ JSON OSV: [{pkg, version, id, cve, score}] (score null nếu không có CVSS → coi là chưa rõ). */
export function findings(report) {
  const out = [];
  for (const res of report?.results ?? []) {
    for (const p of res.packages ?? []) {
      for (const g of p.groups ?? []) {
        const n = Number.parseFloat(g.max_severity);
        const ids = g.ids ?? [];
        const cve = (g.aliases ?? []).find((a) => a.startsWith("CVE-")) ?? null;
        out.push({
          pkg: p.package?.name ?? "?",
          version: p.package?.version ?? "?",
          id: ids[0] ?? "?",
          cve,
          score: Number.isFinite(n) ? n : null,
        });
      }
    }
  }
  return out;
}

/** Phân loại: high (>= 7.0) chặn; unknown (không có điểm) coi như high — mặc định an toàn; còn lại là cảnh báo. */
export function classify(list) {
  const blocking = list.filter((f) => f.score === null || f.score >= HIGH);
  return { blocking, warnings: list.filter((f) => !blocking.includes(f)) };
}

/** Kiểm file ngoại lệ; trả mảng lỗi (rỗng = đạt). `text` rỗng/null = không có ngoại lệ. */
export function checkExceptions(text, now = new Date()) {
  const errors = [];
  const blocks = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split(/^\[\[IgnoredVulns\]\]\s*$/m)
    .slice(1);
  blocks.forEach((raw, i) => {
    const body = raw.split(/^\[/m)[0];
    const where = `IgnoredVulns #${i + 1}`;
    const kv = (k) => new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, "m").exec(body)?.[1]?.trim();
    const id = kv("id");
    if (!id) errors.push(`${where}: thiếu id`);
    if (!kv("reason")) errors.push(`${where}${id ? ` (${id})` : ""}: thiếu reason`);
    if (!/^\s*#\s*approved_by:\s*\S+/m.test(body))
      errors.push(`${where}${id ? ` (${id})` : ""}: thiếu "# approved_by: <tên>"`);
    const until = kv("ignoreUntil");
    const t = until && /^\d{4}-\d{2}-\d{2}$/.test(until) ? Date.parse(`${until}T23:59:59Z`) : NaN;
    if (Number.isNaN(t))
      errors.push(`${where}${id ? ` (${id})` : ""}: ignoreUntil thiếu hoặc không phải YYYY-MM-DD`);
    else if (t < now.getTime())
      errors.push(`${where}${id ? ` (${id})` : ""}: ngoại lệ đã quá hạn (${until})`);
    else if (t - now.getTime() > MAX_EXCEPTION_DAYS * DAY)
      errors.push(`${where}${id ? ` (${id})` : ""}: hạn ${until} vượt ${MAX_EXCEPTION_DAYS} ngày`);
  });
  return errors;
}

export function main(argv = process.argv.slice(2), now = new Date()) {
  const [jsonPath, tomlPath = "osv-scanner.toml"] = argv;
  if (!jsonPath) {
    console.error("Dùng: node scripts/osv-gate.mjs <osv.json> [osv-scanner.toml]");
    return 2;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch (e) {
    console.error(`::error::Không đọc được báo cáo OSV ${jsonPath}: ${e.message}`);
    return 2;
  }
  const exErrors = checkExceptions(existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "", now);
  const { blocking, warnings } = classify(findings(report));
  const row = (f) => `${f.id}${f.cve ? ` (${f.cve})` : ""} · ${f.pkg}@${f.version} · CVSS ${f.score ?? "?"}`;
  for (const f of warnings) console.log(`::warning::Lỗ hổng dưới ngưỡng chặn: ${row(f)}`);
  for (const f of blocking) console.log(`::error::Lỗ hổng high/critical chưa xử lý: ${row(f)}`);
  for (const e of exErrors) console.log(`::error::${tomlPath}: ${e}`);
  console.log(
    `osv-gate: ${blocking.length} high/critical, ${warnings.length} thấp hơn, ${exErrors.length} lỗi ngoại lệ`,
  );
  return blocking.length || exErrors.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
