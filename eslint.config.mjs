import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import jest from "eslint-plugin-jest";
import vitest from "eslint-plugin-vitest";
import globals from "globals";
import tseslint from "typescript-eslint";

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
