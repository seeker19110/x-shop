import { Readable, Writable } from "node:stream";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { GET } from "../../../api/admin/x/files/[key]/route";
import { toHttpProblem } from "../../errors/error-handler";

/**
 * Handler `GET /admin/x/files/:key` (T-141) gọi trực tiếp — lớp phòng thủ thứ hai sau cổng admin và các nhánh lỗi stream.
 * Test tích hợp (integration-tests/http/private-file-security.spec.ts) phủ đường đầy đủ qua cổng.
 */

const KEY = "private-1730000000000-01J9ZQ8Y3M4N5P6Q7R8S9T0VWX.csv";

/** Response giả: Writable gom byte + API tối thiểu Express/Medusa mà route và `sendProblem` dùng. */
class FakeRes extends Writable {
  statusCode = 200;
  readonly headers = new Map<string, unknown>();
  body = "";
  headersSent = false;
  req = {};
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  setHeader(name: string, value: unknown) {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }
  getHeader(name: string) {
    return this.headers.get(name.toLowerCase());
  }
  removeHeader(name: string) {
    this.headers.delete(name.toLowerCase());
  }
  send(body: unknown) {
    this.headersSent = true;
    this.body += String(body);
    this.end();
    return this;
  }
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
    this.headersSent = true;
    this.body += chunk.toString("utf8");
    cb();
  }
}

function setup(opts: { roles?: string[] | null; stream?: () => Readable; key?: string } = {}) {
  const getDownloadStream = jest.fn(async () => (opts.stream ?? (() => Readable.from(["a,b\n"])))());
  const req = {
    params: { key: opts.key ?? KEY },
    scope: { resolve: () => ({ getDownloadStream }) },
    ...(opts.roles !== null && {
      x_admin_access: { userId: "user_1", roles: opts.roles ?? ["owner"], permission: "settings.manage" },
    }),
  } as unknown as MedusaRequest;
  const res = new FakeRes();
  return { req, res, call: () => GET(req, res as unknown as MedusaResponse), getDownloadStream };
}

const statusOf = (err: unknown) => toHttpProblem(err, "t").status;

const enoent = () =>
  new Readable({
    read() {
      this.destroy(
        Object.assign(new Error("ENOENT: no such file, open '/srv/bi-mat/x.csv'"), { code: "ENOENT" }),
      );
    },
  });

describe("GET /admin/x/files/:key — handler", () => {
  it("owner → 200, đủ nội dung, attachment, private no-store", async () => {
    const { res, call } = setup();
    await call();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("a,b\n");
    expect(res.getHeader("content-disposition")).toBe(`attachment; filename="${KEY}"`);
    expect(res.getHeader("cache-control")).toBe("private, no-store");
  });

  it.each([["warehouse"], ["catalog_manager"], ["accountant"], ["support"], ["order_staff"], []])(
    "thiếu settings.manage (vai trò %p) → 403, không mở file",
    async (...roles) => {
      const { call, getDownloadStream } = setup({ roles: roles as string[] });
      const err = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(statusOf(err)).toBe(403);
      expect(getDownloadStream).not.toHaveBeenCalled();
    },
  );

  it("cổng admin chưa chạy (không có x_admin_access) → 401, không mở file", async () => {
    const { call, getDownloadStream } = setup({ roles: null });
    const err = await call().then(
      () => null,
      (e: unknown) => e,
    );
    expect(statusOf(err)).toBe(401);
    expect(getDownloadStream).not.toHaveBeenCalled();
  });

  it("khoá sai mẫu → 404, không mở file", async () => {
    const { res, call, getDownloadStream } = setup({ key: "../../etc/passwd" });
    await call();
    expect(res.statusCode).toBe(404);
    expect(getDownloadStream).not.toHaveBeenCalled();
  });

  it("lỗi stream ENOENT trước byte đầu → 404 KHÔNG còn Content-Disposition, không lộ đường dẫn", async () => {
    const { res, call } = setup({ stream: enoent });
    await call();
    expect(res.statusCode).toBe(404);
    expect(res.getHeader("content-disposition")).toBeUndefined();
    expect(res.getHeader("content-type")).toBe("application/problem+json; charset=utf-8");
    expect(JSON.parse(res.body)).toMatchObject({ code: "NOT_FOUND" });
    expect(res.body).not.toContain("/srv/bi-mat");
  });

  it("lỗi stream khác (EACCES) trước byte đầu → ném cho handler toàn cục (500), bỏ Content-Disposition", async () => {
    const eacces = () =>
      new Readable({
        read() {
          this.destroy(Object.assign(new Error("EACCES"), { code: "EACCES" }));
        },
      });
    const { res, call } = setup({ stream: eacces });
    const err = await call().then(
      () => null,
      (e: unknown) => e,
    );
    expect(statusOf(err)).toBe(500);
    expect(res.getHeader("content-disposition")).toBeUndefined();
  });

  it("lỗi giữa chừng sau khi đã gửi byte → cắt kết nối (không kết thúc như file đủ)", async () => {
    let sent = false;
    const midway = () =>
      new Readable({
        read() {
          if (!sent) {
            sent = true;
            this.push("a,b\n");
          } else this.destroy(Object.assign(new Error("EIO"), { code: "EIO" }));
        },
      });
    const { res, call } = setup({ stream: midway });
    await call();
    expect(res.destroyed).toBe(true);
    expect(res.writableFinished).toBe(false);
  });

  it("client đã ngắt trước khi route chạy (close đã phát) → không mở file, handler kết thúc", async () => {
    const { res, call, getDownloadStream } = setup();
    res.destroy();
    await new Promise((r) => setImmediate(r));
    await call();
    expect(getDownloadStream).not.toHaveBeenCalled();
  });

  it("client ngắt trong lúc đang mở file → huỷ stream vừa mở, handler kết thúc", async () => {
    // Stream không tự kết thúc (như file lớn đang đọc): chỉ đóng khi route huỷ nó.
    const stream = new Readable({ read() {} });
    const { res, call } = setup({
      stream: () => {
        res.destroy();
        return stream;
      },
    });
    await call();
    expect(stream.destroyed).toBe(true);
  });
});
