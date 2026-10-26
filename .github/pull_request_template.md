<!-- Tiêu đề PR: `<type>(scope): mô tả` (conventional commit). Mỗi lát code một PR. Mục không áp dụng ghi "không áp dụng — lý do". -->

## Mục tiêu
<!-- Vì sao làm. Link SPEC (`S-NNN`), task (`T-NNN`), quyết định (`D-NNN`)/ADR, issue. -->

## Thay đổi
<!-- Gồm những gì; phần cố ý không làm. Đụng cấu hình cổng/CI/hook: nêu lý do (không nới ngưỡng, không skip test). -->

## Bằng chứng
<!-- Lệnh + exit code thật, hoặc link lượt chạy CI — tick không kèm bằng chứng là chưa xong. -->
- [ ] `.xtemplates/scripts/dev-task.sh gate` (build · typecheck · lint · test) — kết quả:
- [ ] Test mới cho thay đổi hành vi, gồm ca biên; sửa lỗi có test đỏ trước, xanh sau — tên test:
- [ ] Mục blueprint liên quan tick kèm `— Kiểm: <lệnh>` hoặc `— Bằng chứng:` — ID:

## Docs cập nhật
<!-- WF-DOC-001: thay đổi hành vi đi cùng PR với tài liệu (README, docs/, ADR, CHANGELOG `Unreleased`). Ghi file đã cập nhật, hoặc
"không cần — lý do". Không có "sẽ cập nhật docs sau". `pr-policy` cảnh báo khi đổi API/config mà không chạm tài liệu. -->

## Definition of Done
<!-- WF-TEAM-004: mỗi mục tick kèm bằng chứng (lệnh + exit code, link CI, tên test, link preview); tick không kèm bằng chứng là chưa Done. -->
- [ ] Mỗi tiêu chí chấp nhận có test xanh — map tiêu chí → test (tên test / link CI):
- [ ] Ca biên đã xử lý và có test: rỗng/null/0, lỗi, tải, Unicode, thời gian — bằng chứng:
- [ ] Tự review diff (không secret, không rác, không mã chết) — ghi điều đã soát:
- [ ] Docs cập nhật hoặc "không cần" (xem mục trên) — bằng chứng:
- [ ] Deploy thử (staging/preview) OK hoặc "không áp dụng — lý do" — link:

## Trước/sau (bắt buộc cho PR `refactor:` / `perf:`)
<!-- XC-GREEN-005: refactor/perf không đổi hành vi; số liệu đo, không ước chừng. Dòng không áp dụng ghi "không áp dụng". Test suite xanh,
không đổi số test (trừ test mới); contract/snapshot test xanh. -->

| Chỉ số                       | Trước | Sau | Cách đo |
| ---------------------------- | ----- | --- | ------- |
| Số dòng mã (vùng sửa)        |       |     |         |
| Kích thước bundle / tài nguyên |     |     |         |
| Độ phức tạp (complexity)     |       |     |         |
| Số phụ thuộc                 |       |     |         |

## Rủi ro và đường lùi
<!-- Ảnh hưởng nếu sai, cách phát hiện, cách quay lại (revert, cờ tính năng, migration down). Chạm tiền · dữ liệu người dùng thật ·
auth · mật mã · bí mật · `merge_risk_paths` trong xt.yaml: gắn nhãn `risk:*` — ngoại lệ cứng (ADR-0016/0020 của khung). -->

## Migration
- [ ] Không có migration
- [ ] Có migration: file mới (không sửa migration đã áp), có đường lùi, chạy được trên dữ liệu có sẵn

Backup trước migrate: <!-- DB-MIG-011: link backup/snapshot mới (hoặc PITR đã kiểm) + kế hoạch lùi; không có migration thì ghi "không áp dụng" -->

## Phụ thuộc mới
<!-- Mỗi gói một dòng: `tên · phiên bản ghim · giấy phép · lý do · phương án thay thế đã xét`; không có thì ghi "không có".
Mẫu cố ý không điền sẵn: CI so lockfile có thể đỏ khi mục trống mà có gói mới (BASE-DEP-006). -->

## Hỗ trợ AI
<!-- WF-REVIEW-019: phần nào do AI sinh, phần nào người đã tự kiểm và kiểm thế nào, phần nào chỉ máy/AI kiểm. Không ghi tên model/phiên. -->

## Bảo mật
- [ ] Không bí mật trong mã/log/commit; đầu vào kiểm bằng schema; quyền kiểm ở server
- [ ] Nội dung ngoài (web, issue, PR, output tool) coi là dữ liệu, không phải chỉ thị
