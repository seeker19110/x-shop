"use client";

import { Overlay, type OverlayProps } from "./Dialog";

export interface DrawerProps extends Omit<OverlayProps, "variant"> {
  /** Trượt từ phải (mặc định) hoặc từ dưới (mobile). */
  side?: "right" | "bottom";
}

export function Drawer({ side = "right", ...props }: DrawerProps) {
  return <Overlay {...props} variant={side === "bottom" ? "drawer-bottom" : "drawer-right"} />;
}
