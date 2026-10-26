# docs/privacy — hồ sơ quyền riêng tư của x-shop

| File                               | Nội dung                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data-map.yaml`                    | sổ dữ liệu cá nhân theo bảng/cột: phân loại, mục đích, `legal_basis`, thời hạn lưu, bên nhận, nơi sao chép; đối chiếu máy với migration          |
| `../compliance/data-inventory.csv` | kiểm kê cột PII (khớp từng dòng với data-map)                                                                                                     |
| `../compliance/vendors.yaml`       | sổ nhà cung cấp/bên xử lý                                                                                                                         |
| `processors.md` · `transfers.md`   | bên xử lý; chuyển dữ liệu ra nước ngoài                                                                                                           |
| `CHANGELOG.md`                     | lịch sử thay đổi có ngày (nhịp rà 6 tháng)                                                                                                        |
| `../ops/DPIA.md`                   | đánh giá tác động (hồ sơ ĐGTĐ) — giữ ở docs/ops                                                                                                   |

Chưa có: bản ghi đồng ý (không thu marketing ở P0; module đồng ý tối thiểu: PLAN-2 Q-21), biên nhận nộp hồ sơ cho cơ quan (chưa nộp; nghĩa vụ chưa xác minh).
Kiểm: `node scripts/check-data-map.mjs`.
