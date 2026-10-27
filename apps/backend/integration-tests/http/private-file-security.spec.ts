import { existsSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import type { Role } from "@x-shop/domain";
import { AUDIT_MODULE } from "../../src/modules/audit";
import type AuditModuleService from "../../src/modules/audit/service";
import { createAdmin, createMfaAdmin, type AdminAccount } from "../helpers/auth";

jest.setTimeout(300 * 1000);

/**
 * T-141 — file private ngoài thư mục công khai (BE-FILE-005, hỗ trợ BE-FILE-004).
 *
 * File private (xuất CSV/JSON của Medusa: khách hàng, đơn, tồn, sản phẩm; chunk nhập) ghi vào `PRIVATE_UPLOAD_DIR`, KHÔNG vào
 * `static/` (Express phục vụ công khai `/static`). Tải chỉ qua `GET /admin/x/files/:key` — cổng admin (phiên, RBAC
 * `settings.manage` + MFA, audit từ chối) rồi route kiểm khoá theo mẫu chặt và stream từ thư mục private.
 * Không danh tính → 401; admin thiếu quyền → 403 — CÙNG phản hồi cho khoá có thật và khoá không có (không lộ tồn tại);
 * owner + khoá sai mẫu / traversal / không có → cùng 404.
 */

// Thư mục private riêng cho suite — đặt TRƯỚC khi runner nạp medusa-config (env đọc lúc nạp). Trả lại env ở afterAll:
// worker Jest dùng lại process cho suite sau.
const PRIVATE_DIR = mkdtempSync(join(tmpdir(), "xshop-private-it-"));
const PREVIOUS_PRIVATE_DIR = process.env.PRIVATE_UPLOAD_DIR;
process.env.PRIVATE_UPLOAD_DIR = PRIVATE_DIR;

const STATIC_DIR = join(process.cwd(), "static");
const CSV = "email,phone\nkhach-t141@example.test,0987654321\n";

/** PNG 1×1 hợp lệ. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

/** Khoá đúng mẫu nhưng không có file. */
const MISSING_KEY = "private-1730000000000-01J9ZQ8Y3M4N5P6Q7R8S9T0VWX.csv";

interface Res {
  status: number;
  body: string;
  headers: Headers;
  json: Record<string, unknown>;
}

/** Thân problem bỏ `trace_id` (mỗi request một mã) để so hai phản hồi. */
const comparable = (r: Res) => {
  const { trace_id: _t, ...rest } = r.json;
  return { status: r.status, body: rest };
};

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    let base: URL;
    let container: MedusaContainer;
    let owner: AdminAccount;
    let privateKey: string;
    let privateUrl: string;

    async function get(path: string, headers: Record<string, string> = {}): Promise<Res> {
      const res = await fetch(new URL(path, base), { headers, redirect: "manual" });
      const body = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(body) as Record<string, unknown>;
      } catch {
        // không phải JSON
      }
      return { status: res.status, body, headers: res.headers, json };
    }
    const fileUrl = (key: string) => `/admin/x/files/${key}`;

    beforeAll(async () => {
      base = new URL(String((api as unknown as { defaults: { baseURL: string } }).defaults.baseURL));
      container = getContainer();
      owner = await createMfaAdmin(api as never, container, { roles: ["owner"] });
      // Đi qua File Module như workflow xuất native (exportCustomersStep…): access private, tên client độc.
      const created = await container.resolve(Modules.FILE).createFiles({
        filename: "../../static/khach-hang.csv",
        mimeType: "text/csv",
        content: CSV,
        access: "private",
      });
      privateKey = created.id;
      privateUrl = created.url;
    });

    afterAll(() => {
      if (PREVIOUS_PRIVATE_DIR === undefined) delete process.env.PRIVATE_UPLOAD_DIR;
      else process.env.PRIVATE_UPLOAD_DIR = PREVIOUS_PRIVATE_DIR;
      rmSync(PRIVATE_DIR, { recursive: true, force: true });
    });

    describe("lưu trữ: file private ngoài webroot", () => {
      it("file private nằm trong PRIVATE_UPLOAD_DIR, không có trong `static/`; URL trỏ route admin, không /static", () => {
        expect(privateKey).toMatch(/^private-\d{13}-[0-9A-HJKMNP-TV-Z]{26}\.csv$/);
        expect(readdirSync(PRIVATE_DIR)).toContain(privateKey);
        expect(existsSync(join(STATIC_DIR, privateKey))).toBe(false);
        expect(privateUrl).toBe(new URL(fileUrl(privateKey), "http://localhost:9000").href);
        expect(privateUrl).not.toContain("/static");
      });

      it("truy cập thẳng `/static/<khoá private>` (không đăng nhập và cả owner) → 404, không lộ nội dung", async () => {
        for (const headers of [{}, owner.headers]) {
          const res = await get(`/static/${privateKey}`, headers);
          expect(res.status).toBe(404);
          expect(res.body).not.toContain("khach-t141");
        }
      });

      it("URL của File Module (retrieveFile — nguồn link trong thông báo xuất) trỏ route admin", async () => {
        const file = await container.resolve(Modules.FILE).retrieveFile(privateKey);
        expect(file.url).toBe(privateUrl);
      });

      it("ảnh công khai giữ nguyên hành vi: upload admin → `/static/<khoá>` tải được không cần đăng nhập", async () => {
        const form = new FormData();
        form.append("files", new Blob([new Uint8Array(PNG)], { type: "image/png" }), "ao.png");
        const up = await fetch(new URL("/admin/uploads", base), {
          method: "POST",
          body: form,
          headers: owner.headers,
        });
        expect(up.status).toBe(200);
        const [file] = ((await up.json()) as { files: Array<{ id: string; url: string }> }).files;
        expect(file!.url).toBe(`http://localhost:9000/static/${file!.id}`);
        const res = await fetch(new URL(`/static/${file!.id}`, base));
        expect(res.status).toBe(200);
        expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
        expect(readdirSync(PRIVATE_DIR)).not.toContain(file!.id);
        await fetch(new URL(`/admin/uploads/${encodeURIComponent(file!.id)}`, base), {
          method: "DELETE",
          headers: owner.headers,
        });
      });
    });

    describe("[api5-bfla get /admin/x/files/{key}] tải file private: xác thực + phân quyền", () => {
      it("owner (settings.manage, phiên đã MFA) → 200, đúng nội dung, tải về (attachment), không cache", async () => {
        const res = await get(fileUrl(privateKey), owner.headers);
        expect(res.status).toBe(200);
        expect(res.body).toBe(CSV);
        expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
        expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${privateKey}"`);
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      });

      it("không đăng nhập → 401 như nhau cho khoá có thật và khoá không có", async () => {
        const real = await get(fileUrl(privateKey));
        const missing = await get(fileUrl(MISSING_KEY));
        expect(real.status).toBe(401);
        expect(comparable(real)).toEqual(comparable(missing));
        expect(real.body).not.toContain("khach-t141");
      });

      it("token giả/sai chữ ký → 401, không lộ nội dung", async () => {
        const forged = await get(fileUrl(privateKey), {
          authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.sai",
        });
        expect(forged.status).toBe(401);
        expect(forged.body).not.toContain("khach-t141");
      });

      const OTHER_ROLES: Array<Role[]> = [
        [],
        ["catalog_manager"],
        ["order_staff"],
        ["warehouse"],
        ["support"],
        ["accountant"],
      ];
      it.each(OTHER_ROLES.map((roles) => [roles.join("+") || "(chưa có vai trò)", roles] as const))(
        "admin khác — %s (kể cả đã MFA) → 403 như nhau cho khoá có thật và khoá không có",
        async (_label, roles) => {
          const other = await createMfaAdmin(api as never, container, { roles });
          const real = await get(fileUrl(privateKey), other.headers);
          const missing = await get(fileUrl(MISSING_KEY), other.headers);
          expect(real.status).toBe(403);
          expect(comparable(real)).toEqual(comparable(missing));
          expect(real.body).not.toContain("khach-t141");
        },
      );

      it("owner CHƯA xác minh MFA trong phiên → 403 MFA_REQUIRED như nhau cho khoá có thật/không có", async () => {
        const noMfa = await createAdmin(api as never, container, { roles: ["owner"] });
        const real = await get(fileUrl(privateKey), noMfa.headers);
        const missing = await get(fileUrl(MISSING_KEY), noMfa.headers);
        expect(real.status).toBe(403);
        expect(real.json.code).toBe("MFA_REQUIRED");
        expect(comparable(real)).toEqual(comparable(missing));
      });

      it("owner: khoá không có / sai mẫu / traversal / file công khai → cùng một 404, không đọc ngoài thư mục private", async () => {
        const reference = comparable(await get(fileUrl(MISSING_KEY), owner.headers));
        expect(reference.status).toBe(404);
        const dirName = PRIVATE_DIR.split("/").pop()!;
        const targets = [
          "khong-ton-tai",
          privateKey.toUpperCase(),
          privateKey.replace(/\.csv$/, ".html"),
          `${privateKey}.csv`,
          privateKey.replace(/^private-/, ""),
          encodeURIComponent(`../${dirName}/${privateKey}`),
          encodeURIComponent("../../../../etc/passwd"),
          encodeURIComponent("private-../../../../etc/passwd"),
          encodeURIComponent("/etc/passwd"),
          "..%5C..%5Cwindows%5Cwin.ini",
          "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
          encodeURIComponent(`${privateKey}/../${privateKey}`),
        ];
        for (const target of targets) {
          const res = await get(fileUrl(target), owner.headers);
          expect({ target, ...comparable(res) }).toEqual({ target, ...reference });
        }
        // Thư mục cha (không có route, cổng admin fail-closed) không liệt kê thư mục.
        for (const path of ["/admin/x/files", "/admin/x/files/"]) {
          const listing = await get(path, owner.headers);
          expect(listing.status).toBe(403);
          expect(listing.body).not.toContain(privateKey);
        }
      });

      it("file bị xoá sau khi đã có URL → 404 (không 5xx)", async () => {
        const files = container.resolve(Modules.FILE);
        const tmp = await files.createFiles({
          filename: "x",
          mimeType: "text/csv",
          content: "a\n",
          access: "private",
        });
        expect((await get(fileUrl(tmp.id), owner.headers)).status).toBe(200);
        await files.deleteFiles(tmp.id);
        const gone = await get(fileUrl(tmp.id), owner.headers);
        expect(comparable(gone)).toEqual(comparable(await get(fileUrl(MISSING_KEY), owner.headers)));
      });

      it("luồng thật: xuất khách hàng native → link trong thông báo trỏ route admin; owner tải được, /static và kho thì không", async () => {
        const email = `khach-t141-${Date.now()}@example.test`;
        await container.resolve(Modules.CUSTOMER).createCustomers([{ email, first_name: "T141" }]);
        const exp = await fetch(new URL("/admin/customers/export", base), {
          method: "POST",
          headers: { ...owner.headers, "content-type": "application/json" },
          body: JSON.stringify({ format: "csv" }),
        });
        expect(exp.status).toBe(202);
        const notifications = container.resolve(Modules.NOTIFICATION);
        let url: string | undefined;
        for (let i = 0; i < 150 && url === undefined; i++) {
          const [n] = await notifications.listNotifications(
            { to: owner.userId },
            { take: 1, order: { created_at: "DESC" } },
          );
          url = (n?.data as { file?: { url?: string } } | undefined)?.file?.url ?? undefined;
          if (url === undefined) await new Promise((r) => setTimeout(r, 200));
        }
        expect(url).toMatch(
          /^http:\/\/localhost:9000\/admin\/x\/files\/private-\d{13}-[0-9A-HJKMNP-TV-Z]{26}\.csv$/,
        );
        const key = url!.split("/").pop()!;
        expect(readdirSync(PRIVATE_DIR)).toContain(key);
        expect(existsSync(join(STATIC_DIR, key))).toBe(false);
        const ok = await get(new URL(url!).pathname, owner.headers);
        expect(ok.status).toBe(200);
        expect(ok.body).toContain(email);
        expect((await get(`/static/${key}`)).status).toBe(404);
        const warehouse = await createMfaAdmin(api as never, container, { roles: ["warehouse"] });
        const denied = await get(new URL(url!).pathname, warehouse.headers);
        expect(denied.status).toBe(403);
        expect(denied.body).not.toContain(email);
      });

      it("tải thành công ghi audit `data.accessed` (pii, đích = khoá file)", async () => {
        const audit = container.resolve<AuditModuleService>(AUDIT_MODULE);
        const rowsOf = async () =>
          (
            await audit.list({ action: "data.accessed", actor_id: owner.userId }, { limit: 100, offset: 0 })
          ).entries.filter((e) => (e as { resource_type?: string }).resource_type === "private_file");
        const before = (await rowsOf()).length;
        expect((await get(fileUrl(privateKey), owner.headers)).status).toBe(200);
        let rows = await rowsOf();
        for (let i = 0; i < 50 && rows.length <= before; i++) {
          await new Promise((r) => setTimeout(r, 100));
          rows = await rowsOf();
        }
        expect(rows.length).toBe(before + 1);
        expect(rows[0]).toMatchObject({ resource_id: privateKey, outcome: "success" });
      });

      it("đồng thời: 15 owner + 15 kho + 15 vô danh tải cùng lúc → 200 đúng nội dung / 403 / 401, không lẫn", async () => {
        const warehouse = await createMfaAdmin(api as never, container, { roles: ["warehouse"] });
        const results = await Promise.all(
          Array.from({ length: 45 }, (_, i) => {
            const who = i % 3;
            const headers = who === 0 ? owner.headers : who === 1 ? warehouse.headers : {};
            return get(fileUrl(privateKey), headers).then((r) => ({ who, r }));
          }),
        );
        for (const { who, r } of results) {
          if (who === 0) {
            expect(r.status).toBe(200);
            expect(r.body).toBe(CSV);
          } else {
            expect(r.status).toBe(who === 1 ? 403 : 401);
            expect(r.body).not.toContain("khach-t141");
          }
        }
      });

      it("client ngắt kết nối sớm (khi request còn ở cổng admin hoặc đang stream) → không rò fd trong thư mục private", async () => {
        // Review T-141 🟠: `close` của response phát TRƯỚC khi route gắn listener → pipe vào response đã huỷ, Promise treo,
        // fd mở mãi (tái hiện 3/10). Server test chạy trong cùng process → đếm fd qua /proc/self/fd.
        const openFdsInto = (dir: string) =>
          readdirSync("/proc/self/fd").filter((fd) => {
            try {
              return readlinkSync(`/proc/self/fd/${fd}`).startsWith(dir);
            } catch {
              return false;
            }
          }).length;
        const ok = await get(fileUrl(privateKey), owner.headers);
        expect(ok.status).toBe(200);
        const baseline = openFdsInto(PRIVATE_DIR);
        const delays = [0, 1, 2, 3, 5, 8, 12, 20, 30, 50, 0, 1, 2, 3, 5, 8, 12, 20, 30, 50];
        for (const d of delays) {
          await new Promise<void>((done) => {
            const req = http.request({
              host: base.hostname,
              port: Number(base.port),
              path: fileUrl(privateKey),
              method: "GET",
              headers: owner.headers,
            });
            req.on("error", () => {});
            req.on("response", (r) => r.resume());
            req.end();
            setTimeout(() => {
              req.destroy();
              done();
            }, d);
          });
        }
        let leaked = openFdsInto(PRIVATE_DIR) - baseline;
        for (let i = 0; i < 30 && leaked > 0; i++) {
          await new Promise((r) => setTimeout(r, 100));
          leaked = openFdsInto(PRIVATE_DIR) - baseline;
        }
        expect({ leaked, of: delays.length }).toEqual({ leaked: 0, of: delays.length });
        // Server vẫn phục vụ bình thường sau loạt ngắt kết nối.
        expect((await get(fileUrl(privateKey), owner.headers)).body).toBe(CSV);
      });
    });
  },
});
