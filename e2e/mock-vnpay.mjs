#!/usr/bin/env node
/**
 * Cổng VNPAY giả lập cho E2E (không gọi mạng ngoài). Backend đặt VNPAY_PAYMENT_URL trỏ về đây:
 *  - GET  /pay?vnp_…            trang "cổng thanh toán" (hiển thị số tiền, mã giao dịch; liên kết quay về cửa hàng).
 *  - POST /api/ipn {txnRef, outcome?}  giả lập VNPAY gọi IPN: ký bằng MockVnpayGateway của packages/domain (cùng thuật
 *    toán với protocol), gọi GET <bộ cân bằng tải backend>/x/webhooks/vnpay/ipn, trả JSON {RspCode, Message} của
 *    backend. Gọi lại cùng (txnRef, outcome) = VNPAY gửi lại IPN y hệt.
 *  - GET  /health
 * Chỉ nhớ URL thanh toán đã thấy (để biết số tiền) trong bộ nhớ.
 */
import { createServer } from "node:http";
import { MockVnpayGateway } from "../packages/domain/dist/providers/vnpay/mock.js";
import { PORTS, URLS, VNPAY } from "./env.mjs";

const gateway = new MockVnpayGateway({ tmnCode: VNPAY.tmnCode, hashSecret: VNPAY.hashSecret });
/** txnRef → URL thanh toán đầy đủ đã ký (đủ để MockVnpayGateway.pay dựng IPN). */
const seen = new Map();
/** `${txnRef}|${outcome}` → query IPN đã ký lần đầu. VNPAY gửi lại IPN y hệt khi chưa nhận được phản hồi — gọi lặp phải
 * gửi lại ĐÚNG query cũ (không sinh mã giao dịch mới). */
const sentIpn = new Map();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function payPage(url) {
  const q = url.searchParams;
  const amount = Number(q.get("vnp_Amount") ?? "0") / 100;
  const back = q.get("vnp_ReturnUrl") ?? "";
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cổng VNPAY giả lập</title></head>
<body><main><h1>Cổng thanh toán VNPAY (giả lập E2E)</h1>
<p>Mã giao dịch: <span data-testid="txn-ref">${esc(q.get("vnp_TxnRef"))}</span></p>
<p>Số tiền: <span data-testid="amount">${amount}</span> VND</p>
<p><a href="${esc(back)}">Quay lại cửa hàng</a></p></main></body></html>`;
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", URLS.mockVnpay);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("OK");
      return;
    }
    if (req.method === "GET" && url.pathname === "/pay") {
      const ref = url.searchParams.get("vnp_TxnRef");
      if (!ref) {
        res.writeHead(400).end("thiếu vnp_TxnRef");
        return;
      }
      seen.set(ref, url.toString());
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(payPage(url));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/ipn") {
      const { txnRef, outcome = "success" } = await readJson(req);
      const paymentUrl = seen.get(txnRef);
      if (!paymentUrl) {
        res
          .writeHead(404, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "chưa thấy giao dịch" }));
        return;
      }
      const key = `${txnRef}|${outcome}`;
      if (!sentIpn.has(key)) sentIpn.set(key, gateway.pay(paymentUrl, outcome).toString());
      const params = sentIpn.get(key);
      // Qua bộ cân bằng tải (T-095): IPN có thể tới bản sao khác với bản đã tạo giao dịch.
      const r = await fetch(`${URLS.backendLb}/x/webhooks/vnpay/ipn?${params}`);
      res.writeHead(200, { "Content-Type": "application/json" }).end(await r.text());
      return;
    }
    res.writeHead(404).end("not found");
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end(String(e instanceof Error ? e.message : e));
  }
});

server.listen(PORTS.mockVnpay, "127.0.0.1", () => {
  console.log(`[mock-vnpay] lắng nghe ${URLS.mockVnpay}`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
