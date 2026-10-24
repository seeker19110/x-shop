import type { MedusaContainer } from "@medusajs/framework/types";
import { FASHION_MODULE } from "../../modules/fashion";
import type FashionModuleService from "../../modules/fashion/service";

export interface ColorEntry {
  value: string;
  label: string;
  hex: string | null;
  rank: number;
}

export interface SizeEntry {
  value: string;
  label: string;
  rank: number;
}

export interface Dictionary {
  colors: Map<string, ColorEntry>;
  sizes: Map<string, SizeEntry>;
}

/** Bảng màu/size dùng chung (module fashion). Giá trị lạ không có trong bảng → nhãn = giá trị, xếp cuối. */
export async function loadDictionary(container: MedusaContainer): Promise<Dictionary> {
  const fashion: FashionModuleService = container.resolve(FASHION_MODULE);
  const [colors, sizes] = await Promise.all([
    fashion.listFashionColors({}, { take: null }),
    fashion.listFashionSizes({}, { take: null }),
  ]);
  return {
    colors: new Map(
      colors.map((c) => [c.value, { value: c.value, label: c.label, hex: c.hex ?? null, rank: c.rank }]),
    ),
    sizes: new Map(sizes.map((s) => [s.value, { value: s.value, label: s.label, rank: s.rank }])),
  };
}

export const UNKNOWN_RANK = 9999;

export function colorOf(dict: Dictionary, value: string): ColorEntry {
  return dict.colors.get(value) ?? { value, label: value, hex: null, rank: UNKNOWN_RANK };
}

export function sizeOf(dict: Dictionary, value: string): SizeEntry {
  return dict.sizes.get(value) ?? { value, label: value.toUpperCase(), rank: UNKNOWN_RANK };
}
