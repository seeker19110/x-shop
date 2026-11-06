import { readFileSync } from "node:fs";
import path from "node:path";

export interface BuildInfo {
  version: string;
  commit?: string;
  built_at?: string;
}

/** Phiên bản trong package.json của backend (cùng độ sâu thư mục ở src/ và .medusa/server/). */
const packageVersion = (): string => {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
};

/**
 * Định danh bản build (D-050). `XS_RELEASE_*` đã được schema env kiểm định dạng lúc khởi động; ở đây chỉ đọc lại, chuỗi rỗng
 * coi như vắng. Chỉ ba trường — không trả cấu hình, đường dẫn, phiên bản phụ thuộc hay biến môi trường khác.
 */
export function buildInfo(source: Readonly<Record<string, string | undefined>> = process.env): BuildInfo {
  const pick = (k: string): string | undefined => {
    const v = (source[k] ?? "").trim();
    return v === "" ? undefined : v;
  };
  const commit = pick("XS_RELEASE_COMMIT");
  const builtAt = pick("XS_BUILT_AT");
  return {
    version: pick("XS_RELEASE_VERSION") ?? packageVersion(),
    ...(commit === undefined ? {} : { commit }),
    ...(builtAt === undefined ? {} : { built_at: builtAt }),
  };
}
