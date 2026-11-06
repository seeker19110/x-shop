# SLO — x-shop

> Lập 2026-10-26 (T-079, OPS-SLO-001). Mục tiêu lấy từ đặc tả gốc §10.1 (`docs/specs/DAC-TA-GOC.md`) và `PROJECT.md` §5 — là
> mục tiêu nội bộ, hiệu chỉnh khi có hạ tầng thật. Mọi SLI viết dạng **tỷ lệ sự kiện tốt / tổng sự kiện** trên cửa sổ trượt
> **28 ngày** (theo Google SRE Workbook, "Implementing SLOs"). Cảnh báo burn rate, dashboard và kho metric: chờ hạ tầng
> (OPS-OBS-001/003, OPS-SLO-004/005/006 — xem `docs/autopilot/PLAN-2.md` mục "Chờ hạ tầng").

## 1. Nguồn dữ liệu

| Dịch vụ | Nguồn | Trạng thái |
|---|---|---|
| Backend (Medusa, `apps/backend`) — Store API mà storefront gọi | Log truy cập JSON một dòng/request của `medusa start` ở production (`{"level":"http","method","path","status","duration","timestamp",…}`; `duration` tính bằng ms, `timestamp` ISO 8601 UTC) | **Có ngay** — truy vấn `jq` ở §3 chạy được trên file log; kiểm tự động: `node --test scripts/check-slo.test.mjs` |
| Backend — cùng SLI dạng PromQL | Metric HTTP server theo quy ước ngữ nghĩa OpenTelemetry (`http.server.request.duration`, giây, histogram) xuất sang Prometheus | Chờ hạ tầng metric (OPS-OBS-001) — truy vấn §4 dùng khi có |
| Storefront (Next.js, `apps/storefront`) — trang HTML | Log truy cập của reverse proxy/bộ cân bằng tải trước storefront (chưa chọn nhà cung cấp) | Chờ hạ tầng — SLI định nghĩa ở §2, truy vấn viết khi biết định dạng log của proxy |

Loại khỏi mọi SLI: kiểm sống/sẵn sàng (`/health`, `/x/health`, `/x/readyz` — `/health` Medusa vốn không ghi log), Admin
(`/admin/*`, `/app/*` — nhân viên, không phải hành trình khách), webhook đối tác (`/x/webhooks/*` — đặc tả §10.1 "báo ảnh
hưởng đối tác riêng"). 4xx (dữ liệu sai, 404, 409 xung đột, 429 rate limit) là sự kiện **tốt** với availability: lỗi do
yêu cầu, không do dịch vụ (đặc tả §10.1 "loại lỗi validation hợp lệ"). 5xx — kể cả 503 `LOCK_UNAVAILABLE`/`SHIPPING_UNAVAILABLE`
khi checkout tự dừng — là sự kiện **xấu**.

## 2. SLI và SLO

| ID | Dịch vụ | SLI (tốt / tổng) | SLO (28 ngày) | Ngân sách lỗi |
|---|---|---|---|---|
| `SLI-A1` | Backend | Availability: request `/store/*` có `status < 500` / mọi request `/store/*` | ≥ 99,9 % | 0,1 % ≈ 40 phút/28 ngày nếu lỗi dồn liên tục |
| `SLI-L1` | Backend | Latency đọc: `GET /store/*` không 5xx có `duration ≤ 300 ms` / mọi `GET /store/*` không 5xx | ≥ 95 % (≡ p95 ≤ 300 ms) | 5 % request chậm |
| `SLI-L2` | Backend | Latency ghi: `POST/PUT/PATCH/DELETE /store/*` (trừ `/store/x/checkout/submit`) không 5xx có `duration ≤ 700 ms` / tổng tương ứng | ≥ 95 % (≡ p95 ≤ 700 ms) | 5 % |
| `SLI-L3` | Backend | Latency checkout: `POST /store/x/checkout/submit` không 5xx có `duration ≤ 2000 ms` / tổng tương ứng | ≥ 95 % (≡ p95 ≤ 2 s) | 5 % |
| `SLI-A2` | Storefront | Availability: request trang HTML có `status < 500` / mọi request trang HTML (tại proxy) | ≥ 99,9 % | 0,1 % |
| `SLI-L4` | Storefront | Latency: request trang HTML không 5xx có thời gian tới byte đầu ≤ 800 ms / tổng tương ứng | ≥ 75 % (≡ p75 TTFB ≤ 800 ms, đặc tả §10.1) | 25 % |

Ghi chú:
- Latency chỉ tính request không 5xx (request lỗi đã bị tính ở availability; lỗi nhanh không được làm đẹp latency).
- `SLI-L3` gồm thời gian giữ hàng + tạo đơn + tạo URL thanh toán (ký cục bộ); không gồm thời gian khách ở cổng VNPAY.
  Đặc tả §10.1 đo "checkout nội bộ" không gồm provider — khi GHN/VNPAY gọi đồng bộ trong submit làm lệch số, tách span provider
  bằng trace (T-090, BASE-ERR-009) rồi đo lại.
- Số đo trước ra mắt (k6, không phải SLO): `docs/ops/perf/load-smoke-latest.md`; ngưỡng k6 ở `scripts/load/k6/xshop-load.js`.

## 3. Truy vấn trên log truy cập backend (chạy được ngay)

Đầu vào: `LOG` = file log stdout của tiến trình server backend (NDJSON; dòng không phải JSON hoặc không phải `level: http` bị bỏ
qua); `FROM`/`TO` = mốc ISO 8601 UTC (`YYYY-MM-DDTHH:MM:SSZ`, so sánh chuỗi đúng thứ tự thời gian). Mỗi truy vấn in
`{"good","total","ratio"}` (`ratio = null` khi `total = 0` — không có mẫu, ghi "thiếu mẫu", không coi là đạt).

<!-- slo-query: SLI-A1 -->
```bash
jq -Rn --arg from "$FROM" --arg to "$TO" '
  [inputs | fromjson? | select(type == "object" and .level == "http")
   | select(.timestamp >= $from and .timestamp < $to)
   | select(.path | startswith("/store/"))] as $r
  | ($r | map(select(.status < 500)) | length) as $good
  | {good: $good, total: ($r | length), ratio: (if ($r | length) == 0 then null else $good / ($r | length) end)}
' "$LOG"
```

<!-- slo-query: SLI-L1 -->
```bash
jq -Rn --arg from "$FROM" --arg to "$TO" '
  [inputs | fromjson? | select(type == "object" and .level == "http")
   | select(.timestamp >= $from and .timestamp < $to)
   | select(.method == "GET" and (.path | startswith("/store/")) and .status < 500)] as $r
  | ($r | map(select(.duration <= 300)) | length) as $good
  | {good: $good, total: ($r | length), ratio: (if ($r | length) == 0 then null else $good / ($r | length) end)}
' "$LOG"
```

<!-- slo-query: SLI-L2 -->
```bash
jq -Rn --arg from "$FROM" --arg to "$TO" '
  [inputs | fromjson? | select(type == "object" and .level == "http")
   | select(.timestamp >= $from and .timestamp < $to)
   | select((.method | IN("POST", "PUT", "PATCH", "DELETE")) and (.path | startswith("/store/")) and .status < 500)
   | select((.path | split("?")[0]) != "/store/x/checkout/submit")] as $r
  | ($r | map(select(.duration <= 700)) | length) as $good
  | {good: $good, total: ($r | length), ratio: (if ($r | length) == 0 then null else $good / ($r | length) end)}
' "$LOG"
```

<!-- slo-query: SLI-L3 -->
```bash
jq -Rn --arg from "$FROM" --arg to "$TO" '
  [inputs | fromjson? | select(type == "object" and .level == "http")
   | select(.timestamp >= $from and .timestamp < $to)
   | select(.method == "POST" and (.path | split("?")[0]) == "/store/x/checkout/submit" and .status < 500)] as $r
  | ($r | map(select(.duration <= 2000)) | length) as $good
  | {good: $good, total: ($r | length), ratio: (if ($r | length) == 0 then null else $good / ($r | length) end)}
' "$LOG"
```

Ví dụ: `LOG=server.log FROM=2026-10-01T00:00:00Z TO=2026-10-29T00:00:00Z bash -c '<truy vấn>'`. Đạt SLO khi `ratio ≥`
mục tiêu ở §2. Kiểm tự động (cú pháp + kết quả trên log mẫu có đủ ca biên): `node --test scripts/check-slo.test.mjs` — test
đọc chính các khối truy vấn trên (đánh dấu `slo-query`) nên sửa truy vấn ở đây là sửa thứ được kiểm.

## 4. Truy vấn PromQL (khi có metric OpenTelemetry — chờ hạ tầng)

Tên metric Prometheus của histogram OTel `http.server.request.duration` (đơn vị giây): `http_server_request_duration_seconds_*`;
nhãn `http_request_method`, `http_response_status_code`, `http_route` (route mẫu, không phải URL thật); `service_name` gắn khi
xuất (`x-shop-backend`, `x-shop-storefront`). `le` phải có bucket đúng ngưỡng (0.3, 0.7, 0.8, 2) — đặt khi cấu hình exporter.

```promql
# SLI-A1 — availability Store API
sum(rate(http_server_request_duration_seconds_count{service_name="x-shop-backend", http_route=~"/store/.*", http_response_status_code!~"5.."}[28d]))
/
sum(rate(http_server_request_duration_seconds_count{service_name="x-shop-backend", http_route=~"/store/.*"}[28d]))

# SLI-L1 — latency đọc ≤ 300 ms
sum(rate(http_server_request_duration_seconds_bucket{service_name="x-shop-backend", http_route=~"/store/.*", http_request_method="GET", http_response_status_code!~"5..", le="0.3"}[28d]))
/
sum(rate(http_server_request_duration_seconds_count{service_name="x-shop-backend", http_route=~"/store/.*", http_request_method="GET", http_response_status_code!~"5.."}[28d]))

# SLI-L2 — latency ghi ≤ 700 ms (trừ submit)
sum(rate(http_server_request_duration_seconds_bucket{service_name="x-shop-backend", http_route=~"/store/.*", http_route!="/store/x/checkout/submit", http_request_method=~"POST|PUT|PATCH|DELETE", http_response_status_code!~"5..", le="0.7"}[28d]))
/
sum(rate(http_server_request_duration_seconds_count{service_name="x-shop-backend", http_route=~"/store/.*", http_route!="/store/x/checkout/submit", http_request_method=~"POST|PUT|PATCH|DELETE", http_response_status_code!~"5.."}[28d]))

# SLI-L3 — latency checkout ≤ 2 s
sum(rate(http_server_request_duration_seconds_bucket{service_name="x-shop-backend", http_route="/store/x/checkout/submit", http_request_method="POST", http_response_status_code!~"5..", le="2"}[28d]))
/
sum(rate(http_server_request_duration_seconds_count{service_name="x-shop-backend", http_route="/store/x/checkout/submit", http_request_method="POST", http_response_status_code!~"5.."}[28d]))

# SLI-A2 — availability storefront (trang HTML; nhãn route theo exporter của proxy)
sum(rate(http_server_request_duration_seconds_count{service_name="x-shop-storefront", http_response_status_code!~"5.."}[28d]))
/
sum(rate(http_server_request_duration_seconds_count{service_name="x-shop-storefront"}[28d]))

# SLI-L4 — storefront ≤ 800 ms
sum(rate(http_server_request_duration_seconds_bucket{service_name="x-shop-storefront", http_response_status_code!~"5..", le="0.8"}[28d]))
/
sum(rate(http_server_request_duration_seconds_count{service_name="x-shop-storefront", http_response_status_code!~"5.."}[28d]))
```

## 5. Readiness và SLO

`GET /x/readyz` (T-079) trả 503 khi Postgres hoặc Redis không trả lời trong 1 s — bộ cân bằng tải rút instance ra khỏi vòng,
request khách đi sang instance khỏe thay vì nhận 5xx (bảo vệ `SLI-A1`). Probe của bộ điều phối: `timeoutSeconds ≥ 2`,
`periodSeconds` 5–10, `failureThreshold` 2–3; liveness dùng `/x/health` (không chạm phụ thuộc — DB chập chờn không làm khởi
động lại hàng loạt). Không đưa phiên bản build vào hai endpoint này (D-050).

## 6. Khi tiêu hết ngân sách lỗi

Chính sách tạm (đến khi có cảnh báo burn rate — OPS-SLO-004/005): `ratio` 28 ngày dưới mục tiêu → ưu tiên việc độ tin cậy trước
tính năng mới trong mốc kế tiếp, ghi sự cố/nguyên nhân vào `docs/ops/RUNBOOK.md` hoặc postmortem; chủ dự án quyết ngoại lệ.
