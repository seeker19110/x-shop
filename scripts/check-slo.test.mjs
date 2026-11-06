// Kiểm truy vấn SLI trong docs/ops/SLO.md (OPS-SLO-001, T-079): đọc chính các khối ```bash có đánh dấu
// `<!-- slo-query: ID -->`, chạy bằng jq trên log truy cập mẫu (định dạng JSON của `medusa start`) và so số tốt/tổng.
// Sai cú pháp jq hoặc đổi ngữ nghĩa truy vấn → đỏ. Cần `jq` trên PATH (có sẵn trên runner ubuntu của GitHub).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = readFileSync(join(ROOT, "docs/ops/SLO.md"), "utf8");

/** Khối truy vấn theo ID. */
function queries(md) {
  const out = new Map();
  const re = /<!-- slo-query: ([A-Z0-9-]+) -->\s*```bash\n([\s\S]*?)```/g;
  for (const m of md.matchAll(re)) out.set(m[1], m[2]);
  return out;
}

const FROM = "2026-10-01T00:00:00Z";
const TO = "2026-10-29T00:00:00Z";
const t = (day) => `2026-10-${String(day).padStart(2, "0")}T10:00:00.000Z`;
const line = (method, path, status, duration, ts = t(10)) =>
  JSON.stringify({
    level: "http",
    client_ip: "-",
    request_id: "r",
    method,
    path,
    status,
    duration,
    timestamp: ts,
  });

const LOG = [
  // SLI-A1: /store/* trong cửa sổ — 6 tốt (2xx/4xx kể cả 429), 2 xấu (500, 503).
  line("GET", "/store/x/products?q=ao", 200, 120),
  line("GET", "/store/x/products/ao-thun", 200, 300), // biên L1: đúng 300 ms → tốt
  line("GET", "/store/x/search?q=quan", 200, 301), // 301 ms → chậm
  line("GET", "/store/x/orders/ABC", 404, 50),
  line("POST", "/store/x/checkout/quote", 429, 5),
  line("POST", "/store/carts", 200, 700), // biên L2: đúng 700 ms → tốt
  line("POST", "/store/x/checkout/submit", 503, 10), // xấu (A1), loại khỏi L2/L3 latency (5xx)
  line("GET", "/store/x/categories", 500, 10), // xấu (A1), loại khỏi L1
  line("POST", "/store/x/checkout/submit?x=1", 201, 2000), // L3 biên: tốt; không vào L2
  line("POST", "/store/x/checkout/submit", 201, 2500), // L3 chậm
  line("DELETE", "/store/carts/c1/line-items/l1", 200, 900), // L2 chậm
  // Ngoài phạm vi: ngoài cửa sổ, admin, health, webhook, dòng không phải http/JSON.
  line("GET", "/store/x/products", 500, 10, "2026-09-30T23:59:59.999Z"),
  line("GET", "/store/x/products", 500, 10, TO),
  line("GET", "/admin/x/refunds", 500, 10),
  line("GET", "/x/readyz", 503, 1000),
  line("POST", "/x/webhooks/vnpay/ipn", 500, 10),
  JSON.stringify({ level: "info", message: "Server is ready", timestamp: t(10) }),
  "Gracefully shutting down server",
  "42",
  "",
].join("\n");

const dir = mkdtempSync(join(tmpdir(), "slo-"));
const logFile = join(dir, "server.log");
writeFileSync(logFile, LOG);
after(() => rmSync(dir, { recursive: true, force: true }));

function run(script, env) {
  const out = execFileSync("bash", ["-c", script], {
    env: { ...process.env, LOG: logFile, FROM, TO, ...env },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

const Q = queries(DOC);

test("SLO.md có đủ truy vấn cho SLI backend (availability + latency)", () => {
  assert.deepEqual([...Q.keys()].sort(), ["SLI-A1", "SLI-L1", "SLI-L2", "SLI-L3"]);
});

test("SLI-A1: 4xx/429 là tốt, 5xx là xấu; loại admin/health/webhook/ngoài cửa sổ", () => {
  assert.deepEqual(run(Q.get("SLI-A1")), { good: 9, total: 11, ratio: 9 / 11 });
});

test("SLI-L1: GET /store/* không 5xx, biên 300 ms là tốt", () => {
  assert.deepEqual(run(Q.get("SLI-L1")), { good: 3, total: 4, ratio: 0.75 });
});

test("SLI-L2: ghi /store/* trừ submit, biên 700 ms là tốt", () => {
  assert.deepEqual(run(Q.get("SLI-L2")), { good: 2, total: 3, ratio: 2 / 3 });
});

test("SLI-L3: submit (kể cả có query string), biên 2000 ms là tốt", () => {
  assert.deepEqual(run(Q.get("SLI-L3")), { good: 1, total: 2, ratio: 0.5 });
});

test("không có mẫu → ratio null (không coi là đạt)", () => {
  const empty = join(dir, "empty.log");
  writeFileSync(empty, "");
  for (const id of Q.keys()) {
    assert.deepEqual(run(Q.get(id), { LOG: empty }), { good: 0, total: 0, ratio: null }, id);
  }
});
