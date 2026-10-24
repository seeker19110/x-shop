import { render } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { ProductCard } from "../product-card/ProductCard";
import { Breadcrumb } from "./Breadcrumb";
import { Button } from "./Button";
import { ChipList } from "./Chip";
import { ColorSwatchGroup } from "./ColorSwatch";
import { Dialog } from "./Dialog";
import { EmptyState } from "./EmptyState";
import { IconButton } from "./IconButton";
import { InlineError } from "./InlineError";
import { Price } from "./Price";
import { SizeSelector } from "./SizeSelector";

/** Lỗi serious/critical (S-509). Tương phản màu cần trình duyệt thật nên tắt ở jsdom; token đã có cổng `xt.py contrast`. */
async function violations(node: Element) {
  const res = await axe.run(node, { rules: { "color-contrast": { enabled: false } } });
  return res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id);
}

describe("axe (jsdom)", () => {
  it("bộ điều khiển và lựa chọn", async () => {
    const { container } = render(
      <main>
        <Breadcrumb items={[{ label: "Trang chủ", href: "/" }, { label: "Áo" }]} />
        <Button>Mua</Button>
        <Button href="/gio-hang" variant="secondary">
          Xem giỏ
        </Button>
        <IconButton label="Mở giỏ" icon="🛒" />
        <ChipList items={[{ key: "a", label: "Đen" }]} onRemove={() => {}} onClearAll={() => {}} />
        <SizeSelector
          options={[
            { value: "S", available: true },
            { value: "L", available: false },
          ]}
          value="S"
          onChange={() => {}}
          error="Vui lòng chọn size"
          sizeGuideHref="/size"
        />
        <ColorSwatchGroup
          options={[
            { value: "d", name: "Đen", hex: "#111" },
            { value: "t", name: "Trắng", hex: "#fff", available: false },
          ]}
          value="d"
          onChange={() => {}}
        />
        <Price current={900000} original={1200000} />
        <InlineError alert>Lỗi</InlineError>
        <EmptyState title="Trống" description="Không có gì" />
      </main>,
    );
    expect(await violations(container)).toEqual([]);
  });

  it("ProductCard trong lưới", async () => {
    const { container } = render(
      <main>
        <ul>
          <li>
            <ProductCard
              slug="x"
              name="Áo"
              image={{ src: "/a.jpg", alt: "Áo màu đen" }}
              hoverImage={{ src: "/b.jpg" }}
              price={1}
              originalPrice={2}
              colors={[{ value: "d", name: "Đen", hex: "#111" }]}
            />
          </li>
        </ul>
      </main>,
    );
    expect(await violations(container)).toEqual([]);
  });

  it("Dialog đang mở", async () => {
    render(
      <Dialog open onClose={() => {}} title="Giỏ hàng">
        <p>Nội dung</p>
      </Dialog>,
    );
    expect(await violations(document.body)).toEqual([]);
  });
});
