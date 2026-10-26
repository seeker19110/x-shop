// `test_list` của xt.yaml (T-128): in mỗi dòng một id test cho `dev-task.sh test-shard`/`gate-fast` (commit đụng cấu
// hình cổng chạy MỌI lớp test song song qua `test_unit` = scripts/test-shards/unit.sh). Phủ đúng những gì `test` của
// xt.yaml chạy (`pnpm -r --if-present test && pnpm -r --if-present test:integration`):
//   unit:<thư mục gói>   — mỗi gói workspace có script `test`;
//   http:<tên file>      — mỗi file apps/backend/integration-tests/http/*.spec.ts (gói duy nhất có `test:integration`).
// Gói khác thêm `test:integration` mà list chưa biết cách chia → exit 1 (không lặng lẽ bỏ sót lớp test).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const HTTP_PKG = "apps/backend";
const HTTP_DIR = join(HTTP_PKG, "integration-tests/http");
const ids = [];

for (const group of ["apps", "packages"]) {
  for (const name of readdirSync(join(root, group)).sort()) {
    const dir = `${group}/${name}`;
    const manifest = join(root, dir, "package.json");
    if (!existsSync(manifest)) continue;
    const scripts = JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {};
    if (scripts.test) ids.push(`unit:${dir}`);
    if (scripts["test:integration"] && dir !== HTTP_PKG) {
      console.error(
        `list.mjs: ${dir} có script test:integration nhưng chưa được chia shard — thêm vào list.mjs/unit.sh`,
      );
      process.exit(1);
    }
  }
}

const specs = readdirSync(join(root, HTTP_DIR))
  .filter((f) => f.endsWith(".spec.ts"))
  .sort();
if (specs.length === 0) {
  console.error(`list.mjs: không thấy file nào trong ${HTTP_DIR}`);
  process.exit(1);
}
for (const f of specs) ids.push(`http:${f.slice(0, -".spec.ts".length)}`);

process.stdout.write(ids.join("\n") + "\n");
