"use client";

import { useRef, useState } from "react";
import { Drawer } from "../ui/Drawer";
import { MenuIcon } from "./icons";
import styles from "./Header.module.css";
import { NavLinks, type NavItem } from "./NavLinks";
import { t } from "../../lib/i18n";

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
        <span className="visually-hidden">{t("header.menuOpen")}</span>
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={t("mobileMenu.title")}
        returnFocusRef={openerRef}
        closeLabel={t("mobileMenu.close")}
      >
        <nav aria-label={t("mobileMenu.navLabel")}>
          {items.length > 0 ? (
            <NavLinks items={items} onNavigate={() => setOpen(false)} />
          ) : (
            <p>{t("mobileMenu.empty")}</p>
          )}
        </nav>
      </Drawer>
    </>
  );
}
