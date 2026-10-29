#!/usr/bin/env node
/**
 * Bộ cân bằng tải round-robin cho E2E hai bản sao backend (T-095, ARC-RES-005 / ARC-STYLE-004). KHÔNG sticky session:
 * mỗi request (không phải mỗi kết nối) sang bản sao kế tiếp — hai request liên tiếp của cùng một khách luôn rơi vào hai
 * tiến trình khác nhau. Không thử lại/chuyển bản khi lỗi (POST không idempotent; lỗi phải lộ ra test): upstream lỗi → 502.
 * Không thêm `x-forwarded-for` — backend nhìn thấy đúng socket như khi gọi thẳng (rate limit theo IP không đổi nghĩa).
 *
 *  - GET /__lb/health  200 khi CẢ HAI bản sao trả 200 ở /health (webServer của Playwright chờ cổng này).
 *  - GET /__lb/stats   {a, b, errors}: số request đã chuyển tới từng bản sao và số lần upstream lỗi.
 *  - mọi đường khác   chuyển nguyên (method, path, header, body) tới bản sao theo lượt; phản hồi kèm `x-e2e-replica`.
 */
import { Agent, createServer, request } from "node:http";
import { PORTS } from "./env.mjs";

const UPSTREAMS = [
  { name: "a", port: PORTS.backend },
  { name: "b", port: PORTS.backendB },
];
const agent = new Agent({ keepAlive: true, maxSockets: 64 });
const stats = { a: 0, b: 0, errors: 0 };
let turn = 0;

function probe(port) {
  return new Promise((resolve) => {
    const req = request(
      { host: "localhost", port, path: "/health", method: "GET", agent, timeout: 2_000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** Log injection: bỏ xuống dòng/ký tự điều khiển khỏi giá trị do client/upstream điều khiển. */
const oneLine = (v) =>
  [...String(v)]
    .map((c) => (c.charCodeAt(0) < 0x20 ? " " : c))
    .join("")
    .replace(/\n|\r/g, " ");

function json(res, status, body) {
  res
    .writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
    .end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/__lb/health") {
    const ok = (await Promise.all(UPSTREAMS.map((u) => probe(u.port)))).every(Boolean);
    json(res, ok ? 200 : 503, { ok });
    return;
  }
  if (req.method === "GET" && req.url === "/__lb/stats") {
    json(res, 200, stats);
    return;
  }
  const up = UPSTREAMS[turn % UPSTREAMS.length];
  turn += 1;
  stats[up.name] += 1;
  const proxied = request(
    { host: "localhost", port: up.port, method: req.method, path: req.url, headers: req.headers, agent },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, { ...upRes.headers, "x-e2e-replica": up.name });
      upRes.pipe(res);
    },
  );
  proxied.on("error", (e) => {
    stats.errors += 1;
    console.error(`[lb] ${up.name} ${oneLine(req.method)} ${oneLine(req.url)}: ${oneLine(e.message)}`);
    if (!res.headersSent) json(res, 502, { error: "upstream", replica: up.name });
    else res.destroy();
  });
  req.pipe(proxied);
});

server.listen(PORTS.backendLb, () =>
  console.log(`[lb] round-robin :${PORTS.backendLb} → ${UPSTREAMS.map((u) => u.port).join(", ")}`),
);
// Thoát ngay: kết nối keep-alive với upstream không được giữ tiến trình lại khi Playwright tắt webServer.
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
