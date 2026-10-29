#!/usr/bin/env node
/**
 * Kiểm trước phát hành (GO-NO-GO, T-181, ADR-0006): mọi chuỗi băm mật khẩu emailpass trong DB đạt mức tối thiểu OWASP
 * cho scrypt (logN ≥ 17, r ≥ 8, p ≥ 1). Hash tham số cũ (vd logN 15 trước T-181) chỉ được nâng ở lần đăng nhập đúng
 * (D-137) — tài khoản lâu không đăng nhập vẫn còn hash cũ; script đếm để chủ dự án buộc đặt lại mật khẩu trước ra mắt.
 *
 *   DATABASE_URL=postgres://… node scripts/ops/check-scrypt-params.mjs
 *   node scripts/ops/check-scrypt-params.mjs postgres://…
 *
 * CHỈ ĐỌC (`SELECT` trên `provider_identity`). Không in email/hash — chỉ số đếm và id provider identity cần xử lý.
 * Header định dạng scrypt-kdf 2.x (base64 của 96 byte): "scrypt" · phiên bản (1) · logN (1) · r (u32 BE) · p (u32 BE) · …
 * — cùng bố cục với `scryptParamsFromHash` ở apps/backend/src/lib/admin-security/password-hash.ts.
 *
 * Exit: 0 = mọi hash đạt · 1 = có hash dưới chuẩn hoặc không đọc được định dạng · 2 = lỗi cấu hình/kết nối.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Mức tối thiểu OWASP Password Storage Cheat Sheet cho scrypt (tra 2026-10-29) — khớp OWASP_SCRYPT_MIN của backend. */
export const OWASP_SCRYPT_MIN = Object.freeze({ logN: 17, r: 8, p: 1 });

const SCRYPT_KDF = { length: 96, magic: "scrypt", logN: 7, r: 8, p: 12 };

/** Tham số đọc từ header chuỗi băm base64; `null` nếu không phải định dạng scrypt-kdf. */
export function scryptParamsFromHash(hash) {
  if (typeof hash !== "string") return null;
  const buf = Buffer.from(hash, "base64");
  if (buf.length !== SCRYPT_KDF.length) return null;
  if (buf.subarray(0, SCRYPT_KDF.magic.length).toString("latin1") !== SCRYPT_KDF.magic) return null;
  return {
    logN: buf.readUInt8(SCRYPT_KDF.logN),
    r: buf.readUInt32BE(SCRYPT_KDF.r),
    p: buf.readUInt32BE(SCRYPT_KDF.p),
  };
}

export function meetsOwaspScryptMinimum(c) {
  return c.logN >= OWASP_SCRYPT_MIN.logN && c.r >= OWASP_SCRYPT_MIN.r && c.p >= OWASP_SCRYPT_MIN.p;
}

/** Phân loại các dòng `{ id, hash }` → { total, ok, below: id[], invalid: id[], byLogN: {logN: số} }. */
export function classify(rows) {
  const result = { total: rows.length, ok: 0, below: [], invalid: [], byLogN: {} };
  for (const { id, hash } of rows) {
    const params = scryptParamsFromHash(hash);
    if (params === null) {
      result.invalid.push(id);
      continue;
    }
    result.byLogN[params.logN] = (result.byLogN[params.logN] ?? 0) + 1;
    if (meetsOwaspScryptMinimum(params)) result.ok += 1;
    else result.below.push(id);
  }
  return result;
}

export const QUERY = `select id, provider_metadata->>'password' as hash
  from provider_identity
 where provider = 'emailpass' and deleted_at is null and provider_metadata ? 'password'`;

export async function main(argv = process.argv.slice(2), env = process.env, out = console) {
  const url = argv[0] ?? env.DATABASE_URL;
  if (!url) {
    out.error("check-scrypt-params: thiếu DATABASE_URL (hoặc đối số URL)");
    return 2;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const { Client } = createRequire(path.join(root, "apps/backend/package.json"))("pg");
  const client = new Client({ connectionString: url });
  let rows;
  try {
    await client.connect();
    rows = (await client.query(QUERY)).rows;
  } catch (e) {
    // Chỉ tên lỗi + mã SQLSTATE (vd 42P01 = chưa migrate), không thông điệp (có thể chứa URL/tài khoản).
    const code = typeof e?.code === "string" ? ` ${e.code}` : "";
    out.error(`check-scrypt-params: không đọc được DB (${e instanceof Error ? e.name : "lỗi"}${code})`);
    return 2;
  } finally {
    await client.end().catch(() => undefined);
  }
  const r = classify(rows);
  out.log(
    `check-scrypt-params: ${r.total} hash emailpass · đạt ${r.ok} · dưới chuẩn ${r.below.length} · sai định dạng ${r.invalid.length} · theo logN ${JSON.stringify(r.byLogN)}`,
  );
  for (const id of r.below) out.log(`  dưới chuẩn: provider_identity ${id}`);
  for (const id of r.invalid) out.log(`  sai định dạng: provider_identity ${id}`);
  return r.below.length === 0 && r.invalid.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
