import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      // json-summary: scripts/coverage-ratchet.mjs đọc; lcov: báo cáo HTML cho artifact CI (QA-COV-001/002).
      reporter: ["text", "json-summary", "lcov"],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
