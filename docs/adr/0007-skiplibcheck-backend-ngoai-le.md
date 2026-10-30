# ADR-0007 — Backend giữ `skipLibCheck: true` (ngoại lệ; domain và storefront đã tắt)

## Trạng thái

Accepted (2026-10-30), theo Q-05 của `docs/autopilot/PLAN-2.md` (phương án A theo từng gói); task T-199. Đóng FE-BUILD-003, PRF-WEB-002 cho `packages/domain` và `apps/storefront`.

## Ngày

2026-10-30

## Bối cảnh

`tsconfig.base.json` từng đặt `skipLibCheck: true` cho mọi gói, nên lỗi kiểu trong `.d.ts` phụ thuộc không bao giờ lộ. T-199 đổi mặc định ở `tsconfig.base.json` thành `false`; chỉ `apps/backend/tsconfig.json` ghi đè `true`. Thử `tsc --noEmit -p apps/backend/tsconfig.typecheck.json --skipLibCheck false` (2026-10-30, TypeScript 5.9.3, Medusa 2.22.1) cho 140 lỗi (cộng 1 lỗi ở tsconfig admin, bên dưới), 0 lỗi trong mã dự án (`src/`, `integration-tests/`), toàn bộ nằm trong `.d.ts` của Medusa:

- 72 × TS2416 + 65 × TS2425 (137 lỗi) ở `@medusajs/order` (69) và `@medusajs/product` (68) `dist/services/*-module-service.d.ts`: lớp `OrderModuleService`/`ProductModuleService` khai báo lại thuộc tính (vd `createOrders`) mà kiểu không gán được cho lớp cha `AbstractModuleService<…>`; ví dụ `@medusajs/order/dist/services/order-module-service.d.ts(145,5): TS2416 Property 'createOrders' in type 'OrderModuleService' is not assignable to the same property in base type 'AbstractModuleService<…>'`; `(132,5): TS2425 Class 'AbstractModuleService<…>' defines instance member property …`.
- 2 × TS2339 `@medusajs/utils/dist/totals/big-number.d.ts(4,46)`: `Property 'BigNumber' does not exist on type 'typeof globalThis'` (kiểu toàn cục do gói bên thứ ba khai báo, không nạp trong cấu hình backend).
- 1 × TS2503 ở bundle admin (`apps/backend/src/admin/tsconfig.json`, cũng thuộc backend): `@tanstack/react-table/build/lib/index.d.ts(8,119): Cannot find namespace 'JSX'` (gói do Medusa admin kéo vào, d.ts dùng `JSX` toàn cục đã bị @types/react mới bỏ).
- 1 × TS2304 `@medusajs/types/dist/http/file/common.d.ts(27,5)`: `Cannot find name 'FileList'` (d.ts dùng kiểu DOM, backend không bật lib `dom`).

## Phương án đã cân nhắc

1. Tắt `skipLibCheck` ở backend, sửa d.ts — loại: lỗi nằm trong `node_modules` của Medusa, không sửa được ở dự án (vá bằng `pnpm patch` mỗi lần nâng phiên bản là gánh nặng, ghi đè kiểu nội bộ dễ làm sai kiểu API thật mà mã dự án dùng).
2. Thêm `lib: ["dom"]`/khai báo toàn cục để giảm 3 lỗi nhỏ — không chọn: không xử lý 137 lỗi lớp, thêm kiểu DOM vào backend làm mất khả năng bắt nhầm API trình duyệt.
3. Giữ `true` ở backend, tắt ở gói còn lại, kèm cổng `tsc` mã dự án — chọn.

## Quyết định

- `tsconfig.base.json`: `skipLibCheck: false`. `packages/domain`, `apps/storefront`, `e2e` kế thừa `false` và xanh.
- `apps/backend/tsconfig.json` và `apps/backend/src/admin/tsconfig.json`: `skipLibCheck: true` (hai ghi đè duy nhất), kèm ADR này. `tsconfig.typecheck.json` kế thừa nên `pnpm typecheck` vẫn kiểm đầy đủ MÃ dự án (kiểu tại điểm dùng API Medusa vẫn được kiểm; chỉ bỏ kiểm nội dung `.d.ts`).
- Storefront cần 3 chỗ chỉnh cho đúng kiểu thật (không `@ts-ignore`): `lib` thêm `ES2024.Promise` (d.ts của Next dùng `PromiseWithResolvers`); `src/types/next-url-pattern.d.ts` khai báo tối thiểu `URLPattern*` (Next 16 tham chiếu, TS 5.9 và @types/node 22 chưa có); `src/types/jest-dom-vitest.d.ts` + `vitest.setup.ts` đăng ký matcher jest-dom bằng `expect.extend` thay cho `@testing-library/jest-dom/vitest` (d.ts của nó khai báo `Assertion<T>` xung đột `Assertion<R, T>` của vitest 5, TS2428).

## Hệ quả

- Lỗi kiểu trong d.ts Medusa không bị phát hiện ở backend; lỗi do nâng Medusa làm đổi kiểu API vẫn lộ tại mã dự án gọi nó.
- Hai shim ở storefront là mã dự án phải gỡ khi nguyên nhân gốc hết (xem Điều kiện đọc lại).
- Đường lùi: đặt lại `skipLibCheck: true` ở `tsconfig.base.json` và bỏ shim (không ảnh hưởng dữ liệu).

## Điều kiện đọc lại

- Nâng Medusa: chạy lại lệnh thử trên; về 0 lỗi thì bỏ ghi đè ở backend và đóng ADR này.
- Nâng `@types/node` >= 24 hoặc TypeScript có kiểu URLPattern → bỏ `next-url-pattern.d.ts`.
- `@testing-library/jest-dom` hoặc vitest sửa xung đột `Assertion` → bỏ `jest-dom-vitest.d.ts`, quay lại `import "@testing-library/jest-dom/vitest"`.
