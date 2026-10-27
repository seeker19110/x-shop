// Jest theo mẫu medusajs/dtc-starter (apps/backend) — TEST_TYPE chọn bộ test; tham số sau `--` lọc theo tên file.
const { loadEnv } = require("@medusajs/framework/utils");

loadEnv("test", process.cwd());

if (process.env.TEST_TYPE?.startsWith("integration")) {
  // Test tích hợp chạy trên Postgres/Redis thật (đặc tả §13.3). Mặc định trỏ dịch vụ cục bộ của
  // scripts/dev-services.sh — trùng giá trị của job CI; không phải bí mật (tài khoản DB thử nghiệm cục bộ).
  process.env.DATABASE_URL ||= "postgres://xshop:xshop@localhost:5432/xshop";
  process.env.REDIS_URL ||= "redis://localhost:6379";
  // Hai lần chạy đồng thời (worktree, máy dev) chung một Redis DB thì tranh khoá/hàng đợi BullMQ của nhau. DB index do
  // globalSetup (integration-tests/global-setup.ts, T-146/D-077) giành ĐỘC QUYỀN bằng SET NX EX có gia hạn rồi ghi vào
  // REDIS_URL cho worker; globalTeardown trả. Không còn chọn theo `pid % 12` (hai pid cách nhau 12 trùng DB).
  // MFA TOTP native cần khoá mã hoá bí mật (Auth Module đọc AUTH_MFA_ENCRYPTION_KEY) — giá trị CHỈ cho test cục bộ/CI.
  process.env.AUTH_MFA_ENCRYPTION_KEY ||= "x-shop-test-only-mfa-encryption-key-0123456789";
  // @medusajs/test-utils tạo DB tạm từ DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD; CI và dev chỉ đặt DATABASE_URL.
  const db = new URL(process.env.DATABASE_URL);
  process.env.DB_HOST ??= db.hostname;
  process.env.DB_PORT ??= db.port || "5432";
  process.env.DB_USERNAME ??= decodeURIComponent(db.username);
  process.env.DB_PASSWORD ??= decodeURIComponent(db.password);
}

module.exports = {
  transform: {
    "^.+\\.[jt]s$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript", decorators: true },
        },
      },
    ],
  },
  testEnvironment: "node",
  // Gói workspace (@x-shop/domain…) được nạp từ src/*.ts qua điều kiện export riêng — không cần build dist trước
  // khi test. Mã nguồn ESM của gói dùng đuôi `.js` cho import tương đối → ánh xạ về file không đuôi (tìm .ts).
  testEnvironmentOptions: {
    customExportConditions: ["node", "node-addons", "@x-shop/source"],
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  moduleFileExtensions: ["js", "ts", "json"],
  modulePathIgnorePatterns: ["dist/", "<rootDir>/.medusa/"],
  setupFiles: ["./integration-tests/setup.ts"],
  ...(process.env.TEST_TYPE?.startsWith("integration") && {
    globalSetup: "./integration-tests/global-setup.ts",
    globalTeardown: "./integration-tests/global-teardown.ts",
  }),
  // Coverage nhánh (QA-COV-001) — chỉ bật khi chạy `--coverage` (`pnpm test:coverage`). Provider v8: transform là
  // @swc/jest nên instrument kiểu babel-istanbul không áp. Mọi file .ts của src (kể cả chưa có test → 0 %); .tsx của
  // Admin UI không thuộc phạm vi Jest (moduleFileExtensions). Ngưỡng: ratchet theo coverage-baseline.json ở gốc repo
  // (scripts/coverage-ratchet.mjs, QA-COV-002).
  coverageProvider: "v8",
  collectCoverageFrom: ["src/**/*.ts", "!src/**/__tests__/**", "!src/**/*.d.ts"],
  coverageDirectory: "coverage",
  coverageReporters: ["text-summary", "json-summary", "lcov"],
};

if (process.env.TEST_TYPE === "integration:http") {
  module.exports.testMatch = ["**/integration-tests/http/*.spec.[jt]s"];
  // Mỗi suite dựng một app Medusa đầy đủ; chạy chung một process thì heap tăng dần tới OOM khi số suite lớn.
  // Một worker (vẫn tuần tự) + giới hạn bộ nhớ → Jest dựng lại worker khi vượt ngưỡng giữa các suite.
  module.exports.workerIdleMemoryLimit = "1536MB";
} else if (process.env.TEST_TYPE === "integration:modules") {
  module.exports.testMatch = ["**/src/modules/*/__tests__/**/*.[jt]s"];
} else if (process.env.TEST_TYPE === "unit") {
  module.exports.testMatch = [
    "**/src/**/__tests__/**/*.unit.spec.[jt]s",
    // Hạ tầng test (giành Redis DB của globalSetup, T-146) — test đơn vị dùng Redis giả.
    "<rootDir>/integration-tests/__tests__/*.unit.spec.[jt]s",
  ];
}
