"use strict";
/* global module -- tệp CommonJS: cả jest (backend) và vitest (storefront) nạp được, kèm .d.cts */
// Validator JSON Schema tối thiểu cho docs/ops/log-schema.json (T-190) — MỘT bản cho test backend và storefront.
// Từ khoá hỗ trợ (danh sách trắng): type (string|object), required, properties, additionalProperties (chỉ boolean), enum,
// const, pattern, minLength, allOf, if, then, và các từ khoá chú thích ($schema, $id, $comment, title, description).
// Từ khoá khác hoặc `type` khác → ném lỗi (không bao giờ bỏ qua lặng lẽ: schema thêm ràng buộc mà validator không kiểm
// được phải làm test đỏ, không phải xanh giả).

const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "title", "description"]);
const SUPPORTED = new Set([
  "type",
  "required",
  "properties",
  "additionalProperties",
  "enum",
  "const",
  "pattern",
  "minLength",
  "allOf",
  "if",
  "then",
]);

function validate(schema, value, path, errors) {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema))
    throw new Error(`${path}: schema con phải là object`);
  for (const k of Object.keys(schema)) {
    if (!SUPPORTED.has(k) && !ANNOTATIONS.has(k))
      throw new Error(`${path}: từ khoá schema chưa hỗ trợ: ${k}`);
  }
  const bad = (msg) => errors.push(`${path}: ${msg}`);
  if (schema.type !== undefined) {
    if (schema.type !== "string" && schema.type !== "object")
      throw new Error(`${path}: type chưa hỗ trợ: ${JSON.stringify(schema.type)}`);
    if (schema.type === "string" && typeof value !== "string") bad("phải là chuỗi");
    if (schema.type === "object" && (typeof value !== "object" || value === null || Array.isArray(value)))
      bad("phải là object");
  }
  if ("const" in schema && value !== schema.const) bad(`phải bằng ${JSON.stringify(schema.const)}`);
  if (schema.enum !== undefined && !schema.enum.includes(value))
    bad(`ngoài enum ${JSON.stringify(schema.enum)}`);
  if (typeof value === "string") {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value))
      bad(`không khớp ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) bad("quá ngắn");
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const r of schema.required ?? []) if (!(r in value)) bad(`thiếu ${r}`);
    const props = schema.properties ?? {};
    for (const [k, sub] of Object.entries(props))
      if (k in value) validate(sub, value[k], `${path}.${k}`, errors);
    if (schema.additionalProperties === false)
      for (const k of Object.keys(value)) if (!(k in props)) bad(`trường thừa ${k}`);
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean")
    throw new Error(`${path}: additionalProperties chỉ hỗ trợ boolean`);
  for (const sub of schema.allOf ?? []) validate(sub, value, path, errors);
  if (schema.if !== undefined) {
    const cond = [];
    validate(schema.if, value, path, cond);
    if (cond.length === 0 && schema.then !== undefined) validate(schema.then, value, path, errors);
  }
}

/** Trả danh sách lỗi (rỗng = hợp lệ); ném nếu schema dùng từ khoá chưa hỗ trợ. */
function schemaErrors(schema, value) {
  const errors = [];
  validate(schema, value, "$", errors);
  return errors;
}

module.exports = { schemaErrors };
