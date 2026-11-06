# Image triển khai của x-shop (T-191; BASE-DEP-009, BASE-SEC-010, WF-ENV-006, OPS-DEPLOY-001). Container chỉ là ĐỊNH DẠNG
# ARTEFACT: lệnh chạy, biến môi trường, thứ tự migrate → server/worker → storefront vẫn theo docs/ops/RUNBOOK.md §8.2 và
# docs/ops/ENV.md. Không chọn hạ tầng production ở đây.
#
# Target:
#   backend    — Medusa (`.medusa/server`). CÙNG image cho server và worker, khác biến MEDUSA_WORKER_MODE=server|worker;
#                migrate = cùng image, lệnh `db:migrate` (ENTRYPOINT là CLI medusa). Mặc định lệnh `start`.
#   storefront — Next.js `next start` (next.config.ts CHƯA có `output: "standalone"` — xem ghi chú ở stage storefront).
#
# Build:  docker build --target backend    -t x-shop-backend:<sha> .
#         docker build --target storefront -t x-shop-storefront:<sha>-<môi-trường> \
#           --build-arg NEXT_PUBLIC_SITE_URL=https://shop.example.vn --build-arg NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=pk_… \
#           --build-arg XS_MEDIA_URL=https://media.shop.example.vn …   (SITE_URL + PUBLISHABLE_KEY bắt buộc)
#
# Base image: node 22.22.0 (đúng .nvmrc) bản Debian bookworm-slim, ghim digest MANIFEST LIST (đa kiến trúc). Digest lấy
# 2026-10-30 từ https://hub.docker.com/v2/repositories/library/node/tags?name=22.22 (tag 22.22.0-bookworm-slim, cập nhật
# 2026-02-24); `docker pull …@sha256:dd9d…` khớp cùng digest. Nâng: đổi .nvmrc + tag + digest trong CÙNG commit.
# Không có bí mật trong image: không ARG/ENV bí mật; bí mật chỉ vào lúc chạy (env_file / kho bí mật của nền tảng).

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS node-base
# Tắt telemetry của công cụ ở mọi stage (PM-RISK-006, docs/ops/ENV.md §Telemetry).
ENV MEDUSA_DISABLE_TELEMETRY=true \
    NEXT_TELEMETRY_DISABLED=1

# ---------------------------------------------------------------------------------------------------------------------
# Công cụ build: pnpm đúng `packageManager` của package.json qua corepack (kèm Node; corepack kiểm chữ ký gói từ npm).
FROM node-base AS pnpm
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
WORKDIR /app
COPY package.json ./
RUN corepack enable && pnpm --version

# Khai báo workspace: chỉ manifest + lockfile → lớp cài phụ thuộc chỉ build lại khi lockfile/manifest đổi.
FROM pnpm AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/domain/package.json packages/domain/
COPY apps/backend/package.json apps/backend/
COPY apps/storefront/package.json apps/storefront/

# ---------------------------------------------------------------------------------------------------------------------
# Phụ thuộc đầy đủ (gồm dev) để build. --frozen-lockfile: lockfile lệch manifest → build đỏ. Script cài đặt của phụ thuộc
# theo mặc định pnpm 10 (không chạy script chưa duyệt) — giống máy dev/CI.
FROM manifests AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store \
      --filter "@x-shop/backend..." --filter "@x-shop/storefront..."

# Phụ thuộc production riêng cho từng runtime (không dev: không ts-node, vite, jest, typescript…).
FROM manifests AS backend-prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm/store --filter "@x-shop/backend..."

FROM manifests AS storefront-prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir /pnpm/store --filter "@x-shop/storefront..."

# ---------------------------------------------------------------------------------------------------------------------
# Build domain → backend (`medusa build` → apps/backend/.medusa/server, gồm admin dashboard đã build).
# `medusa build` nạp medusa-config nên cần DATABASE_URL dù không kết nối (D-007): URL GIẢ, không thông tin đăng nhập, chỉ
# trong lệnh RUN này (không ARG/ENV, không còn trong image). NODE_ENV để trống (= development) như CI: production đòi đủ
# biến bí mật lúc nạp cấu hình. Không truyền MEDUSA_BACKEND_URL → admin gọi API cùng origin (image không gắn môi trường).
FROM deps AS backend-build
COPY tsconfig.base.json ./
COPY packages/domain packages/domain
COPY apps/backend apps/backend
RUN DATABASE_URL=postgres://localhost:5432/build-only pnpm --filter @x-shop/backend build \
    && test -f apps/backend/.medusa/server/medusa-config.js \
    && test -f packages/domain/dist/index.js

# Build domain → storefront (`next build`). NEXT_PUBLIC_* được Next NHÚNG vào bundle lúc build, XS_MEDIA_URL đóng vào
# images.remotePatterns (docs/ops/ENV.md) → các biến này là tham số build (đều CÔNG KHAI, không phải bí mật). Hệ quả:
# image storefront gắn với MỘT bộ giá trị này (staging và production khác SITE_URL → hai image) — ngoại lệ D-150, RUNBOOK §8.2c.
# Thiếu SITE_URL/PUBLISHABLE_KEY thì bản production từ chối phục vụ mọi trang (getClientEnv ném lỗi) → dừng ngay lúc build.
FROM deps AS storefront-build
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_ANALYTICS_TRANSPORT
ARG NEXT_PUBLIC_VNPAY_EXTRA_ORIGINS
ARG XS_MEDIA_URL
COPY tsconfig.base.json ./
COPY packages/domain packages/domain
COPY apps/storefront apps/storefront
RUN test -n "${NEXT_PUBLIC_SITE_URL:-}" && test -n "${NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY:-}" \
    || { echo "Thiếu --build-arg NEXT_PUBLIC_SITE_URL / NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY" >&2; exit 1; }
RUN pnpm --filter @x-shop/storefront build \
    && test -f apps/storefront/.next/BUILD_ID \
    && rm -rf apps/storefront/.next/cache

# ---------------------------------------------------------------------------------------------------------------------
# Nền runtime:
#  - nâng gói Debian lên bản vá bảo mật hiện có: tag node 22.22.0 đóng băng từ 2026-02-24, bookworm đã có bản vá sau đó
#    (kiểm 2026-10-30 `apt list --upgradable` trong image gốc: libgnutls30, liblzma5, libpcre2-8-0, libgcrypt20,
#    perl-base, tzdata thuộc bookworm-security). Không cài gói mới; apt kiểm chữ ký kho. Image cuối vẫn bất biến theo
#    digest của chính nó (build một lần, promote cùng digest — OPS-DEPLOY-001).
#  - bỏ npm/corepack/yarn kèm image node (runtime không cài gói; bớt bề mặt tấn công và CVE của gói đi kèm).
FROM node-base AS runtime-base
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
    && node --version
ENV NODE_ENV=production
WORKDIR /app
STOPSIGNAL SIGTERM

# ---------------------------------------------------------------------------------------------------------------------
# Backend: server và worker (MEDUSA_WORKER_MODE=server|worker do môi trường chạy đặt; vắng = shared — chỉ dev/một tiến trình).
# Mã và node_modules thuộc root, chỉ đọc với user `node` (uid 1000): tiến trình không sửa được mã của chính nó.
# Chạy từ `.medusa/server` (bản build JS) — `require` đi lên thư mục cha tìm apps/backend/node_modules (symlink pnpm, gồm
# @x-shop/domain → packages/domain) nên không cần cài lại phụ thuộc trong thư mục build.
FROM runtime-base AS backend
COPY --from=backend-prod-deps /app/node_modules ./node_modules
COPY --from=backend-prod-deps /app/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=backend-prod-deps /app/packages/domain/node_modules ./packages/domain/node_modules
COPY --from=backend-build /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=backend-build /app/packages/domain/dist ./packages/domain/dist
COPY --from=backend-build /app/packages/domain/data ./packages/domain/data
COPY --from=backend-build /app/apps/backend/.medusa/server ./apps/backend/.medusa/server
WORKDIR /app/apps/backend/.medusa/server
# Bind: mặc định ứng dụng là 127.0.0.1 (BASE-SEC-010); trong container phải nghe giao diện của container để LB/mạng nội bộ
# tới được — đặt TƯỜNG MINH ở đây. Không publish cổng này ra Internet trực tiếp (đi qua reverse proxy/LB).
# `medusa start` đọc HOST/PORT từ môi trường (mặc định của cờ -H/-p). CLI medusa ghi configstore vào $XDG_CONFIG_HOME
# (mặc định ~/.config) ngay khi nạp → trỏ vào /tmp để chạy được với root filesystem chỉ đọc (compose: read_only + tmpfs).
ENV HOST=0.0.0.0 \
    PORT=9000 \
    XDG_CONFIG_HOME=/tmp/.config
EXPOSE 9000
USER 1000:1000
# Healthcheck: server/shared → /x/readyz (DB + Redis, 503 khi đang tắt êm — T-079, T-094); worker không nạp API route
# → /health (sống). Dùng node (image không có curl). Gọi loopback nên cần HOST là 0.0.0.0 hoặc 127.0.0.1.
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "-e", "const p=process.env.MEDUSA_WORKER_MODE==='worker'?'/health':'/x/readyz';fetch('http://127.0.0.1:'+(process.env.PORT||9000)+p,{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# PID 1 là node (không qua pnpm/sh) → nhận SIGTERM trực tiếp: tắt êm theo SHUTDOWN_TIMEOUT_MS (mặc định 25 s); nền tảng
# phải cho grace period LỚN HƠN giá trị đó (compose: stop_grace_period). Chạy kèm `init` (compose `init: true`) để dọn
# tiến trình con mồ côi.
ENTRYPOINT ["node", "/app/apps/backend/node_modules/@medusajs/cli/cli.js"]
CMD ["start"]

# ---------------------------------------------------------------------------------------------------------------------
# Storefront: `next start` trên bản build đầy đủ + phụ thuộc production. next.config.ts hiện KHÔNG có output "standalone"
# (đổi cấu hình Next ngoài phạm vi T-191; `next start` ở E2E/perf phụ thuộc cấu hình hiện tại) → image lớn hơn bản
# standalone nhưng chạy đúng cùng lệnh với E2E. `next start` nạp lại next.config.ts (nhập src/lib/env/media.ts) nên
# chép cả src. `.next` thuộc uid 1000 (user `node`): cache dữ liệu/ISR và cache ảnh của Next ghi vào đó lúc chạy.
FROM runtime-base AS storefront
COPY --from=storefront-prod-deps /app/node_modules ./node_modules
COPY --from=storefront-prod-deps /app/apps/storefront/node_modules ./apps/storefront/node_modules
COPY --from=storefront-prod-deps /app/packages/domain/node_modules ./packages/domain/node_modules
COPY --from=storefront-build /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=storefront-build /app/packages/domain/dist ./packages/domain/dist
COPY --from=storefront-build /app/packages/domain/data ./packages/domain/data
COPY --from=storefront-build /app/apps/storefront/package.json /app/apps/storefront/next.config.ts ./apps/storefront/
COPY --from=storefront-build /app/apps/storefront/public ./apps/storefront/public
COPY --from=storefront-build /app/apps/storefront/src ./apps/storefront/src
COPY --from=storefront-build --chown=1000:1000 /app/apps/storefront/.next ./apps/storefront/.next
WORKDIR /app/apps/storefront
ENV HOST=0.0.0.0 \
    PORT=3000
EXPOSE 3000
USER 1000:1000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/robots.txt',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# `next start` không đọc HOST từ môi trường → truyền qua -H; `exec` để node là PID 1 và nhận SIGTERM (Next tự dọn rồi thoát).
CMD ["sh", "-c", "exec node /app/apps/storefront/node_modules/next/dist/bin/next start -H \"$HOST\" -p \"$PORT\""]
