/**
 * dependency-cruiser (`pnpm depcruise`) — ARC-MOD-004 (không vòng phụ thuộc), ARC-MOD-005 (module chỉ import điểm xuất
 * công khai của module khác). Phạm vi và lệnh: package.json `depcruise`.
 *
 * "Điểm xuất công khai" của một module Medusa trong apps/backend/src/modules/<m>/ = `index.ts` (khoá đăng ký),
 * `service.ts` (kiểu/lớp service dùng cho `container.resolve<…>`) và `constants.ts`. Mọi tệp khác (migrations/, models/,
 * helper) là nội bộ, trừ NGOẠI LỆ có lý do ở PUBLIC_EXCEPTIONS bên dưới.
 */

/* global module -- tệp CommonJS do dependency-cruiser nạp, `module` là biến của Node */

const MODULES = "^apps/backend/src/modules/";
const PUBLIC = `${MODULES}[^/]+/(index|service|constants)\\.ts$`;

/**
 * Ngoại lệ: tệp THUẦN (không import Medusa/container) mà lib/workflows/script dùng làm hợp đồng dữ liệu. Đi qua `index.ts`
 * sẽ kéo `Module()` + service vào logic thuần và tạo nguy cơ vòng (index → service → lib → index), nên cho import thẳng.
 * Thêm dòng mới = quyết định có lý do, ghi vào đây.
 */
const PUBLIC_EXCEPTIONS = [
  // Validator/schema zod của mô hình thời trang: dùng chung cho route admin, workflow, script dữ liệu mẫu.
  `${MODULES}fashion/validators\\.ts$`,
  // Hằng trạng thái/lý do của checkout (nằm cạnh model nhưng là hằng thuần): lib/checkout và workflow dùng.
  `${MODULES}checkout/models/constants\\.ts$`,
  // Kiểu/hằng của outbound message: adapter thông báo ở lib/notify dùng, không cần service.
  `${MODULES}notify/models/outbound-message\\.ts$`,
  // Truy vấn tìm kiếm thuần SQL-builder của catalog-index: lib/catalog/listing + test tích hợp dùng.
  `${MODULES}catalog-index/query\\.ts$`,
  // Bộ ghi CSV đối soát: lib/settlement/http xuất báo cáo.
  `${MODULES}settlement/csv\\.ts$`,
];

const TEST_FILES = "(^|/)(__tests__|integration-tests)/|\\.(spec|test)\\.(ts|tsx|js|mjs)$";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment: "ARC-MOD-004: không có vòng phụ thuộc (kể cả import chỉ-kiểu).",
      severity: "error",
      // NGOẠI LỆ: mô hình DML của Medusa (modules/*/models/) khai quan hệ hai chiều `hasMany(() => B)` ↔ `belongsTo(() => A)`
      // bằng thunk lười — đó là cách duy nhất của DML, vòng giữa hai tệp model cùng module là bắt buộc và an toàn (không
      // đánh giá lúc nạp). Vòng ở mọi chỗ khác vẫn lỗi.
      from: { pathNot: `${MODULES}[^/]+/models/` },
      to: { circular: true },
    },
    {
      name: "module-no-cross-module-internals",
      comment: "ARC-MOD-005: module A chỉ import điểm xuất công khai của module B.",
      severity: "error",
      from: { path: `${MODULES}([^/]+)/` },
      to: {
        path: `${MODULES}(?!$1/)[^/]+/`,
        pathNot: [PUBLIC, ...PUBLIC_EXCEPTIONS],
      },
    },
    {
      name: "outside-module-internals",
      comment:
        "ARC-MOD-005: code ngoài modules/ (api, workflows, lib, jobs, subscribers, scripts, admin) chỉ import điểm xuất công khai của module.",
      severity: "error",
      from: { path: "^apps/backend/", pathNot: [`${MODULES}`, TEST_FILES] },
      to: { path: `${MODULES}[^/]+/`, pathNot: [PUBLIC, ...PUBLIC_EXCEPTIONS] },
    },
    {
      name: "tests-module-internals",
      comment:
        "ARC-MOD-005 cho test: như trên, thêm cho phép nạp `migrations/` (test tích hợp dựng/khôi phục schema bằng migration thật).",
      severity: "error",
      from: {
        path: `^apps/backend/(integration-tests/|.*(__tests__/|\\.(spec|test)\\.(ts|tsx|js)$))`,
        pathNot: `${MODULES}[^/]+/__tests__/`,
      },
      to: {
        path: `${MODULES}[^/]+/`,
        pathNot: [PUBLIC, ...PUBLIC_EXCEPTIONS, `${MODULES}[^/]+/migrations/Migration[0-9]+\\.ts$`],
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: ["\\.d\\.ts$", "(^|/)\\.(next|medusa)/", "(^|/)dist/", "(^|/)node_modules/"] },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types"],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
