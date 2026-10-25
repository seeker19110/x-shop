import type { ElementType, ReactNode } from "react";

/** Nội dung chỉ dành cho trình đọc màn hình (class dùng chung ở globals.css). */
export function VisuallyHidden({
  children,
  as: Tag = "span",
  id,
}: {
  children: ReactNode;
  as?: ElementType;
  id?: string;
}) {
  return (
    <Tag id={id} className="visually-hidden">
      {children}
    </Tag>
  );
}
