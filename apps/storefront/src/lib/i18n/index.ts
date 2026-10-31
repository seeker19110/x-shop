import vi from "../../../messages/vi.json";

/**
 * XC-I18N-001: mọi chuỗi hiển thị nằm ở `messages/vi.json`, truy cập qua `t(key, params?)`.
 * - Khoá suy từ cây JSON (`"namespace.sub.key"`): khoá sai là lỗi typecheck.
 * - Nội suy `{tên}`; tham số thiếu là lỗi ở dev/test (không để lọt chữ `{tên}` ra giao diện).
 * - Thuần, không phụ thuộc React/Next: dùng được ở Server Component lẫn Client Component.
 * - Khoá thiếu lúc chạy (không thể xảy ra khi qua typecheck): ném lỗi ở dev/test; production trả lại chính khoá
 *   (hiện chữ xấu còn hơn làm sập cả trang).
 */
type Messages = typeof vi;

type Flatten<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Flatten<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type MessageKey = Flatten<Messages>;
export type MessageParams = Readonly<Record<string, string | number>>;

const CATALOG: Readonly<Record<string, unknown>> = vi;
const isProduction = (): boolean => process.env.NODE_ENV === "production";

function lookup(key: string): string | undefined {
  let node: unknown = CATALOG;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, part)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** Nội suy `{tên}` trong mẫu; tách riêng để test độc lập với nội dung vi.json. */
export function interpolate(template: string, params: MessageParams | undefined, key: string): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params !== undefined && Object.hasOwn(params, name) ? params[name] : undefined;
    if (value === undefined) {
      if (isProduction()) return "";
      throw new Error(`i18n: khoá "${key}" thiếu tham số "${name}"`);
    }
    return String(value);
  });
}

/** Mẫu thô (chưa nội suy) của một khoá; khoá thiếu → ném lỗi như `t`. */
export function rawMessage(key: MessageKey): string {
  const template = lookup(key);
  if (template === undefined) throw new Error(`i18n: thiếu khoá "${key}" trong messages/vi.json`);
  return template;
}

export function t(key: MessageKey, params?: MessageParams): string {
  const template = lookup(key);
  if (template === undefined) {
    if (isProduction()) return key;
    throw new Error(`i18n: thiếu khoá "${key}" trong messages/vi.json`);
  }
  return interpolate(template, params, key);
}

/** Mọi khoá lá của vi.json (dùng cho test và công cụ kiểm). */
export function allMessageKeys(): MessageKey[] {
  const out: string[] = [];
  const walk = (node: unknown, prefix: string): void => {
    if (typeof node === "string") out.push(prefix);
    else if (typeof node === "object" && node !== null)
      for (const [k, v] of Object.entries(node)) walk(v, prefix === "" ? k : `${prefix}.${k}`);
  };
  walk(CATALOG, "");
  return out as MessageKey[];
}
