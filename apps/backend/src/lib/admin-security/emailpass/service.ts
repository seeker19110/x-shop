import type {
  AuthenticationInput,
  AuthenticationResponse,
  AuthIdentityDTO,
  AuthIdentityProviderService,
  EmailPassAuthProviderOptions,
  Logger,
} from "@medusajs/framework/types";
import { MedusaError } from "@medusajs/framework/utils";
import EmailPassProvider from "@medusajs/medusa/auth-emailpass";
import { randomBytes } from "node:crypto";
import { MEDUSA_DEFAULT_SCRYPT, needsRehash, type ScryptHashConfig } from "../password-hash";

/**
 * Provider `emailpass` của Medusa, bọc lại để thời gian phản hồi đăng nhập KHÔNG lộ tài khoản có tồn tại hay không
 * (BE-AUTH-003, T-099).
 *
 * Bản gốc (`@medusajs/auth-emailpass` 2.22.1, `authenticate`): email không có → trả "Invalid email or password" NGAY
 * (chỉ một truy vấn DB); email có → chạy scrypt (logN 15 ≈ hàng chục–trăm ms) rồi mới trả cùng thông báo. Chênh lệch
 * này đo được qua mạng → dò được email admin.
 *
 * Ở đây: khi email không có (hoặc identity không có hash mật khẩu emailpass), chạy THÊM một lần `authenticate` gốc với
 * một identity mồi mang hash của chuỗi ngẫu nhiên (cùng `hashConfig`) — cùng đường mã scrypt.verify như tài khoản thật
 * sai mật khẩu — rồi trả kết quả gốc (thông báo/thân lỗi giữ nguyên). Không đổi hành vi khi đăng nhập đúng/sai mật khẩu
 * của tài khoản có thật. `identifier` giữ "emailpass" để provider identity sẵn có và route `/auth/*\/emailpass` không đổi.
 *
 * Băm lại khi đăng nhập (D-137, T-181, ADR-0006): đăng nhập ĐÚNG mà chuỗi băm đang lưu có tham số dưới mức tối thiểu
 * OWASP (vd logN 15 trước T-181) → băm lại bằng chính `hashPassword` của provider (cùng `hashConfig`) và ghi lại theo
 * kiểu so-và-ghi: chỉ ghi khi hash trong DB vẫn là hash vừa kiểm, để đổi mật khẩu chạy song song không bị ghi đè bằng
 * mật khẩu cũ (còn cửa sổ cỡ một truy vấn giữa lần đọc lại và lần ghi — không nguyên tử ở mức DB, ADR-0006). Lỗi khi
 * băm lại chỉ ghi log, không đổi kết quả đăng nhập.
 */
interface EmailPassBase {
  authenticate(data: AuthenticationInput, svc: AuthIdentityProviderService): Promise<AuthenticationResponse>;
  hashPassword(password: string): Promise<string>;
}
type EmailPassCtor = (new (
  deps: { logger: Logger },
  options: EmailPassAuthProviderOptions,
) => EmailPassBase) & {
  identifier: string;
  DISPLAY_NAME: string;
};

/** Lớp gốc trong gói provider; fail fast khi nâng Medusa làm đổi cấu trúc gói — không âm thầm mất lớp bảo vệ. */
function emailPassBase(): EmailPassCtor {
  const services = (EmailPassProvider as unknown as { services?: unknown[] }).services ?? [];
  const klass = services[0] as EmailPassCtor | undefined;
  if (typeof klass !== "function" || klass.identifier !== "emailpass") {
    throw new Error(
      "[admin-security] Không tìm thấy EmailPassAuthService trong @medusajs/medusa/auth-emailpass",
    );
  }
  return klass;
}
const Base = emailPassBase();

const PROVIDER = "emailpass";

function emailpassIdentity(identity: AuthIdentityDTO | null | undefined) {
  return identity?.provider_identities?.find((p) => p.provider === PROVIDER);
}

/** Chuỗi băm mật khẩu emailpass đang lưu, `null` nếu không có. */
function passwordHashOf(identity: AuthIdentityDTO | null | undefined): string | null {
  const password = emailpassIdentity(identity)?.provider_metadata?.password;
  return typeof password === "string" ? password : null;
}

function isNotFound(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && (e as { type?: unknown }).type === MedusaError.Types.NOT_FOUND
  );
}

export class TimingSafeEmailPassAuthService extends Base {
  static override identifier = Base.identifier;
  static override DISPLAY_NAME = Base.DISPLAY_NAME;

  private decoyHash_: Promise<string> | null = null;
  private readonly hashTarget_: ScryptHashConfig;
  private readonly rehashLogger_: Logger;

  constructor(deps: { logger: Logger }, options: EmailPassAuthProviderOptions) {
    super(deps, options);
    this.hashTarget_ = options?.hashConfig ?? MEDUSA_DEFAULT_SCRYPT;
    this.rehashLogger_ = deps.logger;
    // Tính sẵn hash mồi (cùng hashConfig) để lần dò đầu tiên không chậm/nhanh khác thường.
    this.decoy_().catch(() => {
      this.decoyHash_ = null;
    });
  }

  private decoy_(): Promise<string> {
    this.decoyHash_ ??= this.hashPassword(randomBytes(32).toString("hex"));
    return this.decoyHash_;
  }

  /** Chạy `authenticate` gốc trên identity mồi — tốn đúng một scrypt.verify như tài khoản thật sai mật khẩu. */
  private async burn_(data: AuthenticationInput): Promise<void> {
    const hash = await this.decoy_();
    const decoy = {
      id: "authid_decoy",
      provider_identities: [
        { id: "provid_decoy", provider: PROVIDER, provider_metadata: { password: hash } },
      ],
    } as unknown as AuthIdentityDTO;
    const refuse = async (): Promise<never> => {
      throw new MedusaError(MedusaError.Types.NOT_ALLOWED, "identity mồi chỉ đọc");
    };
    const decoyService = {
      retrieve: async () => decoy,
      create: refuse,
      update: refuse,
      setState: refuse,
      getState: refuse,
    } as unknown as AuthIdentityProviderService;
    await super.authenticate(data, decoyService);
  }

  override async authenticate(
    data: AuthenticationInput,
    authIdentityService: AuthIdentityProviderService,
  ): Promise<AuthenticationResponse> {
    let needsBurn = false;
    // Identity có hash đã đưa cho bản gốc kiểm (để băm lại nếu tham số cũ, D-137).
    const seen: { verified: { entityId: string; hash: string } | null } = { verified: null };
    const probe = Object.create(authIdentityService) as AuthIdentityProviderService;
    probe.retrieve = async (selector) => {
      try {
        const identity = await authIdentityService.retrieve(selector);
        const hash = passwordHashOf(identity);
        if (hash === null) needsBurn = true;
        else seen.verified = { entityId: selector.entity_id, hash };
        return identity;
      } catch (e) {
        if (isNotFound(e)) needsBurn = true;
        throw e;
      }
    };
    const result = await super.authenticate(data, probe);
    const password = (data.body as { password?: unknown } | undefined)?.password;
    const legacy = seen.verified;
    if (
      result.success &&
      legacy &&
      typeof password === "string" &&
      needsRehash(legacy.hash, this.hashTarget_)
    ) {
      await this.rehash_(legacy.entityId, legacy.hash, password, authIdentityService);
    }
    if (needsBurn) {
      try {
        await this.burn_(data);
      } catch {
        // Lớp cân thời gian lỗi không được đổi kết quả đăng nhập (vẫn là thất bại như bản gốc).
      }
    }
    return result;
  }

  /** Băm lại bằng tham số hiện hành, ghi khi hash trong DB vẫn là `oldHash` (so-và-ghi); lỗi chỉ ghi log. */
  private async rehash_(
    entityId: string,
    oldHash: string,
    password: string,
    authIdentityService: AuthIdentityProviderService,
  ): Promise<void> {
    try {
      const fresh = await this.hashPassword(password);
      const current = emailpassIdentity(await authIdentityService.retrieve({ entity_id: entityId }));
      if (current?.provider_metadata?.password !== oldHash) return;
      await authIdentityService.update(entityId, {
        provider_metadata: { ...current.provider_metadata, password: fresh },
      });
    } catch (e) {
      // Không ghi email/thông điệp lỗi (có thể chứa dữ liệu DB) — chỉ loại lỗi.
      this.rehashLogger_.warn(
        `[admin-security] Băm lại mật khẩu emailpass thất bại (${e instanceof Error ? e.name : "unknown"})`,
      );
    }
  }
}
