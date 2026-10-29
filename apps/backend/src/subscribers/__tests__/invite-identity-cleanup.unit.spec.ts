import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import inviteIdentityCleanup from "../invite-identity-cleanup";

/** Payload `invite.deleted|resent` đến từ Event Bus: sai/quá dài → bỏ qua có log, không chạm module nào (BASE-SEC-001). */
function setup() {
  const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
  const resolved: string[] = [];
  const container = {
    resolve: jest.fn((key: string) => {
      resolved.push(key);
      if (key === ContainerRegistrationKeys.LOGGER) return logger;
      throw new Error("module không dùng trong test");
    }),
  };
  const run = (data: unknown) =>
    inviteIdentityCleanup({
      event: { name: "invite.deleted", data },
      container,
      pubSubService: undefined,
    } as never);
  return { logger, resolved, run };
}

describe("subscriber invite-identity-cleanup: payload qua zod", () => {
  it.each([
    ["thiếu data", undefined],
    ["data null", null],
    ["thiếu id", {}],
    ["id rỗng", { id: "" }],
    ["id sai kiểu (số)", { id: 5 }],
    ["id là mảng", { id: ["a"] }],
    ["id là object", { id: { $ne: 1 } }],
    ["id quá dài (129)", { id: "i".repeat(129) }],
  ])("%s → bỏ qua, ghi cảnh báo, không chạm module khác", async (_name, data) => {
    const { logger, resolved, run } = setup();
    await run(data);
    expect(resolved).toEqual([ContainerRegistrationKeys.LOGGER]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain("invite.deleted");
    expect(String(logger.warn.mock.calls[0]?.[0])).not.toContain("iiiiiiii");
  });

  it("id đúng 128 ký tự hợp lệ → chạy dọn dẹp (lỗi module được bắt và ghi log, không ném)", async () => {
    const { logger, resolved, run } = setup();
    await expect(run({ id: "i".repeat(128) })).resolves.toBeUndefined();
    expect(resolved.length).toBeGreaterThan(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
