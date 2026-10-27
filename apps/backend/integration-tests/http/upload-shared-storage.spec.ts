import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { parseEnv } from "../../src/lib/env";
import { fileProviderEntry } from "../../src/lib/upload/config";
import { isPrivateFileKey, isPublicFileKey } from "../../src/lib/upload/key";
import { ServerKeyedLocalFileService } from "../../src/lib/upload/provider";
import { SharedS3FileService, type SharedS3Options } from "../../src/lib/upload/s3/provider";
import { createMfaAdmin, type MfaAdmin } from "../helpers/auth";
import { startFakeS3, type FakeS3 } from "../helpers/fake-s3";

jest.setTimeout(300 * 1000);

/**
 * T-154 — file upload DÙNG CHUNG giữa các bản sao (ARC-RES-005, BE-FILE-004).
 *
 * Bản sao A = app Medusa đầy đủ của runner (HTTP + File Module nạp từ medusa-config với FILE_STORAGE=s3). Bản sao B = một
 * provider S3 khác, dựng ĐỘC LẬP từ cùng biến môi trường (parseEnv → fileProviderEntry), không chung bộ nhớ với A — như
 * tiến trình ở máy khác. Ghi ở A đọc được ở B và ngược lại; xoá ở A thì B hết đọc được.
 *
 * Kho: mặc định `helpers/fake-s3.ts` (server HTTP trong tiến trình, CI không cần dịch vụ thêm). Đặt `XS_TEST_S3_ENDPOINT`
 * (+ `XS_TEST_S3_ACCESS_KEY_ID`, `XS_TEST_S3_SECRET_ACCESS_KEY`, tuỳ chọn `XS_TEST_S3_REGION`, `XS_TEST_S3_BUCKET`,
 * `XS_TEST_S3_PRIVATE_BUCKET`, `XS_TEST_S3_FILE_URL`) để chạy cùng suite với kho thật (docs/ops/ENV.md — bucket đã tạo, bucket
 * công khai cho đọc nặc danh, bucket private thì không).
 *
 * Đối chứng: provider local trên hai máy (hai thư mục) KHÔNG thấy file của nhau — đúng lỗi T-154 sửa.
 */

const EXTERNAL = process.env.XS_TEST_S3_ENDPOINT?.trim() || undefined;
const ACCESS_KEY_ID = EXTERNAL ? (process.env.XS_TEST_S3_ACCESS_KEY_ID ?? "") : "XSHOPFAKES3TESTKEY";
const SECRET_ACCESS_KEY = EXTERNAL
  ? (process.env.XS_TEST_S3_SECRET_ACCESS_KEY ?? "")
  : "x-shop-fake-s3-chi-dung-cho-test-tich-hop";
const REGION = process.env.XS_TEST_S3_REGION ?? "us-east-1";
const PUBLIC_BUCKET = process.env.XS_TEST_S3_BUCKET ?? "xshop-it-public";
const PRIVATE_BUCKET = process.env.XS_TEST_S3_PRIVATE_BUCKET ?? "xshop-it-private";

const S3_ENV_KEYS = [
  "FILE_STORAGE",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_PRIVATE_BUCKET",
  "S3_FILE_URL",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_FORCE_PATH_STYLE",
  "PRIVATE_UPLOAD_DIR",
] as const;
const savedEnv = Object.fromEntries(S3_ENV_KEYS.map((k) => [k, process.env[k]]));

let fake: FakeS3 | undefined;
let endpoint = "";
let publicBase = "";

/** Logger im lặng cho provider B (A dùng logger của Medusa). */
const quietLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
} as unknown as Logger;

// Chạy TRƯỚC beforeAll của runner (runner bọc suite trong describe): medusa-config đọc env lúc runner nạp cấu hình.
beforeAll(async () => {
  if (EXTERNAL === undefined) {
    fake = await startFakeS3({
      accessKeyId: ACCESS_KEY_ID,
      publicBuckets: [PUBLIC_BUCKET],
      privateBuckets: [PRIVATE_BUCKET],
    });
  }
  endpoint = EXTERNAL ?? fake!.endpoint;
  publicBase = process.env.XS_TEST_S3_FILE_URL ?? `${endpoint}/${PUBLIC_BUCKET}`;
  Object.assign(process.env, {
    FILE_STORAGE: "s3",
    S3_ENDPOINT: endpoint,
    S3_REGION: REGION,
    S3_BUCKET: PUBLIC_BUCKET,
    S3_PRIVATE_BUCKET: PRIVATE_BUCKET,
    S3_FILE_URL: publicBase,
    S3_ACCESS_KEY_ID: ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
  });
  delete process.env.S3_FORCE_PATH_STYLE;
  delete process.env.PRIVATE_UPLOAD_DIR;
});

// Chạy SAU afterAll của runner (app đã tắt): trả env cho suite sau trong cùng worker, đóng kho giả.
afterAll(async () => {
  for (const k of S3_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await fake?.close();
});

/** Provider của "bản sao B": dựng từ env y như medusa-config, đối tượng riêng. */
function replicaB(): SharedS3FileService {
  const parsed = parseEnv(process.env);
  if (!parsed.ok) throw new Error(`env test sai: ${parsed.problems.map((p) => p.variable).join(",")}`);
  const entry = fileProviderEntry({
    privateUploadDir: parsed.env.privateUploadDir,
    backendUrl: parsed.env.MEDUSA_BACKEND_URL,
    fileStorage: parsed.env.fileStorage,
  });
  expect(entry.resolve).toBe("./src/lib/upload/s3");
  return new SharedS3FileService({ logger: quietLogger }, entry.options as SharedS3Options);
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}

/** PNG hợp lệ ở đầu (qua kiểm magic bytes của route upload) + đuôi phân biệt nội dung. */
const png = (tag: string) =>
  Buffer.concat([
    Buffer.from(
      "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
        "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
      "hex",
    ),
    Buffer.from(tag, "utf8"),
  ]);

const errCode = async (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e: { code?: unknown; type?: unknown }) => e.code ?? e.type,
  );

describe("đối chứng: provider local trên hai máy không dùng chung (lỗi T-154 sửa)", () => {
  it("ghi ở A (đĩa máy A) → B (đĩa máy B) không đọc được", async () => {
    const base = await mkdtemp(join(tmpdir(), "xshop-t154-local-"));
    try {
      const make = (m: string) =>
        new ServerKeyedLocalFileService(
          {},
          { upload_dir: join(base, m, "static"), private_upload_dir: join(base, m, "private") },
        );
      const a = make("a");
      const b = make("b");
      const res = await a.upload({
        filename: "ao.png",
        mimeType: "image/png",
        content: png("local").toString("base64"),
        access: "public",
      });
      expect(await a.getAsBuffer({ fileKey: res.key })).toEqual(png("local"));
      expect(await errCode(b.getAsBuffer({ fileKey: res.key }))).toBe("ENOENT");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    let base: URL;
    let container: MedusaContainer;
    let owner: MfaAdmin;
    let b: SharedS3FileService;

    const adminFetch = (
      path: string,
      init: RequestInit = {},
      headers: Record<string, string> = owner.headers,
    ) =>
      fetch(new URL(path, base), {
        ...init,
        headers: { ...headers, ...(init.headers as object) },
        redirect: "manual",
      });

    async function uploadViaA(name: string, body: Buffer): Promise<{ id: string; url: string }> {
      const form = new FormData();
      form.append("files", new Blob([new Uint8Array(body)], { type: "image/png" }), name);
      const res = await adminFetch("/admin/uploads", { method: "POST", body: form });
      expect(res.status).toBe(200);
      const { files } = (await res.json()) as { files: Array<{ id: string; url: string }> };
      expect(files).toHaveLength(1);
      return files[0]!;
    }

    beforeAll(async () => {
      base = new URL(String((api as unknown as { defaults: { baseURL: string } }).defaults.baseURL));
      container = getContainer();
      owner = await createMfaAdmin(api as never, container, { roles: ["owner"] });
      b = replicaB();
    });

    describe("ảnh công khai", () => {
      it("upload qua HTTP ở A → B đọc đúng byte; URL công khai của kho tải được không cần đăng nhập", async () => {
        const before = fake?.count(PUBLIC_BUCKET);
        const body = png("anh-cong-khai");
        const file = await uploadViaA("ao.png", body);
        expect(isPublicFileKey(file.id)).toBe(true);
        expect(file.url).toBe(`${publicBase}/${file.id}`);
        if (fake !== undefined) expect(fake.count(PUBLIC_BUCKET)).toBe(before! + 1);

        expect(await b.getAsBuffer({ fileKey: file.id })).toEqual(body);
        expect(await b.getPresignedDownloadUrl({ fileKey: file.id })).toBe(file.url);
        const anon = await fetch(file.url);
        expect(anon.status).toBe(200);
        expect(Buffer.from(await anon.arrayBuffer())).toEqual(body);
        // Không còn ghi đĩa cục bộ của A: `/static/<khoá>` không có.
        expect((await fetch(new URL(`/static/${file.id}`, base))).status).toBe(404);
      });

      it("tên file Unicode/độc → khoá do server sinh (không byte nào của tên), B đọc được", async () => {
        const body = png("unicode");
        const file = await uploadViaA("Áo dài đỏ 🎉 ../../static/x.png", body);
        expect(isPublicFileKey(file.id)).toBe(true);
        expect(file.url).not.toMatch(/%|Áo|\.\./);
        expect(await b.getAsBuffer({ fileKey: file.id })).toEqual(body);
      });

      it("trùng tên file (tuần tự và đồng thời) → khoá khác nhau, không ghi đè; xoá một cái không ảnh hưởng cái kia", async () => {
        const first = await uploadViaA("trung-ten.png", png("lan-1"));
        const second = await uploadViaA("trung-ten.png", png("lan-2"));
        const concurrent = await Promise.all(
          Array.from({ length: 6 }, (_, i) => uploadViaA("trung-ten.png", png(`dong-thoi-${i}`))),
        );
        const all = [first, second, ...concurrent];
        expect(new Set(all.map((f) => f.id)).size).toBe(all.length);
        expect(await b.getAsBuffer({ fileKey: first.id })).toEqual(png("lan-1"));
        expect(await b.getAsBuffer({ fileKey: second.id })).toEqual(png("lan-2"));
        for (const [i, f] of concurrent.entries()) {
          expect(await b.getAsBuffer({ fileKey: f.id })).toEqual(png(`dong-thoi-${i}`));
        }
        const del = await adminFetch(`/admin/uploads/${encodeURIComponent(first.id)}`, { method: "DELETE" });
        expect(del.status).toBe(200);
        expect(await errCode(b.getAsBuffer({ fileKey: first.id }))).toBe("ENOENT");
        expect(await b.getAsBuffer({ fileKey: second.id })).toEqual(png("lan-2"));
      });

      it("xoá ở A (DELETE /admin/uploads) → B không còn đọc được, URL công khai 404", async () => {
        const file = await uploadViaA("xoa.png", png("xoa"));
        expect(await b.getAsBuffer({ fileKey: file.id })).toEqual(png("xoa"));
        const del = await adminFetch(`/admin/uploads/${encodeURIComponent(file.id)}`, { method: "DELETE" });
        expect(del.status).toBe(200);
        expect(await errCode(b.getAsBuffer({ fileKey: file.id }))).toBe("ENOENT");
        expect(await errCode(b.getPresignedDownloadUrl({ fileKey: file.id }))).toBe("not_found");
        expect((await fetch(file.url)).status).toBe(404);
      });
    });

    describe("file private (xuất PII, chunk nhập — T-141) ở bucket private", () => {
      const CSV = "email,ten\nkhach-t154@example.test,Nguyễn Thị Ánh 🎉\n";

      it("ghi qua File Module ở A → B đọc đúng byte UTF-8; URL là route admin, không URL kho", async () => {
        const created = await container.resolve(Modules.FILE).createFiles({
          filename: "../../static/khách-hàng.csv",
          mimeType: "text/csv",
          content: CSV,
          access: "private",
        });
        expect(isPrivateFileKey(created.id)).toBe(true);
        expect(created.url).toBe(`http://localhost:9000/admin/x/files/${created.id}`);
        expect((await b.getAsBuffer({ fileKey: created.id })).toString("utf8")).toBe(CSV);
        expect(await b.getPresignedDownloadUrl({ fileKey: created.id })).toBe(created.url);
      });

      it("không lộ qua kho: URL công khai và đọc nặc danh thẳng bucket private đều bị từ chối", async () => {
        const created = await container.resolve(Modules.FILE).createFiles({
          filename: "x.csv",
          mimeType: "text/csv",
          content: CSV,
          access: "private",
        });
        const viaPublic = await fetch(`${publicBase}/${created.id}`);
        expect([403, 404]).toContain(viaPublic.status);
        expect(await viaPublic.text()).not.toContain("khach-t154");
        const direct = await fetch(`${endpoint}/${PRIVATE_BUCKET}/${created.id}`);
        expect(direct.status).toBe(403);
        expect(await direct.text()).not.toContain("khach-t154");
      });

      it("ghi ở B (vd. worker) → tải qua route của A: owner 200; vô danh 401; vai trò khác 403", async () => {
        const res = await b.upload({
          filename: "bao-cao.csv",
          mimeType: "text/csv",
          content: CSV,
          access: "private",
        });
        expect(isPrivateFileKey(res.key)).toBe(true);
        const path = `/admin/x/files/${res.key}`;
        const ok = await adminFetch(path);
        expect(ok.status).toBe(200);
        expect(await ok.text()).toBe(CSV);
        expect(ok.headers.get("cache-control")).toBe("private, no-store");

        const anon = await fetch(new URL(path, base));
        expect(anon.status).toBe(401);
        const warehouse = await createMfaAdmin(api as never, container, { roles: ["warehouse"] });
        const denied = await adminFetch(path, {}, warehouse.headers);
        expect(denied.status).toBe(403);
        expect(await denied.text()).not.toContain("khach-t154");
      });

      it("đồng thời: 10 bản ghi cùng tên ở B song song → 10 khoá khác nhau, A đọc đúng từng nội dung", async () => {
        const results = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            b.upload({
              filename: "trung.csv",
              mimeType: "text/csv",
              content: `${CSV}${i}\n`,
              access: "private",
            }),
          ),
        );
        expect(new Set(results.map((r) => r.key)).size).toBe(10);
        const files = container.resolve(Modules.FILE);
        for (const [i, r] of results.entries()) {
          expect((await readAll(await files.getDownloadStream(r.key))).toString("utf8")).toBe(`${CSV}${i}\n`);
        }
      });

      it("xoá ở A → B không đọc được; route của A trả 404 (không 5xx); xoá ở B → A 404", async () => {
        const files = container.resolve(Modules.FILE);
        const a1 = await files.createFiles({
          filename: "x",
          mimeType: "text/csv",
          content: "a\n",
          access: "private",
        });
        expect((await adminFetch(`/admin/x/files/${a1.id}`)).status).toBe(200);
        await files.deleteFiles(a1.id);
        expect(await errCode(b.getAsBuffer({ fileKey: a1.id }))).toBe("ENOENT");
        expect((await adminFetch(`/admin/x/files/${a1.id}`)).status).toBe(404);

        const b1 = await b.upload({ filename: "y", mimeType: "text/csv", content: "b\n", access: "private" });
        expect((await adminFetch(`/admin/x/files/${b1.key}`)).status).toBe(200);
        await b.delete({ fileKey: b1.key });
        expect((await adminFetch(`/admin/x/files/${b1.key}`)).status).toBe(404);
        // Xoá lại khoá đã xoá: idempotent, không lỗi.
        await expect(b.delete([{ fileKey: b1.key }, { fileKey: a1.id }])).resolves.toBeUndefined();
      });

      it("luồng thật: xuất khách hàng native (ghi stream) → file ở bucket private; owner tải qua route; B đọc được", async () => {
        const email = `khach-t154-${Date.now()}@example.test`;
        await container.resolve(Modules.CUSTOMER).createCustomers([{ email, first_name: "Ánh" }]);
        const before = fake?.count(PRIVATE_BUCKET);
        const exp = await adminFetch("/admin/customers/export", {
          method: "POST",
          headers: { "content-type": "application/json" },
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
        if (fake !== undefined) expect(fake.count(PRIVATE_BUCKET)).toBeGreaterThan(before!);
        expect((await b.getAsBuffer({ fileKey: key })).toString("utf8")).toContain(email);
        const ok = await adminFetch(new URL(url!).pathname);
        expect(ok.status).toBe(200);
        expect(await ok.text()).toContain(email);
      });
    });

    describe("khoá lạ và thao tác không hỗ trợ", () => {
      it.each([
        "../../etc/passwd",
        "private-../../x.csv",
        "private-1730000000000-01J9ZQ8Y3M4N5P6Q7R8S9T0VWX.html",
        "a/b.png",
        "",
      ])("khoá %j → ENOENT ở B, không gọi kho", async (key) => {
        const before = fake?.requests();
        expect(await errCode(b.getAsBuffer({ fileKey: key }))).toBe("ENOENT");
        expect(await errCode(b.getDownloadStream({ fileKey: key }))).toBe("ENOENT");
        expect(await errCode(b.getPresignedDownloadUrl({ fileKey: key }))).toBe("ENOENT");
        await expect(b.delete({ fileKey: key })).resolves.toBeUndefined();
        if (fake !== undefined) expect(fake.requests()).toBe(before);
      });

      it("không cấp URL ký để client PUT thẳng lên kho", async () => {
        expect(await errCode(b.getPresignedUploadUrl())).toBe("not_allowed");
      });
    });
  },
});
