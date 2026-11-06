import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Test chạy thẳng từ nguồn domain, không cần build trước.
    // Khớp chính xác từng điểm xuất (chuỗi khoá sẽ khớp cả tiền tố `@x-shop/domain/…`).
    alias: [
      {
        find: /^@x-shop\/domain\/validation$/,
        replacement: fileURLToPath(new URL("../../packages/domain/src/validation/index.ts", import.meta.url)),
      },
      {
        find: /^@x-shop\/domain$/,
        replacement: fileURLToPath(new URL("../../packages/domain/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Coverage nhánh (QA-COV-001): mọi file nguồn, kể cả file chưa có test (tính 0 %). Ngưỡng không đặt ở đây —
    // ratchet so với coverage-baseline.json ở gốc repo (scripts/coverage-ratchet.mjs, QA-COV-002).
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary", "lcov"],
    },
  },
});
