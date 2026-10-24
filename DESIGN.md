# DESIGN.md — ngôn ngữ thiết kế storefront X-Shop

Nguồn: `docs/specs/DAC-TA-GOC.md` §3.1–3.2. Token thật: `apps/storefront/src/styles/tokens.css` (nguồn sự thật duy nhất; file này mô tả).
Cổng tương phản: `python3 .xtemplates/scripts/xt.py contrast apps/storefront/src/styles/tokens.css --pairs apps/storefront/contrast-pairs.txt`.
Mục tiêu tiếp cận: WCAG 2.2 AA. Mức 44 px / 48 px là chuẩn nội bộ của dự án, không phải ngưỡng chung của WCAG AA.

## 1. Ngôn ngữ hình ảnh

Biên tập thời trang hiện đại: **ảnh sản phẩm là trọng tâm**, nền sáng ấm, chữ gần đen, bố cục rõ, khoảng cách thoáng.
Khối mua hàng (giá, size, nút mua) dễ nhận biết và không bị hình trang trí lấn át. Một màu nhấn duy nhất (`--accent`) cho CTA/điểm nhấn.
Khác biệt thương hiệu đến từ ảnh chụp, cách phối đồ, nội dung bộ sưu tập — không từ hiệu ứng.

Không dùng: màn hình giới thiệu phải chờ, video tự chạy nặng, pop-up ngay lần truy cập đầu, bộ đếm khan hiếm không có dữ liệu.
Màu không bao giờ là dấu hiệu duy nhất (luôn kèm chữ/icon/hình dạng).
Ngân sách: CSS ≤ 50 KiB gzip; font ≤ 100 KiB; không Tailwind, không UI kit — CSS Modules + custom properties.

## 2. Token

### Màu (chữ thường ≥ 4.5:1; viền/focus/đồ hoạ ≥ 3:1 — đo thật, xem `contrast-pairs.txt`)

| Token | Giá trị | Dùng cho | Tỷ lệ đo |
|---|---|---|---|
| `--background` | #FAF8F4 | Nền trang | — |
| `--surface` | #FFFFFF | Form, drawer, giỏ hàng, header | — |
| `--foreground` | #191919 | Nội dung, giá | 16.57 (nền) / 17.58 (bề mặt) |
| `--muted` | #5F5A53 | Chữ phụ | 6.44 / 6.83 |
| `--divider` | #E5E1DA | Đường chia bố cục; **không** phải viền điều khiển hay dấu focus | (trang trí) |
| `--border-strong` | #85807A | Viền input, nút size, checkbox | 3.68 / 3.91 |
| `--accent` | #6D2635 | CTA, điểm nhấn, link nhấn | 10.0 / 10.61 |
| `--accent-hover` | #571E2A | Hover/active của CTA | 12.18 |
| `--on-accent` | #FFFFFF | Chữ trên `--accent` | 10.61 (12.92 trên hover) |
| `--error` / `--error-bg` | #A3262A / #FBEAEA | Lỗi (kèm icon + chữ) | 6.29 trên error-bg |
| `--success` / `--success-bg` | #1E6B3A / #E8F4EC | Thành công (kèm chữ) | 5.77 |
| `--warning` / `--warning-bg` | #7A4F00 / #FDF1D8 | Cảnh báo (kèm chữ) | 6.36 |
| `--focus-ring` | #0B57D0 | Vòng focus | 6.02 / 6.38 |

Chế độ tối: chưa có (ngoài phạm vi đợt 1); thêm bằng khối `[data-theme=dark]` và mở rộng `contrast-pairs.txt`.

### Chữ

Be Vietnam Pro, tự host (OFL-1.1), subset latin + vietnamese, weight 400/500/600, `font-display: swap`. Fallback: system-ui.

| Token | Giá trị |
|---|---|
| `--text-body` | 16 px mobile; 17 px từ 48em (khoảng 16–18), line-height `--leading-body` 1,5 |
| `--text-h1` | clamp 28–40 px mobile; 40–64 px từ 48em |
| `--text-h2` | clamp 22–32 px |
| `--text-small` | 14 px (nhãn phụ, chân trang; không dùng cho nhãn lỗi) |
| Weight | 400 nội dung · 500 nhãn/nút · 600 tiêu đề |

### Spacing, bố cục, hình dạng

- Spacing: `--space-1…16` = 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 px (1, 2, 3, 4, 6, 8, 12, 16). Không đặt khoảng cách tuỳ ý.
- Lề trang `--page-margin`: 16 px mobile, 32 px từ 48em, 64 px từ 72em. Nội dung tối đa `--page-max` 1440 px.
- Lưới sản phẩm `--grid-cols`: 2 cột mobile, 3 cột từ 48em, 4 cột từ 72em; `--grid-gap` 16 / 24 / 32 px.
- Ảnh danh sách: tỷ lệ 4:5 (`--aspect-product`), khung đồng nhất, `object-fit: cover`, giữ điểm quan trọng.
- Radius: 2 / 4 / 8 px / tròn (`--radius-sm|md|lg|full`) — góc vuông vắn, biên tập, không bo quá tay.
- Breakpoint **theo nội dung**, không theo tên thiết bị: hiện 48em (đủ chỗ cho 3 cột) và 72em (4 cột, lề rộng); thêm khi bố cục vỡ, không khi gặp tên máy. Kiểm tra 320 (reflow), 360, 390, 768, 1024, 1440 và zoom.

### Điều khiển và chuyển động

- Nút mua cao `--control-height` 48 px. Mọi vùng chạm ≥ `--touch-min` 44×44 px (link trong nội dung dòng được miễn theo WCAG 2.5.8 nhưng ưu tiên đạt).
- Chuyển động `--motion-fast|base|slow` 120 / 160 / 200 ms, `--ease`; ưu tiên `opacity` và `transform`.
- `prefers-reduced-motion: reduce`: token về 0 ms và tắt animation/transition (đã có trong `globals.css`). Không chuyển động nào truyền thông tin duy nhất.

## 3. Luật focus

- Mọi phần tử tương tác có `:focus-visible` rõ: `outline: 3px solid var(--focus-ring); outline-offset: 2px` (đã đặt toàn cục; component không được `outline: none` mà không thay thế tương đương).
- Vòng focus ≥ 3:1 với nền kề (đo với `--background`, `--surface`); offset 2 px để vòng luôn nằm trên nền trang, kể cả với nút nền nhấn.
- **Không** dùng `--divider` (hay thay đổi màu viền nhạt) làm dấu focus duy nhất. Không dựa vào màu đơn thuần.
- Focus không bị che bởi header/CTA sticky (`scroll-padding`/chừa safe area). Dialog/drawer khoá focus, đóng bằng Esc, trả focus về nút mở. Skip link "Bỏ qua tới nội dung" là phần tử focus đầu tiên.

## 4. Component và trạng thái

Mỗi component có đủ trạng thái khi phù hợp: **default · focus · selected · disabled · loading · error**. Màu không là dấu hiệu duy nhất.

| Component | Ghi chú thiết kế | Trạng thái đặc thù |
|---|---|---|
| Header | Logo, menu, search, giỏ; nền `--surface`, đường chia dưới | — |
| Menu | Danh mục từ cấu hình; mobile dạng drawer | selected = trang hiện tại (`aria-current`) + gạch chân |
| Search | Ô nhập + gợi ý; vùng chạm 44 px | loading (đang tìm), empty, error |
| Product card | Ảnh 4:5, tên, giá, swatch; cả thẻ là một link | out-of-stock = nhãn chữ "Hết hàng" |
| Swatch màu | Ô tròn ≥ 44 px, viền `--border-strong`, tên màu trong `aria-label`/tooltip chữ | selected = viền dày + dấu tick; disabled = gạch chéo + `aria-disabled` |
| Nút size | Ô chữ ≥ 44×44 | selected = nền `--foreground` chữ `--background`; disabled = gạch chéo + chữ "hết" cho trình đọc |
| Giá | Số nguyên VND, định dạng `1.250.000 ₫`; giá gốc gạch kèm nhãn "Giá gốc" | — |
| Badge | Chữ ngắn ("Mới", "Giảm giá") | không truyền nghĩa chỉ bằng màu |
| Chip lọc | Có thể bỏ chọn bằng nút ≥ 44 px | selected = nền đặc + dấu tick |
| Nút (primary) | Nền `--accent`, chữ `--on-accent`, cao 48 px; secondary: viền `--border-strong` | hover `--accent-hover`; loading = spinner + chữ "Đang xử lý…" (khoá bấm lặp); disabled = chữ giải thích lý do |
| Drawer / Dialog | Khoá focus, Esc đóng, trả focus; không mở tự động lần đầu | loading, error |
| Toast | `role=status` (lỗi: `role=alert`), tự ẩn không quá ngắn, có nút đóng | success / error / warning kèm icon + chữ |
| Skeleton | Khối cùng tỷ lệ nội dung (tránh CLS), không animation khi giảm chuyển động | loading |
| Inline error | Dưới trường, icon + chữ `--error` trên `--error-bg`, nối `aria-describedby`, cỡ ≥ 14 px đậm 500 | error |
| Empty state | Tiêu đề + hướng đi tiếp (link/nút) | — |
| Ô nhập (form) | Nhãn luôn hiện; viền `--border-strong`; vùng chạm cao ≥ 48 px | error = viền `--error` + inline error; disabled |
| Summary đơn hàng | Dòng tạm tính/giảm/vận chuyển/tổng, tiền số nguyên | loading khi tính lại |
| Timeline | Danh sách có thứ tự trạng thái đơn, bước hiện tại `aria-current="step"` | selected = bước hiện tại; error = bước thất bại kèm chữ |

Sticky CTA trên trang sản phẩm chỉ xuất hiện khi khối mua chính ra khỏi vùng nhìn; chừa safe area, không che trường nhập/bàn phím/focus.

## 5. Quy ước thực thi

- Style bằng CSS Modules (`*.module.css`) cạnh component; chỉ dùng token (`var(--…)`), không hard-code màu/spacing.
- Thêm cặp màu mới → thêm vào `contrast-pairs.txt` cùng commit; cổng `xt.py contrast` phải exit 0.
- Cổng render thật (axe, tràn ngang 320 px) theo `.xtemplates/framework/templates/ui-gates/` ở task E2E sau.
