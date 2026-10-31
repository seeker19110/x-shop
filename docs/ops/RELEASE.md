# Quy trình phát hành (SemVer)

Nguồn phiên bản duy nhất: trường `version` của `package.json` gốc, khớp `.release-please-manifest.json`; `apps/*` và `packages/domain` được đồng bộ tự động qua `extra-files` trong `release-please-config.json`. Không sửa tay số phiên bản trong PR tính năng (`WF-REL-001`).

## Luồng

1. Commit conventional (`feat`, `fix`, `feat!`…) vào `master`.
2. Workflow `.github/workflows/release.yml` (release-please) mở/cập nhật **Release PR**: tăng phiên bản theo SemVer 2.0.0 + cập nhật `CHANGELOG.md`.
3. Người merge Release PR (qua cổng CI bình thường) → release-please tạo tag `vX.Y.Z` và GitHub Release; job `assets` đính `x-shop-vX.Y.Z.tar.gz` và `SHA256SUMS`.
4. Kiểm: `git tag -l 'v*'`; `gh release view vX.Y.Z` có asset + `SHA256SUMS`; `sha256sum -c SHA256SUMS`.

Tag do release-please tạo qua API là tag nhẹ (lightweight). `BASE-REPO-006` yêu cầu annotated tag: nếu giữ yêu cầu này, người phát hành tạo/chuyển tag bằng `git tag -a` thủ công (xem câu hỏi mở của T-112).

## Việc của người (H-02) — chưa làm

Bật **ruleset tag** cho mẫu `refs/tags/v*`: cấm xoá, cấm cập nhật (dời tag), cấm force-push; chỉ cho phép tạo. GitHub: Settings → Rules → Rulesets → New tag ruleset. Phải bật **trước** lần phát hành đầu để tag đã công bố bất biến (`WF-REL-003`). Task T-112 không tạo tag và không chạy release.
