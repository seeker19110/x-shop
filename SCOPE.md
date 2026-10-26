# SCOPE.md — kiểm soát thay đổi phạm vi

Phạm vi MVP là `PROJECT.md` §3 (F-001…F-012 = Must; F-101 = Should/P1) và danh sách "Không làm (lúc này)". Phạm vi đóng băng từ commit đặc tả đầu (`9f7f8b2`, 2026-10-24, G0–G4). Mọi thay đổi sau đó đi qua file này.

## Điều kiện xét một thay đổi

Một thay đổi (thêm, bớt, đổi mức Must/Should) chỉ được xét khi thỏa cả bốn:

1. Có lý do là bằng chứng (lỗi pháp lý/an toàn, số đo, quyết định của chủ dự án), không phải ý thích.
2. Nêu rõ mục bị đẩy ra (hoặc thêm thời gian có ngày) để bù; không thêm mà không bớt.
3. Chủ dự án quyết với việc ảnh hưởng tiền thật, hợp đồng VNPAY/GHN, chính sách đổi trả/thuế, dữ liệu thật. Còn lại phiên chính quyết và ghi `D-NNN` (AGENTS.md §5).
4. Mức ảnh hưởng tới `PLAN` và blueprint MUST đã ghi trong dòng sổ.

## Quy trình

- Sửa `PROJECT.md` §3 bằng một commit riêng có message `docs(scope): <mục bị đổi>`.
- Thêm một dòng vào sổ dưới đây trong cùng commit.
- Đồng bộ `docs/autopilot/PLAN*.md` ở commit kế tiếp (nếu thêm/bớt task).

## Sổ thay đổi phạm vi

| Ngày       | Người quyết | Thay đổi                                                         | Mục bị đẩy ra / bù                                | Tham chiếu                          |
| ---------- | ----------- | ---------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------- |
| 2026-10-24 | Phiên chính | Đóng băng phạm vi MVP gốc (F-001…F-012 Must, F-101 Should)        | Không có (mốc khởi đầu)                           | `9f7f8b2`, D-006             |
| 2026-10-26 | —           | Chưa có thay đổi phạm vi nào sau đóng băng                        | —                                                 | `git log -- PROJECT.md`: mục §3 chỉ đổi ở `9f7f8b2` |

Lưu ý: `PROJECT.md` §3 chỉ được sửa ở `9f7f8b2` (xem `git log -L` mục §3 ngày 2026-10-26); nếu thấy thay đổi phạm vi không có dòng ở bảng này, đó là vi phạm quy trình và phải bổ sung dòng kèm lý do.
