Phiên bản 1.0 · 24 tháng 10 năm 2026 · Việt Nam

Thiết kế cửa hàng hiện đại, ưu tiên điện thoại, tốc độ và độ chính xác
của giao dịch. Tài liệu dùng để chia việc, phát triển, kiểm thử và
nghiệm thu trước khi mở bán.

Phương án cơ sở: **Next.js và Medusa v2**, COD và một cổng thanh toán
trực tuyến, một hãng vận chuyển. Phạm vi một đơn vị bán; P0 là các yêu
cầu bắt buộc để ra mắt.

## Nội dung

[1 Mục tiêu và quyết định triển
khai](#1-mục-tiêu-và-quyết-định-triển-khai)

[2 Cơ sở nghiên cứu và hàm ý thiết
kế](#2-cơ-sở-nghiên-cứu-và-hàm-ý-thiết-kế)

[3 Định hướng giao diện và hệ thống thiết
kế](#3-định-hướng-giao-diện-và-hệ-thống-thiết-kế)

[4 Đặc tả trải nghiệm mua sắm](#4-đặc-tả-trải-nghiệm-mua-sắm)

[5 Quản trị và quy tắc thương mại](#5-quản-trị-và-quy-tắc-thương-mại)

[6 Luồng đơn hàng thanh toán và giao
vận](#6-luồng-đơn-hàng-thanh-toán-và-giao-vận)

[7 Kiến trúc và ranh giới trách
nhiệm](#7-kiến-trúc-và-ranh-giới-trách-nhiệm)

[8 Mô hình dữ liệu và ràng buộc](#8-mô-hình-dữ-liệu-và-ràng-buộc)

[9 Hợp đồng API và tích hợp](#9-hợp-đồng-api-và-tích-hợp)

[10 Hiệu năng và khả năng mở rộng](#10-hiệu-năng-và-khả-năng-mở-rộng)

[11 Bảo mật dữ liệu và khả năng tiếp
cận](#11-bảo-mật-dữ-liệu-và-khả-năng-tiếp-cận)

[12 SEO nội dung và PWA](#12-seo-nội-dung-và-pwa)

[13 Quan sát hệ thống và vận hành](#13-quan-sát-hệ-thống-và-vận-hành)

[14 Kế hoạch thực thi và phân công](#14-kế-hoạch-thực-thi-và-phân-công)

[15 Ma trận nghiệm thu](#15-ma-trận-nghiệm-thu)

[16 Phạm vi sau ra mắt và quyết định cần cấu
hình](#16-phạm-vi-sau-ra-mắt-và-quyết-định-cần-cấu-hình)

[17 Nguồn tham khảo](#17-nguồn-tham-khảo)

# 1 Mục tiêu và quyết định triển khai

Xây dựng một cửa hàng thời trang trực tuyến có bản sắc hình ảnh, hoạt
động tốt trên điện thoại, giúp khách chọn đúng sản phẩm và hoàn tất mua
hàng nhanh. Hệ thống phải phục vụ được toàn bộ quy trình từ đăng sản
phẩm, quản lý size và màu, đặt hàng, thu tiền, giao hàng đến đổi trả và
đối soát.

**Phương án cơ sở:** storefront Next.js App Router và TypeScript;
commerce backend Medusa v2; PostgreSQL; Redis; kho ảnh tương thích S3 và
CDN. Dùng Medusa Admin rồi mở rộng các nghiệp vụ còn thiếu. Đây là lựa
chọn cho mục tiêu sở hữu mã nguồn và tùy biến lâu dài. Các phiên bản phụ
thuộc phải được chốt tương thích và khóa trong lockfile tại lúc khởi
tạo.

**Phạm vi ra mắt:** một đơn vị bán, tiếng Việt, tiền VND, một kho vận
hành, COD và một cổng thanh toán trực tuyến, một đơn vị giao vận. Kiến
trúc có khả năng bổ sung kho và nhà cung cấp nhưng không triển khai
nghiệp vụ sàn nhiều người bán.

**Chuẩn chất lượng:** giao diện theo hướng biên tập thời trang, ưu tiên
ảnh thật; Core Web Vitals đạt mức tốt ở dữ liệu người dùng thực; đơn
hàng, tồn kho và tiền có kiểm soát nhất quán; quản trị có phân quyền và
lịch sử thao tác.

Các chỉ tiêu dung lượng, thời gian và ngân sách hiệu năng trong tài liệu
là yêu cầu thiết kế để kiểm chứng. Chúng không phải số liệu kinh doanh
hiện có hoặc kết quả benchmark của một hệ thống đã xây dựng. Những nguồn
bên ngoài được đánh dấu \[S01\] đến \[S27\]; các quyết định còn lại là
đề xuất cho dự án.

## 1.1 Giả định để triển khai

| **Hạng mục**         | **Giả định cơ sở**                      | **Cách điều chỉnh**                                    |
|----------------------|-----------------------------------------|--------------------------------------------------------|
| Mô hình bán          | Shop một chủ bán trực tiếp              | Thêm marketplace phải làm đặc tả riêng                 |
| Hàng hóa             | Quần áo, giày hoặc phụ kiện có biến thể | Danh mục và bảng size cấu hình được                    |
| Thị trường           | Việt Nam, VND, tiếng Việt               | Dữ liệu hỗ trợ locale; chưa mở đa tiền tệ              |
| Kho                  | Một kho ở P0                            | Mọi tồn kho vẫn gắn location để mở rộng                |
| Dữ liệu kiểm thử tải | 10.000 sản phẩm và 50.000 SKU           | Không coi đây là quy mô kinh doanh bắt buộc            |
| Kênh bán             | Web responsive; PWA cơ bản              | POS và sàn bên ngoài thuộc giai đoạn sau               |
| Tài khoản khách      | Mua không cần đăng nhập                 | Tài khoản và Google login là tùy chọn P1               |
| Thanh toán           | COD và VNPAY theo hợp đồng phù hợp      | Có thể chọn MoMo thay thế trước khi phát triển adapter |
| Vận chuyển           | GHN theo vùng phục vụ và hợp đồng       | Thêm hãng khác qua adapter ở P1                        |

## 1.2 Định nghĩa mức ưu tiên

**P0** là điều kiện để ra mắt có giao dịch thật. **P1** tăng hiệu quả
mua sắm và vận hành sau khi P0 ổn định. **P2** là thử nghiệm hoặc mở
rộng cần dữ liệu chứng minh nhu cầu.

Mục tiêu kinh doanh được đo bằng tỷ lệ xem sản phẩm sang thêm giỏ, hoàn
tất checkout, thanh toán thành công, đổi trả do sai size và chênh lệch
đối soát. Thu thập baseline trong 2–4 tuần đầu rồi đặt mục tiêu cải
thiện; không cam kết một tỷ lệ chuyển đổi trước khi biết nguồn khách và
phân khúc giá.

# 2 Cơ sở nghiên cứu và hàm ý thiết kế

Baymard ghi nhận việc giấu size trong dropdown khiến khách khó thấy lựa
chọn và tồn hàng. Dự án dùng các nút size hiển thị trực tiếp, không chọn
sẵn size một cách tùy tiện. \[S01\]

Thông tin số đo người mẫu và size đang mặc giúp bổ sung ngữ cảnh cho
bảng size. Dự án lưu số đo theo từng bộ ảnh, phân biệt số đo cơ thể với
số đo thành phẩm, đặt hướng dẫn ngay cạnh bộ chọn size. \[S02\]

Nghiên cứu về checkout khuyến nghị làm rõ đường mua dạng khách, kể cả
khi email đã thuộc một tài khoản. Dự án không bắt đăng nhập để mua;
không tiết lộ tài khoản có tồn tại cho người chưa xác thực. \[S03\]

Tổng quan các bộ lọc đang áp dụng giúp người mua hiểu phạm vi kết quả và
gỡ lựa chọn. Dự án có chip bộ lọc, số lượng kết quả, xóa từng điều kiện
và trạng thái URL có thể chia sẻ. \[S04\]

UNIQLO Việt Nam có hướng dẫn chiều dài sản phẩm theo chiều cao với ảnh
trước và sau. COS tổ chức trang hàng mới theo loại hàng và bộ lọc. Dự án
học cách trình bày thông tin vừa vặn và bộ sưu tập; không sao chép nhận
diện, ảnh hoặc nội dung của thương hiệu. Đây là tham khảo cấu trúc nội
dung, không phải đánh giá tốc độ hay audit giao diện trực quan của hai
website. \[S05, S06\]

Google định nghĩa mức tốt của Core Web Vitals tại phân vị 75: LCP không
quá 2,5 giây, INP không quá 200 ms và CLS không quá 0,1; cần tách dữ
liệu mobile và desktop. Dự án dùng các ngưỡng này làm mục tiêu trải
nghiệm. \[S07\]

Medusa tách storefront khỏi commerce backend, hỗ trợ dùng Next.js và các
commerce module. Tài liệu triển khai có PostgreSQL, Redis và tiến trình
server cùng worker; không triển khai toàn bộ nghiệp vụ trong một
frontend serverless đơn lẻ. \[S09, S10\]

GHN có danh mục địa chỉ hai cấp và cờ chọn hệ địa chỉ khi tạo vận đơn.
Form địa chỉ mới không bắt buộc quận/huyện. Các nghĩa vụ thương mại điện
tử và dữ liệu cá nhân phải được rà soát theo văn bản đang hiệu lực tại
thời điểm ra mắt. \[S17, S18, S21–S24\]

# 3 Định hướng giao diện và hệ thống thiết kế

## 3.1 Ngôn ngữ hình ảnh

Thiết kế theo hướng biên tập thời trang hiện đại: ảnh sản phẩm lớn, nền
sáng ấm, màu chữ gần đen, bố cục rõ và khoảng cách thoáng. Khối mua hàng
dễ nhận biết; không để hình ảnh trang trí lấn át giá, size hoặc nút mua.
Sự khác biệt thương hiệu đến từ ảnh chụp, cách phối đồ và nội dung bộ
sưu tập.

Trang chủ có một chiến dịch chính, sau đó đi vào danh mục và sản phẩm.
Không dùng màn hình giới thiệu phải chờ, video tự chạy tải nặng, pop-up
xuất hiện ngay lần truy cập đầu hoặc bộ đếm khan hiếm không có dữ liệu.

| **Token**      | **Giá trị khởi điểm**                   | **Quy tắc sử dụng**                                   |
|----------------|-----------------------------------------|-------------------------------------------------------|
| Nền chính      | \#FAF8F4                                | Nền ấm cho trang nội dung và sản phẩm                 |
| Bề mặt         | \#FFFFFF                                | Form, drawer, giỏ hàng và quản trị                    |
| Chữ chính      | \#191919                                | Nội dung và giá, kiểm tra tương phản thực tế          |
| Màu nhấn       | \#6D2635                                | Một màu thương hiệu cho CTA hoặc điểm nhấn            |
| Đường chia     | \#E5E1DA                                | Bố cục; không dùng làm dấu hiệu focus duy nhất        |
| Chữ            | Be Vietnam Pro hoặc sans tương đương    | Tự host, đầy đủ glyph tiếng Việt, ít weight           |
| Nội dung chính | 16 px mobile; 16–18 px desktop          | Line height khoảng 1,5; nhãn lỗi dễ đọc               |
| Tiêu đề        | 28–40 px mobile; 40–64 px desktop       | Co giãn theo viewport, không ép chữ quá lớn           |
| Spacing        | Thang 4, 8, 12, 16, 24, 32, 48, 64 px   | Dùng token, không đặt tùy tiện từng màn               |
| Lề trang       | 16–20 px mobile; 32–64 px desktop       | Nội dung tối đa khoảng 1440 px                        |
| Ảnh danh sách  | Tỷ lệ 4:5                               | Khung đồng nhất, giữ điểm quan trọng của sản phẩm     |
| Nút mua        | Cao 48 px; vùng chạm ít nhất 44 × 44 px | Đây là chuẩn nội bộ cho thao tác chính                |
| Chuyển động    | 120–200 ms                              | Ưu tiên opacity và transform; hỗ trợ giảm chuyển động |

Mọi cặp màu phải được kiểm tra tương phản trên trạng thái thật. Mục tiêu
tiếp cận là WCAG 2.2 AA; mức 44 px là lựa chọn thiết kế của dự án, không
diễn giải thành ngưỡng tối thiểu chung của WCAG AA. \[S08\]

## 3.2 Responsive và thành phần

Kiểm tra ở các chiều rộng 360, 390, 768, 1024 và 1440 px; vẫn phải
reflow tại 320 px và khi zoom. Mobile dùng lưới sản phẩm hai cột khi đủ
chỗ; desktop dùng ba hoặc bốn cột. Breakpoint thay đổi theo nội dung,
không theo tên thiết bị.

Hệ thống thành phần gồm header, menu, search, product card, swatch màu,
nút size, giá, badge, chip lọc, drawer, dialog, toast, skeleton, inline
error, empty state, summary đơn hàng và timeline. Mỗi thành phần có
default, focus, selected, disabled, loading và error khi phù hợp. Màu
sắc không được là dấu hiệu duy nhất.

Sticky CTA trên trang sản phẩm chỉ xuất hiện khi khối mua chính ra khỏi
vùng nhìn; phải chừa safe area và không che trường nhập, bàn phím hoặc
focus. Dialog khóa focus trong lớp đang mở, đóng bằng bàn phím và trả
focus về nút mở.

## 3.3 Sơ đồ trang

| **Nhóm**     | **Đường dẫn đề xuất**                    | **Nội dung chính**                            |
|--------------|------------------------------------------|-----------------------------------------------|
| Khám phá     | / và /hang-moi                           | Chiến dịch, danh mục, hàng mới, bộ sưu tập    |
| Danh mục     | /danh-muc/{slug}                         | Bộ lọc, sắp xếp, phân trang                   |
| Sản phẩm     | /san-pham/{slug}                         | Gallery, màu, size, thông tin mua             |
| Tìm kiếm     | /tim-kiem?q=...                          | Kết quả và hỗ trợ sửa truy vấn                |
| Bộ sưu tập   | /bo-suu-tap/{slug}                       | Nội dung biên tập và sản phẩm liên quan       |
| Giao dịch    | /gio-hang và /thanh-toan                 | Giỏ, địa chỉ, giao hàng, phương thức trả tiền |
| Sau mua      | /don-hang và /doi-tra                    | Tra cứu xác thực, timeline, yêu cầu hỗ trợ    |
| Chính sách   | /giao-hang, /doi-tra-hoan-tien, /bao-mat | Điều kiện và thông tin đơn vị bán             |
| Tài khoản P1 | /tai-khoan                               | Hồ sơ, địa chỉ, lịch sử, wishlist             |
| Quản trị     | admin trên host riêng                    | Catalog, kho, đơn, tiền, nội dung và báo cáo  |

Tên mục Nữ, Nam hoặc Trẻ em chỉ hiển thị khi shop có dữ liệu tương ứng.
Menu lấy từ cấu hình quản trị, không cố định theo một mô hình kinh doanh
chưa được xác nhận.

# 4 Đặc tả trải nghiệm mua sắm

## 4.1 Trang chủ và bộ sưu tập

**WEB01 · P0.** Trang chủ hiển thị một hero với tiêu đề HTML và CTA rõ,
các danh mục chính, sản phẩm mới, một khối phối đồ hoặc lookbook và
thông tin giao hàng/đổi trả. Ảnh hero có phiên bản mobile; chữ không
được đặt sẵn trong ảnh như cách duy nhất truyền tải thông tin.

**WEB02 · P0.** Quản trị viên chọn sản phẩm nổi bật, sắp thứ tự, hẹn giờ
xuất bản chiến dịch và xem trước trên mobile. Khi một sản phẩm bị ẩn
hoặc hết hàng, hệ thống áp dụng quy tắc hiển thị đã cấu hình. Không để
khối trống hoặc đường dẫn hỏng.

**WEB03 · P1.** Mua theo bộ phối cho phép chọn size từng món. Hết hàng
một món không làm mất các món khác. Giá bộ, giảm giá và khả năng đổi trả
từng món phải được công bố rõ trước khi mua.

## 4.2 Danh sách và tìm kiếm

**CAT01 · P0.** Tìm theo tên, SKU, danh mục; chuẩn hóa tiếng Việt có dấu
và không dấu. Có gợi ý truy vấn tối thiểu, giới hạn độ dài và debounce ở
phía giao diện. Tìm kiếm không có kết quả hiển thị cách sửa từ khóa và
danh mục liên quan.

**CAT02 · P0.** Lọc loại hàng, size, màu, khoảng giá, chất liệu và còn
hàng khi dữ liệu hỗ trợ. Bộ lọc size M và màu đen phải khớp trên cùng
một SKU; sản phẩm chỉ có đen-S và trắng-M không được tính là kết quả phù
hợp.

Giá dùng để lọc, sắp xếp và hiển thị card phải lấy từ các SKU thỏa toàn
bộ điều kiện đang chọn. Ví dụ đen-M giá 700.000đ và trắng-S giá
300.000đ: lọc đen-M dưới 500.000đ không được trả sản phẩm này.

**CAT03 · P0.** URL lưu bộ lọc, thứ tự sắp xếp và trang. Reload, Back và
chia sẻ liên kết giữ lựa chọn. Khi quay lại từ trang chi tiết, phục hồi
vị trí danh sách hợp lý. Có phân trang hoặc nút tải thêm được tăng cường
từ liên kết phân trang crawl được.

Drawer lọc mobile giữ lựa chọn nháp; nút “Xem N sản phẩm” mới áp dụng.
Đóng hoặc hủy bỏ phần nháp chưa xác nhận. Sau áp dụng, chip phản ánh URL
đã chốt. Khi không có kết quả, giữ điều kiện và cho gỡ từng mục; không
tự xóa bộ lọc.

**CAT04 · P0.** Card có ảnh, tên, giá hiện tại, giá trước giảm khi hợp
lệ, màu có tên truy cập và trạng thái hết hàng. Nếu giá khác nhau giữa
biến thể, hiển thị khoảng giá hoặc giá từ kèm ngữ cảnh; không quảng cáo
giá thấp nhất rồi mặc định chọn SKU đắt hơn.

Sắp xếp P0 gồm mới nhất và giá tăng/giảm. Bán chạy chỉ xuất hiện khi đã
có định nghĩa số liệu và khoảng thời gian tính. Search index là bản đọc
phục vụ khám phá; backend phải xác nhận lại giá và tồn khi đặt hàng.

## 4.3 Chi tiết sản phẩm

**PDP01 · P0.** Desktop dùng gallery khoảng 60% và khối mua khoảng 40%;
mobile đi theo thứ tự ảnh, tên/giá, màu/size, CTA, thông tin chi tiết.
Không buộc khách cuộn qua lookbook dài trước khi thấy lựa chọn mua.

**PDP02 · P0.** Mỗi sản phẩm có ảnh thật ở mặt trước, mặt sau và chi
tiết chất liệu; có ảnh mặc trên người khi phù hợp. Có phóng ảnh, alt
text có ý nghĩa và ảnh theo màu. Mục tiêu nội dung là 4–6 ảnh chất
lượng, tối thiểu 3 ảnh trước khi xuất bản hàng may mặc; ngoại lệ phải
được người quản trị chịu trách nhiệm ghi nhận.

**PDP03 · P0.** Size hiển thị thành nút, ghi rõ còn/hết hàng. Hướng dẫn
size đặt cạnh lựa chọn, dùng đơn vị cm và số đo đúng loại hàng. Không
suy ra size chỉ từ cân nặng như một bảo đảm vừa. Đổi màu mà size đang
chọn không tồn tại phải yêu cầu chọn lại.

**PDP04 · P0.** Nội dung gồm chất liệu, thành phần, độ co giãn nếu có dữ
liệu, form, hướng dẫn bảo quản, xuất xứ và thông tin hàng hóa áp dụng.
Metadata người mẫu phải gắn với bộ ảnh thực, không tạo thông tin giả.

**PDP05 · P0.** Gần CTA có tóm tắt giao hàng, điều kiện đổi trả và liên
kết chi tiết. CTA phản ánh chính xác tình trạng cần chọn size, hết hàng,
đang thêm hoặc lỗi. Mua ngay vẫn phải đi qua kiểm tra biến thể và tổng
tiền của backend.

**PDP06 · P1.** Wishlist, thông báo có hàng theo SKU, đánh giá gắn đơn
mua thật và sản phẩm phối cùng. Không sinh đánh giá giả, số lượt mua giả
hoặc nhãn xác thực không có chứng cứ.

## 4.4 Giỏ hàng và checkout

**CHK01 · P0.** Khách sửa số lượng, size, màu hoặc xóa từng dòng trong
giỏ. Lỗi một dòng không làm mất các dòng còn lại. Sản phẩm bị ẩn, giá
đổi hoặc SKU hết hàng được giải thích trước khi tiếp tục.

**CHK02 · P0.** Hiển thị rõ “Mua không cần tài khoản”. Thu tên, số điện
thoại, địa chỉ và kênh liên hệ cần cho giao dịch. Email có thể tùy chọn
khi đã có SMS hoặc phương án thông báo phù hợp; nếu vận hành chọn email
là kênh bắt buộc, phải quyết định trước UAT. Không tự tạo tài khoản hoặc
gộp lịch sử chỉ vì email trùng.

**CHK03 · P0.** Form địa chỉ mặc định gồm tỉnh/thành, phường/xã và địa
chỉ chi tiết theo danh mục hiện hành. Lưu địa chỉ gốc và bản chuẩn hóa.
Không suy diễn mã GHN thành mã quốc gia. Địa chỉ cũ mơ hồ cần khách xác
nhận ánh xạ.

**CHK04 · P0.** Trước nút đặt hàng phải có tổng sản phẩm, từng loại giảm
giá, phí vận chuyển, thuế/phí bổ sung nếu áp dụng, tổng phải trả và
phương thức thanh toán. Khi tổng tăng hoặc điều kiện thay đổi, yêu cầu
xác nhận lại; không thu thêm âm thầm.

**CHK05 · P0.** Checkout một trang chia thành các nhóm liên hệ, giao
hàng và thanh toán; order summary luôn dễ truy cập. Form có nhãn thật,
autocomplete, bàn phím phù hợp và lỗi gắn trường. Retry sau lỗi mạng giữ
dữ liệu hợp lệ trong phiên; không lưu địa chỉ đầy đủ vào localStorage
lâu dài.

**CHK06 · P0.** Kết quả đặt đơn, kết quả thanh toán và kết quả giao hàng
được trình bày riêng. Sau redirect chưa xác minh, hiển thị “Đang xác
nhận thanh toán”, có tra cứu lại và thông tin liên hệ.

Thời hạn giữ hàng lấy từ server. Với pending hoặc unknown, nút “Kiểm tra
lại” truy vấn cùng giao dịch, không mời trả tiền lần nữa. Khi đã hết hạn
và kết quả được xác định, cho bắt đầu checkout mới sau khi kiểm tra lại
giá/tồn. Trạng thái kéo dài phải có mã tham chiếu và kênh hỗ trợ.

## 4.5 Sau mua và hỗ trợ

**POST01 · P0.** Khách nhận mã đơn và xem timeline qua phiên đã đặt,
liên kết ngắn hạn hoặc OTP. Mã đơn và số điện thoại không đủ để lấy toàn
bộ thông tin cá nhân. Link xác thực được đổi sang phiên bảo mật rồi loại
token khỏi URL.

**POST02 · P0.** Hủy đơn chỉ khả dụng ở trạng thái cho phép; một yêu cầu
hủy có thể cần xử lý hoàn tiền riêng. Đơn đã giao không được “hủy” để
xóa lịch sử.

**POST03 · P0.** Yêu cầu đổi/trả theo từng dòng hàng và số lượng, có lý
do, ảnh tùy trường hợp và hướng dẫn. Người mua thấy đã tiếp nhận, chờ
gửi hàng, đã nhận, đã kiểm tra và kết quả hoàn/đổi.

**POST04 · P1.** Tài khoản tùy chọn, đăng nhập email hoặc Google nếu
được chọn, wishlist đồng bộ và địa chỉ đã lưu. Liên kết đơn guest vào
tài khoản yêu cầu chứng minh quyền truy cập kênh liên hệ.

# 5 Quản trị và quy tắc thương mại

## 5.1 Catalog và nội dung

**ADM01 · P0.** Quản lý sản phẩm cha và SKU màu × size, giá, hình ảnh
theo màu, bảng size, thuộc tính, danh mục, bộ sưu tập, trạng thái
draft/published/archived và SEO. SKU phải duy nhất, không tái sử dụng
cho hàng khác đã có lịch sử giao dịch.

**ADM02 · P0.** Nhập CSV có preview, kiểm tra lỗi từng dòng và báo cáo
kết quả; cùng mã import retry không tạo bản ghi trùng. Thao tác xuất dữ
liệu chống công thức nguy hiểm trong CSV. Import giá và tồn cần quyền
riêng, ghi lại người thao tác và nội dung thay đổi.

**ADM03 · P0.** Kiểm tra dữ liệu trước xuất bản: tên, SKU, biến thể hợp
lệ, giá, ảnh, mô tả, bảng size khi cần và chính sách liên quan. Đơn cũ
vẫn giữ snapshot khi sản phẩm hoặc nội dung chính sách đổi.

CMS P0 gồm trang tĩnh, block trang chủ, lookbook và lịch xuất bản trong
module nội dung nhỏ hoặc tích hợp sẵn phù hợp. Chỉ thêm một CMS độc lập
khi đội biên tập có nhu cầu workflow rõ; không nhân đôi nguồn sự thật
của giá và tồn.

## 5.2 Giá và khuyến mãi

**PRICE01 · P0.** Tiền trong domain dùng số nguyên VND; không tính tổng
bằng số thực nhị phân. Adapter chịu trách nhiệm chuyển định dạng tiền
của provider. Backend xác định giá cuối cùng từ price list và quy tắc
hiệu lực.

**PRICE02 · P0.** Đợt giảm giá có khoảng hiệu lực, phạm vi sản phẩm,
giới hạn lượt dùng và quy tắc cộng dồn. P0 mặc định tối đa một mã giảm
cấp đơn; ưu đãi vận chuyển có thể kết hợp nếu đã cấu hình.

**PRICE03 · P0.** Giảm giá cấp đơn được phân bổ xuống từng dòng bằng quy
tắc làm tròn xác định, bảo đảm tổng phân bổ đúng tổng giảm. Khi trả một
món, hoàn theo giá thực trả đã phân bổ; không mặc định hoàn giá niêm
yết.

**PRICE04 · P0.** Backend chặn giá âm, số lượng âm, giảm vượt điều kiện
và dùng mã đồng thời vượt hạn mức. Lưu policy version và breakdown trong
đơn. Thuế, hóa đơn và phí được cấu hình theo mô hình kinh doanh, không
hardcode một thuế suất cho mọi mặt hàng.

## 5.3 Tồn kho

**INV01 · P0.** Tồn theo SKU và location; phân biệt hàng có thể bán,
hàng đang giữ cho đơn, hàng hỏng/cách ly và hàng chờ kiểm tra. Hàng cách
ly không được đưa vào stocked quantity bán được hoặc phải ở location
không cấp bán.

**INV02 · P0.** Available to sell được tính từ tồn bán được trừ số đã
giữ; không giữ hàng khi khách chỉ thêm giỏ. Bắt đầu giữ khi checkout hợp
lệ tạo đơn online chờ thanh toán hoặc đơn COD; mỗi loại dùng thời hạn và
quy trình xác nhận riêng.

**INV03 · P0.** Điều chỉnh tồn phải có lý do, người thực hiện, lượng
trước/sau và khóa chống trùng. Không cho sửa tồn giảm xuống thấp hơn
phần đã giữ mà không có quy trình xử lý ngoại lệ.

**INV04 · P0.** Hàng trả chỉ trở lại tồn bán sau kiểm định. Mỗi nhập lại
gắn return line và quantity để retry không cộng tồn hai lần. Kho quét
SKU khi nhặt và đóng gói nếu thiết bị hỗ trợ.

Luồng nhận hàng trả native phải nhập về location cách ly không cấp bán
hoặc trì hoãn bước restock tới sau kiểm định. Không chạy một workflow
receive mặc định làm tăng tồn bán ngay trước khi đánh giá chất lượng.

## 5.4 Vai trò và quyền

| **Vai trò**        | **Được thực hiện**                            | **Hạn chế bắt buộc**                                   |
|--------------------|-----------------------------------------------|--------------------------------------------------------|
| Chủ shop           | Cấu hình, phân quyền, theo dõi toàn bộ        | MFA, ghi log, xác thực lại thao tác nhạy cảm           |
| Quản lý catalog    | Sản phẩm, ảnh, nội dung, giá theo quyền       | Không hoàn tiền hoặc xem toàn bộ bí mật tích hợp       |
| Nhân viên đơn hàng | Xác nhận, đóng gói, vận đơn                   | Không tự sửa tiền đã thu                               |
| Kho                | Nhập, xuất, kiểm kê, kiểm định hàng trả       | Không hoàn tiền, không xuất hồ sơ khách hàng hàng loạt |
| CSKH               | Xem đơn được phép, xử lý yêu cầu hỗ trợ       | Che bớt dữ liệu; hoàn tiền cần quyền/phê duyệt         |
| Kế toán            | Thanh toán, hoàn tiền, đối soát, xuất báo cáo | Không sửa nội dung sản phẩm nếu không có vai trò       |

**ADM04 · P0.** Quyền phải được kiểm tra ở từng API; ẩn nút trên giao
diện không đủ. Hoàn tiền vượt ngưỡng cấu hình cần người có thẩm quyền
thứ hai. Audit log lưu actor, thời điểm, hành động, đối tượng và lý do,
tránh chép nguyên dữ liệu nhạy cảm.

## 5.5 Báo cáo

P0 có đơn theo trạng thái, doanh số theo định nghĩa, tiền đã thu, hoàn
tiền, tiền COD phải nhận, chênh lệch và SKU sắp hết. Phân biệt giá trị
đơn, doanh thu vận hành và tiền mặt thực nhận; không dùng chung một số
“doanh thu” cho mọi mục đích.

Dashboard ngoại lệ phải thấy đơn đã thu tiền chưa xử lý được, webhook
lỗi, hoàn tiền chưa rõ kết quả, tồn không khớp, vận đơn trùng và COD
chưa đối soát. Các mục có owner, mức ưu tiên và thời gian tồn đọng.

# 6 Luồng đơn hàng thanh toán và giao vận

## 6.1 Tách mô hình trạng thái

Các trạng thái dưới đây là mô hình nghiệp vụ dự án. Nhóm backend phải
ánh xạ chúng vào entity, workflow và trạng thái native của Medusa trong
tài liệu ADR; không tự thêm enum vào core hoặc tuyên bố tên này là API
có sẵn.

| **Miền**       | **Trạng thái chính**                                                          | **Nguồn sự thật**                              |
|----------------|-------------------------------------------------------------------------------|------------------------------------------------|
| Đơn thương mại | preparing, awaiting_payment, placed, confirmed, cancelled, completed          | Workflow đơn hàng và lịch sử chuyển trạng thái |
| Lần thanh toán | created, pending, authorized, captured, failed, unknown                       | Kết quả provider đã xác thực                   |
| Giao hàng      | unfulfilled, picking, packed, shipped, delivered, failed, returning, returned | Shipment và dữ liệu giao vận đã đối chiếu      |
| Đổi trả        | requested, approved, rejected, received, inspected, closed                    | Return line và kiểm định                       |
| Hoàn tiền      | requested, approved, processing, succeeded, failed, unknown                   | Refund ledger và kết quả provider              |
| Đối soát       | unsettled, partially_settled, settled, disputed                               | Settlement batch và chứng từ                   |

Không cho trạng thái tài chính lùi từ captured về pending khi callback
cũ đến muộn. Refund là giao dịch mới liên kết với tiền đã thu, không ghi
đè lịch sử thanh toán. Một đơn có thể có nhiều lần thử thanh toán nhưng
mỗi lần có reference riêng.

## 6.2 Luồng online với giữ hàng

Thiết kế P0 dùng workflow tùy chỉnh **tạo đơn chờ thanh toán trước**.
Đơn này giữ đúng snapshot và có reservation native gắn với từng order
line; khi khách trả tiền, hệ thống xác nhận chính đơn đó. Không tạo một
đơn thứ hai sau thanh toán.

1.  Backend đọc lại giỏ, giá, mã giảm, địa chỉ, báo phí còn hiệu lực và
    phiên bản giỏ. Nếu thay đổi, trả lỗi có cấu trúc để khách xác nhận.

2.  Nhận Idempotency-Key, tạo bản ghi checkout attempt bền vững, khóa
    các tài nguyên giỏ/SKU theo thứ tự ổn định và kiểm tra available
    stock.

3.  Tạo đơn ở giai đoạn preparing, dùng workflow Medusa phù hợp; tạo
    đúng một bộ reservation cho mỗi order line và location; liên kết
    payment collection.

4.  Khi các bước nội bộ hoàn tất, đánh dấu awaiting_payment với thời hạn
    giữ hàng. Giá trị cấu hình khởi điểm 15 phút chỉ được dùng nếu phù
    hợp thời hạn gateway; trạng thái chưa chuẩn bị xong không được gọi
    gateway hoặc xuất kho.

5.  Tạo payment attempt và phiên thanh toán phía provider. Request gửi
    provider dùng reference ổn định; timeout chuyển unknown và truy vấn
    lại trước khi tạo attempt mới.

6.  Browser chuyển sang provider, rồi quay lại màn hình tra cứu kết quả.
    Backend xác minh IPN hoặc truy vấn provider; chữ ký, merchant,
    reference, số tiền và tiền tệ phải khớp.

7.  Payment thành công xác nhận đơn hiện có; reservation được giữ đến
    lúc native fulfillment tiêu thụ tồn. Thông báo và cập nhật phụ được
    gửi qua tác vụ nền.

8.  Hết hạn chưa thanh toán được xử lý dưới khóa trạng thái: kiểm tra
    tình trạng đáng tin cậy, hủy/cancel workflow và nhả reservation đúng
    một lần. Trường hợp provider chưa rõ kết quả được cách ly, có hạn xử
    lý và người phụ trách.

Medusa mô tả completeCartWorkflow tạo reservation khi hoàn tất giỏ,
trong khi createOrderWorkflow có thể kiểm tra tồn nhưng không tạo
reservation. Vì vậy đường checkout tùy chỉnh phải gọi phần tạo
reservation phù hợp và gắn line_item_id. Không gọi thêm
completeCartWorkflow nguyên bản cho cùng checkout rồi giữ hàng lần hai.
\[S11\]

Workflow qua nhiều module không được coi là một transaction SQL duy
nhất. Phải có trạng thái bền vững, khóa theo tài nguyên, bước bù trừ và
job đối chiếu. Nếu tiến trình chết sau khi tạo một phần reservation, hệ
thống phục hồi hoặc giải phóng phần đã tạo; không để đơn preparing bị
xuất kho.

Workflow tùy chỉnh còn phải sở hữu các bước bị bỏ qua khi không chạy
completeCartWorkflow: đóng băng và tiêu thụ đúng cart version, giữ/ghi
nhận/hoàn lại hạn mức mã giảm, nối order với payment collection và
native payment record, tạo audit cùng sự kiện cuối. Subscriber chỉ được
tạo vận đơn hoặc gửi xác nhận sau khi trạng thái finalization đủ điều
kiện; không mặc định mọi order.placed phát sớm đều là đơn được phép
giao.

Đặc biệt, xử lý payment webhook native có thể tự hoàn tất giỏ chưa hoàn
tất có liên kết với payment collection. Thiết kế phải nối payment
collection/session vào đơn đã tạo mà không kích hoạt hoàn tất giỏ lần
nữa, hoặc dùng handler tùy chỉnh kiểm soát đường này. Cart phải được
đóng/tiêu thụ nhất quán trước khi gọi provider. Chứng minh bằng
notification chạy qua handler thực tế rằng order_id và số reservation
không thay đổi. \[S27\]

Khóa phân tán phải có thời hạn, gia hạn và phục hồi được; ràng buộc
uniqueness và kiểm tra đồng thời tại lớp dữ liệu/workflow vẫn bắt buộc.
Tất cả đường tạo đơn và điều chỉnh tồn phải đi qua quy tắc thống nhất.
Hàng quản lý tồn bật manage_inventory; backorder mặc định tắt.

**Thanh toán đến sau khi đơn đã hủy:** ghi nhận khoản tiền vào ledger và
mở ngoại lệ hoàn tiền/CSKH; không tự phục hồi đơn, tự thay SKU hoặc tự
giao. Nếu muốn đặt lại khi còn hàng, đó là nghiệp vụ mới có xác nhận phù
hợp và liên kết giao dịch.

Mỗi đơn chỉ cho một payment attempt đang hoạt động khi hệ thống kiểm
soát được. Nếu hai giao dịch thật khác nhau vẫn cùng thành công, ghi
nhận cả hai khoản thu, phát hiện phần dư và hoàn phần dư theo quy trình.
Chỉ có một lần xác nhận nghiệp vụ và một quyền fulfillment; không bỏ qua
khoản thu thứ hai như callback trùng.

## 6.3 COD

COD tạo đơn placed và reservation, sau đó xác nhận theo quy trình vận
hành. Thời hạn kiểm tra đơn COD là cấu hình riêng, không dùng TTL thanh
toán online. Biện pháp chống đặt giả có thể là giới hạn tốc độ hoặc xác
minh theo rủi ro; không bắt OTP tất cả khách chỉ để vượt checkout.

Trước khi tạo vận đơn, hệ thống tính số cần thu tại cửa từ số tiền còn
phải thu. Đơn đã trả đủ online phải có COD bằng 0. Phí vận chuyển đã thu
trong checkout phải được ánh xạ đúng bên trả phí để khách không trả hai
lần.

Giao thành công, courier đã thu hộ và courier đã chuyển tiền cho shop là
các mốc riêng. GHN có sự kiện callback về trạng thái vận đơn và COD;
không chuyển settlement sang settled chỉ từ delivered. \[S19\]

## 6.4 Vận chuyển và retry

Adapter P0 gồm báo phí, ước tính thời gian, tạo/in/hủy vận đơn, tra cứu
và callback. Báo phí có thời điểm và hết hạn cấu hình. Không phục vụ địa
chỉ phải được báo rõ trước khi xác nhận.

Khi tạo vận đơn timeout, tra cứu bằng reference của shop trước khi gửi
lại. Callback có thể lặp hoặc sai thứ tự; giữ sự kiện thô đã lọc dữ liệu
nhạy cảm, đối chiếu provider khi cần và áp dụng chuyển trạng thái hợp
lệ.

Webhook giao vận phải dùng cơ chế xác thực mà provider thực sự hỗ trợ.
Nếu không có chữ ký đáng tin cậy, đối chiếu qua API có xác thực trước
khi thay đổi trạng thái có hệ quả tài chính; không phát minh một header
chữ ký không tồn tại.

## 6.5 Đổi trả hoàn tiền

P0 hỗ trợ trả một phần, hoàn một phần và đổi size qua đơn thay thế liên
kết. Quy trình gồm tiếp nhận, kiểm tra điều kiện, nhận hàng, kiểm định,
tính khoản hoàn/chênh lệch, phê duyệt và thực hiện. Không sửa size trực
tiếp trên dòng hàng lịch sử đã giao.

Hoàn do hủy trước giao, thanh toán dư, tiền đến sau hủy hoặc không thể
cung cấp hàng không cần chờ hàng trả/kiểm định. Chọn nhánh quy trình
theo lý do và chứng cứ; không áp dụng điều kiện nhận hàng cho trường hợp
chưa giao hàng.

Thời hạn và điều kiện đổi trả là chính sách kinh doanh được cấu hình và
rà soát trước xuất bản. Không mặc định 7, 14 hoặc 30 ngày là quy định
chung. Tính tiền hoàn theo snapshot thực trả, phần giảm giá đã phân bổ
và chính sách phí áp dụng.

Tổng hoàn thành công cộng số tiền đang giữ cho yêu cầu hoàn chưa ngã ngũ
không vượt tiền đã thu hợp lệ. Khi refund timeout, truy vấn và retry
cùng nghiệp vụ; không tạo refund mới để thử lại. Với COD, ghi nhận chứng
từ hoàn ngoài hệ thống và đối soát riêng khi cần.

# 7 Kiến trúc và ranh giới trách nhiệm

## 7.1 Lựa chọn nền tảng

| **Phương án**             | **Khi phù hợp**                                | **Đánh đổi**                                                  |
|---------------------------|------------------------------------------------|---------------------------------------------------------------|
| Nền tảng SaaS như Shopify | Muốn vận hành nhanh, ít quản lý backend        | Cần kiểm chứng checkout, đối tác Việt Nam và chi phí hợp đồng |
| Next.js và Medusa v2      | Muốn sở hữu mã nguồn, UI riêng và tích hợp sâu | Cần đội backend, vận hành và kiểm thử commerce                |
| Tự viết commerce từ đầu   | Nghiệp vụ cốt lõi khác biệt đã được chứng minh | Tăng công việc về tiền, tồn, đơn và admin                     |

Dự án chọn Next.js và Medusa theo giả định ưu tiên tùy biến lâu dài. Nếu
mục tiêu thực tế chỉ là mở cửa hàng tiêu chuẩn với ít nhân lực kỹ thuật,
cần so lại phương án SaaS trước khi cam kết vận hành. Với Shopify
headless, Storefront Cart API cung cấp checkout URL để chuyển sang quy
trình checkout của Shopify; phải kiểm chứng mức tùy biến và tích hợp phù
hợp. Không chọn stack chỉ vì số sao GitHub. \[S26\]

## 7.2 Thành phần triển khai

| **Thành phần**           | **Trách nhiệm**                                                           |
|--------------------------|---------------------------------------------------------------------------|
| Next.js storefront       | Render trang, metadata, tương tác mua sắm, lớp API theo nhu cầu giao diện |
| Medusa server            | Commerce API, workflow, quyền, Admin và module mở rộng                    |
| Medusa worker            | Webhook processing, thông báo, expiry, đối soát và cập nhật index         |
| PostgreSQL               | Commerce, checkout attempt, inbox/outbox và audit bền vững                |
| Redis production modules | Session, khóa, event/workflow infrastructure theo cấu hình Medusa         |
| Object storage và CDN    | Ảnh sản phẩm công khai; vùng riêng cho ảnh đổi trả/chứng từ               |
| Search                   | Read model PostgreSQL ở P0; engine riêng nếu benchmark yêu cầu            |
| Provider adapters        | Payment, fulfillment, email/SMS; không chứa logic giá và tồn              |

Server và worker dùng chung codebase và module nghiệp vụ, triển khai
thành tiến trình riêng. Không tách thành microservice theo từng tính
năng ở P0. PostgreSQL là dữ liệu gốc; cache và search có thể tái tạo.
\[S09, S10\]

Trạng thái thực thi workflow engine tuân cấu hình production của phiên
bản Medusa, bao gồm Redis khi module yêu cầu. Redis không chỉ là cache
có thể xóa tùy ý; phải cấu hình persistence, giới hạn eviction phù hợp
và quy trình resume/đối soát khi mất trạng thái.

Storefront ưu tiên Server Components cho nội dung và Client Components
nhỏ cho biến thể, lọc, giỏ. Server-rendered code gọi commerce service
trực tiếp qua lớp server phù hợp, tránh vòng gọi API nội bộ không cần
thiết. Thực thi xác thực tại mọi thao tác server. \[S12\]

Search P0 dùng read model riêng với index tìm tên/SKU, chuẩn hóa tiếng
Việt và truy vấn cùng biến thể; không sửa trực tiếp bảng core để tối ưu
tùy tiện. Nếu dữ liệu giả lập không đạt độ trễ và độ phù hợp, quyết định
bổ sung Meilisearch hoặc dịch vụ tương đương bằng ADR trong giai đoạn
foundation.

## 7.3 Phần tái sử dụng và phần phải phát triển

Tái sử dụng module commerce cho catalog, cart, order, inventory,
promotion, payment, fulfillment và Admin. Phải phát triển hoặc cấu hình
riêng checkout pending order, adapter Việt Nam, đối soát, phân quyền chi
tiết nếu native chưa đáp ứng, audit, bảng size, content blocks và nghiệp
vụ đổi size.

Khả năng có sẵn phải được kiểm chứng trên phiên bản đã chọn. Không xem
framework hoặc starter là bằng chứng rằng cổng thanh toán, RBAC hay
chống oversell đã hoạt động đúng trong dự án.

## 7.4 Cache và nhất quán

| **Dữ liệu**                            | **Chính sách**                                               |
|----------------------------------------|--------------------------------------------------------------|
| Ảnh có hash                            | Cache dài hạn, immutable; thay ảnh tạo URL mới               |
| Trang chủ và nội dung                  | Cache công khai với invalidate theo sự kiện xuất bản         |
| Catalog công khai                      | Cache theo locale, kênh bán, currency và tập tham số hợp lệ  |
| Giá và tồn hiển thị                    | Có mốc cập nhật; invalidate nhanh; kiểm tra lại khi checkout |
| Giỏ, đơn, tài khoản, thanh toán, admin | private, no-store; không cache dùng chung                    |
| Search index                           | Nhất quán cuối cùng; có đo độ trễ đồng bộ và đường tái tạo   |

Mục tiêu nội bộ: cập nhật giá/tồn công khai phản ánh trong 60 giây ở
luồng thường; checkout luôn đọc nguồn có thẩm quyền. Trường hợp index cũ
không được làm bán vượt tồn. Không cache HTML có tên, giá riêng hoặc giỏ
của một khách rồi phục vụ khách khác.

# 8 Mô hình dữ liệu và ràng buộc

Các entity dưới đây là mô hình logic. Với phần Medusa sở hữu, dùng
module/link/extension và workflow chính thức; không tạo một bộ Order
hoặc Inventory thứ hai để thay thế nguồn dữ liệu native.

| **Entity**                       | **Trường hoặc liên kết chính**                                         |
|----------------------------------|------------------------------------------------------------------------|
| Product                          | id, slug, title, description, category, size_chart, publish_status     |
| Variant                          | product_id, sku, option values, media_by_color, price reference        |
| SizeChart                        | loại hàng, đơn vị, số đo cơ thể/thành phẩm, version                    |
| StockLocation và InventoryLevel  | SKU, location, stocked, reserved, adjustment history                   |
| Cart và CartLine                 | session/customer, variant_id, quantity, version                        |
| CheckoutAttempt                  | cart_id, idempotency_key, payload_hash, workflow_state, order_id       |
| Order và OrderLine               | customer/guest, snapshot SKU/giá/địa chỉ/chính sách, quantity          |
| PaymentAttempt                   | order/payment collection, provider, reference, amount, currency, state |
| Refund                           | payment_id, amount, reason, approval, idempotency, provider_ref        |
| Shipment và ShipmentLine         | order, quantity, provider_ref, tracking, COD, shipping_fee             |
| Return và ReturnLine             | order_line, quantity, reason, inspection, restock disposition          |
| Settlement                       | provider, batch, gross, fee, net, expected, difference, evidence       |
| WebhookInbox                     | provider, event_key, payload_hash, verified_at, process_state          |
| Outbox hoặc durable event record | event_key, aggregate_id, state, retry, next_attempt_at                 |
| AuditLog                         | actor, action, resource, timestamp, reason, redacted change            |
| AddressSnapshot                  | names, address_version, provider mapping, original input               |
| PolicyVersion và Consent         | policy version, purpose, actor/session, choice, timestamp              |

**DATA01.** SKU và provider transaction reference có ràng buộc duy nhất
trong đúng phạm vi. Idempotency key gắn actor/phiên, loại thao tác và
hash payload; cùng key khác payload trả conflict.

**DATA02.** Mỗi cart version chỉ có một checkout đang hoạt động; nhiều
tab không tạo nhiều pending order cho cùng lần xác nhận. Retry lấy lại
kết quả hiện có.

Cart version đã dùng cho đơn chờ được đóng băng/tiêu thụ. Sửa giỏ sau đó
phải mở phiên mới hoặc hủy phiên cũ đúng quy trình; không sửa snapshot
của đơn đang trả tiền.

**DATA03.** Số lượng đã fulfill, đã return và đã refund được kiểm tra
theo từng dòng. Không trả nhiều hơn số đã giao hoặc hoàn nhiều hơn số đã
thu.

**DATA04.** Lưu thời gian theo UTC, hiển thị lịch chiến dịch và vận hành
theo Asia/Ho_Chi_Minh. Kiểm tra cả thời điểm bắt đầu, kết thúc và tính
đúng biên thời gian.

**DATA05.** Snapshot đơn bất biến về thông tin đã xác nhận; sửa địa chỉ
trước giao tạo version/audit phù hợp, không viết lại lịch sử tiền đã
thu. Dữ liệu marketing và dữ liệu chứng từ có chính sách lưu khác nhau.

**DATA06.** Không giữ transaction DB trong lúc chờ gateway hoặc courier.
Dùng durable workflow, inbox/outbox và compensation; việc gửi email lỗi
không rollback đơn đã được ghi nhận.

# 9 Hợp đồng API và tích hợp

## 9.1 Quy ước

Các đường dẫn sau là hợp đồng API dự án đề xuất, không phải danh sách
route native Medusa. Nhóm triển khai lập OpenAPI, ánh xạ sang Store
API/Admin API và custom routes trước khi frontend tích hợp.

JSON dùng ID opaque, giá nguyên VND và ISO 8601 cho thời gian. Request
có request_id xuyên storefront, backend, worker và provider mapping.
Validation ở server; lỗi có code ổn định, thông báo tiếng Việt và trường
gây lỗi.

| **API đề xuất**                           | **Hành vi bắt buộc**                                              |
|-------------------------------------------|-------------------------------------------------------------------|
| GET /api/v1/products                      | Cursor/page, sort, filter allowlist, giới hạn page size           |
| GET /api/v1/products/{slug}               | Dữ liệu công khai, biến thể và chính sách liên quan               |
| GET /api/v1/search                        | Chuẩn hóa truy vấn, facets cùng SKU, giới hạn tốc độ              |
| POST /api/v1/carts                        | Tạo giỏ gắn phiên, không nhận customer_id tùy ý từ client         |
| PATCH /api/v1/carts/{id}/lines            | Kiểm tra quyền sở hữu, quantity, version và variant               |
| POST /api/v1/checkout/quote               | Tính lại giá, phí, điều kiện; trả quote_id và expires_at          |
| POST /api/v1/checkout/submit              | Idempotency-Key, cart_version, quote_id; tạo pending/COD order    |
| GET /api/v1/checkout/{attempt}/status     | Chỉ phiên được phép; phục hồi sau timeout                         |
| POST /api/v1/orders/{id}/cancel           | Kiểm tra trạng thái và quyền; thực thi idempotent                 |
| POST /api/v1/returns                      | Xác thực đơn, line, quantity và điều kiện                         |
| GET /api/v1/webhooks/payments/vnpay       | IPN VNPAY theo protocol; xác minh và cập nhật idempotent          |
| POST /api/v1/webhooks/payments/momo       | Chỉ triển khai khi chọn MoMo; xác minh notification theo protocol |
| POST /api/v1/webhooks/shipping/{provider} | Xác thực/đối chiếu, mapping và deduplicate                        |
| POST /api/v1/admin/refunds                | RBAC, phê duyệt, hạn mức và idempotency                           |

Checkout submit chỉ nhận cart_id, cart_version, quote_id, payment_method
và tham chiếu thông tin khách. Không nhận một total từ client làm số
tiền có thẩm quyền. Response gồm checkout_attempt_id, order reference
khi đã có, state và payment_url nếu phù hợp.

HTTP 409 trả CART_CHANGED, PRICE_CHANGED, QUOTE_EXPIRED hoặc
INSUFFICIENT_STOCK kèm hành động cần làm. HTTP 422 là lỗi dữ liệu; 429
có retry guidance; 503 chỉ dùng khi không thể nhận yêu cầu an toàn.
Trường hợp đã nhận và đang xử lý trả 202 cùng endpoint status; không yêu
cầu người dùng tạo đơn mới.

## 9.2 Payment adapter

Giao diện nội bộ gồm createSession, queryStatus, verifyNotification và
refund; capture hoặc cancelSession chỉ khi phương thức/provider hỗ trợ.
Nếu không có API hủy phiên, dùng hết hạn và quy trình chặn/đối soát giao
dịch đến muộn. Hủy đơn nội bộ không đồng nghĩa phiên payment phía
provider đã hủy. Provider giữ khóa bí mật phía server. Không thu hoặc
lưu PAN/CVV trong ứng dụng; dùng trang thanh toán/tokenization được nhà
cung cấp hỗ trợ.

VNPAY PAY dùng GET cho IPN và response JSON RspCode/Message theo kết quả
xử lý; MoMo dùng POST notification, yêu cầu xác minh chữ ký và đối chiếu
dữ liệu giao dịch. Response acknowledge phải tuân protocol của từng
provider, không dùng cùng một mã HTTP/mẫu JSON cho tất cả. Merchant phải
xác minh lại phiên bản protocol được cấp khi tích hợp. \[S15, S16\]

Payment webhook được xác minh trước khi ghi nhận có hiệu lực, lưu
receipt bền vững và xử lý idempotent. Chỉ acknowledge thành công khi đạt
điều kiện mà protocol yêu cầu; tác vụ email, analytics và đồng bộ không
chặn endpoint.

Khóa chống lặp sự kiện dùng event ID khi provider có; nếu không, dùng
reference kèm loại/trạng thái hoặc fingerprint chuẩn hóa theo protocol.
Không dùng riêng transaction reference làm event key vì pending,
captured và refund có thể cùng tham chiếu nhưng đều cần xử lý.
Uniqueness cho khoản thu/hoàn là ràng buộc tài chính riêng.

Cần kiểm thử hợp đồng ở sandbox rồi một giao dịch thật giá trị nhỏ khi
merchant được kích hoạt. Phí, lịch đối soát, phương thức được mở và hạn
mức hoàn tiền phụ thuộc hợp đồng, không suy ra từ logo hoặc demo.

## 9.3 Shipping và thông báo

Shipping adapter bao bọc dữ liệu địa chỉ theo namespace của hãng. Token
chỉ ở server. Ảnh/nhãn vận đơn chứa dữ liệu người nhận dùng đường truy
cập có kiểm soát, không public CDN.

Email/SMS transactional có message key để chống gửi lặp, retry giới hạn
và dashboard lỗi. Gửi marketing có consent riêng. Trước ra mắt phải có
quy trình phát hành hóa đơn đáp ứng nghĩa vụ áp dụng, có thể qua hệ
thống kế toán/hóa đơn bên ngoài. Xuất dữ liệu chính xác là đầu vào cho
quy trình đó, không thay việc phát hành hóa đơn khi có nghĩa vụ.

# 10 Hiệu năng và khả năng mở rộng

## 10.1 Mục tiêu đo được

| **Chỉ số**         | **Mục tiêu nghiệm thu đề xuất** | **Điều kiện đo**                                                     |
|--------------------|---------------------------------|----------------------------------------------------------------------|
| LCP                | ≤ 2,5 giây                      | p75 người dùng thực, mobile/desktop riêng                            |
| INP                | ≤ 200 ms                        | p75 tương tác thực; không suy từ Lighthouse                          |
| CLS                | ≤ 0,1                           | p75 trang thực, gồm luồng mua                                        |
| TTFB               | ≤ 800 ms                        | p75 từ người dùng tại Việt Nam                                       |
| API catalog/search | p95 ≤ 300 ms                    | Đo backend, tách cache hit/miss và vùng                              |
| API ghi nội bộ     | p95 ≤ 700 ms                    | Không gồm thời gian dịch vụ ngoài; checkout workflow đo riêng        |
| Checkout nội bộ    | p95 ≤ 2 giây                    | Chuẩn bị đơn/giữ hàng; provider đo riêng                             |
| Lỗi server         | \< 0,5% dưới tải nghiệm thu     | Loại lỗi validation hợp lệ; báo lỗi provider riêng                   |
| Availability       | Mục tiêu 99,9% mỗi tháng        | Hành trình storefront/cart/API đặt hàng; báo ảnh hưởng đối tác riêng |
| Khôi phục          | RPO ≤ 15 phút, RTO ≤ 2 giờ      | Phải chứng minh bằng phục hồi thử                                    |

Các ngưỡng Core Web Vitals lấy từ web.dev; những ngưỡng API, tải,
availability và recovery là mục tiêu nội bộ cần hiệu chỉnh theo hạ tầng
và ngân sách. \[S07\]

Trước ra mắt dùng lab cố định và interaction tests; sau ra mắt đánh giá
RUM khi đủ mẫu, theo cửa sổ 28 ngày. Thiếu mẫu phải ghi thiếu mẫu. Không
tuyên bố đạt Core Web Vitals từ một lần chạy Lighthouse.

Hồ sơ lab khởi điểm: production build; Chrome stable được khóa phiên
bản; viewport 390 × 844; CPU throttle 4×; mạng 1,6 Mbps xuống, 750 Kbps
lên, RTT 150 ms. Chạy 5 lần mỗi trang chủ, danh mục có bộ lọc và PDP
nhiều ảnh; báo từng lần, median và p75, tách cold/warm cache. Mục tiêu
lab LCP ≤ 2,5 giây và CLS ≤ 0,1 theo median, có điều tra outlier;
checkout có bài tương tác riêng trên Android tầm trung và iPhone Safari
thật. Lưu cấu hình máy chạy vì CPU throttle không đại diện cho mọi điện
thoại.

## 10.2 Ngân sách tài nguyên

Cho route storefront công khai ở tải đầu trên mobile, ngân sách khởi
điểm: JavaScript tải ban đầu không quá 200 KiB gzip, CSS không quá 50
KiB gzip, font không quá 100 KiB và toàn bộ tài nguyên cần cho màn hình
đầu không quá khoảng 900 KiB truyền tải. Đo cả HTML/RSC và prefetch thực
phát sinh; không loại tài nguyên chỉ vì nó được tải bằng cách khác.

Hero mobile mục tiêu dưới 200 KiB; ảnh card khoảng 40–90 KiB tại kích
thước hiển thị; ảnh PDP đầu khoảng 180 KiB. Đây là ngân sách để cân bằng
chất lượng ảnh; ảnh vải và màu phải qua kiểm tra trực quan, không nén
tới mức làm sai cảm nhận hàng.

Ảnh có srcset/sizes, width/height hoặc aspect-ratio, AVIF/WebP khi phù
hợp và fallback. Chỉ ưu tiên ảnh LCP; không lazy-load ảnh đầu cần nhìn
thấy. Ảnh dưới màn hình và gallery tiếp theo lazy-load. Resize theo tập
kích thước allowlist để tránh chi phí biến đổi không giới hạn.

Không tải thư viện carousel, animation, chat hoặc marketing nặng vào mọi
route. Thư viện zoom và đánh giá chỉ tải khi dùng. Hạn chế prefetch hàng
chục PDP trên mạng di động. Script không thiết yếu theo consent và ngân
sách.

## 10.3 Kịch bản tải

Bộ dữ liệu kiểm thử gồm 10.000 sản phẩm, 50.000 SKU, bộ lọc thực tế và
ảnh kích thước sản xuất. Bài tải khởi điểm: 100 request đọc/giây tới
origin và 10 thao tác giỏ/checkout/giây trong 30 phút; tăng gấp đôi
trong 2 phút. Đây là tải request, không quy đổi thành số người đồng thời
nếu chưa có hành vi truy cập.

Read mix cố định: 60% listing, 20% PDP, 20% search; write mix: 60% sửa
giỏ, 20% quote, 20% submit. Dùng mock provider có độ trễ xác định để đo
năng lực nội bộ, và test sandbox riêng cho protocol/timeout. Ngưỡng p95
ở bảng áp dụng steady load; burst cho phép latency tối đa gấp đôi trong
2 phút nhưng không mất dữ liệu, không vượt tồn và error rate vẫn dưới
0,5%.

Đo riêng warm cache, cold cache và thử từ mạng Việt Nam. Ghi cấu hình
CPU/RAM, pool kết nối, dataset, hit ratio và query plans. Mọi báo cáo
benchmark phải có điều kiện tái lập; không coi CDN cache là bằng chứng
database đáp ứng toàn bộ tải.

Stress test 50 lượt đặt đồng thời với một SKU chỉ còn một đơn vị: chỉ
một đơn được giữ hàng thành công, không có tồn âm, những lần còn lại
nhận lỗi có thể hiểu. Test bổ sung ở ranh giới hết hạn/thanh toán thành
công và worker crash.

Chỉ tăng hạ tầng khi có số liệu về latency, queue hoặc DB. Index, truy
vấn tránh N+1, connection pooling và cache đúng thường được xử lý trước
khi thêm microservice hay nhiều engine.

# 11 Bảo mật dữ liệu và khả năng tiếp cận

## 11.1 Bảo mật ứng dụng

Dùng OWASP ASVS làm danh mục kiểm tra có mapping tới tính năng và bằng
chứng; chọn các yêu cầu phù hợp mục tiêu tương đương Level 2 cho ứng
dụng có dữ liệu giao dịch. Đây là mục tiêu kiểm chứng, không phải chứng
nhận. \[S14\]

**SEC01 · P0.** Cookie phiên HttpOnly, Secure, SameSite phù hợp luồng
redirect; chống CSRF cho thao tác cookie-auth; CORS allowlist. Kiểm tra
quyền sở hữu trên từng cart/order/return, chống truy cập đối tượng của
người khác.

**SEC02 · P0.** Admin bắt buộc MFA và session expiry; secret dùng secret
manager hoặc cấu hình bảo mật có kiểm soát. Không đưa admin token vào
bundle, log, analytics hoặc ảnh chụp lỗi.

**SEC03 · P0.** Rate limit đăng nhập, OTP, search, coupon, checkout và
upload theo nhiều tín hiệu; tránh chặn cả mạng dùng chung chỉ vì một IP.
CAPTCHA chỉ tăng cường theo rủi ro, có đường tiếp cận thay thế.

**SEC04 · P0.** Kiểm tra kiểu/tầm dữ liệu, query tham số hóa, escape
output và sanitize rich text. URL ảnh/preview có allowlist chống SSRF.
Upload kiểm MIME, dung lượng, xử lý ảnh, loại metadata không cần và
không thực thi nội dung.

**SEC05 · P0.** TLS, security headers và Content Security Policy phù hợp
provider. Che PII trong log, tracing, error reporting; không gửi điện
thoại, email, địa chỉ hoặc token vào URL analytics.

**SEC06 · P0.** Dependency và secret scan; vá lỗ hổng nghiêm trọng có
khả năng ảnh hưởng thực tế. Có quy trình đổi khóa, chặn tính năng lỗi và
phục hồi sự cố.

## 11.2 Dữ liệu cá nhân và vận hành pháp lý

Tách consent marketing khỏi giao dịch; không tick sẵn. Theo dõi mục đích
xử lý, bên xử lý, nơi lưu, thời hạn và cơ chế yêu cầu dữ liệu. Xóa tài
khoản không đồng nghĩa xóa mọi chứng từ cần lưu; áp dụng retention theo
từng nhóm dữ liệu và nghĩa vụ đã được rà soát.

Trước ra mắt, chủ vận hành hoặc người phụ trách pháp lý rà soát loại
hình shop trực tiếp, thủ tục thông báo/đăng ký phù hợp, công khai thông
tin đơn vị bán, giá/phí, chính sách giao hàng, đổi trả, khiếu nại và dữ
liệu cá nhân. Chỉ hiển thị biểu tượng xác nhận khi có xác nhận hợp lệ.

Mốc pháp lý đã kiểm tra: Luật Thương mại điện tử 122/2025/QH15 và Nghị
định 248/2026/NĐ-CP hiệu lực 01/07/2026; Luật Bảo vệ dữ liệu cá nhân
91/2025/QH15 và Nghị định 356/2025/NĐ-CP hiệu lực 01/01/2026. Tài liệu
này không thay thế việc áp dụng chi tiết văn bản cho pháp nhân, đối tác
và luồng dữ liệu cụ thể. \[S21–S24\]

## 11.3 Tiếp cận

**A11Y01 · P0.** Điều hướng đầy đủ bằng bàn phím; focus thấy được và
không bị sticky header/CTA che. Không có thao tác chỉ dùng hover hoặc
kéo thả.

**A11Y02 · P0.** Heading có cấu trúc, landmark, nhãn form và thông báo
lỗi có ngữ cảnh. Swatch có tên màu, trạng thái size có text, ảnh có alt
phù hợp. Thông báo thêm giỏ cập nhật cho trình đọc màn hình mà không
giật focus.

**A11Y03 · P0.** Tương phản theo WCAG 2.2 AA, hỗ trợ zoom/reflow,
reduced motion và trạng thái tương phản cao khi nền tảng yêu cầu. Kiểm
thử thủ công VoiceOver hoặc NVDA trên luồng mua; scan tự động không đủ
để kết luận tuân thủ đầy đủ. \[S08\]

# 12 SEO nội dung và PWA

## 12.1 SEO cho sản phẩm và bộ lọc

Trang danh mục, sản phẩm và bài nội dung phải có HTML hữu ích ngay từ
server, title/description riêng, canonical đúng, sitemap và liên kết nội
bộ. Không để nội dung chính chỉ xuất hiện sau JavaScript phía khách.

Biến thể có URL truy cập trực tiếp như
/san-pham/ao-so-mi?color=den&size=m, mở đúng lựa chọn, ảnh và giá. Dùng
ProductGroup/Product, variesBy, hasVariant và Offer tương ứng dữ liệu
thật. Với mô hình một PDP chọn biến thể, chốt canonical về trang sản
phẩm gốc theo thiết kế; nếu mở landing riêng theo màu thì làm ADR về
canonical và nội dung khác biệt. \[S13\]

Không tự index mọi tổ hợp size × màu × giá. Tạo một số landing danh mục
có nhu cầu và nội dung riêng; URL tìm kiếm và bộ lọc tùy ý có chính sách
crawl/index rõ. Không dùng robots disallow rồi kỳ vọng bot đọc noindex
trên chính URL bị chặn. Chuẩn hóa thứ tự tham số, không sinh bộ lọc
trùng và xử lý URL vô nghĩa đúng HTTP. \[S20\]

Giá/tồn trong structured data phải khớp UI; không đưa rating giả. Hết
hàng tạm thời giữ trang và mô tả availability; ngừng bán vĩnh viễn áp
dụng 404/410 hoặc redirect có sản phẩm thay thế phù hợp, không đẩy mọi
trang về trang chủ.

Nội dung SEO P1 gồm hướng dẫn chọn size, chất liệu, bảo quản và phối đồ
từ hiểu biết thực của shop. AI có thể hỗ trợ bản nháp có người duyệt;
không xuất bản hàng loạt trang mỏng hoặc khẳng định sản phẩm không có
chứng cứ.

## 12.2 PWA

P0 gồm manifest, icon, HTTPS, responsive và trang fallback mất mạng.
Service worker chỉ cache asset và trang công khai đã cho phép; không
cache API/HTML đơn hàng, checkout, thông tin cá nhân hoặc admin.

Khi offline, khách có thể xem nội dung công khai đã lưu với nhãn dữ liệu
cũ. Không cho xác nhận giá/tồn, tạo đơn hoặc tự phát lại payment request
khi mạng trở lại. Mọi thao tác thay đổi giỏ cần được xác nhận lại với
server khi kết nối phục hồi.

Cập nhật service worker có version và quy trình dọn cache. Không cưỡng
ép reload khi khách đang thanh toán. P1 có lời mời cài sau khi người
dùng thể hiện quan tâm; push chỉ khi nền tảng hỗ trợ và người dùng đồng
ý. Hành vi cài và notification khác nhau theo trình duyệt, cần kiểm thử
trên thiết bị thật. \[S25\]

# 13 Quan sát hệ thống và vận hành

## 13.1 Chỉ số sản phẩm

Theo dõi view_item_list, select_item, view_item, select_variant,
view_size_guide, add_to_cart, begin_checkout, add_shipping_info,
add_payment_info, order_placed, payment_captured, purchase và refund.
Schema sự kiện có version, currency, value và item IDs, không có PII.

Order_placed và payment_captured là sự kiện vận hành riêng. Định nghĩa
purchase nhất quán theo chính sách báo cáo, deduplicate bằng order_id;
nếu gửi cả browser và server thì chỉ được tính một lần. COD phải được
báo riêng về đã đặt, đã giao và đã thu tiền.

RUM theo route, thiết bị và chất lượng mạng; tỷ lệ lỗi checkout, stale
price, stock conflict, payment pending và return do size phải có
dashboard. Không đặt mục tiêu doanh thu theo phỏng đoán; dùng dữ liệu
baseline.

## 13.2 Sự cố và phục hồi

Log có correlation ID, metric và trace đã che dữ liệu. Cảnh báo webhook
không xử lý, queue quá hạn, payment unknown, đối soát lệch và lỗi
checkout tăng. Ngưỡng khởi điểm: đã nhận dấu hiệu thanh toán nhưng chưa
xử lý xong trên 5 phút, hoặc task quan trọng chờ trên 60 giây cần được
quan sát và hiệu chỉnh theo protocol; không báo lỗi chỉ vì khách còn
đang ở trang thanh toán trong TTL hợp lệ.

Runbook phải có payment provider lỗi, courier lỗi, Redis/worker lỗi,
database outage, triển khai lỗi và ảnh lỗi. Nếu mất cơ chế khóa an toàn,
tạm dừng thao tác checkout cần giữ tồn, vẫn cho xem catalog; không tiếp
tục bán bằng tồn cache.

Có bản sao lưu và point-in-time recovery, mã hóa, lịch retention, kiểm
tra restore trước ra mắt. Restore database phải đi kèm đối chiếu
payment/courier sau thời điểm snapshot vì giao dịch ngoài hệ thống có
thể đã diễn ra.

Restore PostgreSQL không tự khôi phục mọi workflow đang chạy trong
Redis. Diễn tập mất Redis phải chứng minh có thể resume hoặc tạo lại
công việc từ bản ghi nghiệp vụ bền vững, deduplicate tác động ngoài và
phát hiện phần cần xử lý thủ công.

## 13.3 Triển khai

Tách development, staging và production, secret và provider môi trường
tương ứng. Preview không dùng dữ liệu khách thật; dữ liệu thử phải ẩn
danh hoặc tổng hợp.

CI gồm lint, typecheck, test domain, integration bằng PostgreSQL/Redis
thật trong môi trường thử, contract test provider, E2E luồng trọng yếu,
security/dependency scan và budget check. Migration theo
expand/contract, backup trước thay đổi rủi ro, rollback ứng dụng không
giả định rollback database phá hủy được.

Ra mắt theo feature flag hoặc nhóm thử, quan sát rồi mở rộng. Nếu
rollback vì lỗi thanh toán, vẫn nhận và lưu notification cần thiết, đối
soát giao dịch đang dở; không làm mất tiền chỉ vì frontend về phiên bản
cũ.

# 14 Kế hoạch thực thi và phân công

## 14.1 Nguyên tắc làm việc

Thực hiện theo vòng lặp: xây tính năng nhỏ, kiểm tra tự động liên tục,
audit tổng thể, sửa, tối ưu, nghiệm thu và phát hành. Không dồn toàn bộ
kiểm thử tiền/tồn tới cuối; audit cuối dùng để tìm thiếu sót xuyên
luồng.

Mỗi task có mã yêu cầu, phạm vi file/module, dependency, tiêu chí nhận,
dữ liệu kiểm thử và rủi ro. Người hoặc AI triển khai không tự xác nhận
hoàn tất nếu thiếu bằng chứng. Reviewer độc lập ưu tiên checkout, tồn,
tiền, quyền và dữ liệu.

| **Vai trò**      | **Trách nhiệm**                                       |
|------------------|-------------------------------------------------------|
| Lead và planner  | Chốt ADR, dependency, chia việc, quyết định phạm vi   |
| UX và frontend   | Design system, responsive, accessibility, storefront  |
| Commerce backend | Data, workflow đơn/tồn/tiền, quyền và Admin           |
| Tích hợp         | Payment, courier, notification, reconciliation        |
| QA và reviewer   | Acceptance, failure injection, bảo mật và hồi quy     |
| DevOps           | CI/CD, observability, backup, tải và runbook          |
| Chủ shop         | Ảnh, dữ liệu hàng, chính sách, hợp đồng, UAT vận hành |

Có thể một người kiêm nhiều vai trò, nhưng đường thay đổi tiền/tồn cần
lượt review độc lập. Không chia nhiều agent cùng chỉnh core schema hoặc
checkout khi hợp đồng chưa chốt.

## 14.2 Lộ trình cơ sở

| **Giai đoạn**            | **Đầu ra**                                           | **Điều kiện chuyển bước**                               |
|--------------------------|------------------------------------------------------|---------------------------------------------------------|
| 0 Khảo sát và foundation | ADR, schema, prototype, provider sandbox, bộ dữ liệu | Chứng minh pending order và reservation không giữ trùng |
| 1 Thiết kế và catalog    | Tokens, màn chính, sản phẩm/SKU, import, search      | Truy cập mobile tốt, chọn đúng biến thể                 |
| 2 Giỏ và giao dịch       | Checkout, giữ tồn, online/COD, callback, retry       | Payment/tồn đúng khi cạnh tranh, timeout, callback lặp  |
| 3 Vận hành               | Vận đơn, đổi trả, refund, RBAC, đối soát             | Một đơn đi trọn quy trình và hoàn một phần được         |
| 4 Hoàn thiện             | SEO, PWA, hiệu năng, a11y, security, runbook         | Đạt các tiêu chí P0 và restore thành công               |
| 5 UAT và ra mắt          | Dữ liệu thật, giao dịch thử, chính sách, triển khai  | Chủ shop nghiệm thu vận hành và không còn lỗi chặn      |
| 6 P1                     | Wishlist, review, tài khoản, phối đồ, tự động hóa    | Có dữ liệu để chọn thứ tự ưu tiên                       |

Ước lượng lập kế hoạch cho P0 là khoảng 8–12 tuần với 2–3 kỹ sư có kinh
nghiệm, UX và QA tham gia, ảnh/sản phẩm được chuẩn bị song song. Đây là
khoảng dự kiến, không phải báo giá hoặc cam kết. Chốt lại sau giai đoạn
0; onboarding merchant, chất lượng dữ liệu và workflow tùy chỉnh có thể
kéo dài đường găng.

Gợi ý phân bổ: foundation 1 tuần; thiết kế và catalog 2 tuần; checkout
và payment 2–3 tuần; vận hành 1–2 tuần; kiểm thử, tối ưu, UAT và ra mắt
2–4 tuần. Các luồng độc lập có thể chạy song song, không cộng cơ học
toàn bộ thời gian.

## 14.3 Backlog phát triển

| **Gói** | **Công việc**                    | **Phụ thuộc**   | **Bằng chứng hoàn tất**                   |
|---------|----------------------------------|-----------------|-------------------------------------------|
| T01     | Repo, CI, môi trường, ADR        | Không           | Build và deploy staging tái lập           |
| T02     | Prototype và tokens              | T01             | 6 màn chính mobile/desktop có states      |
| T03     | Catalog, SKU, size chart, import | T01             | Dataset và import lỗi/rollback có báo cáo |
| T04     | Storefront, search, filter       | T02, T03        | Tìm/lọc cùng SKU và URL state đúng        |
| T05     | Cart và quote                    | T03             | Server total, cart version, expiry        |
| T06     | Pending order và reservation     | T05             | Cạnh tranh tồn, crash, expiry qua test    |
| T07     | Payment adapter và ledger        | T06             | Chữ ký, timeout, late payment, refund     |
| T08     | COD và courier                   | T06             | Địa chỉ mới, phí, vận đơn không trùng     |
| T09     | Return, exchange, settlement     | T07, T08        | Trả một phần và COD lệch xử lý được       |
| T10     | RBAC, audit, dữ liệu cá nhân     | T01; xuyên suốt | Ma trận quyền và test phủ endpoint        |
| T11     | SEO, PWA và telemetry            | T04             | Crawl, schema, offline và analytics đúng  |
| T12     | Tải, a11y, restore, UAT          | T07–T11         | Báo cáo và checklist ra mắt               |

Những hạng mục chưa đủ điều kiện phải ghi nợ với owner, tác động, giải
pháp tạm, điều kiện mở lại và hạn xử lý. Hạng mục P0 không được đóng
bằng ghi nợ; phải sửa hoặc thay đổi phạm vi ra mắt một cách minh bạch.

# 15 Ma trận nghiệm thu

## 15.1 Nghiệp vụ và khả năng phục hồi

| **Mã** | **Tình huống**                                  | **Kết quả bắt buộc**                                  |
|--------|-------------------------------------------------|-------------------------------------------------------|
| AT01   | Lọc đen-M khi chỉ có đen-S và trắng-M           | Không trả kết quả sai biến thể                        |
| AT02   | Đổi màu không có size cũ                        | Xóa chọn size, giải thích, yêu cầu chọn lại           |
| AT03   | Giá hoặc phí đổi trong checkout                 | Tính lại và yêu cầu xác nhận, không thu thêm ngầm     |
| AT04   | 50 checkout cạnh tranh món cuối                 | Một reservation thành công, tồn không âm              |
| AT05   | Double click, retry, hai tab                    | Một order cho checkout hợp lệ; response nhất quán     |
| AT06   | Callback thanh toán lặp 20 lần                  | Một bút toán, không thêm đơn/email/refund trùng       |
| AT07   | Chữ ký sai hoặc số tiền sai                     | Không ghi nhận paid; có cảnh báo và audit             |
| AT08   | Redirect thành công trước IPN                   | Chờ xác nhận; không xuất kho từ URL browser           |
| AT09   | Callback paid sau khi đơn hủy                   | Ghi nhận tiền và ngoại lệ hoàn; không tự giao         |
| AT10   | Worker chết sau giữ quota hoặc giữ một phần tồn | Phục hồi/bù trừ, không kẹt tồn hoặc quota vô thời hạn |
| AT11   | Payment/courier timeout                         | Tra cứu lại cùng reference, không tạo giao dịch trùng |
| AT12   | Expiry đồng thời callback paid                  | Một kết quả hợp lệ theo khóa, ledger không mất tiền   |
| AT13   | Đơn online đã trả đủ                            | COD bằng 0, khách không bị thu phí hai lần            |
| AT14   | Courier delivered nhưng chưa chuyển tiền        | Chưa settled; có số phải thu                          |
| AT15   | Trả một trong hai sản phẩm                      | Hoàn đúng phần thực trả, phần còn lại giữ nguyên      |
| AT16   | Refund retry/timeout                            | Không vượt captured, không hoàn trùng                 |
| AT17   | Nhận hàng trả qua workflow/API thực tế          | Chưa kiểm định thì không tăng tồn bán                 |
| AT18   | Email/SMS gửi lỗi                               | Đơn còn nguyên, retry thông báo được                  |

## 15.2 Giao diện bảo mật và vận hành

| **Mã** | **Tình huống**                                 | **Kết quả bắt buộc**                                             |
|--------|------------------------------------------------|------------------------------------------------------------------|
| AT19   | Guest checkout với email đã có tài khoản       | Vẫn mua được, không lộ tài khoản hoặc đơn cũ                     |
| AT20   | Dò ID đơn của khách khác                       | Không trả PII, rate limit và log phù hợp                         |
| AT21   | Kho gọi API hoàn tiền trực tiếp                | Bị chặn ở backend                                                |
| AT22   | Cache/CDN/service worker giữa hai khách        | Không chia sẻ giỏ, giá riêng, đơn hoặc PII                       |
| AT23   | Địa chỉ hai cấp và địa chỉ cũ                  | Validate/ánh xạ rõ, tạo vận đơn sandbox được                     |
| AT24   | Mất mạng hoặc trở lại từ provider              | Không báo paid giả, không tự replay thanh toán                   |
| AT25   | Keyboard, screen reader, zoom, mobile keyboard | Hoàn tất nhiệm vụ, focus/CTA không bị che                        |
| AT26   | URL lọc/variant, schema và sitemap             | Lựa chọn đúng, canonical và nội dung nhất quán                   |
| AT27   | Tải theo hồ sơ ở mục 10                        | Đạt latency/error budget đã thống nhất, có báo cáo               |
| AT28   | Restore backup và rollback ứng dụng            | Đạt RPO/RTO, đối soát giao dịch đang dở                          |
| AT29   | Tracking browser và server                     | Không nhân đôi purchase; không chứa PII                          |
| AT30   | Dữ liệu/catalog/chính sách production          | Không placeholder, link hỏng hoặc claim giả                      |
| AT31   | Lọc đen-M dưới giá của SKU đen-M               | Không lấy giá SKU khác để trả kết quả                            |
| AT32   | Sửa filter nháp rồi hủy, Back và reload        | Giữ đúng bộ lọc đã áp dụng                                       |
| AT33   | Cạnh tranh hạn mức coupon cuối                 | Không vượt quota; hủy đơn nhả quota đúng quy tắc                 |
| AT34   | Native event trước finalization                | Không tạo vận đơn hoặc gửi xác nhận sai                          |
| AT35   | Native payment handler nhận notification       | Giữ cùng order_id, không tự hoàn tất giỏ/tạo reservation lần hai |
| AT36   | Hai payment attempt thật cùng thành công       | Ghi đủ tiền, một đơn/một fulfillment, xử lý phần thu dư          |

Tổ chức một vòng thử với 5–8 người mua phù hợp, trên điện thoại tầm
trung và desktop, cho các nhiệm vụ tìm hàng, chọn size, mua guest, sửa
lỗi tồn và yêu cầu đổi trả. Đây là vòng tìm vấn đề sử dụng, không phải
mẫu thống kê chứng minh tăng doanh thu.

Điều kiện phát hành: các yêu cầu P0 có bằng chứng; không có lỗi nghiêm
trọng làm sai tiền, tồn, quyền truy cập hoặc chặn mua; provider đã kiểm
chứng; chính sách và dữ liệu thật được duyệt; người vận hành thực hiện
được một đơn và một lần hoàn/đối soát; có cảnh báo, backup và runbook
hoạt động.

# 16 Phạm vi sau ra mắt và quyết định cần cấu hình

## 16.1 P1

Tài khoản tùy chọn, Google login, wishlist đồng bộ, review mua thật,
back-in-stock theo SKU, phối đồ mua theo bộ, email khôi phục giỏ có đồng
ý phù hợp, báo cáo size/return, nhà thanh toán hoặc courier thứ hai và
đồng bộ kế toán sâu hơn.

Ưu tiên dựa trên dữ liệu: nhiều khách bỏ vì size thì cải thiện thông tin
vừa vặn; nhiều lỗi giao dịch thì xử lý payment trước loyalty; nhiều giờ
thao tác kho thì tự động hóa pick/pack trước thử đồ ảo.

## 16.2 P2

AI stylist, tìm bằng ảnh, thử đồ ảo, đa kho phân bổ tối ưu, đồng bộ
POS/sàn, đa quốc gia và app native chỉ triển khai khi đã xác định đầu
vào, lợi ích và chi phí vận hành. AI không được tự tạo thông tin chất
liệu, cam kết tồn, giá hoặc chính sách.

## 16.3 Quyết định kinh doanh trước production

| **Quyết định**                | **Mặc định thiết kế**                             | **Người phụ trách**                  |
|-------------------------------|---------------------------------------------------|--------------------------------------|
| Tên và nhận diện shop         | Token và nội dung thay được                       | Chủ shop và UX                       |
| Danh mục thật                 | Cấu hình từ catalog                               | Chủ shop                             |
| Cổng thanh toán/hãng giao vận | Một online + COD; một courier                     | Chủ shop và tích hợp                 |
| Đổi trả                       | Cấu hình theo loại hàng, điều kiện và thời gian   | Chủ shop và người rà soát chính sách |
| Thuế/hóa đơn                  | Theo pháp nhân/hộ kinh doanh và quy trình kế toán | Kế toán                              |
| Email/SMS bắt buộc            | Theo kênh transactional đã chọn                   | Vận hành                             |
| TTL giữ hàng và COD xác nhận  | Khác nhau, phù hợp provider                       | Backend và vận hành                  |
| Phí ship/ngưỡng miễn phí      | Quy tắc có version                                | Chủ shop                             |
| Hạ tầng và ngân sách          | Chọn sau benchmark foundation                     | Lead và vận hành                     |
| Dữ liệu và retention          | Theo nhóm dữ liệu/nghĩa vụ                        | Chủ shop và người phụ trách dữ liệu  |

Chi phí cần tính gồm storefront hosting, Medusa server/worker,
PostgreSQL có backup, Redis, ảnh/CDN, email/SMS, giám sát và phí giao
dịch/đối tác. Không có báo giá cố định trong đặc tả khi chưa chốt lưu
lượng, ảnh, vùng đặt máy và hợp đồng. Giai đoạn foundation phải lập bảng
chi phí theo tải thường và tải chiến dịch, với cảnh báo ngân sách.

# 17 Nguồn tham khảo

Các nguồn được kiểm tra ngày 24/10/2026. Nguồn kỹ thuật là tài liệu
chính thức; nghiên cứu UX là nguồn nghiên cứu gốc. Chỉ dùng quan sát
thương hiệu làm tham khảo nội dung. Yêu cầu chi tiết của dự án cần được
kiểm chứng lại bằng prototype, sandbox và nghiệm thu.

\[S01\] Baymard Institute. Always Use Buttons for Size Selection. [<u>Mở
tài
liệu</u>](https://baymard.com/research-articles/use-buttons-for-size-selection)

\[S02\] Baymard Institute. Apparel 10 Best Practices on Sizing. [<u>Mở
tài
liệu</u>](https://baymard.com/research-articles/apparel-size-information)

\[S03\] Baymard Institute. Make Guest Checkout Prominent. [<u>Mở tài
liệu</u>](https://baymard.com/research-articles/make-guest-checkout-prominent)

\[S04\] Baymard Institute. Display Applied Filters in an Overview.
[<u>Mở tài
liệu</u>](https://baymard.com/research-articles/how-to-design-applied-filters)

\[S05\] UNIQLO Việt Nam. Length Guide by Height. [<u>Mở tài
liệu</u>](https://www.uniqlo.com/vn/en/special-feature/measurement)

\[S06\] COS. New Arrivals. [<u>Mở tài
liệu</u>](https://www.cos.com/en-ww/women/new-arrivals)

\[S07\] web.dev. Web Vitals. [<u>Mở tài
liệu</u>](https://web.dev/articles/vitals)

\[S08\] W3C. Web Content Accessibility Guidelines 2.2. [<u>Mở tài
liệu</u>](https://www.w3.org/TR/WCAG22/)

\[S09\] Medusa. Storefront Development. [<u>Mở tài
liệu</u>](https://docs.medusajs.com/learn/storefront-development)

\[S10\] Medusa. General Application Deployment Guide. [<u>Mở tài
liệu</u>](https://docs.medusajs.com/learn/deployment/general)

\[S11\] Medusa. Reservations Lifecycle. [<u>Mở tài
liệu</u>](https://docs.medusajs.com/resources/commerce-modules/inventory/reservations-lifecycle)

\[S12\] Next.js. Production Checklist. [<u>Mở tài
liệu</u>](https://nextjs.org/docs/app/guides/production-checklist)

\[S13\] Google Search Central. Product Variant Structured Data. [<u>Mở
tài
liệu</u>](https://developers.google.com/search/docs/appearance/structured-data/product-variants)

\[S14\] OWASP. Application Security Verification Standard. [<u>Mở tài
liệu</u>](https://asvs.owasp.org/)

\[S15\] MoMo. Payment Notification. [<u>Mở tài
liệu</u>](https://developers.momo.vn/v3/docs/payment/api/result-handling/notification/)

\[S16\] VNPAY. Tài liệu thanh toán PAY. [<u>Mở tài
liệu</u>](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html)

\[S17\] GHN. Lấy phường xã mới. [<u>Mở tài
liệu</u>](https://developer.ghn.vn/vi/docs/master-data/get-ward-new)

\[S18\] GHN. Tạo đơn. [<u>Mở tài
liệu</u>](https://developer.ghn.vn/vi/docs/order/create)

\[S19\] GHN. Order Status Callback. [<u>Mở tài
liệu</u>](https://developer.ghn.vn/en/docs/webhook/callback-order-status)

\[S20\] Google. Managing Crawling of Faceted Navigation URLs. [<u>Mở tài
liệu</u>](https://developers.google.com/crawling/docs/faceted-navigation)

\[S21\] Cổng văn bản Chính phủ. Luật 122/2025/QH15. [<u>Mở tài
liệu</u>](https://vanban.chinhphu.vn/?classid=1&docid=216503&orggroupid=1&pageid=27160)

\[S22\] Cổng văn bản Chính phủ. Nghị định 248/2026/NĐ-CP. [<u>Mở tài
liệu</u>](https://vanban.chinhphu.vn/?docid=218747&pageid=27160)

\[S23\] Cổng văn bản Chính phủ. Luật 91/2025/QH15. [<u>Mở tài
liệu</u>](https://chinhphu.vn/?classid=1&docid=214590&pageid=27160&typegroupid=3)

\[S24\] Cổng văn bản Chính phủ. Nghị định 356/2025/NĐ-CP. [<u>Mở tài
liệu</u>](https://vanban.chinhphu.vn/?docid=216387&pageid=27160)

\[S25\] Next.js. Progressive Web Applications. [<u>Mở tài
liệu</u>](https://nextjs.org/docs/app/guides/progressive-web-apps)

\[S26\] Shopify. Create and Update a Cart with the Storefront API.
[<u>Mở tài
liệu</u>](https://shopify.dev/docs/storefronts/headless/building-with-the-storefront-api/cart/manage)

\[S27\] Medusa. Payment Webhook Events. [<u>Mở tài
liệu</u>](https://docs.medusajs.com/resources/commerce-modules/payment/webhook-events)
