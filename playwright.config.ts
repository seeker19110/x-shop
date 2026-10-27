import { defineConfig, devices } from "@playwright/test";
import { backendEnv, PORTS, storefrontEnv, URLS } from "./e2e/env.mjs";

/**
 * E2E (T-022). Chạy qua `pnpm e2e` (e2e/run.mjs dựng DB + seed + build rồi gọi Playwright). Ba tiến trình do
 * `webServer` bật/tắt: backend Medusa (cổng 9100), storefront `next start` (3100), cổng VNPAY giả lập (3300).
 * Một worker, tuần tự: các luồng dùng chung một DB/kho.
 */
const publishableKey = process.env.E2E_PUBLISHABLE_KEY;
if (!publishableKey) {
  throw new Error(
    "Thiếu E2E_PUBLISHABLE_KEY — chạy bằng `pnpm e2e` (dựng DB/seed trước), không gọi playwright trực tiếp.",
  );
}

const stringEnv = (o: Record<string, string>) => ({ ...(process.env as Record<string, string>), ...o });

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: URLS.storefront,
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // UX-RESP-008 / FE-TEST-002: hai project. `desktop` chạy toàn bộ spec; `mobile` (Pixel 7: viewport 412×915, cảm ứng,
  // UA di động) chạy checkout-cod, checkout-vnpay, checkout-total, responsive (reflow 320px mọi route) và mobile-touch. Spec tự đặt viewport (a11y-reflow) và
  // spec bố cục desktop (keyboard-flow: bộ lọc dạng sidebar) không có nghĩa ở mobile nên loại khỏi project này.
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /mobile-touch\.spec\.ts$/ },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      testIgnore: [/a11y-reflow\.spec\.ts$/, /keyboard-flow\.spec\.ts$/],
    },
  ],
  webServer: [
    {
      name: "mock-vnpay",
      command: "node e2e/mock-vnpay.mjs",
      url: `${URLS.mockVnpay}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
    },
    {
      name: "backend",
      command: `pnpm exec medusa start -p ${PORTS.backend}`,
      cwd: "apps/backend",
      url: `${URLS.backend}/health`,
      env: stringEnv(backendEnv()),
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      name: "storefront",
      command: `pnpm exec next start -p ${PORTS.storefront}`,
      cwd: "apps/storefront",
      url: `${URLS.storefront}/`,
      env: stringEnv({ ...storefrontEnv(publishableKey), NODE_ENV: "production" }),
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
