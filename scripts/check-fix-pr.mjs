#!/usr/bin/env node
// Kiểm PR sửa lỗi (QA-STRAT-005, FE-TEST-006): PR có tiêu đề `fix:` phải đổi ít nhất một file test và ghi trong mô tả
// bằng chứng "đỏ trước / xanh sau". Ngoại lệ: nhãn `fix-no-test` kèm dòng `Ngoại lệ test: <lý do>` trong mô tả.
//
// CLI (chạy trong workflow pr-policy; dữ liệu PR đi qua biến môi trường, không nội suy vào shell):
//   PR_TITLE, PR_BODY, PR_LABELS (mảng JSON tên nhãn), FILES_PATH (file liệt kê file đổi, mỗi dòng một đường dẫn)
// Thoát 0 = đạt hoặc không phải PR `fix:`; 1 = vi phạm (in lý do); 2 = đầu vào không đọc được.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const EXEMPT_LABEL = "fix-no-test";

const FIX_TITLE_RE = /^fix(\([^)\s]*\))?!?:\s*\S/;
const TEST_FILE_RES = [
  /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)__tests__\//,
  /(^|\/)(tests?|integration-tests|e2e)\//,
  /(^|\/)test_[^/]+\.py$/,
  /(^|\/)[^/]+_test\.(py|go)$/,
];

export function isFixTitle(title) {
  return FIX_TITLE_RE.test((title ?? "").trim());
}

export function isTestFile(path) {
  const p = (path ?? "").trim().replaceAll("\\", "/");
  return p !== "" && TEST_FILE_RES.some((re) => re.test(p));
}

/** Giá trị (không rỗng, sau khi bỏ chú thích HTML) của dòng `<nhãn>: <giá trị>` trong mô tả; không có → null. */
export function fieldOf(body, label) {
  const clean = (body ?? "").replace(/<!--[\s\S]*?-->/g, "");
  const re = new RegExp(`^\\s*(?:[-*]\\s*)?${label}\\s*:[ \\t]*(\\S[^\\n]*)$`, "imu");
  const m = re.exec(clean);
  return m ? m[1].trim() : null;
}

/**
 * @param {{title?: string, body?: string, labels?: string[], files?: string[]}} pr
 * @returns {{ok: boolean, skipped?: boolean, errors: string[]}}
 */
export function checkFixPr({ title, body, labels = [], files = [] }) {
  if (!isFixTitle(title)) return { ok: true, skipped: true, errors: [] };
  const exempt = labels.includes(EXEMPT_LABEL);
  if (exempt) {
    const reason = fieldOf(body, "Ngoại lệ test");
    if (!reason || reason.length < 10) {
      return {
        ok: false,
        errors: [`nhãn \`${EXEMPT_LABEL}\` cần dòng 'Ngoại lệ test: <lý do ≥ 10 ký tự>' trong mô tả PR`],
      };
    }
    return { ok: true, errors: [] };
  }
  const errors = [];
  if (!files.some(isTestFile)) {
    errors.push(
      `PR \`fix:\` phải thêm/sửa ít nhất một file test tái hiện lỗi (hoặc nhãn \`${EXEMPT_LABEL}\` + 'Ngoại lệ test: <lý do>')`,
    );
  }
  if (!fieldOf(body, "Đỏ trước"))
    errors.push("mô tả PR thiếu dòng 'Đỏ trước: <tên test + cách chạy, kết quả đỏ>'");
  if (!fieldOf(body, "Xanh sau")) errors.push("mô tả PR thiếu dòng 'Xanh sau: <cùng test, kết quả xanh>'");
  return { ok: errors.length === 0, errors };
}

function main() {
  let labels;
  let files;
  try {
    labels = JSON.parse(process.env.PR_LABELS || "[]");
    if (!Array.isArray(labels)) throw new Error("PR_LABELS phải là mảng JSON");
    files = readFileSync(process.env.FILES_PATH ?? "", "utf8").split("\n");
  } catch (e) {
    console.error(`check-fix-pr: không đọc được đầu vào — ${e.message}`);
    return 2;
  }
  const r = checkFixPr({
    title: process.env.PR_TITLE,
    body: process.env.PR_BODY,
    labels,
    files: files.filter((f) => f.trim() !== ""),
  });
  if (r.skipped) console.log("Không phải PR `fix:` — bỏ qua.");
  else if (r.ok)
    console.log("OK — PR `fix:` có test và bằng chứng đỏ trước/xanh sau (hoặc ngoại lệ có lý do).");
  for (const e of r.errors) console.error(`::error::check-fix-pr: ${e}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
