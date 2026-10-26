---
name: Task (việc cần làm)
about: Một việc nhỏ, đo được, gói trong một PR; chỉ gán nhãn `ready` khi checklist DoR đủ
title: "task: "
labels: needs-triage
---

## Mục tiêu

<!-- Vì sao làm; link đặc tả/blueprint/ADR liên quan. -->

## Tiêu chí chấp nhận (đo được)

<!-- Mỗi dòng một tiêu chí kiểm bằng lệnh/test cụ thể, gồm ca biên. -->

-

## Definition of Ready

<!-- WF-TEAM-003: chưa tick đủ thì chưa `ready` — hỏi, không code. -->

- [ ] Tiêu chí chấp nhận đo được (có lệnh/test kiểm)
- [ ] Không còn câu hỏi mở quan trọng
- [ ] Phụ thuộc đã xác định (task/issue/dịch vụ phải xong trước)
- [ ] Thiết kế/luồng đủ rõ (UI: có wireframe hoặc ảnh tham chiếu)
- [ ] Phạm vi gói trong một PR
- [ ] Gate (lệnh kiểm xong việc) đã ghi
