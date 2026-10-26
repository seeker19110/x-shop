import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import react from "eslint-plugin-react";
import testingLibrary from "eslint-plugin-testing-library";
import jest from "eslint-plugin-jest";
import vitest from "eslint-plugin-vitest";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * BASE-DATA-003 (T-082): cấm lấy mặc định bằng `||` và cấm điều kiện ngầm trên giá trị nullable nguyên thuỷ.
 * - prefer-nullish-coalescing: `a || d` khi `a` có thể null/undefined → dùng `a ?? d`; nếu cố ý thay cả ""/0/false
 *   thì viết tường minh (`s === "" ? d : s`), để người đọc thấy rõ 0/rỗng là hợp lệ hay không.
 * - strict-boolean-expressions:
 *   · allowNullableString/Number/Boolean/Enum = false: `if (s)` với `s: string | undefined` gộp "thiếu" với "" (và
 *     `n: number | null` gộp với 0 — tiền/số lượng 0 là hợp lệ) → phải viết `s !== undefined`, `s === ""`, `n !== null`.
 *   · allowNullableObject = true: object/mảng/hàm không bao giờ falsy, nên `if (obj)` chỉ có một nghĩa (khác null).
 *   · allowString/allowNumber = true (mặc định): `if (s)` với `s: string` KHÔNG nullable chỉ có một nghĩa (khác "");
 *     không có nhầm lẫn thiếu-vs-rỗng mà luật này nhắm tới.
 *   · allowAny = false: `any` trong điều kiện phải ép kiểu tường minh.
 * @param {{ files: string[]; project: string[] }[]} scopes
 */
function typedNullishRules(scopes) {
  return scopes.map(({ files, project }) => ({
    files,
    languageOptions: {
      parserOptions: { project, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        {
          allowString: true,
          allowNumber: true,
          allowNullableObject: true,
          allowNullableBoolean: false,
          allowNullableString: false,
          allowNullableNumber: false,
          allowNullableEnum: false,
          allowAny: false,
        },
      ],
    },
  }));
}

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.medusa/**",
      "**/coverage/**",
      ".xtemplates/**",
      ".claude/**",
      "**/*.config.{js,mjs,cjs}",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.{js,mjs}", "e2e/**/*.{js,mjs}"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["apps/storefront/**/*.{ts,tsx}"],
    settings: { next: { rootDir: "apps/storefront/" } },
    plugins: { "react-hooks": reactHooks, "@next/next": nextPlugin },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
  {
    // FE-SEC-001 / SEC-WEB-004: mọi điểm tắt escape của React phải có eslint-disable kèm lý do (JSON-LD đã serialize).
    files: ["apps/storefront/**/*.{ts,tsx}"],
    plugins: { react },
    rules: { "react/no-danger": "error" },
  },
  {
    // FE-TEST-001: truy vấn theo vai trò/nhãn; getByTestId chỉ khi không còn lựa chọn và có eslint-disable kèm lý do.
    files: ["apps/storefront/**/*.test.{ts,tsx}"],
    plugins: { "testing-library": testingLibrary },
    rules: {
      // Theo FE-TEST-001: hai rule blueprint nêu tên + vài rule bắt lỗi thật; no-node-access để dành (nhiều test cũ).
      "testing-library/prefer-screen-queries": "error",
      "testing-library/no-container": "error",
      "testing-library/no-await-sync-queries": "error",
      "testing-library/no-wait-for-multiple-assertions": "error",
      "testing-library/no-promise-in-fire-event": "error",
      "no-restricted-properties": [
        "error",
        ...["get", "getAll", "query", "queryAll", "find", "findAll"].map((p) => ({
          property: `${p}ByTestId`,
          message:
            "Dùng getByRole/getByLabelText/getByText; ByTestId chỉ khi không còn lựa chọn khác (FE-TEST-001).",
        })),
      ],
    },
  },
  {
    // Cưỡng chế QA-STATIC-004 / BASE-ERR-001: không any, không ts-comment trần, mọi disable có lý do.
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { "@eslint-community/eslint-comments": eslintComments },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
          minimumDescriptionLength: 10,
        },
      ],
      "@eslint-community/eslint-comments/require-description": ["error", { ignore: [] }],
      "@eslint-community/eslint-comments/disable-enable-pair": ["error", { allowWholeFile: true }],
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
      "@eslint-community/eslint-comments/no-unused-disable": "error",
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='catch'][arguments.0.type=/^(Arrow)?FunctionExpression$/][arguments.0.body.type='BlockStatement'][arguments.0.body.body.length=0]",
          message:
            "Không nuốt lỗi bằng .catch(() => {}) (BASE-ERR-001): xử lý, chuyển tiếp có ngữ cảnh hoặc ghi log.",
        },
      ],
    },
  },
  {
    // Mã chạy sản phẩm: không console debug (QA-STATIC-005); dùng logger/analytics có chủ đích.
    files: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.ts"],
    ignores: ["**/*.test.{ts,tsx}", "**/__tests__/**"],
    rules: { "no-console": "error" },
  },
  {
    // Test vitest: không .only/.skip, mỗi test có assertion (QA-STRAT-008, QA-COV-004).
    files: ["apps/storefront/**/*.test.{ts,tsx}", "packages/domain/**/*.test.ts"],
    plugins: { vitest },
    rules: {
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "error",
      // fc.assert (fast-check) là khẳng định thuộc tính, tính như assertion.
      "vitest/expect-expect": [
        "error",
        { assertFunctionNames: ["expect", "expectTypeOf", "fc.assert", "assert*"] },
      ],
    },
  },
  {
    // Test jest của backend (unit + integration).
    files: ["apps/backend/**/*.{spec,test}.ts", "apps/backend/integration-tests/**/*.ts"],
    plugins: { jest },
    rules: {
      "jest/no-focused-tests": "error",
      "jest/no-disabled-tests": "error",
      "jest/expect-expect": ["error", { assertFunctionNames: ["expect", "expect*", "assert*"] }],
    },
  },
  // BASE-DATA-003: phân biệt thiếu (null/undefined) với rỗng ("") và 0/false. Hai luật cần thông tin kiểu nên chỉ
  // chạy trên mã TS thuộc một tsconfig; bật dần theo gói (T-082).
  ...typedNullishRules([
    { files: ["packages/domain/src/**/*.ts"], project: ["packages/domain/tsconfig.json"] },
  ]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "Tiền là số nguyên VND (BASE-DATA-005)." },
      ],
    },
  },
);
