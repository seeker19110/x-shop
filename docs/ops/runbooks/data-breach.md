---
title: Runbook vi phạm dữ liệu cá nhân x-shop
kind: runbook
version: "1.0"
updated: 2026-10-26
status: bản đầu — thời hạn pháp lý chưa được pháp chế xác nhận
---

# Runbook: vi phạm dữ liệu cá nhân — x-shop · 1.0 · 2026-10-26

> Dùng cùng [`../INCIDENT-RESPONSE.md`](../INCIDENT-RESPONSE.md) (vi phạm dữ liệu = SEV1) và [`../RUNBOOK.md`](../RUNBOOK.md) §10. "Vi phạm" gồm: lộ/mất/bị sửa/bị truy cập trái phép
> dữ liệu cá nhân (họ tên, SĐT, email, địa chỉ, IP khách trong `order_finance`, `checkout_quote`, `outbound_message`, `webhook_inbox`…; danh mục cột ở
> [`../../privacy/data-map.yaml`](../../privacy/data-map.yaml)), kể cả do bên xử lý (GHN, nhà cung cấp email/SMS, hạ tầng). Pháp luật dưới đây lấy từ khung X-Templates
> (`16-compliance-privacy/`, xác minh 2026-10-13); **số điều và nội dung Mẫu 08 chưa đối chiếu văn bản gốc — pháp chế phải xác nhận trước khi dùng** (PROJECT.md §6, DPIA §9).

## 1. Đồng hồ: bắt đầu khi nào, thời hạn nào áp dụng

Đồng hồ bắt đầu từ lúc **phát hiện** (hoặc nhận báo từ bên xử lý), không phải lúc điều tra xong. Ghi giờ UTC phát hiện ở bản ghi sự cố. Gửi **thông báo sơ bộ** đúng hạn rồi bổ sung — không chờ đủ thông tin.

SLA kỹ thuật của x-shop = **thời hạn ngắn nhất áp dụng = 72 giờ** kể từ phát hiện (mọi vùng, trừ khi pháp chế xác nhận khác). Hiện x-shop nhắm khách ở Việt Nam; các hàng EU/TH/SG chỉ áp dụng khi có khách ở đó
(tập pháp luật áp dụng chưa ghi ở `docs/privacy/jurisdictions.md` — file chưa có, việc chờ chủ dự án).

| Vùng / luật               | Thông báo ai                                              | Thời hạn                               | Nguồn (xác minh)                                                                                              | Áp dụng cho x-shop                        |
| ------------------------- | --------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Việt Nam                  | Bộ Công an (Mẫu 08) và chủ thể dữ liệu khi có thể gây hại | **72 giờ** kể từ phát hiện             | Luật 91/2025/QH15 Đ.23; NĐ 356/2025/NĐ-CP Mẫu 08 (xác minh 2026-10-13; **chưa xác minh số điều** của NĐ 356) | Có — khách mua trong nước                 |
| EU/EEA (GDPR)             | Cơ quan giám sát; chủ thể nếu rủi ro cao                  | 72 giờ kể từ khi biết (Art. 33, 34)    | GDPR Art. 33 (xác minh 2026-10-13)                                                                            | Chỉ khi có khách ở EU/EEA (chưa xác định) |
| Thái Lan (PDPA B.E. 2562) | PDPC                                                      | 72 giờ (s.37(4))                       | PDPA TH s.37(4) (xác minh 2026-10-13)                                                                         | Chỉ khi có khách ở Thái Lan               |
| Singapore (PDPA 2012)     | PDPC; cá nhân bị ảnh hưởng                                | ≤ 3 ngày lịch sau khi xác định (s.26D) | PDPA SG s.26D (xác minh 2026-10-13)                                                                           | Chỉ khi có khách ở Singapore              |
| Hợp đồng đối tác          | VNPAY, GHN, nhà cung cấp email/SMS nếu hợp đồng yêu cầu   | theo hợp đồng (chưa có hợp đồng)       | —                                                                                                             | Chưa có                                   |

Ghi chú: NĐ 13/2023/NĐ-CP trước đây cũng quy định 72 giờ; theo khung, NĐ 356/2025 thay thế từ 01/01/2026 (phạm vi còn hiệu lực của NĐ 13: chưa xác minh).
Ngưỡng "có thể gây hại" và việc có thông báo chủ thể do pháp chế đánh giá; nghi ngờ thì thông báo.

## 2. Các bước (mốc giờ tính từ T0 = phát hiện)

| Mốc               | Việc                                                                                                                                                                                                                                                                                  | Ai                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| T0                | Tuyên bố SEV1, mở bản ghi `docs/ops/incidents/YYYY-MM-DD-<slug>.md`, ghi T0 UTC. Gọi IC và đầu mối pháp lý.                                                                                                                                                                           | người phát hiện, IC       |
| T0 + 1 giờ        | **Giảm thiệt hại và bảo toàn chứng cứ** (INCIDENT-RESPONSE §3, §5): chép log sang nơi chỉ-đọc, đóng đường truy cập, xoay/thu hồi bí mật (RUNBOOK §9–§10), vô hiệu liên kết tra cứu đơn nếu nghi lộ (đổi `ORDER_LOOKUP_SECRET`). Trước lệnh lên dữ liệu thật: INCIDENT-RESPONSE §4. | IC, kỹ thuật              |
| T0 + 4 giờ        | **Đánh giá**: dữ liệu gì (cột nào theo data-map), bao nhiêu chủ thể, khoảng thời gian, nguyên nhân, còn diễn ra không, có mã hoá/băm không, có gây hại được không. Điền §5.                                                                                                            | kỹ thuật, đầu mối pháp lý |
| T0 + 24 giờ       | Quyết định **có phải thông báo** (pháp chế). Chuẩn bị Mẫu 08 (cơ quan) và thông báo chủ thể (§3, §4). Báo VNPAY/GHN/nhà cung cấp nếu họ liên quan hoặc hợp đồng yêu cầu.                                                                                                              | đầu mối pháp lý, IC       |
| **≤ T0 + 72 giờ** | **Gửi thông báo cho Bộ Công an (Mẫu 08) và chủ thể** nếu có thể gây hại; ghi giờ gửi và kênh/biên nhận vào §6. Chưa đủ thông tin → gửi sơ bộ, ghi rõ phần chưa biết, bổ sung sau.                                                                                                     | đầu mối pháp lý           |
| Sau khi gửi       | Khắc phục triệt để qua cổng thường; theo dõi dấu hiệu lạm dụng; cập nhật thông báo khi có thêm thông tin.                                                                                                                                                                             | IC, kỹ thuật              |
| ≤ 5 ngày làm việc | Post-mortem không đổ lỗi, ≥ 1 hàng rào mới; cập nhật `docs/privacy/data-map.yaml`, DPIA, sổ rủi ro nếu đổi; ghi `docs/privacy/CHANGELOG.md`.                                                                                                                                          | IC                        |

Nếu vi phạm xảy ra ở bên xử lý (GHN, email/SMS, hạ tầng): đồng hồ của x-shop chạy từ lúc x-shop biết; yêu cầu bên đó cung cấp thông tin ngay (điều khoản thuộc DPA — hiện chưa có DPA nào, xem `docs/compliance/vendors.yaml`).

## 3. Mẫu thông báo cho cơ quan (nội dung tối thiểu — Mẫu 08 chính thức do pháp chế điền theo văn bản gốc)

```text
Gửi: Bộ Công an (đầu mối tiếp nhận: [pháp chế điền — chưa xác minh]) · Ngày giờ gửi: <dd/mm/yyyy hh:mm, GMT+7> · Mã sự cố nội bộ: <slug>
1. Bên kiểm soát/xử lý dữ liệu: x-shop — [tên pháp nhân, mã số thuế, địa chỉ — chủ dự án điền]; đầu mối: [họ tên, SĐT, email]
2. Thời điểm phát hiện: <T0>; thời điểm xảy ra (nếu biết): <...>; còn diễn ra: có/không
3. Mô tả: <chuyện gì xảy ra; hệ thống nào (Postgres, backup, log, storefront, nhà cung cấp…)>
4. Loại và số lượng dữ liệu: <cột/loại — họ tên, SĐT, email, địa chỉ giao hàng, IP…>; ~<n> chủ thể; x-shop không lưu số thẻ (VNPAY xử lý) — xác nhận lại theo sự cố
5. Hậu quả có thể xảy ra: <lừa đảo giao hàng/spam/mạo danh…>
6. Biện pháp đã làm: <giảm thiệt hại, xoay khoá, chặn truy cập, bảo toàn chứng cứ>; biện pháp sẽ làm: <...>
7. Thông tin còn thiếu và hẹn bổ sung: <...>
```

## 4. Mẫu thông báo cho chủ thể (khách)

```text
Tiêu đề: Thông báo về sự cố an toàn thông tin liên quan đến đơn hàng của bạn tại x-shop
Ngày <dd/mm/yyyy>, chúng tôi phát hiện <mô tả ngắn, không đổ lỗi, không suy đoán>. Thông tin có thể bị ảnh hưởng: <họ tên/SĐT/email/địa chỉ giao hàng — nêu đúng loại>.
Chúng tôi không lưu số thẻ hay mật khẩu thanh toán (thanh toán qua VNPAY) — <xác nhận lại theo sự cố>.
Chúng tôi đã: <chặn truy cập, đổi khoá…>. Bạn nên: cảnh giác với cuộc gọi/tin nhắn tự xưng x-shop hoặc hãng vận chuyển yêu cầu chuyển khoản hay cung cấp mã OTP; chúng tôi không bao giờ yêu cầu mã OTP.
Liên hệ: [email/SĐT hỗ trợ — chủ dự án điền]. Chúng tôi sẽ cập nhật khi có thêm thông tin.
```

Gửi qua kênh đã dùng cho đơn (email/SMS qua `outbound_message`, mẫu riêng, thử trên dữ liệu tổng hợp trước). Không đưa liên kết tra cứu đơn hay thông tin cá nhân khác trong nội dung.

## 5. Bảng đánh giá nhanh (điền ở T0 + 4 giờ)

| Câu hỏi                                       | Trả lời |
| --------------------------------------------- | ------- |
| Cột/bảng nào (đối chiếu `data-map.yaml`)?     |         |
| Số chủ thể ước tính; có người ngoài Việt Nam? |         |
| Dữ liệu có mã hoá/băm không (khoá có lộ)?     |         |
| Còn diễn ra? Đã chặn lúc nào (UTC)?           |         |
| Có thể gây hại (lừa đảo, mạo danh…)?          |         |
| Bên xử lý liên quan (GHN/email-SMS/hạ tầng)?  |         |
| Quyết định thông báo (pháp chế) + giờ         |         |

## 6. Bảng ghi thông báo (đưa vào bản ghi sự cố)

| Đối tượng                        | Giờ gửi (UTC+7) | Kênh/biên nhận | Người gửi | Ghi chú |
| -------------------------------- | --------------- | -------------- | --------- | ------- |
| Bộ Công an (Mẫu 08)              |                 |                |           |         |
| Chủ thể dữ liệu                  |                 |                |           |         |
| Đối tác (VNPAY/GHN/…)            |                 |                |           |         |
| Cơ quan nước ngoài (nếu áp dụng) |                 |                |           |         |

## 7. Diễn tập

Tabletop ≥ 1 lần/năm (kịch bản: dump DB lộ; lộ khoá nhà cung cấp email/SMS), có biên bản ở `docs/ops/incidents/`. `last_drilled`: **chưa diễn tập**.

## 8. Việc chờ chủ dự án / pháp chế

Xác minh Luật 91/2025/QH15 Đ.23 và NĐ 356/2025/NĐ-CP (số điều, Mẫu 08, đầu mối tiếp nhận, ngưỡng "có thể gây hại"); điền thông tin pháp nhân và liên hệ trong mẫu; xác định có khách ở EU/TH/SG
không; ký DPA có điều khoản báo vi phạm với GHN, VNPAY, nhà cung cấp email/SMS và hạ tầng.
