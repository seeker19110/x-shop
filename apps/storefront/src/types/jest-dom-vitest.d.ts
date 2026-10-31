/* eslint-disable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars -- gộp khai báo (declaration merging) cần đúng tham số kiểu của vitest; thân rỗng là chủ ý */
// `@testing-library/jest-dom/vitest` (7.0.1) khai báo `interface Assertion<T = any>` còn vitest 5 khai báo
// `Assertion<R, T>` → TS2428 khi skipLibCheck=false. Tự bổ sung matcher với đúng tham số kiểu của vitest; vitest.setup.ts
// đăng ký matcher bằng `expect.extend` thay cho import `/vitest`. Tham số thứ hai của matcher là kiểu trả về (R: void
// hoặc Promise<void> khi `.resolves`), kiểm ở jest-dom-vitest.test.ts. Điều kiện gỡ: ADR-0008.
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  interface Assertion<R extends void | Promise<void> = void, T = unknown> extends TestingLibraryMatchers<
    unknown,
    R
  > {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, unknown> {}
}
