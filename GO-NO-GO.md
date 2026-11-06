# GO/NO-GO — x-shop · phát hành chưa gắn tag (pha build) · 2026-10-26

> Commit: `b17ec82` (+ thay đổi của T-038 chưa merge) · Blueprint: `xt.py blueprint-status BLUEPRINT.md --strict --run` → exit 1 (MUST chưa đạt: xem mục 1; số liệu máy chạy lại ở `release-check`) · CI: không có run gắn với báo cáo này
> Người kiểm: agent thực thi (report-only, không deploy, không sửa mã) · Phạm vi: web (storefront Next.js + backend Medusa + Admin); không có mobile app
> **Kết luận: NO-GO** — còn BLOCKER (mục 3). Đây là báo cáo trạng thái giữa chừng ở pha `delivery_phase: build`, không phải đề nghị phát hành.

## 1. Đếm
Phần máy — `python3 .xtemplates/scripts/xt.py release-check` @ `b17ec8221cb5`, kết quả `NO-GO`:

| Hàng | Mức | Kết quả | Ghi chú máy |
|---|---|---|---|
| blueprint | BLOCKER | FAIL | `blueprint-status --strict --run`: MUST mở 306 (trước T-038) |
| audit | BLOCKER | FAIL | không có `docs/ops/AUDIT-STATUS.md` — audit toàn bộ `--strict` trước phát hành |
| verify | SHOULD | N/A | không chạy autopilot (không có `.autopilot/state.json`) — Gate chạy ở CI |
| tree | BLOCKER | PASS | cây sạch, HEAD `b17ec8221cb5` |
| prod_switch | BLOCKER | N/A (chờ người) | 4 đề xuất "Khi chạy thật" trong `docs/autopilot/DECISIONS.md` — chủ dự án quyết từng mục |
| phase | BLOCKER | FAIL | `xt.yaml` `delivery_phase: build` — phát hành cần `harden` + audit delta (ADR-0031) |
| review_debt | SHOULD | N/A | không đọc được `docs/ops/AUDIT-STATUS.md` |
| attack | BLOCKER | N/A (chờ người) | `xt.yaml` chưa khai `attack` (DAST/fuzz/kịch bản khai thác thử) |
| perf | BLOCKER | N/A (chờ người) | `xt.yaml` chưa khai `perf` (kiểm tải/ngân sách có ngưỡng) |
| unchecked_must | SHOULD | PASS | 0/144 MUST đạt không có lệnh kiểm |

Máy: "Chờ người: prod_switch, attack, perf — máy không thay được chữ ký".

Đếm theo danh mục mục 2 (BLOCKER 1–13, 18 và 20; SHOULD 14–17; NICE 19; `PASS` chỉ khi có bằng chứng chạy thật):

| Mức | PASS | FAIL | N/A |
|---|---|---|---|
| BLOCKER | 0 | 15 | 0 |
| SHOULD | 0 | 4 | 0 |
| NICE | 0 | 1 | 0 |

(0 PASS vì lần lập này không chạy lại build/test/CI; theo luật "Evidence or FAIL", mục không có bằng chứng ở báo cáo này tính FAIL. Bằng chứng một phần đã có ở cột bằng chứng để người ký tham khảo.)

## 2. Danh mục kiểm (mỗi dòng có bằng chứng)
| # | Mức | Mục | Máy đã chạy: kết quả | Nhãn bằng chứng | Máy đã chạy: bằng chứng (file:dòng / lệnh → output / link) | Người đã đọc (tên · ngày) |
|---|---|---|---|---|---|---|
| 1 | BLOCKER | Build tái lập từ clone sạch, không lỗi type/lint | FAIL (chưa chạy) | asserted-not-measured | không có run CI gắn với commit này; `pnpm lint`/`pnpm format:check` được chạy ở commit T-038, không thay cho build sạch | |
| 2 | BLOCKER | Toàn bộ test xanh (unit/integration/E2E luồng chính) | FAIL (chưa chạy) | asserted-not-measured | cổng nhanh chạy ở commit; suite đầy đủ chạy ở CI của PR, không có link ở đây | |
| 3 | BLOCKER | Blueprint: 0 MUST mở | FAIL | real-path | `python3 .xtemplates/scripts/xt.py release-check` → blueprint FAIL, MUST mở 306 trước T-038, còn 302 sau (T-038 đạt thêm 4: SEC-TM-005, STD-SEC-001, STD-SEC-003, STD-API-001) | |
| 4 | BLOCKER | Không secret trong repo và lịch sử git | FAIL (chưa chạy) | asserted-not-measured | workflow `.github/workflows/secret-scan.yml` (gitleaks) tồn tại; không có output chạy ở báo cáo này | |
| 5 | BLOCKER | Phụ thuộc: 0 lỗ hổng cao chưa xử lý; license trong allowlist | FAIL | asserted-not-measured | CI chưa có quét lỗ hổng (OSV/audit) và allowlist license; chưa có `LICENSE` (THREAT-MODEL R-04, O-04) | |
| 6 | BLOCKER | Kiểm quyền phía server cho mọi thao tác nhạy cảm; test vượt quyền xanh | FAIL (chưa chạy) | faithful-fixture | `apps/backend/integration-tests/http/rbac.spec.ts`, `returns-privacy.spec.ts`, `mfa.spec.ts` có; không có run gắn báo cáo | |
| 7 | BLOCKER | Threat model: mọi mối đe doạ Cao có biện pháp + bằng chứng | FAIL (chờ duyệt) | faithful-fixture | `docs/ops/THREAT-MODEL.md` §4 (21 hàng, không hàng Cao nào `accept`), §6 OWASP Top 10:2025, §7 ASVS 5.0.0 L2; chủ dự án chưa duyệt; SEC-TM-006 còn mở | |
| 8 | BLOCKER | Migration có đường lùi; rollback deploy đã diễn tập | FAIL | asserted-not-measured | `docs/ops/RUNBOOK.md` mục 5; chưa có pipeline deploy/staging để diễn tập rollback | |
| 9 | BLOCKER | Backup bật và đã khôi phục thử | FAIL | faithful-fixture | diễn tập restore cục bộ 2026-10-25 (`bash scripts/ops/restore-drill.sh`, `docs/ops/RUNBOOK.md` mục 4, PASS 2 lần) — không phải backup/PITR trên hạ tầng thật | |
| 10 | BLOCKER | Giám sát + cảnh báo đã thử kích hoạt, tới đúng kênh | FAIL | asserted-not-measured | chưa có kênh giám sát/cảnh báo (hạ tầng chưa chọn) | |
| 11 | BLOCKER | Dữ liệu cá nhân: DPIA, đồng ý trước thu thập, chính sách riêng tư công bố | FAIL | asserted-not-measured | `docs/ops/DPIA.md` v1.0 (kỹ thuật, chờ pháp chế/chủ dự án; nhiều bảng chưa có job xoá — §3); chính sách `/bao-mat` chưa duyệt | |
| 12 | BLOCKER | Hiệu năng đạt ngưỡng hồ sơ, đo thật | FAIL | faithful-fixture | `docs/ops/perf/lighthouse-latest.md` (lab, 2026-10-26) và `docs/ops/perf/load-smoke-latest.md` (smoke thu nhỏ ~20×, máy dev) — không phải trên môi trường thật; `xt.yaml` chưa khai `perf` | |
| 13 | BLOCKER | Tiếp cận: 0 vi phạm nghiêm trọng (axe/WCAG AA) trên luồng chính | FAIL (chưa chạy) | asserted-not-measured | `@axe-core/playwright` có trong devDependencies; không có báo cáo run ở đây; kiểm tay bàn phím + trình đọc màn hình chưa làm (STD-A11Y-004) | |
| 14 | SHOULD | Release notes + CHANGELOG cập nhật | FAIL | asserted-not-measured | chưa có | |
| 15 | SHOULD | Runbook được người không xây chạy thử | FAIL | asserted-not-measured | chưa có biên bản | |
| 16 | SHOULD | Sự kiện đo có schema, dashboard baseline ghi | FAIL | asserted-not-measured | chưa có kho analytics (`track()` chỉ chuyển tiếp) | |
| 17 | SHOULD | Tài liệu khớp code | FAIL | asserted-not-measured | tài liệu T-038 (THREAT-MODEL, DPIA, openapi) mới cập nhật theo mã ngày 2026-10-26; chưa rà README (chưa có `README.md`) | |
| 18 | BLOCKER | Mọi đề xuất "Khi chạy thật" đã được chủ dự án quyết | FAIL (chờ người) | real-path | `grep -n "Khi chạy thật" docs/autopilot/DECISIONS.md` → 4 mục, chưa có quyết định (xem 3.2) | |
| 19 | NICE | Tối ưu mã nguồn: dead code/dependency thừa đã rà | FAIL | asserted-not-measured | chưa chạy knip/depcheck | |
| 20 | BLOCKER | Mật khẩu admin: mọi hash emailpass trên DB production đạt scrypt tối thiểu OWASP (logN ≥ 17, r ≥ 8, p ≥ 1) — tài khoản còn hash cũ phải đặt lại mật khẩu (ADR-0006, D-137) | FAIL (chưa chạy trên DB production) | faithful-fixture | `DATABASE_URL=<production, chỉ đọc> pnpm check:scrypt-params` → phải exit 0 (`dưới chuẩn 0 · sai định dạng 0`); script được chạy trong `apps/backend/integration-tests/http/password-hash.spec.ts` (hash logN 15 → exit 1, sau đăng nhập đúng → exit 0) | |

Mục đặc thù hồ sơ/ngành (ecommerce, PCI SAQ A, đối soát) nằm trong BLUEPRINT.md (IND-ECOM-*) — chưa tính ở bảng trên.

## 2b. Bằng chứng chưa chứng minh (bắt buộc ghi, kể cả khi GO)
| Phạm vi | Vì sao chưa chứng minh | Kiểm thật khi nào / ai |
|---|---|---|
| Thanh toán qua cổng VNPAY thật (IPN, querydr, hoàn tiền) | chỉ chạy mock + fixture theo protocol (`faithful-fixture`); chưa có khoá merchant | trước khi bật cho khách thật — chủ dự án cấp khoá sandbox/merchant |
| Vận chuyển GHN thật (tạo vận đơn, callback, đối soát COD) | mock + fixture; chưa có token/shop_id; callback GHN không có chữ ký (rủi ro R-01) | trước ra mắt — chủ dự án |
| Gửi email/SMS thật | adapter `log`; nhà cung cấp chưa chọn | khi chọn nhà cung cấp — chủ dự án |
| Hiệu năng ở quy mô thật | smoke thu nhỏ trên máy dev; Lighthouse lab; không có RUM | sau khi có staging/production |
| Backup/PITR, TLS, log tập trung, cảnh báo | hạ tầng chưa chọn; chỉ diễn tập cục bộ | khi có staging — chủ dự án |
| Bảo mật tấn công thử (DAST/fuzz) và ASVS L2 từng yêu cầu con | chưa khai `attack`; THREAT-MODEL §7 chỉ đối chiếu theo chương | trước G7 — người bảo mật độc lập |
| Tiếp cận (kiểm tay) | chưa có biên bản | trước G7 — người kiểm |

## 3. Bảng FAIL
### 3.1 BLOCKER
| # | Mức | Mục | Bằng chứng | Cách sửa đề xuất | Ticket / chủ / hạn |
|---|---|---|---|---|---|
| 3 | BLOCKER | MUST mở (306 trước T-038) | `release-check` blueprint FAIL | làm tiếp PLAN; mục cần người ghi `loop defer` | phiên chính |
| — | BLOCKER | Chưa có `docs/ops/AUDIT-STATUS.md` (audit `--strict` trước phát hành) | `release-check` audit FAIL | chạy audit toàn bộ khi chuyển sang harden (ADR-0033) | phiên chính |
| — | BLOCKER | `delivery_phase: build` | `release-check` phase FAIL | đặt `harden` khi lên production + audit delta (ADR-0031) | chủ dự án quyết thời điểm |
| — | BLOCKER | `attack` chưa khai trong `xt.yaml` | `release-check` attack N/A | khai lệnh (DAST/fuzz/kịch bản khai thác thử), hoặc người ký lý do không áp | chủ dự án / phiên chính |
| — | BLOCKER | `perf` chưa khai trong `xt.yaml` | `release-check` perf N/A | khai lệnh có ngưỡng (`pnpm load:smoke`/`perf:budget` đã có, cần nối vào cổng) hoặc người ký | chủ dự án / phiên chính |
| 5 | BLOCKER | Chưa có `LICENSE`; chưa quét lỗ hổng phụ thuộc trong CI | THREAT-MODEL O-04, R-04 | chủ dự án chọn license; thêm bước OSV-Scanner vào CI | chủ dự án / phiên chính |
| 8–10 | BLOCKER | Chưa có staging, backup/PITR thật, giám sát/cảnh báo | THREAT-MODEL O-03 | chọn hạ tầng, diễn tập restore + cảnh báo thử | chủ dự án |
| 11 | BLOCKER | DPIA chờ pháp chế; chính sách `/bao-mat`; job xoá theo thời hạn | `docs/ops/DPIA.md` §3, §9 | chủ dự án chốt thời hạn lưu; phiên chính viết job + test | chủ dự án |
| 12 | BLOCKER | Hiệu năng chưa đo trên môi trường thật | `docs/ops/perf/` | đo trên staging | chủ dự án |
| 13 | BLOCKER | Kiểm tay a11y chưa có | — | biên bản người + ngày + luồng | người kiểm |
| — | BLOCKER | Ruleset nhánh `main` đang tắt trên remote | THREAT-MODEL O-01 (file mẫu `.github/rulesets/main.json` đặt `active`) | chủ dự án bật ruleset đòi check `quality`, `gitleaks` | chủ dự án |
| — | BLOCKER | Khoá merchant thật VNPAY + token GHN chưa có | THREAT-MODEL O-02 | chủ dự án đăng ký | chủ dự án |
| — | BLOCKER | Production bắt buộc đặt `STOREFRONT_URL` (https://, gốc storefront thật) — liên kết tra cứu đơn dựng từ biến này; thiếu/không https thì backend từ chối khởi động (D-091, T-149) | `apps/backend/src/lib/env/index.ts` (`PRODUCTION_REQUIRED`), `docs/ops/ENV.md` | đặt biến trong cấu hình triển khai (server và worker) trước khi lên production | chủ dự án / người triển khai |
| — | BLOCKER | Production bắt buộc kho file S3-compatible DÙNG CHUNG giữa các bản sao: `FILE_STORAGE=s3` + `S3_REGION`, `S3_BUCKET`, `S3_PRIVATE_BUCKET`, `S3_FILE_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (endpoint/URL công khai https), `MEDUSA_BACKEND_URL` https; vắng, `local`, hai bucket trùng, hay đặt kèm `PRIVATE_UPLOAD_DIR` thì backend từ chối khởi động (T-154; thay ràng buộc volume `PRIVATE_UPLOAD_DIR` của T-141/D-104) | `apps/backend/src/lib/env/index.ts` (`fileStorageProblems`), `apps/backend/src/lib/upload/s3/`, `docs/ops/RUNBOOK.md` §8.2b, `docs/ops/ENV.md` | dựng kho S3-compatible (tự host Garage/SeaweedFS — MinIO cộng đồng đã ngừng bảo trì — hoặc dịch vụ quản lý); bucket công khai có policy đọc nặc danh, bucket private KHÔNG (kiểm `curl` không chữ ký → 403); khoá truy cập riêng chỉ Get/Put/Delete/Head + `s3:ListBucket` trên hai bucket; TLS; cùng biến cho server, worker, `medusa db:migrate`, `medusa exec`; storefront đặt `XS_MEDIA_URL` (= `S3_FILE_URL`, https) LÚC BUILD; chuyển file `static/` và `PRIVATE_UPLOAD_DIR` cũ (nếu có) vào hai bucket cùng tên khoá; chạy test `upload` với kho thật (`XS_TEST_S3_ENDPOINT`) | chủ dự án / người triển khai |
| — | BLOCKER | Script `start` của backend và storefront bind `127.0.0.1` mặc định (BASE-SEC-010) — triển khai sau LB/container phải đặt `HOST=0.0.0.0` cho tiến trình server và storefront, nếu không LB không kết nối được backend | `apps/backend/package.json` và `apps/storefront/package.json` (`start`), `docs/ops/ENV.md`, `docs/ops/RUNBOOK.md` | đặt `HOST=0.0.0.0` trong cấu hình triển khai (server) và kiểm readiness qua LB trước khi lên production | chủ dự án / người triển khai |

### 3.2 Đề xuất "Khi chạy thật" chờ chủ dự án quyết (mục 18, `prod_switch`)
| D-NNN | Đề xuất (chủ dự án quyết ở G7) | Quyết định (chủ dự án) |
|---|---|---|
| D-005 | Production: Postgres/Redis managed có backup PITR; object storage S3 + CDN | chưa quyết |
| D-024 | Ảnh qua S3-compatible + CDN đặt `nosniff`; tắt `/static` | chưa quyết |
| D-027 | Dùng file xuất thật VNPAY/GHN khi có hợp đồng merchant (định dạng đối soát hiện là GIẢ ĐỊNH) | chưa quyết |
| D-039 | RUM web-vitals trên hạ tầng thật sau ra mắt | chưa quyết |

### 3.3 SHOULD
| # | Mức | Mục | Bằng chứng | Cách sửa đề xuất | Ticket / chủ / hạn |
|---|---|---|---|---|---|
| 14–17 | SHOULD | Release notes/CHANGELOG, runbook chạy thử bởi người ngoài, schema sự kiện đo, rà tài liệu (chưa có `README.md`) | mục 2 | làm trước G7 | phiên chính — chưa đặt hạn (cần ticket trước khi GO) |

## 4. Kết luận
**NO-GO** — BLOCKER ở mục 3.1 (blueprint, audit, phase, attack, perf, hạ tầng, pháp lý/DPIA, ruleset, khoá merchant, LICENSE) chưa FAIL→PASS; 4 đề xuất "Khi chạy thật" (mục 3.2) chưa được chủ dự án quyết. Điều kiện kèm theo (SHOULD FAIL có ticket): chưa áp dụng vì chưa GO.
Rủi ro còn lại được chấp nhận: chưa có mục nào được người có thẩm quyền chấp nhận (xem THREAT-MODEL §8–§9).

## 5. Ký (con người, không phải agent)
| Vai trò | Tên | Quyết định | Ngày |
|---|---|---|---|
| Chủ sản phẩm | | | |
| Kỹ thuật / vận hành | | | |
| Bảo mật / pháp lý | | | |

## 6. Kiểm tay a11y (STD-A11Y-004)
Chưa thực hiện. Cần biên bản: người kiểm, ngày, luồng (mua COD, mua VNPAY, tra cứu đơn, đổi trả), công cụ (bàn phím + một trình đọc màn hình), kết quả.

## 7. Hiệu năng (QA-PERF-006)
Chưa có số đo đủ 5 trường (commit, môi trường, thiết bị/mạng mô phỏng, VU/thời lượng, ngày) trên môi trường thật → mục hiệu năng là NO-GO. Số đo lab/smoke hiện có: `docs/ops/perf/lighthouse-latest.md`, `docs/ops/perf/load-smoke-latest.md` (máy dev, thu nhỏ).
