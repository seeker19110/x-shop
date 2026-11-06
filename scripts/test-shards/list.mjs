// `test_list` của xt.yaml (T-128): in mỗi dòng một id test cho `dev-task.sh test-shard`/`gate-fast` (commit đụng cấu
// hình cổng chạy MỌI lớp test song song qua `test_unit` = scripts/test-shards/unit.sh). Phủ đúng những gì `test` của
// xt.yaml chạy (`pnpm -r --if-present test && pnpm -r --if-present test:integration`):
//   unit:<thư mục gói>   — mỗi gói workspace có script `test`;
//   http:<tên file>      — mỗi file apps/backend/integration-tests/http/*.spec.ts (gói duy nhất có `test:integration`).
// Gói khác thêm `test:integration` mà list chưa biết cách chia → exit 1 (không lặng lẽ bỏ sót lớp test).
// `--http-shard I/N` (T-198, job `integration-coverage` của CI): chỉ in các id `http:` thuộc shard I trong N, chia cân theo
// thời lượng ở http-durations.json (split.mjs); hợp N shard = mọi id `http:` của lệnh không tham số, không trùng.
// Tham số sai → exit 2. Không tham số → hành vi cũ (test_list của xt.yaml).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assign, parseShard } from "./split.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const HTTP_PKG = "apps/backend";
const HTTP_DIR = join(HTTP_PKG, "integration-tests/http");
const ids = [];
const args = process.argv.slice(2);
let shard = null;
if (args.length) {
  try {
    if (args.length !== 2 || args[0] !== "--http-shard") throw new Error("dùng: list.mjs [--http-shard I/N]");
    shard = parseShard(args[1]);
  } catch (e) {
    console.error(`list.mjs: ${e.message}`);
    process.exit(2);
  }
}

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
const names = specs.map((f) => f.slice(0, -".spec.ts".length));
if (shard) {
  const durations = JSON.parse(readFileSync(new URL("./http-durations.json", import.meta.url), "utf8"));
  const group = assign(names, durations.seconds ?? {}, shard.total)[shard.index - 1];
  // Shard rỗng (N > số suite) in rỗng, exit 0 — CI tự đỏ khi shard không có suite nào để chạy.
  process.stdout.write(group.names.map((n) => `http:${n}\n`).join(""));
} else {
  for (const n of names) ids.push(`http:${n}`);
  process.stdout.write(ids.join("\n") + "\n");
}
