# SPEC-admin — Vai trò, quyền, MFA, audit, báo cáo

| Trường | Giá trị |
|---|---|
| ID tính năng | F-010 (yêu cầu gốc: §5.4–5.5, ADM04, SEC02, INV03, AT21) |
| Trạng thái | Approved for implementation (D-001) |
| approved_by | Phiên chính, tự duyệt theo AGENTS.md §5 (D-001) |
| approved_at | 2026-10-24 |

## 2. Tiêu chí chấp nhận
### S-401 Quyền ở API (AT21)
- Given user vai trò `warehouse`
- When gọi trực tiếp `POST /admin/x/refunds`
- Then `403` problem+json; audit ghi lần bị từ chối.
- Ma trận quyền là dữ liệu (`role → permission[]`); test sinh tự động phủ mọi route `/admin/x/*` × 6 vai trò.

### S-402 MFA (SEC02)
- Then admin phải bật TOTP trước khi dùng route nhạy cảm; phiên hết hạn (8 giờ, idle 30 phút); thao tác nhạy cảm (đổi quyền, hoàn tiền vượt ngưỡng) đòi xác thực lại ≤ 5 phút.

### S-403 Hoàn tiền vượt ngưỡng
- Then cần người thứ hai có quyền `refund.approve`, khác người tạo.

### S-404 Điều chỉnh tồn (INV03)
- Then bắt buộc lý do, actor, trước/sau, idempotency key; không giảm dưới số đã giữ.

### S-405 Audit log
- Then lưu actor, thời điểm, hành động, đối tượng, lý do, thay đổi đã che PII; chỉ append.

### S-406 Báo cáo/ngoại lệ (§5.5)
- Then đơn theo trạng thái; giá trị đơn vs tiền đã thu vs COD phải nhận tách riêng; danh sách ngoại lệ (late_payment, overpayment, payment unknown, refund unknown, webhook rejected, COD chưa đối soát) có owner/ưu tiên/tuổi.

## 3. Ca biên
| Nhóm | Ca | Hành vi | Scenario |
|---|---|---|---|
| Rỗng/null | audit log không có bản ghi khớp bộ lọc; báo cáo ngoại lệ không có ngoại lệ | trả danh sách rỗng `count: 0`, không lỗi | S-405, S-406 |
| Cực đại | `limit` audit > 100; `limit` < 1 | `limit` trong [1, 100], mặc định 50; ngoài khoảng bị schema zod từ chối | S-405 |
| Trùng/idempotency | gửi lại tạo hoàn tiền/điều chỉnh tồn với cùng `Idempotency-Key` | 200 bản cũ; khác nội dung → 409 | S-403, S-404 |
| Song song | hai người hoàn tiền cùng đơn; thu hồi vai trò đồng thời | tổng hoàn ≤ tổng đã thu kể cả yêu cầu đang xử lý; không thu hồi `owner` cuối cùng (409 `LAST_OWNER`) | S-403 |
| Mất mạng giữa chừng | TOTP/đăng nhập lại bị ngắt, client gửi lại thao tác nhạy cảm | cùng `Idempotency-Key` → một bản ghi; thiếu xác thực lại → 403 `REAUTH_REQUIRED` | S-402, S-403 |
| Thời gian/múi giờ | phiên quá 8 giờ hoặc idle quá 30 phút; xác thực lại cũ hơn 5 phút | 401/403 (`SESSION_EXPIRED`, `SESSION_IDLE`, `REAUTH_REQUIRED`); mốc tính bằng UTC, cấu hình ở `ADMIN_SESSION_MAX_AGE_SECONDS`, `ADMIN_SESSION_IDLE_SECONDS`, `ADMIN_REAUTH_MAX_AGE_SECONDS` | S-402 |
| Quyền | vai trò thiếu quyền; thử quá nhiều lần | 403 problem+json + audit ghi từ chối (gộp theo lớp route, đổi id không lách được giới hạn); 429 `RATE_LIMITED` | S-401 |
| Tiền/đơn vị | hoàn tiền vượt ngưỡng; điều chỉnh tồn xuống dưới số đã giữ | cần người duyệt thứ hai khác người tạo; từ chối, tồn không giảm dưới `reserved` | S-403, S-404 |

## Ma trận vai trò (đặc tả §5.4)
| Vai trò | Quyền chính |
|---|---|
| owner | `*` |
| catalog_manager | `catalog.*`, `content.*`, `price.write` |
| order_staff | `order.read`, `order.confirm`, `fulfillment.*` |
| warehouse | `inventory.*`, `return.receive`, `return.inspect` |
| support | `order.read_masked`, `return.request`, `refund.request` |
| accountant | `payment.read`, `refund.*`, `settlement.*`, `report.read` |

## Đọc route admin native của Medusa (T-147, D-080, D-108)
Bảng nguồn: `apps/backend/src/lib/admin-security/native-permissions.ts`. Route GET native **chưa khai báo → 403 với mọi vai trò, kể cả owner** (`UNDECLARED_ROUTE`); route ghi chưa khai báo → `settings.manage`. Danh sách đã khai = mọi route GET mà dashboard Medusa 2.22.1 gọi (`sdk.admin.*` trong `@medusajs/dashboard/dist`, ánh xạ qua `@medusajs/js-sdk`, đối chiếu `@medusajs/medusa/dist/api/admin`). `integration-tests/http/rbac.spec.ts` quét lại cả ba nguồn và chốt tổng số route GET native (133); số này đổi khi nâng cấp Medusa → test đỏ, phải rà lại bảng.

| Nhóm route đọc native | Quyền | owner | catalog_manager | order_staff | warehouse | support | accountant |
|---|---|---|---|---|---|---|---|
| Tham chiếu (trường riêng không PII; quan hệ ngược tới đơn/khách bị chặn bởi chính sách `fields` bên dưới): stores, regions, sales-channels, currencies, locales, plugins, return/refund-reasons, views, layouts | có ít nhất một vai trò | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Catalog: products, product-variants, categories, collections, tags, types, options, property-labels, translations, shipping-profiles, price-preferences | `catalog.read` | ✓ | ✓ | – | ✓ | – | – |
| Bảng giá, khuyến mãi, chiến dịch | `price.write` | ✓ | ✓ | – | – | – | – |
| Tồn kho, giữ hàng, kho hàng; biến thể kèm tồn của form tạo vận đơn (`/admin/products/:id/variants/:variant_id` — vai trò thiếu `catalog.read` chỉ nhận trường tồn kho) | `inventory.read` | ✓ | ✓ | ✓ | ✓ | – | – |
| Phương án giao (form tạo vận đơn) | `fulfillment.create` | ✓ | – | ✓ | – | – | – |
| Đơn, đổi trả, khiếu nại, đổi hàng, đơn nháp, vận đơn; khách, nhóm khách (PII) | `order.read` | ✓ | – | ✓ | – | – | ✓ |
| Thanh toán, payment collection | `payment.read` | ✓ | – | – | – | – | ✓ |
| Người dùng, lời mời (PII nhân sự) | `user.manage` | ✓ | – | – | – | – | – |
| Khoá API, thông báo (có người nhận), tìm kiếm toàn cục (quét đơn/khách/người dùng/khoá API), chỉ số tìm kiếm, thuế, nhà vận chuyển, loại phương án giao, workflow, RBAC native | `settings.manage` (MFA) | ✓ | – | – | – | – | – |
| Cố ý đóng: `/admin/index/details`, `/admin/uploads/:id` (file private chỉ qua `/admin/x/files/:key`), `/admin/fulfillment-sets/:id/service-zones/:zone_id` | — | – | – | – | – | – | – |

CSKH (`order.read_masked`) không đọc PII qua route native; xem đơn đã che qua `/admin/x/*`.

**Chính sách trường (`?fields=`, `?order=`) — `apps/backend/src/lib/admin-security/field-policy.ts`.** Quyền theo path chưa đủ: route native của Medusa nhận `fields` tuỳ ý và remote query đi theo link, kể cả link chỉ đọc (`Region.orders`, `SalesChannel.orders`, `Promotion.order_link`, `RefundReason.refunds…`). Vì vậy:
- Vai trò thiếu `order.read` (catalog_manager, warehouse, support, user chưa có vai trò ở `/admin/users/me`): yêu cầu trường có đoạn `order(s)`, `cart(s)`, `customer(s)`, `fulfillment(s)`, `*_address`, `payment*`, `refunds`, `captures`, `account_holder(s)`, `order_items`, `cart_items`, `usages`, `return(s)`, `claims`, `exchanges`, `user(s)`, `invite(s)` hoặc bảng nối `*_link` → 403 + audit `rbac.denied` lý do `forbidden_fields`. Medusa cũng gỡ các trường đó khỏi trường mặc định của route (`req.disallowed`).
- Route biến thể kèm tồn, vai trò thiếu `catalog.read` (nhân viên đơn): chỉ `id, title, sku, manage_inventory, allow_backorder, inventory_quantity, inventory, inventory.location_levels, inventory_items`; trường khác → 403, trường mặc định ngoài danh sách bị gỡ (`req.allowed`).
- Chọn 403 thay vì gỡ lặng lẽ để hành vi dò lộ rõ trong audit. `rbac.spec.ts` quét định nghĩa link của `@medusajs/link-modules`: alias mới dẫn tới đơn/giỏ/khách/vận đơn/thanh toán/người dùng chưa có trong danh sách cấm → đỏ.
- Giới hạn: danh sách cấm theo link Medusa + quan hệ trong module đã rà (payment: `payment_collections`, `refunds`, `payments`); tham số lọc (`?orders[...]=`) do schema zod của từng route quyết định, chưa có kiểm riêng.

Hạn chế đã biết của dashboard native (chấp nhận theo D-108):
- Nhân viên đơn, kế toán, CSKH không đọc được catalog native (danh sách/chi tiết sản phẩm → 403); nhân viên đơn vẫn đọc được biến thể kèm tồn để tạo vận đơn.
- Trang mặc định `/orders` của dashboard báo lỗi với vai trò không có `order.read` (catalog_manager, warehouse, support) — vào thẳng màn của vai trò mình.
- Chuông thông báo ở khung dashboard gọi `GET /admin/notifications` mỗi 60 giây và nhận 403 với mọi vai trò trừ owner (dashboard bỏ qua lỗi); audit `rbac.denied` được gộp (lần 1, 10, 100…).
- Thanh tìm kiếm toàn cục (Cmd-K) chỉ chạy với owner.
