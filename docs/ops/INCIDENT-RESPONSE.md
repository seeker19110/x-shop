---
title: INCIDENT-RESPONSE x-shop
kind: incident-response
version: "1.0"
updated: 2026-10-26
status: bản đầu (chưa diễn tập; chủ dự án điền vai trò và liên hệ)
---

# INCIDENT-RESPONSE — x-shop · 1.0 · 2026-10-26

> Phạm vi: storefront Next.js, backend Medusa v2 (server + worker + Admin), Postgres, Redis, VNPAY, GHN, email/SMS. Quy trình kỹ thuật theo
> từng loại lỗi nằm ở [`RUNBOOK.md`](RUNBOOK.md); vi phạm dữ liệu cá nhân ở [`runbooks/data-breach.md`](runbooks/data-breach.md). Nguyên tắc dự án:
> **tiền và tồn đúng quan trọng hơn còn bán được**. Nguồn khung: NIST SP 800-61r3; PagerDuty Incident Response; SRE Book (theo khung X-Templates, tra 2026-10-13).
> Hiện chưa có hạ tầng production, người trực, status page hay cảnh báo tự động (RUNBOOK §8.1): các thời gian phản ứng dưới đây là **mục tiêu**,
> chỉ có hiệu lực khi chủ dự án điền người trực ở §2.

## 1. Mức độ (SEV)

| Mức      | Nghĩa                                                             | Ví dụ của x-shop                                                                                                                                                                                                                                                                                      | Phản ứng (mục tiêu)                                                    | Post-mortem                      |
| -------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------- |
| **SEV1** | Sập toàn bộ, mất/lộ dữ liệu, mất tiền, xâm nhập xác nhận          | (1) Lộ `VNPAY_HASH_SECRET` hoặc bị giả IPN "đã thanh toán". (2) Lộ DB/dump PII khách. (3) Đơn đã đặt thiếu `order_finance`/`payment_attempt` hàng loạt. (4) Toàn bộ checkout và catalog không truy cập được.                                                                                          | Ngay lập tức; IC nhận trong ≤ 15 phút; bắt đầu giảm thiệt hại ngay    | Bắt buộc, ≤ 5 ngày làm việc      |
| **SEV2** | Luồng chính suy giảm nặng hoặc một nhóm lớn khách không dùng được | (1) VNPAY không phản hồi/IPN không về (RUNBOOK §1), `payment_attempt` `unknown` tăng. (2) Redis mất → checkout trả 503 `LOCK_UNAVAILABLE` (RUNBOOK §3). (3) Deploy lỗi cần rollback (RUNBOOK §5). (4) Callback GHN ngừng, vận đơn không cập nhật.                                                      | Trong giờ làm ưu tiên tuyệt đối; ngoài giờ nếu có người trực           | Bắt buộc, ≤ 5 ngày làm việc      |
| **SEV3** | Ảnh hưởng nhỏ, có cách lách                                       | (1) `outbox_event` `dead` vài bản ghi, thông báo email chưa gửi (RUNBOOK §12). (2) Ảnh sản phẩm hỏng/CDN chậm một phần (RUNBOOK §6). (3) `ops_exception late_payment` cần kế toán xử lý (RUNBOOK §7).                                                                                                  | Lên lịch trong tuần                                                    | Tuỳ chọn; lặp ≥ 2 lần/quý → SEV2 |
| **SEV4** | Không ảnh hưởng khách, nợ vận hành                                | (1) Cảnh báo nhiễu. (2) Job `reconcile-attempts` chậm nhưng không có attempt kẹt. (3) Ổ đĩa/cache gần ngưỡng cảnh báo.                                                                                                                                                                                | Ticket thường                                                          | Không                            |

**Sự cố bảo mật = SEV1** (lộ dữ liệu/bí mật, xâm nhập, dữ liệu production bị đưa vào staging/dev/repo — PROJECT.md §6), dù chưa thấy thiệt hại. Mức
có thể hạ sau khi có bằng chứng, không hạ khi đang nghi ngờ.

## 2. Vai trò và ai được tuyên bố sự cố

| Vai trò                                  | Ai                                                                                          | Quyền                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Người tuyên bố sự cố                     | **Bất kỳ ai** trong đội (kể cả agent) thấy dấu hiệu SEV1/SEV2 — tuyên bố trước, hạ mức sau  | Mở bản ghi sự cố (§6), gọi IC                                                                          |
| IC (điều phối sự cố)                     | [chủ dự án điền — chưa có dữ liệu]                                                          | Quyết định mức SEV, giảm thiệt hại, rollback/dừng checkout (vai trò "Quyết định rollback", RUNBOOK §0) |
| Kế toán (tiền, hoàn)                     | [chủ dự án điền — chưa có dữ liệu]                                                          | Xác minh trên cổng VNPAY, duyệt hoàn tiền                                                              |
| Đầu mối pháp lý / bảo vệ dữ liệu cá nhân | [chủ dự án điền — chưa có dữ liệu]                                                          | Đánh giá nghĩa vụ thông báo (data-breach.md); làm việc với cơ quan                                     |
| Liên hệ đối tác                          | VNPAY, GHN theo hợp đồng merchant (chưa có hợp đồng — RUNBOOK §0)                           | Hỗ trợ phía cổng/vận chuyển                                                                            |

Leo thang: SEV1 → IC báo chủ dự án ngay khi xác nhận; vi phạm dữ liệu cá nhân → đầu mối pháp lý ngay (đồng hồ 72 giờ chạy từ lúc phát hiện, xem
data-breach.md). Danh sách liên hệ kiểm lại mỗi quý, ghi ngày kiểm: **chưa kiểm lần nào** (chưa điền).

## 3. Thứ tự xử lý cố định

1. **Phát hiện** — ghi giờ UTC đầu tiên có triệu chứng và giờ phát hiện.
2. **Phân mức** — chọn SEV theo §1; nghi ngờ thì lấy mức cao hơn.
3. **Giảm thiệt hại** — làm TRƯỚC khi chẩn đoán nguyên nhân gốc. Công cụ của x-shop, từ ít đến nhiều can thiệp:
   - Tạm ẩn phương thức VNPAY (`VNPAY_ENABLED=false` + restart, hoặc cờ cấu hình) để khách chọn COD; giữ endpoint IPN chạy (RUNBOOK §1).
   - Dừng nhận đơn nhưng vẫn cho xem catalog (checkout đã tự trả 503 khi mất khóa; nếu cần dừng chủ động, chặn `POST /store/x/checkout/submit` ở reverse proxy).
   - Rollback ứng dụng về SHA trước (RUNBOOK §5) — không rollback DB phá huỷ.
   - Xoay/thu hồi bí mật nghi lộ (RUNBOOK §9, §10); vô hiệu hoá tài khoản admin bị chiếm.
   - Khôi phục từ backup/PITR (RUNBOOK §4) — chỉ khi dữ liệu hỏng, và theo mục "Trước khi chạy lệnh lên dữ liệu thật" (§4).
4. **Liên lạc** — cập nhật trạng thái cho đội (và khách khi SEV1/SEV2 ảnh hưởng đơn): nêu tác động + bước tiếp theo, không hứa thời gian không chắc. Mục tiêu cập nhật đầu ≤ 15 phút sau xác nhận, rồi mỗi 30–60 phút. Kênh khách: [chủ dự án điền — chưa có status page].
5. **Khắc phục triệt để** qua cổng thường (nhánh, test hồi quy đỏ→xanh, `dev-task.sh gate`, PR). Không sửa tay trên production ngoài lệnh đã viết sẵn ở bước 3.
6. **Đóng** — xác nhận theo mục "Xác nhận đã ổn" của mục RUNBOOK tương ứng (vd §1: không còn attempt `unknown` quá hạn chưa có owner).
7. **Post-mortem** không đổ lỗi theo mẫu khung (`.xtemplates/framework/templates/POST-MORTEM.md`), lưu `docs/ops/incidents/`, bắt buộc ≥ 1 hàng rào mới.

Timeline của mọi sự cố PHẢI có mốc "giảm thiệt hại" trước mốc "nguyên nhân gốc". Chẩn đoán song song được, nhưng không thay cho bước 3.

## 4. Trước khi chạy lệnh lên dữ liệu thật

Áp dụng cho mọi lệnh ghi/xoá/migrate/khôi phục trên Postgres, Redis hoặc dữ liệu cổng (VNPAY, GHN) của production — kể cả "sửa nhanh" lúc sự cố.

1. **Snapshot ngay trước**: tạo snapshot/điểm PITR và ghi **snapshot id + giờ UTC** vào bản ghi sự cố. Chưa có snapshot → không chạy.
2. **Lệnh hoàn tác viết sẵn** và dán vào bản ghi sự cố trước khi chạy lệnh chính (vd `SELECT` lưu giá trị cũ trước `UPDATE`; khôi phục theo RUNBOOK §4.2).
3. **Thử trước trên dữ liệu tổng hợp** cùng hình dạng (RUNBOOK §11) khi có thể; không copy dữ liệu production sang staging/dev.
4. **Thao tác không thể hoàn tác** (xoá dữ liệu khách, huỷ vận đơn GHN đã lấy hàng, hoàn tiền đã gửi cổng, `db:rollback` migration): cần **hai người xác nhận** (IC + một người khác) ghi tên và giờ vào bản ghi.
5. Không sửa tay số dư/ledger (`payment_ledger`, `order_finance`): ghi bổ sung qua đường IPN/`querydr` idempotent (RUNBOOK §4.2). `audit_log` bất biến, không sửa/xoá.
6. Chạy từng bước, đọc kết quả thật, không lặp lệnh phá huỷ khi kết quả chưa rõ. Ghi mọi lệnh đã chạy (không kèm bí mật) vào timeline.

## 5. Nhánh sự cố bảo mật (SEV1)

Khi nghi lộ dữ liệu/bí mật hoặc xâm nhập, ngoài §3 làm thêm đủ 3 việc:

1. **Bảo toàn chứng cứ** — chép log liên quan (backend, reverse proxy, `webhook_inbox`, `audit_log`, log nhà cung cấp hạ tầng) sang nơi chỉ-đọc TRƯỚC khi xoay khoá, khởi động lại hay dọn dẹp. Không xoá commit/log để "che"; coi khoá từng nằm trong lịch sử git là đã lộ.
2. **Thu hồi/xoay bí mật** theo RUNBOOK §10 (bảng từng khoá VNPAY/GHN/JWT/MFA/lookup/DB/Redis/email-SMS) và §9.
3. **Đánh giá nghĩa vụ thông báo** — chuyển sang [`runbooks/data-breach.md`](runbooks/data-breach.md); đầu mối pháp lý: [chủ dự án điền — chưa có dữ liệu].

## 6. Sổ sự cố

Mọi sự cố (mọi SEV; SEV4 có thể một dòng) có một file trong `docs/ops/incidents/`, tên `YYYY-MM-DD-<slug>.md`, dùng mẫu POST-MORTEM của khung (`.xtemplates/framework/templates/POST-MORTEM.md`)
cộng bảng thông báo ở data-breach.md §6 nếu có dữ liệu cá nhân. Bản ghi có: phát hiện, phân loại, timeline UTC (tối thiểu mốc phát hiện · SEV · giảm thiệt hại · khôi phục · đóng),
snapshot id nếu có thao tác lên dữ liệu, thông báo cơ quan/khách kèm giờ, khắc phục, hành động (chủ + hạn), hàng rào mới. Post-mortem không nêu tên người ở mục nguyên nhân.

Hiện sổ trống: chưa có sự cố nào được ghi (`docs/ops/incidents/` chỉ có `.gitkeep`).

## 7. Diễn tập

Diễn tập tabletop ≥ 1 lần/năm (kịch bản gợi ý: lộ `VNPAY_HASH_SECRET`; mất DB và khôi phục; lộ dump PII) có biên bản lưu `docs/ops/incidents/YYYY-MM-DD-drill-<slug>.md`.
`last_drilled`: **chưa diễn tập** (chưa có người trực và hạ tầng). Phần kỹ thuật đã diễn tập: khôi phục DB và mất Redis (RUNBOOK §0, ngày 2026-10-25).

## 8. Việc chờ chủ dự án

Điền IC, kế toán, đầu mối pháp lý, kênh liên lạc; chọn hạ tầng (RUNBOOK §8.1) để có snapshot/PITR, cảnh báo và status page; duyệt thời gian phản ứng ở §1; đưa tài liệu này
vào onboarding người mới (`docs/handover/`); lên lịch diễn tập đầu tiên.
