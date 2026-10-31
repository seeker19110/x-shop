import type {
  AuthenticationInput,
  AuthenticationResponse,
  AuthIdentityDTO,
  AuthIdentityProviderService,
  Logger,
} from "@medusajs/framework/types";
import { MedusaError } from "@medusajs/framework/utils";
import EmailPassProvider from "@medusajs/medusa/auth-emailpass";
import { TimingSafeEmailPassAuthService } from "../emailpass";

/**
 * BE-AUTH-003 (T-099): đăng nhập sai với email KHÔNG tồn tại phải tốn thời gian như email tồn tại sai mật khẩu.
 * Đo thời gian CPU bằng trung vị của các mẫu xen kẽ (A/B/A/B…) — bền với nhiễu lịch CPU; ngưỡng 1.5× cho hai đường cùng một
 * scrypt.verify, còn bản gốc của Medusa phải chênh ≥ 5× (chứng minh phép đo đủ nhạy để bắt lỗi).
 */

type Provider = {
  authenticate(d: AuthenticationInput, s: AuthIdentityProviderService): Promise<AuthenticationResponse>;
  register(d: AuthenticationInput, s: AuthIdentityProviderService): Promise<AuthenticationResponse>;
};
type ProviderCtor = new (deps: { logger: Logger }, options: Record<string, unknown>) => Provider;

const OriginalEmailPass = (EmailPassProvider as unknown as { services: ProviderCtor[] }).services[0]!;
const logger = { warn() {}, info() {}, error() {}, debug() {} } as unknown as Logger;

/** Kho identity trong bộ nhớ, cùng hợp đồng `AuthIdentityProviderService` của Auth Module (NOT_FOUND khi không có). */
function memoryIdentities() {
  const byEmail = new Map<string, AuthIdentityDTO>();
  let writes = 0;
  const svc: AuthIdentityProviderService = {
    retrieve: async ({ entity_id }: { entity_id: string }) => {
      const found = byEmail.get(entity_id);
      if (!found) throw new MedusaError(MedusaError.Types.NOT_FOUND, `không có ${entity_id}`);
      return structuredClone(found);
    },
    create: async ({
      entity_id,
      provider_metadata,
    }: {
      entity_id: string;
      provider_metadata?: Record<string, unknown>;
    }) => {
      writes += 1;
      const identity = {
        id: `authid_${byEmail.size + 1}`,
        provider_identities: [
          { id: `prov_${byEmail.size + 1}`, provider: "emailpass", entity_id, provider_metadata },
        ],
      } as unknown as AuthIdentityDTO;
      byEmail.set(entity_id, identity);
      return structuredClone(identity);
    },
    update: async () => {
      writes += 1;
      throw new Error("không dùng trong test");
    },
    setState: async () => undefined,
    getState: async () => null,
  } as unknown as AuthIdentityProviderService;
  return { svc, byEmail, writes: () => writes };
}

const body = (email: string, password: string) => ({ body: { email, password } }) as AuthenticationInput;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Thời gian CPU (user + system, ms) của tiến trình trong một lần gọi — gồm cả thread libuv chạy scrypt (getrusage
 * SELF). Không đo wall-clock: khi cổng chạy song song nhiều tiến trình test, tải CPU của tiến trình khác làm lệch
 * tỷ lệ wall-clock của hai đường cùng một scrypt.verify (đỏ 1.52× hai lần, T-143) dù khối lượng việc như nhau.
 */
async function timeIt(fn: () => Promise<unknown>): Promise<number> {
  const t0 = process.cpuUsage();
  await fn();
  const d = process.cpuUsage(t0);
  return (d.user + d.system) / 1000;
}

/** Trung vị thời gian của hai đường, lấy mẫu xen kẽ sau 2 lượt khởi động. */
async function compare(a: () => Promise<unknown>, b: () => Promise<unknown>, samples = 15) {
  for (let i = 0; i < 2; i++) {
    await a();
    await b();
  }
  const ta: number[] = [];
  const tb: number[] = [];
  for (let i = 0; i < samples; i++) {
    if (i % 2 === 0) {
      ta.push(await timeIt(a));
      tb.push(await timeIt(b));
    } else {
      tb.push(await timeIt(b));
      ta.push(await timeIt(a));
    }
  }
  // Tỷ lệ theo cặp đo liền kề (cùng cửa sổ tải máy): trung vị log-tỷ lệ bền với tải dao động theo đợt
  // hơn so sánh hai trung vị riêng (mỗi trung vị có thể rơi vào cửa sổ tải khác nhau). Ngưỡng không đổi.
  const logRatios = ta.map((x, i) => Math.log(x / Math.max(tb[i] ?? x, 0.01)));
  return { a: median(ta), b: median(tb), pairRatio: Math.exp(Math.abs(median(logRatios))) };
}

jest.setTimeout(60_000);

describe("đăng nhập emailpass: thời gian phản hồi không phân biệt tài khoản tồn tại (login-timing)", () => {
  const EMAIL = "admin@x-shop.test";
  const PASSWORD = "mat-khau-dung-0123456789";
  let store: ReturnType<typeof memoryIdentities>;
  let safe: Provider;
  let original: Provider;

  beforeAll(async () => {
    store = memoryIdentities();
    // Cấu hình hash mặc định của Medusa (logN 15) cho cả hai provider — rẻ hơn production (logN 17, ADR-0006); test so
    // tỷ lệ thời gian giữa hai nhánh cùng tham số nên không phụ thuộc logN.
    safe = new (TimingSafeEmailPassAuthService as unknown as ProviderCtor)({ logger }, {});
    original = new OriginalEmailPass({ logger }, {});
    expect((await safe.register(body(EMAIL, PASSWORD), store.svc)).success).toBe(true);
    // Identity có nhưng không có hash mật khẩu emailpass (vd tạo bằng provider khác).
    store.byEmail.set("no-hash@x-shop.test", {
      id: "authid_nohash",
      provider_identities: [{ id: "prov_nohash", provider: "emailpass", provider_metadata: {} }],
    } as unknown as AuthIdentityDTO);
  });

  it("được phép: đúng mật khẩu → thành công; bị từ chối: sai mật khẩu / email không có → cùng thân lỗi", async () => {
    const ok = await safe.authenticate(body(EMAIL, PASSWORD), store.svc);
    expect(ok.success).toBe(true);
    const wrong = await safe.authenticate(body(EMAIL, "sai-mat-khau"), store.svc);
    const missing = await safe.authenticate(body("khong-co@x-shop.test", "sai-mat-khau"), store.svc);
    const noHash = await safe.authenticate(body("no-hash@x-shop.test", "sai-mat-khau"), store.svc);
    expect(wrong).toEqual({ success: false, error: "Invalid email or password" });
    expect(missing).toEqual(wrong);
    expect(noHash).toEqual(wrong);
  });

  it("đầu vào sai kiểu giữ nguyên lỗi của Medusa, không chạy scrypt mồi", async () => {
    expect(await safe.authenticate({ body: { email: EMAIL } } as AuthenticationInput, store.svc)).toEqual({
      success: false,
      error: "Password should be a string",
    });
    expect(await safe.authenticate({ body: { password: "x" } } as AuthenticationInput, store.svc)).toEqual({
      success: false,
      error: "Email should be a string",
    });
  });

  it("bản gốc của Medusa LỘ tài khoản qua thời gian (email không có nhanh hơn ≥ 5×) — phép đo đủ nhạy", async () => {
    const t = await compare(
      () => original.authenticate(body(EMAIL, "sai-mat-khau"), store.svc),
      () => original.authenticate(body("khong-co@x-shop.test", "sai-mat-khau"), store.svc),
      9,
    );
    expect(t.a / Math.max(t.b, 0.01)).toBeGreaterThanOrEqual(5);
    expect(t.pairRatio).toBeGreaterThanOrEqual(5); // ước lượng theo cặp cũng bắt được lộ thời gian
  });

  it("bản bọc: email không có ≈ email có sai mật khẩu (trung vị chênh ≤ 1.5×)", async () => {
    const t = await compare(
      () => safe.authenticate(body(EMAIL, "sai-mat-khau"), store.svc),
      () => safe.authenticate(body(`khong-co-${Math.random()}@x-shop.test`, "sai-mat-khau"), store.svc),
    );
    expect(t.pairRatio).toBeLessThanOrEqual(1.5);
  });

  it("bản bọc: identity không có hash mật khẩu ≈ sai mật khẩu (≤ 1.5×)", async () => {
    const t = await compare(
      () => safe.authenticate(body(EMAIL, "sai-mat-khau"), store.svc),
      () => safe.authenticate(body("no-hash@x-shop.test", "sai-mat-khau"), store.svc),
    );
    expect(t.pairRatio).toBeLessThanOrEqual(1.5);
  });

  it("đồng thời: 10 lần dò email không có song song → đều thất bại cùng thân lỗi, không ghi kho identity", async () => {
    const before = store.writes();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        safe.authenticate(body(`song-song-${i}@x-shop.test`, "sai-mat-khau"), store.svc),
      ),
    );
    for (const r of results) expect(r).toEqual({ success: false, error: "Invalid email or password" });
    expect(store.writes()).toBe(before);
    // Không tạo identity nào cho email lạ.
    expect([...store.byEmail.keys()].some((k) => k.startsWith("song-song-"))).toBe(false);
  });

  it("lỗi kho identity khác NOT_FOUND → trả lỗi như bản gốc (không nuốt)", async () => {
    const broken = {
      ...store.svc,
      retrieve: async () => {
        throw new Error("db down");
      },
    } as AuthIdentityProviderService;
    expect(await safe.authenticate(body(EMAIL, PASSWORD), broken)).toEqual({
      success: false,
      error: "db down",
    });
  });
});
