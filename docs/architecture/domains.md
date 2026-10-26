# Miền nghiệp vụ (bounded context)

Cập nhật 2026-10-26 theo cây mã thật. Miền = ngữ cảnh có từ vựng, dữ liệu và bất biến riêng; tên cột "Miền" là tên dùng trong `PROJECT.md` và `docs/specs/SPEC-*.md`. Kiểu kiến trúc: ADR-0002 (modular monolith).

| Miền                             | Spec                                       | Module backend (`apps/backend/src/modules/`) | Lõi thuần (`packages/domain/src/`) | Bất biến chính                                                 |
| -------------------------------- | ------------------------------------------ | -------------------------------------------- | ---------------------------------- | -------------------------------------------------------------- |
| Catalog (danh mục, biến thể, lọc) | SPEC-catalog                               | `fashion`, `catalog-import`, `catalog-index` | `catalog`, `catalog-admin`         | SKU = màu × size; lọc cùng biến thể + giá; xuất bản có kiểm    |
| Giá và tiền                      | SPEC-checkout                              | (trong `checkout`)                           | `money`, `pricing`                 | Tiền là số nguyên VND; tổng phân bổ giảm giá = tổng giảm       |
| Checkout và đơn                  | SPEC-checkout                              | `checkout`                                   | `state`                            | Một đơn / một bộ reservation; idempotency; không bán vượt tồn  |
| Thanh toán (VNPAY, COD)          | SPEC-payment                               | (trong `checkout`, `settlement`)             | `providers`, `ledger`              | Không thu tiền trùng; trạng thái tài chính đơn điệu            |
| Vận chuyển và giao hàng (GHN)    | SPEC-fulfillment                           | `shipping`                                   | `address`, `providers`             | Chỉ chuyển protocol; tồn trừ dưới khóa khi tạo vận đơn         |
| Đổi trả và hoàn tiền             | SPEC-fulfillment                           | `returns`                                    | `state`                            | Hàng trả chờ kiểm định; hoàn tiền thật cần ủy quyền            |
| Đối soát                         | SPEC-payment                               | `settlement`                                 | `ledger`                           | Chênh lệch COD/cổng được ghi và xử lý, không tự xóa            |
| Quản trị và phân quyền           | SPEC-admin                                 | `rbac`, `audit`                              | `access`                           | Quyền kiểm ở server; thao tác nhạy cảm có nhật ký kiểm toán    |
| Thông báo                        | SPEC-checkout                              | `notify`                                     | —                                  | Gửi qua outbox, không chặn đường đặt hàng                      |
| Storefront (trình bày)           | SPEC-storefront                            | —                                            | —                                  | Không tính giá/tồn ở client; route riêng tư `private, no-store` |

## Ghi chú về cấu trúc thư mục

- Module backend và thư mục `packages/domain/src/*` ánh xạ vào bảng trên; thêm module/thư mục mới phải thêm miền hoặc gán vào miền sẵn có ở đây (kiểm bằng lệnh ở mục `ARC-MOD-008` của `BLUEPRINT.md`).
- `apps/backend/src/` cấp một (`admin`, `api`, `jobs`, `links`, `modules`, `scripts`, `subscribers`, `workflows`, `lib`) là bố cục do khung Medusa quy định theo loại thành phần, không theo miền; miền nằm ở cấp `modules/` và trong `workflows/<miền>`, `lib/<miền>`.
- `apps/storefront/src/lib/` chia theo chức năng trình bày (`cart`, `catalog`, `checkout`, `orders`, `seo`, `pwa`, …), không sở hữu dữ liệu miền.
