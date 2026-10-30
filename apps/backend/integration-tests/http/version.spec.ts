import { readFileSync } from "node:fs";
import path from "node:path";
import type { MedusaContainer } from "@medusajs/framework/types";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { createAdmin, noThrow, type AdminAccount } from "../helpers/auth";

jest.setTimeout(300 * 1000);

type Res = { status: number; data: Record<string, unknown>; headers: Record<string, string> };
interface Api {
  request(config: Record<string, unknown>): Promise<Res>;
}

const pkgVersion = (
  JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")) as { version: string }
).version;

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let owner: AdminAccount;
    let warehouse: AdminAccount;
    const saved = { ...process.env };

    beforeAll(async () => {
      container = getContainer();
      owner = await createAdmin(rawApi, container, { roles: ["owner"] });
      warehouse = await createAdmin(rawApi, container, { roles: ["warehouse"] });
    });

    afterEach(() => {
      for (const k of ["XS_RELEASE_VERSION", "XS_RELEASE_COMMIT", "XS_BUILT_AT"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    const get = (who?: AdminAccount) =>
      api.request({ method: "GET", url: "/admin/x/version", headers: who?.headers ?? {}, ...noThrow });

    it("không xác thực → 401 và không lộ phiên bản", async () => {
      const res = await get();
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.data)).not.toContain(pkgVersion);
    });

    it("có quyền report.read → 200, version = package.json, no-store, không có trường thừa", async () => {
      const res = await get(owner);
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.data).toEqual({ version: pkgVersion });
    });

    it("biến môi trường ghi đè version và thêm commit, built_at; giá trị rỗng coi như vắng", async () => {
      process.env.XS_RELEASE_VERSION = "9.9.9-rc.1";
      process.env.XS_RELEASE_COMMIT = "886beed";
      process.env.XS_BUILT_AT = "2026-10-30T08:00:00Z";
      expect((await get(owner)).data).toEqual({
        version: "9.9.9-rc.1",
        commit: "886beed",
        built_at: "2026-10-30T08:00:00Z",
      });
      process.env.XS_RELEASE_VERSION = "  ";
      process.env.XS_RELEASE_COMMIT = "";
      delete process.env.XS_BUILT_AT;
      expect((await get(owner)).data).toEqual({ version: pkgVersion });
    });

    it("vai trò không có report.read → 403 (RBAC)", async () => {
      const res = await get(warehouse);
      expect(res).toMatchObject({ status: 403, data: { code: "FORBIDDEN", permission: "report.read" } });
    });
  },
});
