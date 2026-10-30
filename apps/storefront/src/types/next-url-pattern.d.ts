// Next 16 (`next/dist/server/web/spec-extension/url-pattern.d.ts`) tham chiếu kiểu toàn cục URLPattern mà
// lib.dom của TypeScript 5.9 và @types/node 22 chưa khai báo. Khai báo tối thiểu để tsc chạy với skipLibCheck=false
// (FE-BUILD-003). Gỡ khi nâng @types/node >= 24 hoặc TypeScript có lib.dom.urlpattern. Dự án không dùng URLPattern.
type URLPatternInput = string | Record<string, string | undefined>;
interface URLPatternOptions {
  ignoreCase?: boolean;
}
interface URLPattern {
  test(input?: URLPatternInput, baseURL?: string): boolean;
}
