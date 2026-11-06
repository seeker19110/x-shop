import type {
  AuthenticationInput,
  AuthenticationResponse,
  AuthIdentityDTO,
  AuthIdentityProviderService,
  Logger,
} from "@medusajs/framework/types";
import { MedusaError } from "@medusajs/framework/utils";
import { TimingSafeEmailPassAuthService } from "../emailpass";
import {
  EMAILPASS_HASH_CONFIG,
  MEDUSA_DEFAULT_SCRYPT,
  needsRehash,
  scryptParamsFromHash,
  type ScryptHashConfig,
} from "../password-hash";

/**
 * D-137 (T-181, ADR-0006): đăng nhập đúng với chuỗi băm tham số cũ (dưới mức OWASP) → băm lại bằng `hashPassword` của
 * provider và ghi theo kiểu so-và-ghi; đăng nhập sai / hash đã đạt chuẩn → không ghi; lỗi khi băm lại không làm hỏng
 * đăng nhập. Hash thật do provider Medusa sinh (scrypt-kdf), test chỉ đọc header.
 */

jest.setTimeout(60_000);

type Provider = {
  authenticate(d: AuthenticationInput, s: AuthIdentityProviderService): Promise<AuthenticationResponse>;
  hashPassword(password: string): Promise<string>;
};
type ProviderCtor = new (deps: { logger: Logger }, options: Record<string, unknown>) => Provider;
const Safe = TimingSafeEmailPassAuthService as unknown as ProviderCtor;

const EMAIL = "rehash@example.test";
const PASSWORD = "SENTINEL-mat-khau-rehash";

function makeLogger() {
  const warns: string[] = [];
  const logger = {
    warn: (m: string) => warns.push(m),
    info() {},
    error() {},
    debug() {},
  } as unknown as Logger;
  return { logger, warns };
}

/** Kho một identity emailpass trong bộ nhớ; `beforeUpdate` cho phép chen thay đổi đồng thời/lỗi trước khi ghi. */
function store(initialHash: string) {
  let hash = initialHash;
  let extra: Record<string, unknown> = { giu_nguyen: "metadata-khac" };
  const updates: Record<string, unknown>[] = [];
  const hooks: { onRetrieve?: (n: number) => void; failUpdate?: boolean } = {};
  let retrieves = 0;
  const identity = (): AuthIdentityDTO =>
    ({
      id: "authid_1",
      provider_identities: [
        {
          id: "prov_1",
          provider: "emailpass",
          entity_id: EMAIL,
          provider_metadata: { ...extra, password: hash },
        },
      ],
    }) as unknown as AuthIdentityDTO;
  const svc = {
    retrieve: async ({ entity_id }: { entity_id: string }) => {
      if (entity_id !== EMAIL) throw new MedusaError(MedusaError.Types.NOT_FOUND, "không có");
      hooks.onRetrieve?.(++retrieves);
      return identity();
    },
    update: async (_entityId: string, data: { provider_metadata?: Record<string, unknown> }) => {
      if (hooks.failUpdate === true) throw new Error(`lỗi DB khi ghi ${EMAIL}`);
      updates.push(data);
      const { password, ...rest } = data.provider_metadata ?? {};
      if (typeof password === "string") hash = password;
      extra = rest;
      return identity();
    },
    create: async () => {
      throw new Error("không dùng");
    },
    setState: async () => undefined,
    getState: async () => null,
  } as unknown as AuthIdentityProviderService;
  return {
    svc,
    updates,
    hooks,
    hash: () => hash,
    setHash: (h: string) => (hash = h),
    extra: () => extra,
  };
}

const body = (email: string, password: string) => ({ body: { email, password } }) as AuthenticationInput;
const params = (h: string) => scryptParamsFromHash(h);

async function legacyHash(password: string, config: ScryptHashConfig = MEDUSA_DEFAULT_SCRYPT) {
  const { logger } = makeLogger();
  return new Safe({ logger }, { hashConfig: { ...config } }).hashPassword(password);
}

describe("đọc tham số từ chuỗi băm", () => {
  it("chuỗi không đúng định dạng scrypt-kdf → null, không băm lại", () => {
    for (const bad of ["", "khong-phai-base64", Buffer.alloc(96).toString("base64"), "c2NyeXB0"]) {
      expect(scryptParamsFromHash(bad)).toBeNull();
      expect(needsRehash(bad, EMAILPASS_HASH_CONFIG)).toBe(false);
    }
  });

  it("hash logN 15 cần băm lại khi cấu hình đạt OWASP; không khi cấu hình vẫn là mặc định Medusa", async () => {
    const h = await legacyHash(PASSWORD);
    expect(params(h)).toEqual({ logN: 15, r: 8, p: 1 });
    expect(needsRehash(h, EMAILPASS_HASH_CONFIG)).toBe(true);
    expect(needsRehash(h, MEDUSA_DEFAULT_SCRYPT)).toBe(false);
  });
});

describe("băm lại khi đăng nhập (D-137)", () => {
  const safe = (logger: Logger, config: ScryptHashConfig | null = EMAILPASS_HASH_CONFIG) =>
    new Safe({ logger }, config ? { hashConfig: { ...config } } : {});

  it("được phép: đúng mật khẩu với hash logN 15 → hash mới logN 17, giữ metadata khác, đăng nhập lại được", async () => {
    const s = store(await legacyHash(PASSWORD));
    const { logger, warns } = makeLogger();
    const p = safe(logger);
    expect((await p.authenticate(body(EMAIL, PASSWORD), s.svc)).success).toBe(true);
    expect(s.updates).toHaveLength(1);
    expect(params(s.hash())).toEqual({ logN: 17, r: 8, p: 1 });
    expect(s.extra()).toEqual({ giu_nguyen: "metadata-khac" });
    expect(warns).toEqual([]);
    expect((await p.authenticate(body(EMAIL, PASSWORD), s.svc)).success).toBe(true);
    expect(s.updates).toHaveLength(1); // đã đạt chuẩn → không ghi thêm
  });

  it("bị từ chối: sai mật khẩu → không ghi, hash cũ giữ nguyên", async () => {
    const old = await legacyHash(PASSWORD);
    const s = store(old);
    const { logger } = makeLogger();
    expect(await safe(logger).authenticate(body(EMAIL, "SENTINEL-sai"), s.svc)).toEqual({
      success: false,
      error: "Invalid email or password",
    });
    expect(s.updates).toHaveLength(0);
    expect(s.hash()).toBe(old);
  });

  it("cấu hình provider dưới chuẩn (mặc định Medusa) → không băm lại vô ích", async () => {
    const s = store(await legacyHash(PASSWORD));
    const { logger } = makeLogger();
    expect((await safe(logger, null).authenticate(body(EMAIL, PASSWORD), s.svc)).success).toBe(true);
    expect(s.updates).toHaveLength(0);
  });

  it("lỗi khi ghi → đăng nhập vẫn thành công, chỉ log cảnh báo không chứa email/mật khẩu", async () => {
    const old = await legacyHash(PASSWORD);
    const s = store(old);
    s.hooks.failUpdate = true;
    const { logger, warns } = makeLogger();
    expect((await safe(logger).authenticate(body(EMAIL, PASSWORD), s.svc)).success).toBe(true);
    expect(s.hash()).toBe(old);
    expect(warns).toHaveLength(1);
    expect(warns[0]).not.toContain(EMAIL);
    expect(warns[0]).not.toContain(PASSWORD);
  });

  it("đồng thời: mật khẩu bị đổi giữa lúc kiểm và lúc ghi → không ghi đè hash mới bằng mật khẩu cũ", async () => {
    const s = store(await legacyHash(PASSWORD));
    const changed = await legacyHash("SENTINEL-mat-khau-moi", EMAILPASS_HASH_CONFIG);
    // Lần retrieve thứ 2 là lần đọc lại trước khi ghi (so-và-ghi): giả lập đổi mật khẩu đã xảy ra ngay trước đó.
    s.hooks.onRetrieve = (n) => {
      if (n === 2) s.setHash(changed);
    };
    const { logger } = makeLogger();
    expect((await safe(logger).authenticate(body(EMAIL, PASSWORD), s.svc)).success).toBe(true);
    expect(s.updates).toHaveLength(0);
    expect(s.hash()).toBe(changed);
  });

  it("đồng thời: hai đăng nhập đúng song song → cả hai thành công, hash cuối logN 17 và vẫn kiểm được", async () => {
    const s = store(await legacyHash(PASSWORD));
    const { logger } = makeLogger();
    const p = safe(logger);
    const results = await Promise.all([
      p.authenticate(body(EMAIL, PASSWORD), s.svc),
      p.authenticate(body(EMAIL, PASSWORD), s.svc),
    ]);
    expect(results.map((r) => r.success)).toEqual([true, true]);
    expect(s.updates.length).toBeGreaterThanOrEqual(1);
    expect(params(s.hash())).toEqual({ logN: 17, r: 8, p: 1 });
    expect((await p.authenticate(body(EMAIL, PASSWORD), s.svc)).success).toBe(true);
  });
});
