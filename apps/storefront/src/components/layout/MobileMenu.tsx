"use client";

import { useRef, useState } from "react";
import { Drawer } from "../ui/Drawer";
import { MenuIcon } from "./icons";
import styles from "./Header.module.css";
import { NavLinks, type NavItem } from "./NavLinks";

/** Menu di động: nút mở `Drawer` (khóa focus, Esc đóng, trả focus về nút). Chỉ hiện dưới 48em. */
export function MobileMenu({ items }: { items: readonly NavItem[] }) {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={openerRef}
        type="button"
        className={`${styles.iconLink} ${styles.menuButton}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <MenuIcon />
        <span className="visually-hidden">Mở menu danh mục</span>
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Danh mục"
        returnFocusRef={openerRef}
        closeLabel="Đóng menu"
      >
        <nav aria-label="Danh mục (menu di động)">
          {items.length > 0 ? (
            <NavLinks items={items} onNavigate={() => setOpen(false)} />
          ) : (
            <p>Chưa có danh mục.</p>
          )}
        </nav>
      </Drawer>
    </>
  );
}
