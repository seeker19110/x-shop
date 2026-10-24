# SPEC-catalog — Catalog, tìm kiếm, lọc cùng biến thể

| Trường | Giá trị |
|---|---|
| ID tính năng | F-003, F-004 (yêu cầu gốc: ADM01–03, CAT01–04, AT01, AT26, AT31, AT32) |
| Trạng thái | Approved for implementation (D-001) |
| Nguồn | `docs/specs/DAC-TA-GOC.md` §4.2, §5.1, §7.2 (search read model) |

## 1. User story
Là khách, tôi lọc "đen, M, dưới 500.000đ" và chỉ thấy sản phẩm có đúng một SKU thỏa mọi điều kiện, với giá của chính SKU đó.

## 2. Tiêu chí chấp nhận
### S-201 Lọc cùng SKU (AT01)
- Given sản phẩm P có SKU đen-S và trắng-M
- When lọc `color=den&size=m`
- Then P không có trong kết quả; facet count không đếm P.

### S-202 Giá theo SKU khớp (AT31)
- Given P có đen-M 700.000đ, trắng-S 300.000đ
- When lọc `color=den&size=m&price_max=500000`
- Then P không có; khi bỏ `price_max`, card P hiển thị giá 700.000đ (giá của SKU khớp), sắp xếp theo giá dùng 700.000đ.

### S-203 Tìm tiếng Việt có/không dấu (CAT01)
- Given sản phẩm "Áo sơ mi lụa"
- When tìm `ao so mi`, `ÁO SƠ MI`, `so mi lua`, hoặc đúng SKU
- Then có P; truy vấn > 100 ký tự bị cắt; không kết quả → gợi ý danh mục.

### S-204 URL state (CAT03, AT32)
- Given đã áp `color=den`; mở drawer, chọn thêm `size=m` (nháp) rồi hủy
- Then URL và chip vẫn chỉ `color=den`; Back/reload giữ đúng; tham số được chuẩn hóa thứ tự, tham số lạ bị bỏ.

### S-205 Card (CAT04)
- Then card có ảnh 4:5, tên, giá (khoảng giá "Từ X" khi SKU khác giá), giá gạch khi giảm hợp lệ, swatch có tên, nhãn hết hàng.

### S-206 Import CSV (ADM02)
- Given CSV 3 dòng, dòng 2 thiếu SKU, ô bắt đầu bằng `=`
- When preview
- Then báo lỗi dòng 2 kèm cột; không ghi gì; commit với cùng `import_id` 2 lần không tạo trùng; xuất CSV vô hiệu hóa công thức (`'` tiền tố).

### S-207 Kiểm trước xuất bản (ADM03, PDP02)
- Then chặn publish khi thiếu tên/SKU/giá/ít hơn 3 ảnh hàng may mặc (trừ khi có ngoại lệ ghi người chịu trách nhiệm)/bảng size cho loại cần.

## 3. Ca biên
| Nhóm | Ca | Hành vi |
|---|---|---|
| Rỗng | không filter; q rỗng | danh sách mặc định "mới nhất" |
| Cực đại | page_size > 48; page > tổng | kẹp 48; trang rỗng có link về trang 1 |
| Trùng | tham số lặp `size=m&size=m` | dedupe |
| Song song | index đang rebuild | đọc bảng cũ tới khi swap |
| Thời gian | giá khuyến mãi hết hạn | read model theo `price_valid_until`; checkout luôn đọc nguồn có thẩm quyền |
| Quyền | sản phẩm draft | không xuất hiện ở store API |
| Tiền | price_min > price_max | 422 |
| Unicode | NFD vs NFC; "đ" | chuẩn hóa NFC + bỏ dấu + `đ→d` |

## 4. Quyết định
- Read model `catalog_variant_index` trong Postgres: một dòng/SKU đã publish (product_id, color, size, price, in_stock,
  material, category, search_text không dấu) + trigram index; truy vấn GROUP BY product trên các SKU thỏa đủ điều kiện (D-009).
