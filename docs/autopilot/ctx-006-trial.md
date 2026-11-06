# Thử nghiệm LOOP-CTX-006 — agent mới chỉ với AGENTS.md + PROGRESS.md (T-223)

- **Ngày:** 2026-10-31
- **Cách làm:** một agent mới, không có ngữ cảnh phiên, nhận đúng một tin "tiếp tục". Agent chỉ được đọc `AGENTS.md` và
  `PROGRESS.md` (vừa viết lại theo mẫu 4 mục, 3 KB); không đọc file khác, không chạy lệnh. Agent phải trả lời 4 câu:
  làm task nào, Gate là gì, việc nào không được tự làm, PROGRESS thiếu gì.
- **Đáp án đúng do phiên chính đặt trước:** nối `T-220` (đang làm). `T-236` bị chặn, chờ CI. `T-221` làm sau `T-220`. PII,
  bigint và `T-060` làm sau khi PR #20 merge. Các task chờ người không tự làm.

## Kết quả

**Đạt.** Agent chọn đúng `T-220` vì nó ở mục Đang làm (đúng AGENTS.md §3: nối Đang làm, không hỏi lại). Agent nhận ra
`T-236` bị chặn và xếp `T-221` ngay sau.

Agent liệt kê đủ các việc không được tự làm:
- merge PR #20;
- dismiss CodeQL;
- sửa `xt.yaml`, `.claude/`, hook (D-052);
- các task chờ người;
- PII, phải để PR riêng sau khi PR #20 merge;
- khoá thật và hạ tầng;
- force-push, ghi tay `.autopilot/`, hạ ngưỡng;
- ghi tên model hay URL phiên.

**Chỗ thiếu agent chỉ ra, đã sửa trong PROGRESS.md cùng commit:**
- `T-220` chưa có Gate riêng → đã ghi Gate.
- Chưa rõ executor ở worktree nào và cách xử lý khi phiên mới không thấy executor → đã ghi cách kiểm
  (`git worktree list` và log nhánh worktree).
- Gate `T-236` chỉ là văn xuôi → đã ghi lệnh cụ thể.
- Thứ tự `T-221` giữa mục Đang làm và Tiếp theo lệch nhau → đã thống nhất là "sau T-220".
- Chưa rõ các task chờ người đang chờ gì → đã ghi từng điều kiện, kèm lệnh `xt.py loop status`.

**Chỗ thiếu giữ nguyên:** SHA master và thời lượng gate có thể đã cũ khi phiên sau đọc. Đây là tính chất của bản chụp; phiên
sau kiểm bằng `progress-check` và `git log`.
