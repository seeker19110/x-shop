/**
 * Menu danh mục là cấu hình (đặc tả §3.3: "menu lấy từ cấu hình quản trị, không cố định theo một mô hình kinh doanh").
 * Header chỉ hiện nhóm CÓ sản phẩm: danh sách này được lọc theo dữ liệu thật ở `getMenuCategories()`.
 * Khi backend có endpoint danh mục (xem API-CONTRACT), thay nguồn ở đây — không đổi component.
 */
export const NAV_CATEGORIES = [
  { handle: "ao", name: "Áo" },
  { handle: "quan", name: "Quần" },
  { handle: "vay", name: "Váy và đầm" },
  { handle: "phu-kien", name: "Phụ kiện" },
] as const;

export function categoryHref(handle: string): string {
  return `/danh-muc/${encodeURIComponent(handle)}`;
}

export function categoryName(handle: string): string | null {
  return NAV_CATEGORIES.find((c) => c.handle === handle)?.name ?? null;
}
