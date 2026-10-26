# PROJECT.md — x-shop (webapp shop thời trang)

> Cổng G0/G1: phiên chính tự duyệt 2026-10-24 (D-001) · Nguồn yêu cầu: `docs/specs/DAC-TA-GOC.md` (bản Markdown của
> `Dac-ta-webapp-shop-thoi-trang.docx` v1.0, 24/10/2026 — chủ dự án cung cấp) · Phiên bản tài liệu: 1

## 0. Loại dự án & hồ sơ
- Hồ sơ: `web-app` · Gói ngành: `ecommerce` · Quy mô: **M** — lý do: tiền thật (COD + cổng online), dữ liệu cá nhân
  khách (tên, SĐT, địa chỉ), nhiều vai trò quản trị; một đơn vị bán, không đa tenant.
- Feature fact: `auth`, `payment`, `pii`.
- Blueprint: `python3 .xtemplates/scripts/xt.py compose --profile web-app --industry ecommerce --scale M --feature payment --feature pii --feature auth --out BLUEPRINT.md`

## 1. Vấn đề & người dùng
- Vấn đề: shop/thương hiệu thời trang bán trực tiếp tại Việt Nam cần kênh bán riêng trên điện thoại mà khách chọn
  đúng màu/size và mua nhanh, còn chủ shop kiểm soát được tồn, tiền COD/online, giao vận và đổi trả — sàn và
  website mẫu thường giấu size, bắt đăng nhập, bán vượt tồn và không đối soát được COD.
- Người dùng: (1) người mua trên điện thoại tầm trung tại VN; (2) chủ shop và nhân viên (đơn hàng, kho, CSKH, kế toán).
- JTBD: Khi thấy một món ưng ý, tôi muốn chọn đúng size và trả tiền không cần tài khoản, để nhận đúng hàng và biết
  rõ đơn đang ở đâu.
- Bằng chứng nhu cầu: đặc tả gốc §2 (Baymard S01–S04, tham khảo UNIQLO VN/COS S05–S06).
- Thay thế: Shopify headless, sàn TMĐT, tự viết từ đầu — so sánh ở đặc tả gốc §7.1; quyết định ở ADR-0001.

## 2. Chỉ số thành công
| ID | Chỉ số | Baseline | Mục tiêu | Hạn | Sự kiện đo |
|---|---|---|---|---|---|
| M-01 | Tỷ lệ hoàn tất checkout = `order_placed` / `begin_checkout` (28 ngày) | chưa đo — đo 2–4 tuần đầu sau ra mắt | đặt sau baseline | baseline + 4 tuần | `begin_checkout`, `order_placed` |
| M-02 | Đổi trả do sai size = return lý do `size` / đơn giao (28 ngày) | chưa đo | đặt sau baseline | như trên | `refund`, return reason |
| M-03 | Chênh lệch đối soát COD chưa xử lý quá 7 ngày | chưa đo | 0 | ra mắt + 30 ngày | settlement `disputed` |
| M-04 | Core Web Vitals p75 mobile: LCP ≤ 2,5 s · INP ≤ 200 ms · CLS ≤ 0,1 | chưa đo | đạt | ra mắt + 28 ngày RUM | web-vitals RUM |
| M-05 | Bán vượt tồn / thu tiền trùng không hoàn | 0 (bất biến) | 0 | luôn | test AT04, AT06, AT36 |

## 3. Phạm vi MVP (P0 của đặc tả gốc = Must)
| ID | Tính năng | Mức | Spec | Yêu cầu gốc |
|---|---|---|---|---|
| F-001 | Nền tảng: monorepo, CI, Medusa + Postgres + Redis, Next.js | Must | ADR-0001 | §7, T01 |
| F-002 | Design system + 6 màn hình cốt lõi | Must | `docs/specs/SPEC-storefront.md` | §3, WEB01, PDP01–05, T02 |
| F-003 | Catalog: SKU màu × size, bảng size, import CSV, kiểm trước xuất bản | Must | `docs/specs/SPEC-catalog.md` | ADM01–03, T03 |
| F-004 | Tìm kiếm + lọc cùng biến thể + URL state | Must | `docs/specs/SPEC-catalog.md` | CAT01–04, AT01, AT31, AT32, T04 |
| F-005 | Giỏ + báo giá server (quote, cart version) | Must | `docs/specs/SPEC-checkout.md` | CHK01–05, PRICE01–04, T05 |
| F-006 | Đơn chờ thanh toán + giữ hàng + idempotency | Must | `docs/specs/SPEC-checkout.md` | §6.2, INV02, DATA01–02, AT04–05, AT10, AT12, T06 |
| F-007 | Thanh toán: COD + VNPAY (adapter, ledger, IPN, query, refund) | Must | `docs/specs/SPEC-payment.md` | §6.2, §9.2, AT06–09, AT11, AT16, AT35–36, T07 |
| F-008 | Giao vận GHN + địa chỉ 2 cấp + COD | Must | `docs/specs/SPEC-fulfillment.md` | §6.3–6.4, CHK03, AT13–14, AT23, T08 |
| F-009 | Sau mua: tra cứu đơn, hủy, đổi trả, hoàn tiền, đối soát | Must | `docs/specs/SPEC-fulfillment.md` | POST01–03, §6.5, INV04, AT15, AT17, T09 |
| F-010 | Quản trị: RBAC 6 vai trò, MFA, audit log, báo cáo/ngoại lệ | Must | `docs/specs/SPEC-admin.md` | §5.4–5.5, ADM04, SEC02, AT21, T10 |
| F-011 | SEO, PWA, telemetry không PII | Must | `docs/specs/SPEC-storefront.md` | §12, §13.1, AT26, AT29, T11 |
| F-012 | Chất lượng: tải, a11y, restore, runbook | Must | `docs/ops/` | §10, §11.3, §13.2, AT25, AT27–28, T12 |
| F-101 | Tài khoản, Google login, wishlist, review, phối đồ | Should (P1) | — | §16.1 |

### Không làm (lúc này)
- P2: AI stylist, tìm bằng ảnh, thử đồ ảo, đa kho phân bổ, POS/sàn, đa quốc gia, app native — cần dữ liệu chứng minh.
- Marketplace nhiều người bán; đa tiền tệ; thanh toán thẻ trực tiếp (không lưu PAN/CVV — chỉ trang của cổng).
- Kết nối tiền thật, khoá merchant thật, gửi SMS/email thật, deploy production: cần chủ dự án (PLAN §Ủy quyền).

## 4. Luồng chính (bắt buộc E2E)
1. R-001 Mua COD dạng khách: trang chủ → danh mục (lọc đen-M) → PDP chọn màu/size → giỏ → checkout → đơn `placed` → tra cứu đơn.
2. R-002 Mua online: … → checkout VNPAY (sandbox/mock) → redirect → "Đang xác nhận" → IPN hợp lệ → đơn `confirmed`.
3. R-003 Vận hành: nhân viên đơn xác nhận → tạo vận đơn → giao → COD về → đối soát `settled`.
4. R-004 Đổi trả: khách yêu cầu trả 1/2 món → kho nhận + kiểm định → kế toán hoàn đúng phần đã trả.

## 5. Phi chức năng
| Nhóm | Ngưỡng | Nguồn | Cách đo |
|---|---|---|---|
| CWV | LCP ≤ 2,5 s, INP ≤ 200 ms, CLS ≤ 0,1 (p75) | web.dev [S07] | Lighthouse lab (hồ sơ §10.1) trước ra mắt, RUM sau |
| Ngân sách | JS đầu ≤ 200 KiB gzip, CSS ≤ 50 KiB, font ≤ 100 KiB | đặc tả §10.2 | `scripts/budget` trên build |
| API | đọc p95 ≤ 300 ms, ghi p95 ≤ 700 ms, checkout nội bộ p95 ≤ 2 s | đặc tả §10.1 | k6 theo §10.3 |
| Bảo mật | ASVS 5.0.0 L2 (chọn lọc theo bề mặt thật) | OWASP [S14] | `docs/ops/THREAT-MODEL.md` + test |
| Tiếp cận | WCAG 2.2 AA | W3C [S08] | axe trong E2E + kiểm tay |
| Thiết bị | 320–1440 px; Chrome/Safari/Firefox hiện hành; Android tầm trung, iPhone Safari | đặc tả §3.2 | Playwright viewport |

## 6. Dữ liệu & pháp lý
- Dữ liệu cá nhân: có — cơ bản (họ tên, SĐT, email, địa chỉ); không thu dữ liệu nhạy cảm.
- Tiền thật: có (COD, VNPAY). Dev/CI chỉ sandbox/mock.
- Luật (xác minh ở `docs/research/2026-10-24-stack.md`): Luật TMĐT 122/2025/QH15 + NĐ 248/2026/NĐ-CP; Luật BVDLCN
  91/2025/QH15 + NĐ 356/2025/NĐ-CP. Chủ shop/người phụ trách pháp lý rà trước ra mắt (đặc tả §11.2).
- DPIA: `docs/ops/DPIA.md` (lát hoàn thiện).

## 7. Stack (chi tiết + phiên bản: ADR-0001)
Next.js App Router + TypeScript (storefront) · Medusa v2 (commerce + Admin) · PostgreSQL · Redis · S3-compatible + CDN.

## 8. Giả định, rủi ro
| Giả định/rủi ro | Cách kiểm chứng | RK |
|---|---|---|
| Medusa v2 cho phép "đơn chờ thanh toán + reservation gắn line" mà webhook native không hoàn tất giỏ lần hai | Spike Lát 2 (AT04, AT05, AT35) — đỏ thì ADR đổi hướng | RK-001 |
| Lọc cùng biến thể + giá của SKU khớp không làm được bằng API list native | Read model Postgres riêng (bắt buộc từ P0) | RK-002 |
| Admin native thiếu RBAC chi tiết/MFA | Kiểm trên bản đã ghim; thiếu → middleware RBAC + TOTP riêng | RK-003 |
| VND không có số lẻ; phân bổ giảm giá làm tròn | Lõi tiền thuần TS, test thuộc tính (tổng phân bổ = tổng giảm) | RK-004 |
| Phạm vi P0 lớn (8–12 tuần 2–3 kỹ sư theo đặc tả) so với một phiên tự động | Chia lát, lõi tiền/tồn trước UI trang trí; phần cần người → defer | RK-005 |
| Khoá VNPAY/GHN thật chỉ chủ dự án có | Adapter + mock theo protocol; sandbox khi có khoá | RK-006 |

## 9. Các bên
| Vai trò | Quyết định |
|---|---|
| Chủ dự án (seeker19110) | Phạm vi, hợp đồng VNPAY/GHN, chính sách đổi trả/thuế, dữ liệu thật, production |
| Phiên chính (agent) | Quyết định kỹ thuật theo AGENTS.md §5, ghi D-NNN |

## 10. Câu hỏi mở (đặc tả §16.3) — mặc định thiết kế, chủ dự án đổi được qua cấu hình
- [ ] Tên/nhận diện shop — [không chặn] — token + nội dung thay được (D-002)
- [ ] Email hay SMS là kênh bắt buộc — [không chặn] — P0: email tùy chọn khi có SĐT; adapter thông báo dạng log/outbox (D-002)
- [ ] TTL giữ hàng online / hạn xác nhận COD — [không chặn] — 15 phút / 24 giờ, cấu hình (D-002)
- [ ] Chính sách đổi trả, thuế/hóa đơn, phí ship — [chặn ra mắt, không chặn build] — cấu hình có version
