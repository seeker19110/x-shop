/* eslint-disable @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars -- gộp khai báo (declaration merging) cần đúng tham số kiểu của vitest; thân rỗng là chủ ý */
// `@testing-library/jest-dom/vitest` (7.0.1) khai báo `interface Assertion<T = any>` còn vitest 5 khai báo
// `Assertion<R, T>` → TS2428 khi skipLibCheck=false. Tự bổ sung matcher với đúng tham số kiểu của vitest; vitest.setup.ts
// đăng ký matcher bằng `expect.extend` thay cho import `/vitest`.
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  interface Assertion<R extends void | Promise<void> = void, T = unknown> extends TestingLibraryMatchers<
    unknown,
    T
  > {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, unknown> {}
}
