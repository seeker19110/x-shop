import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, generateJwtToken, Modules } from "@medusajs/framework/utils";
import { createCustomerAccountWorkflow } from "@medusajs/medusa/core-flows";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { vnpay } from "@x-shop/domain";
import { expireHolds } from "../../src/lib/checkout/jobs";
import {
  setVnpayGatewayForTest,
  type QueryStatusResult,
  type VnpayGateway,
} from "../../src/lib/checkout/vnpay-gateway";
import { cancelUnverified, notUnverifiedReason } from "../../src/lib/orders/cancel-unverified";
import { AUDIT_MODULE } from "../../src/modules/audit";
import type AuditModuleService from "../../src/modules/audit/service";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { returnsOf } from "../../src/workflows/returns/order-context";
import { MockVnpayRefundGateway, setRefundGatewayForTest } from "../../src/workflows/returns/refund-gateway";
import {
  createAdmin,
  createMfaAdmin,
  jwtPayload,
  loginWithMfa,
  totp,
  type AdminAccount,
  type HttpClient,
  type MfaAdmin,
} from "../helpers/auth";
import { checkoutClient, CONTACT, DEV_VNPAY, ipn, type Api, type Res } from "../helpers/checkout-api";
import {
  inventoryLevel,
  reservationsOf,
  seedCatalog,
  type CatalogFixture,
} from "../helpers/checkout-fixtures";

jest.setTimeout(300 * 1000);

/**
 * `VNPAY_ENABLED=false` lúc đang chạy (như checkout-expiry, T-166): công tắc toàn cục, mặc định tắt → hành vi thật.
 * `"keys"` = VNPAY tắt nhưng còn khoá xác minh IPN.
 */
const vnpaySwitch = globalThis as { __xshopVnpayOff?: "keys" };
jest.mock("../../src/lib/checkout/config", () => {
  const actual = jest.requireActual("../../src/lib/checkout/config");
  const sw = globalThis as { __xshopVnpayOff?: "keys" };
  return { ...actual, getVnpayConfig: () => (sw.__xshopVnpayOff ? null : actual.getVnpayConfig()) };
});

const R = vnpay.IPN_RESPONSES;
const MIN = 60_000;

type Role = "owner" | "order_staff" | "accountant" | "support" | "warehouse" | "catalog_manager";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- thân JSON của API test không có kiểu; kiểm bằng expect từng trường
type J = Record<string, any>;

/** querydr lập trình được theo txnRef (mặc định "chưa trả"); đếm lời gọi theo đơn của test. */
class ScriptedGateway implements VnpayGateway {
  readonly results = new Map<string, QueryStatusResult>();
  readonly seen: string[] = [];
  /** txnRef → promise phải xong trước khi trả lời (giữ lời gọi querydr — tức giữ khóa đơn của route — có chủ đích). */
  readonly holds = new Map<string, Promise<void>>();
  /** txnRef → báo khi lời gọi querydr bắt đầu. */
  readonly started = new Map<string, () => void>();
  async queryStatus(input: { txnRef: string }): Promise<QueryStatusResult> {
    this.seen.push(input.txnRef);
    this.started.get(input.txnRef)?.();
    await this.holds.get(input.txnRef);
    return (
      this.results.get(input.txnRef) ?? { outcome: "not_paid", transactionNo: null, reason: "status_01" }
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = () => `cu-${randomUUID()}`;
const REASON = "Đã đối chiếu cổng merchant VNPAY: không có giao dịch thành công cho txn_ref";
const MREF = "VNP-14422574";

/**
 * T-165 (D-118) — POST /admin/x/orders/:id/cancel-unverified: owner (`payment.override`, MFA) hủy đơn chờ thanh toán có
 * thanh toán chưa xác minh sau khi đối chiếu tay trên cổng merchant. Lý do + mã đối chiếu + Idempotency-Key bắt buộc;
 * dưới khóa `order:<id>` (cùng IPN/job); đóng `payment_unknown`, audit `order.cancelled_unverified`; tiền đến sau → AT09.
 */
medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let fx: CatalogFixture;
    let gateway: ScriptedGateway;
    const staff = {} as Record<Role, MfaAdmin>;
    let ownerNoMfa: AdminAccount;
    const client = checkoutClient(api, () => fx);
    const signer = new vnpay.MockVnpayGateway(DEV_VNPAY);
    const service = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const auditOf = () => container.resolve<AuditModuleService>(AUDIT_MODULE);
    const A = (role: Role) => staff[role].headers;
    const future = (ms: number) => new Date(Date.now() + ms);

    const post = (
      path: string,
      headers: Record<string, string>,
      body: unknown,
      extra: Record<string, string>,
    ) =>
      api.post(path, body, { headers: { ...headers, ...extra }, validateStatus: () => true }) as Promise<
        Res<J>
      >;
    const cancelUv = (
      orderId: string,
      headers: Record<string, string> = A("owner"),
      k: string | null = key(),
      body: object = { reason: REASON, merchant_ref: MREF },
    ) =>
      post(
        `/admin/x/orders/${orderId}/cancel-unverified`,
        headers,
        body,
        k === null ? {} : { "Idempotency-Key": k },
      );

    const fin = async (orderId: string) => (await service().listOrderFinances({ order_id: orderId }))[0]!;
    const nativeStatus = async (orderId: string) =>
      (await container.resolve(Modules.ORDER).retrieveOrder(orderId)).status;
    const outboxOf = async (orderId: string, type: string) =>
      (await service().listOutboxEvents({ aggregate_id: orderId })).filter((e) => e.type === type);
    const cancelRows = async (orderId: string) =>
      (await container.resolve(ContainerRegistrationKeys.PG_CONNECTION)("x_order_cancel").where({
        order_id: orderId,
      })) as Array<{ idempotency_key: string; actor_id: string; reason: string; outcome: string }>;
    const auditEntries = async (orderId: string) =>
      (
        await auditOf().list(
          { action: "order.cancelled_unverified", resource_id: orderId },
          { limit: 10, offset: 0 },
        )
      ).entries;

    /** Đơn VNPAY chờ thanh toán; `unknown` → job hết hạn (giờ tương lai) hỏi cổng không rõ → attempt unknown + payment_unknown. */
    async function vnpayOrder(variant: string, opts: { unknown?: boolean } = {}) {
      const o = await client.placeOrder([[variant, 1]], "vnpay");
      const [pa] = await service().listPaymentAttempts({ order_id: o.orderId });
      if (opts.unknown) {
        gateway.results.set(pa!.txn_ref, { outcome: "unknown", transactionNo: null, reason: "status_91" });
        expect((await expireHolds(container, { now: future(16 * MIN) })).unknown).toContain(o.orderId);
        expect((await service().listPaymentAttempts({ order_id: o.orderId }))[0]!.state).toBe("unknown");
      }
      return { ...o, txnRef: pa!.txn_ref };
    }

    async function registerCustomerToken(): Promise<string> {
      const email = `kh-${randomUUID()}@example.test`;
      const password = "MatKhau-ThuNghiem-123";
      const reg = await container.resolve(Modules.AUTH).register("emailpass", { body: { email, password } });
      expect(reg.success).toBe(true);
      await createCustomerAccountWorkflow(container).run({
        input: { authIdentityId: reg.authIdentity!.id, customerData: { email, first_name: "Khách" } },
      });
      const login = await api.post("/auth/customer/emailpass", { email, password }, client.cfg());
      expect(login.status).toBe(200);
      return String((login.data as unknown as J).token);
    }

    beforeAll(async () => {
      container = getContainer();
      for (const role of [
        "owner",
        "order_staff",
        "accountant",
        "support",
        "warehouse",
        "catalog_manager",
      ] as const) {
        staff[role] = await createMfaAdmin(rawApi as unknown as HttpClient, container, { roles: [role] });
      }
      ownerNoMfa = await createAdmin(rawApi as unknown as HttpClient, container, { roles: ["owner"] });
    });
    afterAll(() => {
      setVnpayGatewayForTest(null);
      setRefundGatewayForTest(null);
      vnpaySwitch.__xshopVnpayOff = undefined;
    });
    beforeEach(async () => {
      container = getContainer();
      fx = await seedCatalog(container, {
        stock: { "Đen/S": 50, "Đen/M": 50, "Trắng/S": 50, "Trắng/M": 50 },
      });
      gateway = new ScriptedGateway();
      setVnpayGatewayForTest(gateway);
      setRefundGatewayForTest(new MockVnpayRefundGateway(DEV_VNPAY));
      vnpaySwitch.__xshopVnpayOff = undefined;
      // Route đòi xác thực lại ≤ 5 phút (D-122): mỗi ca owner đăng nhập lại (mật khẩu + TOTP) để không phụ thuộc thời lượng suite.
      staff.owner = {
        ...staff.owner,
        headers: await loginWithMfa(rawApi as unknown as HttpClient, staff.owner, {
          method: "totp",
          code: totp(staff.owner.secret),
        }),
      };
    });

    /** Token của `base` với claim ghi đè (ký bằng jwtSecret của app) — giả mốc MFA cũ như mfa.spec. */
    function forgeToken(base: MfaAdmin, claims: Record<string, unknown>) {
      const payload = jwtPayload(base.headers.authorization.slice("Bearer ".length));
      const { http } = container.resolve(ContainerRegistrationKeys.CONFIG_MODULE).projectConfig;
      const { exp: _exp, ...rest } = payload;
      const token = generateJwtToken(
        { ...rest, ...claims },
        { secret: http.jwtSecret as string, expiresIn: "1d" },
      );
      return { authorization: `Bearer ${token}` };
    }

    describe("[api5-bfla post /admin/x/orders/{id}/cancel-unverified] quyền payment.override", () => {
      it("owner (MFA) được; order_staff/kế toán/CSKH/kho/catalog → 403 FORBIDDEN; owner chưa MFA → 403 MFA_REQUIRED; ẩn danh/khách → 401; đơn giữ nguyên tới khi owner hủy", async () => {
        const o = await vnpayOrder("Đen/S", { unknown: true });
        for (const role of [
          "order_staff",
          "accountant",
          "support",
          "warehouse",
          "catalog_manager",
        ] as const) {
          const res = await cancelUv(o.orderId, A(role));
          expect({ role, status: res.status, code: res.data.code, permission: res.data.permission }).toEqual({
            role,
            status: 403,
            code: "FORBIDDEN",
            permission: "payment.override",
          });
        }
        const noMfa = await cancelUv(o.orderId, ownerNoMfa.headers);
        expect({ status: noMfa.status, code: noMfa.data.code }).toEqual({
          status: 403,
          code: "MFA_REQUIRED",
        });
        expect((await cancelUv(o.orderId, {})).status).toBe(401);
        const customer = await cancelUv(o.orderId, {
          authorization: `Bearer ${await registerCustomerToken()}`,
        });
        expect(customer.status).toBe(401);
        expect(await fin(o.orderId)).toMatchObject({ state: "awaiting_payment" });
        expect(await reservationsOf(container, fx, "Đen/S")).toHaveLength(1);
        expect(await cancelRows(o.orderId)).toHaveLength(0);
        // Từ chối có dấu vết (rbac.denied) cho kế toán.
        const denied = await auditOf().list(
          { action: "rbac.denied", actor_id: staff.accountant.userId },
          { limit: 5, offset: 0 },
        );
        expect(denied.entries[0]).toMatchObject({
          resource_id: expect.stringMatching(/^POST \/admin\/x\/orders\/.+\/cancel-unverified$/),
          changes: { permission: "payment.override" },
        });

        const ok = await cancelUv(o.orderId, A("owner"));
        expect(ok).toMatchObject({ status: 200, data: { order_id: o.orderId, state: "cancelled" } });
      });

      it("D-122 xác thực lại: owner có MFA nhưng mốc MFA 6 phút trước → 403 REAUTH_REQUIRED (max_age_seconds 300), đơn giữ nguyên; đăng nhập lại (mật khẩu + TOTP) → được", async () => {
        const o = await vnpayOrder("Trắng/M", { unknown: true });
        const stale = forgeToken(staff.owner, {
          mfa_challenge_completed_at: new Date(Date.now() - 6 * MIN).toISOString(),
        });
        const k = key();
        const res = await cancelUv(o.orderId, stale, k);
        expect(res).toMatchObject({
          status: 403,
          data: { code: "REAUTH_REQUIRED", max_age_seconds: 300, permission: "payment.override" },
        });
        expect(res.headers["content-type"]).toContain("application/problem+json");
        // Mốc MFA 4 phút trước còn trong hạn → qua cổng xác thực lại, tới handler (thân thiếu lý do → 422, không hủy).
        const recent = forgeToken(staff.owner, {
          mfa_challenge_completed_at: new Date(Date.now() - 4 * MIN).toISOString(),
        });
        expect((await cancelUv(o.orderId, recent, key(), { merchant_ref: MREF })).status).toBe(422);
        expect(await fin(o.orderId)).toMatchObject({ state: "awaiting_payment" });
        expect(await cancelRows(o.orderId)).toHaveLength(0);
        expect(await inventoryLevel(container, fx, "Trắng/M")).toEqual({ stocked: 50, reserved: 1 });

        const fresh = await loginWithMfa(rawApi as unknown as HttpClient, staff.owner, {
          method: "totp",
          code: totp(staff.owner.secret),
        });
        const ok = await cancelUv(o.orderId, fresh, k);
        expect(ok).toMatchObject({ status: 200, data: { state: "cancelled" } });
        expect(ok.headers["idempotent-replayed"]).toBeUndefined();
      });
    });

    describe("đầu vào bắt buộc", () => {
      it("thiếu/ngắn/dài lý do, thiếu/sai mã đối chiếu, trường lạ, thiếu/sai Idempotency-Key → 422; đơn không có → 404; không đổi gì", async () => {
        const o = await vnpayOrder("Đen/M", { unknown: true });
        const bad: Array<[string, object, string | null]> = [
          ["thiếu lý do", { merchant_ref: MREF }, key()],
          ["lý do rỗng", { reason: "   ", merchant_ref: MREF }, key()],
          ["lý do 9 ký tự", { reason: "Ngắn quá!", merchant_ref: MREF }, key()],
          ["lý do > 500", { reason: "x".repeat(501), merchant_ref: MREF }, key()],
          ["thiếu mã đối chiếu", { reason: REASON }, key()],
          ["mã rỗng", { reason: REASON, merchant_ref: "" }, key()],
          ["mã 5 ký tự", { reason: REASON, merchant_ref: "VNP12" }, key()],
          ["mã có khoảng trắng", { reason: REASON, merchant_ref: "VNP 144225" }, key()],
          ["mã có dấu", { reason: REASON, merchant_ref: "Mãđốichiếu1" }, key()],
          ["mã bắt đầu bằng ký hiệu", { reason: REASON, merchant_ref: "-VNP144225" }, key()],
          ["mã > 64", { reason: REASON, merchant_ref: `V${"1".repeat(64)}` }, key()],
          ["mã không phải chuỗi", { reason: REASON, merchant_ref: 14422574 }, key()],
          ["trường lạ", { reason: REASON, merchant_ref: MREF, force: true }, key()],
          ["thiếu Idempotency-Key", { reason: REASON, merchant_ref: MREF }, null],
          ["Idempotency-Key ngắn", { reason: REASON, merchant_ref: MREF }, "ngan"],
        ];
        for (const [name, body, k] of bad) {
          const res = await cancelUv(o.orderId, A("owner"), k, body);
          expect({ name, status: res.status, code: res.data.code }).toEqual({
            name,
            status: 422,
            code: "VALIDATION",
          });
        }
        // Biên hợp lệ: lý do đúng 10 ký tự, mã đúng 6 và đúng 64 ký tự (khoảng trắng hai đầu được cắt).
        const missing = await cancelUv("order_khong_co", A("owner"));
        expect({ status: missing.status, code: missing.data.code }).toEqual({
          status: 404,
          code: "NOT_FOUND",
        });
        expect(await fin(o.orderId)).toMatchObject({ state: "awaiting_payment" });
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 50, reserved: 1 });
        expect(await cancelRows(o.orderId)).toHaveLength(0);
        expect(gateway.seen.filter((t) => t === o.txnRef)).toHaveLength(1); // chỉ lượt job tạo unknown, route chưa hỏi

        const edge = await cancelUv(o.orderId, A("owner"), key(), {
          reason: "0123456789",
          merchant_ref: `  A${"b".repeat(63)}  `,
        });
        expect(edge.status).toBe(200);
        const six = await vnpayOrder("Trắng/S", { unknown: true });
        expect(
          (await cancelUv(six.orderId, A("owner"), key(), { reason: REASON, merchant_ref: "A1_.:-" })).status,
        ).toBe(200);
      });
    });

    describe("trạng thái sai → 409 mã rõ ràng", () => {
      it("còn hạn giữ hàng (pending) → PAYMENT_NOT_UNVERIFIED hold_active; IPN thất bại (không còn attempt mở) → no_open_payment; đã xác nhận → NOT_AWAITING_PAYMENT confirmed; COD → NOT_AWAITING_PAYMENT placed; không ghi lệnh hủy", async () => {
        // Đơn unknown tạo TRƯỚC: job hết hạn (giờ tương lai) chạy trong vnpayOrder sẽ hủy mọi đơn pending đã có.
        const paid = await vnpayOrder("Trắng/S", { unknown: true });
        const pending = await vnpayOrder("Đen/S");
        const p = await cancelUv(pending.orderId);
        expect({ status: p.status, code: p.data.code, reason: p.data.reason }).toEqual({
          status: 409,
          code: "PAYMENT_NOT_UNVERIFIED",
          reason: "hold_active",
        });

        const failed = await vnpayOrder("Đen/M");
        expect((await ipn(api, signer.pay(failed.paymentUrl, "failed"))).data).toEqual(R.success);
        const f = await cancelUv(failed.orderId);
        expect({ status: f.status, code: f.data.code, reason: f.data.reason }).toEqual({
          status: 409,
          code: "PAYMENT_NOT_UNVERIFIED",
          reason: "no_open_payment",
        });

        expect((await ipn(api, signer.pay(paid.paymentUrl, "success"))).data).toEqual(R.success);
        const c = await cancelUv(paid.orderId);
        expect({ status: c.status, code: c.data.code, state: c.data.state }).toEqual({
          status: 409,
          code: "NOT_AWAITING_PAYMENT",
          state: "confirmed",
        });

        const cod = await client.placeOrder([["Trắng/M", 1]], "cod");
        const d = await cancelUv(cod.orderId);
        expect({ status: d.status, code: d.data.code, state: d.data.state }).toEqual({
          status: 409,
          code: "NOT_AWAITING_PAYMENT",
          state: "placed",
        });

        expect((await fin(pending.orderId)).state).toBe("awaiting_payment");
        expect((await fin(failed.orderId)).state).toBe("awaiting_payment");
        expect((await fin(paid.orderId)).state).toBe("confirmed");
        expect((await fin(cod.orderId)).state).toBe("placed");
        for (const id of [pending.orderId, failed.orderId, paid.orderId, cod.orderId]) {
          expect(await cancelRows(id)).toHaveLength(0);
          expect(await auditEntries(id)).toHaveLength(0);
        }
        expect(await reservationsOf(container, fx, "Đen/S")).toHaveLength(1);
        expect(await reservationsOf(container, fx, "Trắng/S")).toHaveLength(1);
      });

      it("pending QUÁ hạn giữ hàng đủ điều kiện (biên: đúng mốc hết hạn là quá hạn; trước 1 ms → hold_active)", async () => {
        const o = await vnpayOrder("Đen/S");
        const expires = new Date((await fin(o.orderId)).hold_expires_at!);
        const ctx = { actor_type: "user", actor_id: staff.owner.userId, request_id: null, ip_hash: null };
        const input = {
          order_id: o.orderId,
          actor_id: staff.owner.userId,
          reason: REASON,
          merchant_ref: MREF,
        };
        await expect(
          cancelUnverified(
            container,
            { ...input, idempotency_key: key() },
            ctx,
            new Date(expires.getTime() - 1),
          ),
        ).rejects.toMatchObject({ code: "PAYMENT_NOT_UNVERIFIED", detail: { reason: "hold_active" } });
        const r = await cancelUnverified(container, { ...input, idempotency_key: key() }, ctx, expires);
        expect(r).toEqual({ outcome: "cancelled", from: "awaiting_payment", replayed: false });
        expect(await fin(o.orderId)).toMatchObject({ state: "cancelled" });
        expect(await inventoryLevel(container, fx, "Đen/S")).toEqual({ stocked: 50, reserved: 0 });
        expect((await auditEntries(o.orderId))[0]!.changes).toMatchObject({ payment_state: "pending" });
      });

      it("notUnverifiedReason: ca biên rỗng/null/0", () => {
        const now = new Date("2026-10-27T10:00:00.000Z");
        const at = (iso: string | null) => ({ hold_expires_at: iso });
        expect(notUnverifiedReason(at(null), { state: "unknown" }, 0, now)).toBeNull();
        expect(notUnverifiedReason(at(null), { state: "pending" }, 0, now)).toBe("hold_active");
        expect(notUnverifiedReason(at("2026-10-27T10:15:00.000Z"), { state: "created" }, 0, now)).toBe(
          "hold_active",
        );
        expect(notUnverifiedReason(at("2026-10-27T10:15:00.000Z"), { state: "pending" }, 0, now)).toBe(
          "hold_active",
        );
        expect(notUnverifiedReason(at("2026-10-27T10:00:00.000Z"), { state: "created" }, 0, now)).toBeNull();
        expect(notUnverifiedReason(at("2026-10-27T10:00:00.001Z"), { state: "pending" }, 0, now)).toBe(
          "hold_active",
        );
        expect(notUnverifiedReason(at("2026-10-27T09:00:00.000Z"), undefined, 0, now)).toBe(
          "no_open_payment",
        );
        expect(notUnverifiedReason(at("2026-10-27T09:00:00.000Z"), { state: "failed" }, 0, now)).toBe(
          "no_open_payment",
        );
        expect(notUnverifiedReason(at("2026-10-27T09:00:00.000Z"), { state: "unknown" }, 1, now)).toBe(
          "payment_received",
        );
      });
    });

    describe("hủy chưa xác minh thành công", () => {
      it("unknown → hủy + nhả hàng đúng một lần + hủy native + attempt failed + đóng payment_unknown + outbox SHOP_CANCELLED + audit (không PII khách)", async () => {
        const o = await vnpayOrder("Đen/M", { unknown: true });
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 50, reserved: 1 });
        const openEx = await service().listOpsExceptions({ order_id: o.orderId, kind: "payment_unknown" });
        expect(openEx.map((e) => e.state)).toEqual(["open"]);

        const res = await cancelUv(o.orderId);
        expect(res).toMatchObject({
          status: 200,
          data: {
            order_id: o.orderId,
            state: "cancelled",
            cancel: { outcome: "cancelled", from: "awaiting_payment" },
          },
        });
        expect(res.headers["idempotent-replayed"]).toBeUndefined();
        expect(gateway.seen.filter((t) => t === o.txnRef)).toHaveLength(2); // job + một lần hỏi cuối của route

        expect(await fin(o.orderId)).toMatchObject({ state: "cancelled" });
        expect(await nativeStatus(o.orderId)).toBe("canceled");
        expect(await reservationsOf(container, fx, "Đen/M")).toHaveLength(0);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 50, reserved: 0 });
        expect((await service().listPaymentAttempts({ order_id: o.orderId })).map((p) => p.state)).toEqual([
          "failed",
        ]);
        expect((await service().listCheckoutAttempts({ id: o.attemptId }))[0]).toMatchObject({
          state: "failed",
          error_code: "SHOP_CANCELLED",
        });

        const ex = await service().listOpsExceptions({ order_id: o.orderId, kind: "payment_unknown" });
        expect(ex).toHaveLength(1);
        expect(ex[0]).toMatchObject({ state: "resolved", owner: staff.owner.userId });
        expect(ex[0]!.detail).toMatchObject({
          reason: "status_91",
          resolution: "cancelled_unverified",
          resolved_by: staff.owner.userId,
          merchant_ref: MREF,
        });

        const events = await outboxOf(o.orderId, "order.cancelled");
        expect(events).toHaveLength(1);
        expect(events[0]!.payload).toMatchObject({
          reason: "SHOP_CANCELLED",
          from: "awaiting_payment",
          refund_amount: 0,
        });

        const rows = await cancelRows(o.orderId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ actor_id: staff.owner.userId, reason: REASON, outcome: "cancelled" });
        expect(rows[0]!.idempotency_key).toMatch(/^unverified:/);

        const entries = await auditEntries(o.orderId);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          actor_type: "user",
          actor_id: staff.owner.userId,
          resource_type: "order",
          reason: REASON,
          outcome: "success",
          changes: {
            by: "staff",
            from: "awaiting_payment",
            to: "cancelled",
            merchant_ref: MREF,
            txn_ref: o.txnRef,
            payment_state: "unknown",
            querydr: "unknown", // cổng vẫn không trả lời rõ ở lần hỏi cuối → ghi đè
            payment_unknown_closed: 1,
          },
        });
        expect(entries[0]!.request_id).toEqual(expect.any(String));
        const dump = JSON.stringify(entries[0]);
        for (const pii of [CONTACT.email, "0912", "345 678", CONTACT.name, "Nguyễn"]) {
          expect({ pii, found: dump.includes(pii) }).toEqual({ pii, found: false });
        }
      });

      it("querydr cuối báo ĐÃ TRẢ → đơn xác nhận như IPN, lệnh hủy 409 NOT_AWAITING_PAYMENT, không ghi lệnh/audit, payment_unknown không bị đóng bởi lệnh hủy", async () => {
        const o = await vnpayOrder("Trắng/S", { unknown: true });
        gateway.results.set(o.txnRef, { outcome: "paid", transactionNo: "14999777", reason: "status_00" });
        const res = await cancelUv(o.orderId);
        expect({ status: res.status, code: res.data.code, state: res.data.state }).toEqual({
          status: 409,
          code: "NOT_AWAITING_PAYMENT",
          state: "confirmed",
        });
        expect(await fin(o.orderId)).toMatchObject({ state: "confirmed" });
        expect(await reservationsOf(container, fx, "Trắng/S")).toHaveLength(1);
        expect(await cancelRows(o.orderId)).toHaveLength(0);
        expect(await auditEntries(o.orderId)).toHaveLength(0);
        expect(await outboxOf(o.orderId, "order.cancelled")).toHaveLength(0);
      });

      it("querydr cuối báo ĐÃ TRẢ nhưng sự kiện đó đã xử lý trước với kết quả khác (đơn vẫn chờ, chưa có tiền) → 409 PAYMENT_NOT_UNVERIFIED payment_received, không hủy", async () => {
        const o = await vnpayOrder("Đen/S", { unknown: true });
        // Cùng event key querydr sẽ sinh (txn_ref|mã GD|00|00) đã nằm trong inbox với kết quả 04 → processVerified trả sớm.
        const inbox = await service().recordInbox({
          provider: "vnpay",
          event_key: `${o.txnRef}|14999555|00|00`,
          source: "ipn",
          payload: { vnp_TxnRef: o.txnRef },
          payload_hash: "probe",
          verified: true,
        });
        await service().markInboxProcessed(inbox.id, { RspCode: "04", Message: "Invalid amount" });
        gateway.results.set(o.txnRef, { outcome: "paid", transactionNo: "14999555", reason: "status_00" });
        const res = await cancelUv(o.orderId);
        expect({ status: res.status, code: res.data.code, reason: res.data.reason }).toEqual({
          status: 409,
          code: "PAYMENT_NOT_UNVERIFIED",
          reason: "payment_received",
        });
        expect(await fin(o.orderId)).toMatchObject({ state: "awaiting_payment" });
        expect(await service().listPaymentLedgers({ order_id: o.orderId })).toHaveLength(0);
        expect(await inventoryLevel(container, fx, "Đen/S")).toEqual({ stocked: 50, reserved: 1 });
        expect(await cancelRows(o.orderId)).toHaveLength(0);
        expect(await auditEntries(o.orderId)).toHaveLength(0);
      });

      it("review 🟠1: lỗi khi ghi lệnh hủy hoặc audit (giả lập chết giữa chừng) → rollback cả việc hủy, không có 'đã hủy mà mất dấu'; gửi lại cùng khóa → hủy đủ, đúng một lệnh + một audit, lần sau replay", async () => {
        const cases = [
          ["x_order_cancel", "Trắng/S", () => jest.spyOn(returnsOf(container), "insertOrderCancel")],
          ["audit", "Trắng/M", () => jest.spyOn(auditOf(), "record")],
        ] as const;
        for (const [name, variant, spyOn] of cases) {
          const o = await vnpayOrder(variant, { unknown: true });
          const ctx = { actor_type: "user", actor_id: staff.owner.userId, request_id: null, ip_hash: null };
          const input = {
            order_id: o.orderId,
            actor_id: staff.owner.userId,
            reason: REASON,
            merchant_ref: MREF,
            idempotency_key: key(),
          };
          const spy = spyOn().mockRejectedValueOnce(new Error("crash-simulated"));
          await expect(cancelUnverified(container, input, ctx)).rejects.toThrow("crash-simulated");
          spy.mockRestore();
          expect({ name, state: (await fin(o.orderId)).state }).toEqual({ name, state: "awaiting_payment" });
          expect((await service().listPaymentAttempts({ order_id: o.orderId })).map((p) => p.state)).toEqual([
            "unknown",
          ]);
          expect(
            (await service().listOpsExceptions({ order_id: o.orderId, kind: "payment_unknown" })).map(
              (e) => e.state,
            ),
          ).toEqual(["open"]);
          expect(await cancelRows(o.orderId)).toHaveLength(0);
          expect(await auditEntries(o.orderId)).toHaveLength(0);
          expect(await outboxOf(o.orderId, "order.cancelled")).toHaveLength(0);

          expect(await cancelUnverified(container, input, ctx)).toEqual({
            outcome: "cancelled",
            from: "awaiting_payment",
            replayed: false,
          });
          expect(await fin(o.orderId)).toMatchObject({ state: "cancelled" });
          expect(await cancelRows(o.orderId)).toHaveLength(1);
          expect(await auditEntries(o.orderId)).toHaveLength(1);
          expect(await outboxOf(o.orderId, "order.cancelled")).toHaveLength(1);
          expect(await inventoryLevel(container, fx, variant)).toEqual({ stocked: 50, reserved: 0 });
          expect(await cancelUnverified(container, input, ctx)).toMatchObject({ replayed: true });
        }
      });

      it("review vòng 2: audit ĐÃ ghi rồi mới lỗi → dòng audit bị rollback cùng việc hủy (audit nằm trong transaction); gửi lại → một audit", async () => {
        const o = await vnpayOrder("Đen/S", { unknown: true });
        const a = auditOf();
        const orig = a.record.bind(a);
        const spy = jest.spyOn(a, "record").mockImplementationOnce(async (entry, trx) => {
          await orig(entry, trx);
          throw new Error("crash-after-audit-insert");
        });
        const ctx = { actor_type: "user", actor_id: staff.owner.userId, request_id: null, ip_hash: null };
        const input = {
          order_id: o.orderId,
          actor_id: staff.owner.userId,
          reason: REASON,
          merchant_ref: MREF,
          idempotency_key: key(),
        };
        await expect(cancelUnverified(container, input, ctx)).rejects.toThrow("crash-after-audit-insert");
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
        expect(await auditEntries(o.orderId)).toHaveLength(0);
        expect(await fin(o.orderId)).toMatchObject({ state: "awaiting_payment" });
        expect(await cancelRows(o.orderId)).toHaveLength(0);

        expect(await cancelUnverified(container, input, ctx)).toMatchObject({ replayed: false });
        expect(await auditEntries(o.orderId)).toHaveLength(1);
      });

      it("review vòng 2: cùng Idempotency-Key cho HAI đơn chạy song song → bên sau nhận 409 IDEMPOTENCY_CONFLICT, đơn của nó không bị đụng (native còn, hàng còn giữ)", async () => {
        const o1 = await vnpayOrder("Trắng/S", { unknown: true });
        const o2 = await vnpayOrder("Trắng/M", { unknown: true });
        const k = key();
        // Treo querydr của đơn 1 → lệnh 1 giữ khóa đơn 1 (+ khóa key) trong lúc lệnh 2 (đơn 2, cùng key) được bắn.
        let release!: () => void;
        gateway.holds.set(o1.txnRef, new Promise<void>((r) => (release = r)));
        const started = new Promise<void>((r) => gateway.started.set(o1.txnRef, r));
        const r1p = cancelUv(o1.orderId, A("owner"), k);
        await started;
        const r2p = cancelUv(o2.orderId, A("owner"), k);
        await sleep(500); // lệnh 2 phải đứng chờ khóa key, không được tiến tới querydr/hủy native của đơn 2
        expect(gateway.seen.filter((t) => t === o2.txnRef)).toHaveLength(1); // chỉ lượt job tạo unknown
        expect(await nativeStatus(o2.orderId)).not.toBe("canceled");
        release();
        const [r1, r2] = await Promise.all([r1p, r2p]);
        expect(r1).toMatchObject({ status: 200, data: { order_id: o1.orderId, state: "cancelled" } });
        expect({ status: r2.status, code: r2.data.code }).toEqual({
          status: 409,
          code: "IDEMPOTENCY_CONFLICT",
        });
        expect(await fin(o2.orderId)).toMatchObject({ state: "awaiting_payment" });
        expect(await nativeStatus(o2.orderId)).not.toBe("canceled");
        expect(await inventoryLevel(container, fx, "Trắng/M")).toEqual({ stocked: 50, reserved: 1 });
        expect((await service().listPaymentAttempts({ order_id: o2.orderId })).map((p) => p.state)).toEqual([
          "unknown",
        ]);
        expect(await cancelRows(o2.orderId)).toHaveLength(0);
        expect(await cancelRows(o1.orderId)).toHaveLength(1);
      });

      it("VNPAY đang tắt (không hỏi được cổng) → vẫn ghi đè được; IPN đến sau vẫn xác minh và đi AT09", async () => {
        const o = await vnpayOrder("Trắng/M", { unknown: true });
        vnpaySwitch.__xshopVnpayOff = "keys";
        const before = gateway.seen.length;
        const res = await cancelUv(o.orderId);
        expect(res).toMatchObject({ status: 200, data: { state: "cancelled" } });
        expect(gateway.seen.length).toBe(before);
        expect((await auditEntries(o.orderId))[0]!.changes).toMatchObject({ querydr: "unknown" });
        expect((await ipn(api, signer.pay(o.paymentUrl, "success"))).data).toEqual(R.success);
        expect(await fin(o.orderId)).toMatchObject({ state: "cancelled" });
        expect(await service().listOpsExceptions({ order_id: o.orderId, kind: "late_payment" })).toHaveLength(
          1,
        );

        // RUNBOOK §7 — hoàn ngoài hệ thống (`manual` + mã chứng từ) vẫn dùng được (vd. cổng hoàn chưa bật ở sandbox/live).
        const created = await post(
          "/admin/x/refunds",
          A("accountant"),
          {
            order_id: o.orderId,
            reason: "late_payment",
            amount: o.total,
            method: "manual",
            note: "Hoàn tay",
          },
          { "Idempotency-Key": key() },
        );
        expect(created.status).toBe(201);
        const refundId = String(created.data.refund.id);
        if (created.data.refund.state === "requested") {
          expect((await post(`/admin/x/refunds/${refundId}/approve`, A("owner"), {}, {})).status).toBe(200);
        }
        const exec = await post(
          `/admin/x/refunds/${refundId}/execute`,
          A("accountant"),
          { evidence_ref: "CK-20261027-001" },
          {},
        );
        expect({ status: exec.status, data: exec.data }).toMatchObject({
          status: 200,
          data: { outcome: "succeeded" },
        });
        expect(
          (await service().listOpsExceptions({ order_id: o.orderId, kind: "late_payment" })).map(
            (e) => e.state,
          ),
        ).toEqual(["resolved"]);
      });
    });

    describe("idempotency + đồng thời", () => {
      it("cùng key → cùng kết quả (Idempotent-Replayed); cùng key khác lý do/mã → 409 IDEMPOTENCY_CONFLICT; key khác trên đơn đã hủy → 409 NOT_AWAITING_PAYMENT; hàng nhả đúng một lần", async () => {
        const o = await vnpayOrder("Đen/S", { unknown: true });
        const k = key();
        const first = await cancelUv(o.orderId, A("owner"), k);
        expect(first.status).toBe(200);
        const again = await cancelUv(o.orderId, A("owner"), k);
        expect(again.status).toBe(200);
        expect(again.headers["idempotent-replayed"]).toBe("true");
        expect(again.data).toEqual(first.data);

        const otherReason = await cancelUv(o.orderId, A("owner"), k, {
          reason: `${REASON} (sửa)`,
          merchant_ref: MREF,
        });
        expect({ status: otherReason.status, code: otherReason.data.code }).toEqual({
          status: 409,
          code: "IDEMPOTENCY_CONFLICT",
        });
        const otherRef = await cancelUv(o.orderId, A("owner"), k, {
          reason: REASON,
          merchant_ref: "VNP-99999999",
        });
        expect(otherRef.data.code).toBe("IDEMPOTENCY_CONFLICT");
        // Cùng key dùng cho đơn khác → xung đột, đơn kia không bị hủy.
        const other = await vnpayOrder("Đen/M", { unknown: true });
        expect((await cancelUv(other.orderId, A("owner"), k)).data.code).toBe("IDEMPOTENCY_CONFLICT");
        expect((await fin(other.orderId)).state).toBe("awaiting_payment");

        const fresh = await cancelUv(o.orderId, A("owner"), key());
        expect({ status: fresh.status, code: fresh.data.code, state: fresh.data.state }).toEqual({
          status: 409,
          code: "NOT_AWAITING_PAYMENT",
          state: "cancelled",
        });

        expect(await inventoryLevel(container, fx, "Đen/S")).toEqual({ stocked: 50, reserved: 0 });
        expect(await outboxOf(o.orderId, "order.cancelled")).toHaveLength(1);
        expect(await cancelRows(o.orderId)).toHaveLength(1);
        expect(await auditEntries(o.orderId)).toHaveLength(1);
      });

      it("song song: cùng key ×3 → một lần hủy, hai replay; hai key khác nhau → đúng một 200, một 409; reserved không âm", async () => {
        const a = await vnpayOrder("Đen/S", { unknown: true });
        const k = key();
        const three = await Promise.all([1, 2, 3].map(() => cancelUv(a.orderId, A("owner"), k)));
        expect(three.map((r) => r.status)).toEqual([200, 200, 200]);
        expect(three.filter((r) => r.headers["idempotent-replayed"] === "true")).toHaveLength(2);
        expect(await outboxOf(a.orderId, "order.cancelled")).toHaveLength(1);
        expect(await cancelRows(a.orderId)).toHaveLength(1);
        expect(await auditEntries(a.orderId)).toHaveLength(1);
        expect(await inventoryLevel(container, fx, "Đen/S")).toEqual({ stocked: 50, reserved: 0 });

        const b = await vnpayOrder("Đen/M", { unknown: true });
        const two = await Promise.all([cancelUv(b.orderId), cancelUv(b.orderId)]);
        expect(two.map((r) => (r.status === 200 ? "200" : `${r.status}:${r.data.code}`)).sort()).toEqual([
          "200",
          "409:NOT_AWAITING_PAYMENT",
        ]);
        expect(await outboxOf(b.orderId, "order.cancelled")).toHaveLength(1);
        expect(await cancelRows(b.orderId)).toHaveLength(1);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 50, reserved: 0 });
      });
    });

    describe("tiền đến sau khi hủy (AT09) và đua với IPN", () => {
      it("AT09: hủy chưa xác minh rồi IPN thành công → ghi capture + late_payment, đơn vẫn cancelled, không giữ lại hàng; kế toán hoàn qua cổng đủ số → late_payment đóng", async () => {
        const o = await vnpayOrder("Trắng/S", { unknown: true });
        expect((await cancelUv(o.orderId)).status).toBe(200);
        const paidIpn = signer.pay(o.paymentUrl, "success");
        const txnNo = paidIpn.get("vnp_TransactionNo")!;
        expect((await ipn(api, paidIpn)).data).toEqual(R.success);

        expect(await fin(o.orderId)).toMatchObject({ state: "cancelled" });
        expect(await nativeStatus(o.orderId)).toBe("canceled");
        expect(
          (await service().listPaymentLedgers({ order_id: o.orderId })).map((l) => [l.kind, l.amount]),
        ).toEqual([["capture", o.total]]);
        // T-168: attempt giữ `failed` nhưng mang mã giao dịch của khoản thu (để hoàn qua cổng + đối soát tìm được).
        expect((await service().listPaymentAttempts({ order_id: o.orderId }))[0]).toMatchObject({
          state: "failed",
          provider_txn_no: txnNo,
        });
        const late = await service().listOpsExceptions({ order_id: o.orderId, kind: "late_payment" });
        expect(late.map((e) => [e.amount, e.state])).toEqual([[o.total, "open"]]);
        expect(await outboxOf(o.orderId, "order.confirmed")).toHaveLength(0);
        expect(await inventoryLevel(container, fx, "Trắng/S")).toEqual({ stocked: 50, reserved: 0 });
        // VNPAY gửi lại đúng IPN đó → 02, không ghi thêm tiền/ngoại lệ.
        expect((await ipn(api, paidIpn)).data).toEqual(R.alreadyConfirmed);
        expect(await service().listPaymentLedgers({ order_id: o.orderId })).toHaveLength(1);
        expect(await service().listOpsExceptions({ order_id: o.orderId, kind: "late_payment" })).toHaveLength(
          1,
        );

        // RUNBOOK §7: kế toán xác minh trên cổng → tạo hoàn theo late_payment qua cổng → (duyệt) → thực hiện → ledger
        // ròng 0, late_payment đóng. (Hoàn tay có chứng từ: ca "VNPAY đang tắt" ở trên.)
        const created = await post(
          "/admin/x/refunds",
          A("accountant"),
          {
            order_id: o.orderId,
            reason: "late_payment",
            amount: o.total,
            method: "provider",
            note: "Tiền đến sau khi hủy chưa xác minh",
          },
          { "Idempotency-Key": key() },
        );
        expect(created.status).toBe(201);
        const refundId = String(created.data.refund.id);
        expect(created.data.refund).toMatchObject({
          reason: "late_payment",
          amount: o.total,
          method: "provider",
        });
        if (created.data.refund.state === "requested") {
          expect((await post(`/admin/x/refunds/${refundId}/approve`, A("owner"), {}, {})).status).toBe(200);
        }
        const exec = await post(`/admin/x/refunds/${refundId}/execute`, A("accountant"), {}, {});
        expect({ status: exec.status, data: exec.data }).toMatchObject({
          status: 200,
          data: { outcome: "succeeded" },
        });
        const ledger = await service().listPaymentLedgers({ order_id: o.orderId });
        expect(ledger.map((l) => l.kind).sort()).toEqual(["capture", "refund"]);
        expect(
          (await service().listOpsExceptions({ order_id: o.orderId, kind: "late_payment" })).map(
            (e) => e.state,
          ),
        ).toEqual(["resolved"]);
        expect(await fin(o.orderId)).toMatchObject({ state: "cancelled" });
      });

      it("đua có chủ đích: IPN tới khi route đang giữ khóa đơn (querydr bị treo) → IPN chờ khóa, chưa ghi gì; route hủy xong, IPN đi AT09 (late_payment)", async () => {
        const o = await vnpayOrder("Đen/M", { unknown: true });
        let release!: () => void;
        gateway.holds.set(o.txnRef, new Promise<void>((r) => (release = r)));
        const started = new Promise<void>((r) => gateway.started.set(o.txnRef, r));
        const route = cancelUv(o.orderId);
        await started; // route đã qua kiểm tra trạng thái, đang giữ khóa `order:<id>` trong lời gọi querydr
        const ipnDone = ipn(api, signer.pay(o.paymentUrl, "success"));
        // IPN ghi inbox TRƯỚC khi lấy khóa đơn → chờ tới khi thấy dòng inbox = IPN đã tới và đang chờ khóa.
        const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
        for (let i = 0; i < 100; i++) {
          const rows = (await pg("webhook_inbox").whereLike("event_key", `${o.txnRef}|%`)) as unknown[];
          if (rows.length > 0) break;
          await sleep(50);
        }
        expect(await pg("webhook_inbox").whereLike("event_key", `${o.txnRef}|%`)).toHaveLength(1);
        await sleep(200);
        expect(await fin(o.orderId)).toMatchObject({ state: "awaiting_payment" });
        expect(await service().listPaymentLedgers({ order_id: o.orderId })).toHaveLength(0);

        release();
        const [r, i] = await Promise.all([route, ipnDone]);
        expect(r).toMatchObject({ status: 200, data: { state: "cancelled" } });
        expect(i.data).toEqual(R.success);
        expect(await fin(o.orderId)).toMatchObject({ state: "cancelled" });
        expect((await service().listPaymentLedgers({ order_id: o.orderId })).map((l) => l.amount)).toEqual([
          o.total,
        ]);
        expect(await service().listOpsExceptions({ order_id: o.orderId, kind: "late_payment" })).toHaveLength(
          1,
        );
        expect(await outboxOf(o.orderId, "order.confirmed")).toHaveLength(0);
        expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 50, reserved: 0 });
        expect(await auditEntries(o.orderId)).toHaveLength(1);
      });

      it("IPN thành công ∥ hủy chưa xác minh ×8 lượt, độ trễ lệch cố định theo lượt → mỗi đơn đúng một kết cục; đã xác nhận thì route 409", async () => {
        const outcomes: string[] = [];
        const variants = ["Đen/S", "Đen/M", "Trắng/S", "Trắng/M"];
        for (let round = 0; round < 8; round++) {
          const variant = variants[round % 4]!;
          const o = await vnpayOrder(variant, { unknown: true });
          const params = signer.pay(o.paymentUrl, "success");
          const [d1, d2] = [(round * 7) % 25, (round * 11) % 25];
          const [ipnRes, route] = await Promise.all([
            sleep(d1).then(() => ipn(api, params)),
            sleep(d2).then(() => cancelUv(o.orderId)),
          ]);
          expect(ipnRes.data).toEqual(R.success);
          const f = await fin(o.orderId);
          outcomes.push(f.state);
          const ledger = await service().listPaymentLedgers({ order_id: o.orderId });
          expect(ledger.map((l) => [l.kind, l.amount])).toEqual([["capture", o.total]]);
          const late = await service().listOpsExceptions({ order_id: o.orderId, kind: "late_payment" });
          const reservations = (await reservationsOf(container, fx, variant)).filter((r) =>
            String(r.description).includes(o.attemptId),
          );
          const decisive = [
            ...(await outboxOf(o.orderId, "order.confirmed")),
            ...(await outboxOf(o.orderId, "order.cancelled")),
          ];
          expect(decisive).toHaveLength(1);
          if (f.state === "cancelled") {
            expect(route.status).toBe(200);
            expect(late).toHaveLength(1);
            expect(reservations).toHaveLength(0);
            expect(await nativeStatus(o.orderId)).toBe("canceled");
            expect(await auditEntries(o.orderId)).toHaveLength(1);
          } else {
            expect(f.state).toBe("confirmed");
            expect({ status: route.status, code: route.data.code, state: route.data.state }).toEqual({
              status: 409,
              code: "NOT_AWAITING_PAYMENT",
              state: "confirmed",
            });
            expect(late).toHaveLength(0);
            expect(reservations).toHaveLength(1);
            expect(await cancelRows(o.orderId)).toHaveLength(0);
          }
        }
        for (const [i, variant] of variants.entries()) {
          const confirmed = outcomes.filter((s, r) => r % 4 === i && s === "confirmed").length;
          expect(await inventoryLevel(container, fx, variant)).toEqual({ stocked: 50, reserved: confirmed });
        }
        process.stderr.write(`cancel-unverified ∥ IPN kết cục: ${JSON.stringify(outcomes)}\n`);
      });
    });
  },
});
