// Jest theo mẫu medusajs/dtc-starter (apps/backend) — TEST_TYPE chọn bộ test; tham số sau `--` lọc theo tên file.
const { loadEnv } = require("@medusajs/framework/utils");

loadEnv("test", process.cwd());

if (process.env.TEST_TYPE?.startsWith("integration")) {
  // Test tích hợp chạy trên Postgres/Redis thật (đặc tả §13.3). Thông báo chỉ nêu tên biến, không in giá trị.
  for (const name of ["DATABASE_URL", "REDIS_URL"]) {
    if (!process.env[name]) {
      throw new Error(
        `Test tích hợp cần biến ${name} — chạy: bash scripts/dev-services.sh rồi export kết quả.`,
      );
    }
  }
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
};

if (process.env.TEST_TYPE === "integration:http") {
  module.exports.testMatch = ["**/integration-tests/http/*.spec.[jt]s"];
} else if (process.env.TEST_TYPE === "integration:modules") {
  module.exports.testMatch = ["**/src/modules/*/__tests__/**/*.[jt]s"];
} else if (process.env.TEST_TYPE === "unit") {
  module.exports.testMatch = ["**/src/**/__tests__/**/*.unit.spec.[jt]s"];
}
