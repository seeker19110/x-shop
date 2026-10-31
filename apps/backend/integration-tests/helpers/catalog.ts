import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import { createProductsWorkflow } from "@medusajs/medusa/core-flows";
import { isNonEmpty } from "@x-shop/domain";
import { CURRENCY, OPTION_COLOR, OPTION_SIZE } from "../../src/lib/catalog/constants";

export interface TestVariant {
  color: string;
  size: string;
  price: number | null;
}

export interface TestProductInput {
  title?: string;
  handle?: string;
  description?: string | null;
  status?: "draft" | "published";
  salesChannelId?: string;
  variants?: TestVariant[];
  /** Mỗi phần tử: [màu | null, alt | null]. */
  images?: [string | null, string | null][];
  categoryIds?: string[];
  /** Mặc định false (catalog không cần tồn kho); checkout cần true để có inventory item. */
  manageInventory?: boolean;
}

/** Tạo sản phẩm qua workflow lõi (cùng đường Admin API dùng). Mặc định: draft, đủ 3 ảnh đen, 2 SKU đen. */
export async function createTestProduct(container: MedusaContainer, input: TestProductInput = {}) {
  const variants = input.variants ?? [
    { color: "den", size: "s", price: 300_000 },
    { color: "den", size: "m", price: 320_000 },
  ];
  const images = input.images ?? [
    ["den", "Mặt trước màu đen"],
    ["den", "Mặt sau màu đen"],
    ["den", "Chi tiết vải"],
  ];
  const suffix = randomUUID().slice(0, 8);
  const handle = input.handle ?? `test-${suffix}`;
  const { result } = await createProductsWorkflow(container).run({
    input: {
      products: [
        {
          title: input.title ?? `Sản phẩm thử ${suffix}`,
          handle,
          description:
            input.description === undefined
              ? "Mô tả đủ dài cho kiểm trước xuất bản của sản phẩm thử."
              : input.description,
          status: input.status ?? "draft",
          images: images.map(([color, alt], i) => ({
            url: `/static/demo/${color ?? "den"}.svg?i=${i}`,
            metadata: { ...(isNonEmpty(color) ? { color } : {}), ...(isNonEmpty(alt) ? { alt } : {}) },
          })),
          ...(input.categoryIds ? { category_ids: input.categoryIds } : {}),
          ...(isNonEmpty(input.salesChannelId) ? { sales_channels: [{ id: input.salesChannelId }] } : {}),
          options: [
            { title: OPTION_COLOR, values: [...new Set(variants.map((v) => v.color))] },
            { title: OPTION_SIZE, values: [...new Set(variants.map((v) => v.size))] },
          ],
          variants: variants.map((v) => ({
            title: `${v.color} / ${v.size}`,
            sku: `T-${suffix}-${v.color}-${v.size}`.toUpperCase(),
            manage_inventory: input.manageInventory ?? false,
            options: { [OPTION_COLOR]: v.color, [OPTION_SIZE]: v.size },
            prices: v.price === null ? [] : [{ amount: v.price, currency_code: CURRENCY }],
          })),
        },
      ],
    },
  });
  return { id: (result[0] as { id: string }).id, handle, suffix };
}

/** Bảng size tối thiểu hợp lệ cho test. */
export const TEST_CHART = {
  name: "Bảng size thử",
  garment_type: "ao",
  unit: "cm" as const,
  columns: [{ key: "nguc", label: "Vòng ngực", basis: "body" as const }],
  rows: [
    { size: "s", label: "S", values: { nguc: [80, 84] as [number, number] } },
    { size: "m", label: "M", values: { nguc: [84, 88] as [number, number] } },
  ],
};
