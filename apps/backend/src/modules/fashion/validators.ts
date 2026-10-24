import { slugify } from "@x-shop/domain";
import { z } from "zod";

/** Kiểm dữ liệu thời trang ở biên (route admin, seed, import) — một schema dùng chung. */

const measure = z.number().min(0).max(400);
const cell = z.union([measure, z.tuple([measure, measure]).refine(([a, b]) => a <= b, "min > max")]);

export const SizeChartColumnSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/),
  label: z.string().trim().min(1).max(60),
  basis: z.enum(["body", "garment"]),
});

export const SizeChartRowSchema = z.object({
  size: z.string().trim().min(1).max(20),
  label: z.string().trim().min(1).max(20),
  values: z.record(z.string(), cell),
});

export const SizeChartContentSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    garment_type: z.string().trim().min(1).max(60),
    unit: z.literal("cm").default("cm"),
    columns: z.array(SizeChartColumnSchema).min(1).max(20),
    rows: z.array(SizeChartRowSchema).min(1).max(40),
  })
  .superRefine((v, ctx) => {
    const keys = new Set(v.columns.map((c) => c.key));
    if (keys.size !== v.columns.length)
      ctx.addIssue({ code: "custom", path: ["columns"], message: "Trùng key" });
    const sizes = new Set<string>();
    v.rows.forEach((r, i) => {
      const s = slugify(r.size);
      if (s === "" || sizes.has(s))
        ctx.addIssue({ code: "custom", path: ["rows", i, "size"], message: "Size rỗng hoặc trùng" });
      sizes.add(s);
      for (const k of Object.keys(r.values)) {
        if (!keys.has(k)) ctx.addIssue({ code: "custom", path: ["rows", i, "values", k], message: "Cột lạ" });
      }
    });
  })
  .transform((v) => ({ ...v, rows: v.rows.map((r) => ({ ...r, size: slugify(r.size) })) }));

export type SizeChartContent = z.infer<typeof SizeChartContentSchema>;

export const SizeChartCreateSchema = z.intersection(
  z.object({ code: z.string().trim().min(1).max(60).transform(slugify) }),
  SizeChartContentSchema,
);

const text = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

export const ProductFashionSchema = z.object({
  attributes: z.object({
    kind: z.enum(["apparel", "shoes", "accessory"]),
    material: z.string().trim().min(1).max(60).transform(slugify).nullable().optional(),
    material_label: text(60),
    composition: text(255),
    stretch: z.enum(["none", "low", "medium", "high"]).nullable().optional(),
    fit: text(60),
    care: text(1000),
    origin: text(60),
    image_exception_by: text(120),
    image_exception_reason: text(500),
  }),
  /** `undefined` = giữ nguyên; `null` = gỡ bảng size. */
  size_chart_id: z.string().min(1).nullable().optional(),
  /** `undefined` = giữ nguyên; mảng = thay toàn bộ. */
  model_measurements: z
    .array(
      z.object({
        image_set: z.string().trim().min(1).max(60),
        color: z.string().trim().min(1).max(40).nullable().optional(),
        height_cm: z.number().int().min(50).max(250),
        chest_cm: z.number().int().min(20).max(250).nullable().optional(),
        waist_cm: z.number().int().min(20).max(250).nullable().optional(),
        hip_cm: z.number().int().min(20).max(250).nullable().optional(),
        size_worn: z.string().trim().min(1).max(20),
        note: z.string().trim().max(255).nullable().optional(),
      }),
    )
    .max(20)
    .optional(),
});

export type ProductFashionInput = z.infer<typeof ProductFashionSchema>;
