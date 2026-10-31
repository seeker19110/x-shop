import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { TimingSafeEmailPassAuthService } from "../../src/lib/admin-security/emailpass";
import {
  EMAILPASS_HASH_CONFIG,
  MEDUSA_DEFAULT_SCRYPT,
  meetsOwaspScryptMinimum,
  OWASP_SCRYPT_MIN,
  type ScryptHashConfig,
} from "../../src/lib/admin-security/password-hash";
import { createAdmin, createMfaAdmin, noThrow } from "../helpers/auth";

jest.setTimeout(300 * 1000);

/**
 * T-181 (BE-AUTH-001, Q-01, ADR-0006) — mật khẩu admin băm bằng scrypt của `@medusajs/auth-emailpass` với tham số ≥ mức
 * tối thiểu OWASP (N = 2^17, r = 8, p = 1). Kiểm trên chuỗi băm THẬT trong DB (`provider_identity.provider_metadata`),
 * không tin cấu hình: giải header định dạng scrypt-kdf (base64 của 96 byte: "scrypt" · phiên bản · logN · r (u32 BE) ·
 * p (u32 BE) · salt 32 · checksum 16 · HMAC 32). Hash tạo bằng tham số cũ (mặc định Medusa logN 15) vẫn đăng nhập được
 * và được băm lại lên logN 17 ở lần đăng nhập đúng đầu tiên (D-137).
 */

const SCRYPT_KDF_LENGTH = 96;

interface ScryptHeader extends ScryptHashConfig {
  version: number;
  salt: string;
}

/** Đọc header của chuỗi băm scrypt-kdf (chỉ phân tích định dạng, không tính toán mật mã). */
function decodeScryptHeader(b64: string): ScryptHeader {
  const buf = Buffer.from(b64, "base64");
  expect(buf.length).toBe(SCRYPT_KDF_LENGTH);
  expect(buf.subarray(0, 6).toString("latin1")).toBe("scrypt");
  return {
    version: buf.readUInt8(6),
    logN: buf.readUInt8(7),
    r: buf.readUInt32BE(8),
    p: buf.readUInt32BE(12),
    salt: buf.subarray(16, 48).toString("hex"),
  };
}

const params = (h: ScryptHashConfig) => ({ logN: h.logN, r: h.r, p: h.p });
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? Number.NaN;

describe("tham số scrypt của emailpass (tĩnh)", () => {
  it("cấu hình dùng cho mọi môi trường = mức tối thiểu OWASP N=2^17, r=8, p=1", () => {
    expect(params(EMAILPASS_HASH_CONFIG)).toEqual({ logN: 17, r: 8, p: 1 });
    expect(meetsOwaspScryptMinimum(EMAILPASS_HASH_CONFIG)).toBe(true);
    expect(Object.isFrozen(EMAILPASS_HASH_CONFIG)).toBe(true);
    expect(Object.isFrozen(OWASP_SCRYPT_MIN)).toBe(true);
  });

  it("mặc định Medusa (logN 15) và mọi cấu hình thấp hơn/sai kiểu đều không đạt mức tối thiểu", () => {
    expect(meetsOwaspScryptMinimum(MEDUSA_DEFAULT_SCRYPT)).toBe(false);
    for (const bad of [
      { logN: 16, r: 8, p: 1 },
      { logN: 17, r: 7, p: 1 },
      { logN: 17, r: 8, p: 0 },
      { logN: 17.5, r: 8, p: 1 },
      { logN: Number.NaN, r: 8, p: 1 },
      { logN: 0, r: 0, p: 0 },
    ]) {
      expect(meetsOwaspScryptMinimum(bad)).toBe(false);
    }
    expect(meetsOwaspScryptMinimum({ logN: 18, r: 8, p: 1 })).toBe(true);
  });
});

type Res = { status: number; data: Record<string, unknown>; headers: Record<string, unknown> };
interface Api {
  post(url: string, body?: unknown, config?: unknown): Promise<Res>;
}

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let ipSeq = 0;

    beforeAll(() => {
      container = getContainer();
    });

    /** Mỗi lần đăng nhập một IP riêng (loopback là proxy tin cậy trong test) — bộ đếm theo IP không chen vào kết quả. */
    const login = (email: string, password: string) =>
      api.post(
        "/auth/user/emailpass",
        { email, password },
        { ...noThrow, headers: { "x-forwarded-for": `198.51.100.${(ipSeq++ % 250) + 1}` } },
      );

    const db = () => container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);

    /** Chuỗi băm đang lưu trong DB cho identity emailpass của email. */
    async function storedHash(email: string): Promise<string> {
      const row = await db()("provider_identity")
        .where({ entity_id: email, provider: "emailpass" })
        .whereNull("deleted_at")
        .first<{ provider_metadata: Record<string, unknown> | null } | undefined>("provider_metadata");
      const hash = row?.provider_metadata?.password;
      if (typeof hash !== "string") throw new Error("không có hash emailpass trong DB");
      return hash;
    }

    /** Provider của chính dự án với `hashConfig` tuỳ chọn — sinh hash như phiên bản trước (không tự tính scrypt). */
    function providerWith(hashConfig: ScryptHashConfig) {
      const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
      return new TimingSafeEmailPassAuthService({ logger }, { hashConfig: { ...hashConfig } });
    }

    it("cấu hình server đang chạy truyền đúng hashConfig cho provider emailpass", () => {
      const config = container.resolve(ContainerRegistrationKeys.CONFIG_MODULE) as {
        modules?: Record<string, { options?: { providers?: { id?: string; options?: unknown }[] } }>;
      };
      const auth = Object.values(config.modules ?? {}).find(
        (m) => m.options?.providers?.some((p) => p.id === "emailpass") === true,
      );
      const emailpass = auth?.options?.providers?.find((p) => p.id === "emailpass");
      expect(emailpass?.options).toEqual({ hashConfig: { logN: 17, r: 8, p: 1 } });
    });

    it("đăng ký: chuỗi băm trong DB là scrypt-kdf với logN 17, r 8, p 1; salt riêng; không chứa mật khẩu", async () => {
      const a = await createAdmin(rawApi, container, { roles: [] });
      const b = await createAdmin(rawApi, container, { roles: [] });
      const ha = await storedHash(a.email);
      const hb = await storedHash(b.email);
      const da = decodeScryptHeader(ha);
      expect(params(da)).toEqual({ logN: 17, r: 8, p: 1 });
      expect(da.version).toBe(0);
      expect(params(decodeScryptHeader(hb))).toEqual({ logN: 17, r: 8, p: 1 });
      expect(da.salt).not.toBe(decodeScryptHeader(hb).salt);
      expect(ha).not.toContain(a.password);
      expect(Buffer.from(ha, "base64").toString("latin1")).not.toContain(a.password);
      // Bằng chứng hash đúng là của mật khẩu này: đăng nhập được.
      expect((await login(a.email, a.password)).status).toBe(200);
    });

    describe("đổi mật khẩu qua token đặt lại (POST /auth/user/emailpass/update)", () => {
      it("được phép: token reset hợp lệ → hash mới logN 17; mật khẩu mới vào được, mật khẩu cũ bị từ chối", async () => {
        const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
        const target = await createAdmin(rawApi, container, { roles: [] });
        const before = await storedHash(target.email);

        const reset = await api.post(
          `/admin/users/${target.userId}/reset-password`,
          {},
          {
            ...noThrow,
            headers: owner.headers,
          },
        );
        expect(reset.status).toBe(200);
        const newPassword = `SENTINEL-doi-${randomUUID()}`;
        const upd = await api.post(
          "/auth/user/emailpass/update",
          { password: newPassword },
          {
            ...noThrow,
            headers: { authorization: `Bearer ${String(reset.data.token)}` },
          },
        );
        expect(upd.status).toBe(200);

        const after = await storedHash(target.email);
        expect(after).not.toBe(before);
        expect(params(decodeScryptHeader(after))).toEqual({ logN: 17, r: 8, p: 1 });
        expect((await login(target.email, newPassword)).status).toBe(200);
        expect((await login(target.email, target.password)).status).toBe(401);
      });

      it("bị từ chối: token phiên (không phải token reset) → 401, hash trong DB không đổi", async () => {
        const target = await createAdmin(rawApi, container, { roles: [] });
        const before = await storedHash(target.email);
        const upd = await api.post(
          "/auth/user/emailpass/update",
          { password: "SENTINEL-khong-duoc" },
          {
            ...noThrow,
            headers: target.headers,
          },
        );
        expect(upd.status).toBe(401);
        expect(await storedHash(target.email)).toBe(before);
        expect((await login(target.email, target.password)).status).toBe(200);
      });
    });

    /** Mô phỏng tài khoản tạo trước T-181: ghi đè hash trong DB bằng hash tham số cũ (logN 15), giữ metadata khác. */
    async function withLegacyHash(email: string): Promise<{ password: string; hash: string }> {
      const password = `SENTINEL-cu-${randomUUID()}`;
      const hash = await providerWith(MEDUSA_DEFAULT_SCRYPT).hashPassword(password);
      expect(params(decodeScryptHeader(hash))).toEqual({ logN: 15, r: 8, p: 1 });
      const row = await db()("provider_identity")
        .where({ entity_id: email, provider: "emailpass" })
        .first<{ id: string; provider_metadata: Record<string, unknown> }>("id", "provider_metadata");
      await db()("provider_identity")
        .where({ id: row.id })
        .update({ provider_metadata: JSON.stringify({ ...row.provider_metadata, password: hash }) });
      expect(await storedHash(email)).toBe(hash);
      return { password, hash };
    }

    describe("hash tham số cũ (logN 15): tương thích ngược + băm lại khi đăng nhập (D-137)", () => {
      it("sai mật khẩu → 401, hash không đổi; đúng → 200 và hash trong DB thành logN 17; đăng nhập lại 200", async () => {
        const admin = await createAdmin(rawApi, container, { roles: [] });
        const legacy = await withLegacyHash(admin.email);

        expect((await login(admin.email, admin.password)).status).toBe(401);
        expect((await login(admin.email, "SENTINEL-sai")).status).toBe(401);
        expect(await storedHash(admin.email)).toBe(legacy.hash);

        expect((await login(admin.email, legacy.password)).status).toBe(200);
        const upgraded = await storedHash(admin.email);
        expect(upgraded).not.toBe(legacy.hash);
        expect(params(decodeScryptHeader(upgraded))).toEqual({ logN: 17, r: 8, p: 1 });

        expect((await login(admin.email, legacy.password)).status).toBe(200);
        // Đã đạt chuẩn → không băm lại nữa.
        expect(await storedHash(admin.email)).toBe(upgraded);
        expect((await login(admin.email, "SENTINEL-sai")).status).toBe(401);
      });

      it("GO-NO-GO: scripts/ops/check-scrypt-params.mjs đếm hash dưới chuẩn → exit 1; sau đăng nhập đúng (băm lại) → exit 0", async () => {
        const { rows } = await db().raw<{ rows: { name: string }[] }>("select current_database() as name");
        const url = new URL("postgres://localhost");
        url.hostname = process.env.DB_HOST ?? "localhost";
        url.port = process.env.DB_PORT ?? "5432";
        url.username = process.env.DB_USERNAME ?? "";
        url.password = process.env.DB_PASSWORD ?? "";
        url.pathname = `/${rows[0]!.name}`;
        const script = path.resolve(__dirname, "../../../../scripts/ops/check-scrypt-params.mjs");
        const check = () =>
          new Promise<{ code: number; out: string }>((resolve) => {
            // URL qua env (script không nhận đối số — tránh lộ mật khẩu DB trong ps).
            execFile(
              process.execPath,
              [script],
              { env: { ...process.env, DATABASE_URL: url.toString() } },
              (err, stdout) => {
                resolve({ code: err ? Number((err as { code?: unknown }).code ?? 1) : 0, out: stdout });
              },
            );
          });

        const admin = await createAdmin(rawApi, container, { roles: [] });
        const clean = await check();
        expect(clean.code).toBe(0);
        expect(clean.out).toMatch(/dưới chuẩn 0 · sai định dạng 0/);

        const legacy = await withLegacyHash(admin.email);
        const dirty = await check();
        expect(dirty.code).toBe(1);
        expect(dirty.out).toMatch(/dưới chuẩn 1 /);
        expect(dirty.out).not.toContain(admin.email);
        expect(dirty.out).not.toContain(legacy.hash);

        expect((await login(admin.email, legacy.password)).status).toBe(200);
        expect((await check()).code).toBe(0);
      });

      it("đồng thời: hai đăng nhập đúng song song → cả hai 200, hash cuối logN 17 và vẫn đăng nhập được", async () => {
        const admin = await createAdmin(rawApi, container, { roles: [] });
        const legacy = await withLegacyHash(admin.email);
        const both = await Promise.all([
          login(admin.email, legacy.password),
          login(admin.email, legacy.password),
        ]);
        expect(both.map((r) => r.status)).toEqual([200, 200]);
        expect(params(decodeScryptHeader(await storedHash(admin.email)))).toEqual({ logN: 17, r: 8, p: 1 });
        expect((await login(admin.email, legacy.password)).status).toBe(200);
      });
    });

    it("dồn dập vượt trần scrypt → một phần 503 AUTH_BUSY + Retry-After (cùng thân cho email có/không có), không 5xx khác", async () => {
      const admin = await createAdmin(rawApi, container, { roles: [] });
      // Trần mặc định 3 phép chạy + 32 chờ (UV_THREADPOOL_SIZE mặc định): 60 lần cùng lúc chắc chắn vượt.
      const burst = await Promise.all(
        Array.from({ length: 60 }, (_, i) =>
          api.post(
            "/auth/user/emailpass",
            {
              // ≤ 4 lần sai vào tài khoản thật (dưới ngưỡng theo định danh); còn lại email không tồn tại.
              email: i % 15 === 0 ? admin.email : `khong-${i}-${randomUUID()}@example.test`,
              password: "SENTINEL-sai",
            },
            { ...noThrow, headers: { "x-forwarded-for": `203.0.113.${i + 1}` } },
          ),
        ),
      );
      const statuses = burst.map((r) => r.status);
      expect(statuses.every((s) => s === 401 || s === 503)).toBe(true);
      const busy = burst.filter((r) => r.status === 503);
      expect(busy.length).toBeGreaterThan(0);
      expect(statuses.filter((s) => s === 401).length).toBeGreaterThan(0);
      const shapes = new Set(busy.map((r) => JSON.stringify({ ...r.data, trace_id: null })));
      expect(shapes.size).toBe(1);
      for (const r of busy) {
        expect(r.data.code).toBe("AUTH_BUSY");
        expect(String(r.headers["retry-after"])).toBe("1");
        expect(String(r.headers["content-type"])).toContain("application/problem+json");
      }
      // Hết đợt: tài khoản thật vẫn đăng nhập được (5xx không bị tính là lần sai).
      expect((await login(admin.email, admin.password)).status).toBe(200);
    });

    it("đồng thời: nhiều lần đăng nhập song song với hash logN 17 đều thành công; đo thời gian băm/đăng nhập", async () => {
      const admin = await createAdmin(rawApi, container, { roles: [] });
      expect(params(decodeScryptHeader(await storedHash(admin.email)))).toEqual({ logN: 17, r: 8, p: 1 });
      const results = await Promise.all(Array.from({ length: 4 }, () => login(admin.email, admin.password)));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      const wrong = await Promise.all(Array.from({ length: 2 }, () => login(admin.email, "SENTINEL-sai")));
      expect(wrong.map((r) => r.status)).toEqual([401, 401]);

      // Đo (không assert cứng thời gian — phụ thuộc máy): băm trong tiến trình theo hai cấu hình + đăng nhập HTTP.
      const timeHash = async (c: ScryptHashConfig) => {
        const p = providerWith(c);
        const xs: number[] = [];
        for (let i = 0; i < 3; i++) {
          const t = performance.now();
          await p.hashPassword(`SENTINEL-do-${i}`);
          xs.push(performance.now() - t);
        }
        return Math.round(median(xs));
      };
      const timeLogin = async () => {
        const xs: number[] = [];
        for (let i = 0; i < 3; i++) {
          const t = performance.now();
          expect((await login(admin.email, admin.password)).status).toBe(200);
          xs.push(performance.now() - t);
        }
        return Math.round(median(xs));
      };
      const report = {
        hash_ms_logN15: await timeHash(MEDUSA_DEFAULT_SCRYPT),
        hash_ms_logN17: await timeHash(EMAILPASS_HASH_CONFIG),
        login_http_ms_logN17: await timeLogin(),
      };
      console.info(`[password-hash] thời gian đo (trung vị 3 lần): ${JSON.stringify(report)}`);
      expect(report.hash_ms_logN17).toBeGreaterThan(0);
    });
  },
});
