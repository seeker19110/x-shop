import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { GET } from "../../../api/admin/x/files/[key]/route";
import { startFakeS3, type FakeS3 } from "../../../../integration-tests/helpers/fake-s3";
import { isPrivateFileKey, isPublicFileKey } from "../key";
import { ServerKeyedLocalFileService } from "../provider";
import { SharedS3FileService, type SharedS3Options } from "../s3/provider";

/**
 * T-179 (BASE-SEC-007, SEC-WEB-001) — path traversal ở route tải file private, mẫu khoá và hai provider file (local, S3).
 * Mọi khoá/tên "độc" phải bị từ chối, không đọc/ghi/xoá ngoài thư mục (hoặc bucket) gốc.
 */

/** Khoá thật (đủ mẫu) dùng để dựng các biến thể độc. */
const VALID_PRIVATE = "private-1730000000000-01J9ZQ8Y3M4N5P6Q7R8S9T0VWX.csv";
const VALID_PUBLIC = "1730000000000-01J9ZQ8Y3M4N5P6Q7R8S9T0VWX.png";

const MALICIOUS: ReadonlyArray<readonly [string, string]> = [
  ["../", "../secret.txt"],
  ["../ nhiều tầng", "../../../../etc/passwd"],
  ["..%2f (mã hoá một lần)", "..%2fsecret.txt"],
  ["%2e%2e/", "%2e%2e/secret.txt"],
  ["%252e%252e (mã hoá hai lần)", "%252e%252e%252fsecret.txt"],
  ["\\", "dir\\secret.txt"],
  ["..\\", "..\\secret.txt"],
  ["..\\\\", "..\\\\..\\\\secret.txt"],
  ["NUL %00 (đã giải mã)", "secret.txt\u0000.csv"],
  ["NUL %00 (literal)", "secret.txt%00.csv"],
  ["đường dẫn tuyệt đối", "/etc/passwd"],
  ["unicode fullwidth dot", "．．/secret.txt"],
  ["unicode fullwidth slash", "..／secret.txt"],
  ["khoá rỗng", ""],
  ["chỉ khoảng trắng", "   "],
  ["tiền tố private- rồi thoát", "private-/../../secret.txt"],
  ["khoá thật + hậu tố traversal", `${VALID_PRIVATE}/../../secret.txt`],
  ["khoá thật + NUL", `${VALID_PRIVATE}\u0000.png`],
  ["khoá thật + xuống dòng", `${VALID_PRIVATE}\n`],
  ["khoá thật trong thư mục con", `sub/${VALID_PRIVATE}`],
  ["tiền tố PRIVATE- viết hoa", VALID_PRIVATE.replace("private-", "PRIVATE-")],
  ["ULID chữ thường", VALID_PRIVATE.replace("01J9ZQ8Y3M4N5P6Q7R8S9T0VWX", "01j9zq8y3m4n5p6q7r8s9t0vwx")],
  ["đuôi viết hoa", VALID_PRIVATE.replace(".csv", ".CSV")],
  ["khoá công khai có `..` đứng trước", `../${VALID_PUBLIC}`],
];

const NON_STRING: ReadonlyArray<readonly [string, unknown]> = [
  ["undefined", undefined],
  ["null", null],
  ["số", 0],
  ["mảng", ["..", "secret.txt"]],
  ["object", { toString: () => VALID_PRIVATE }],
];

describe("mẫu khoá file (isPrivateFileKey / isPublicFileKey)", () => {
  it("chấp nhận đúng khoá do provider sinh (đối chứng — mẫu không bị chặn quá tay)", () => {
    expect(isPrivateFileKey(VALID_PRIVATE)).toBe(true);
    expect(isPublicFileKey(VALID_PUBLIC)).toBe(true);
  });

  it.each(MALICIOUS)("từ chối: %s", (_name, key) => {
    expect(isPrivateFileKey(key)).toBe(false);
    expect(isPublicFileKey(key)).toBe(false);
  });

  it.each(NON_STRING)("không phải chuỗi (%s) → từ chối", (_name, key) => {
    expect(isPrivateFileKey(key)).toBe(false);
    expect(isPublicFileKey(key)).toBe(false);
  });
});

describe("GET /admin/x/files/:key — traversal", () => {
  class FakeRes extends Writable {
    statusCode = 200;
    headersSent = false;
    body = "";
    readonly headers = new Map<string, unknown>();
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
      this.body += chunk.toString("utf8");
      cb();
    }
  }

  const run = async (key: unknown) => {
    const getDownloadStream = jest.fn(async () => Readable.from(["bi-mat"]));
    const req = {
      params: { key },
      scope: { resolve: () => ({ getDownloadStream }) },
      x_admin_access: { userId: "user_1", roles: ["owner"], permission: "settings.manage" },
    } as unknown as MedusaRequest;
    const res = new FakeRes();
    await GET(req, res as unknown as MedusaResponse);
    return { res, getDownloadStream };
  };

  it("đối chứng: khoá hợp lệ → 200 và có mở file", async () => {
    const { res, getDownloadStream } = await run(VALID_PRIVATE);
    expect(res.statusCode).toBe(200);
    expect(getDownloadStream).toHaveBeenCalledWith(VALID_PRIVATE);
  });

  it.each([...MALICIOUS, ...NON_STRING])("%s → 404, không mở file, không lộ nội dung", async (_n, key) => {
    const { res, getDownloadStream } = await run(key);
    expect(res.statusCode).toBe(404);
    expect(getDownloadStream).not.toHaveBeenCalled();
    expect(res.body).not.toContain("bi-mat");
    expect(res.getHeader("content-disposition")).toBeUndefined();
  });

  it("khoá công khai hợp lệ gọi qua route private → 404 (không đọc chéo kho công khai)", async () => {
    const { res, getDownloadStream } = await run(VALID_PUBLIC);
    expect(res.statusCode).toBe(404);
    expect(getDownloadStream).not.toHaveBeenCalled();
  });
});

describe("provider local — traversal", () => {
  let base: string;
  let svc: ServerKeyedLocalFileService;
  const SECRET = "NOI-DUNG-NGOAI-THU-MUC-GOC";

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "xshop-traversal-"));
    // `secret.txt` nằm ở `base` — NGOÀI cả static/ lẫn private/; `../secret.txt` từ hai thư mục đó trỏ tới nó.
    await writeFile(path.join(base, "secret.txt"), SECRET);
    svc = new ServerKeyedLocalFileService(
      {},
      {
        upload_dir: path.join(base, "static"),
        private_upload_dir: path.join(base, "private"),
        backend_url: "http://localhost:9000/static",
        node_env: "test",
      },
    );
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const readSecret = () => readFile(path.join(base, "secret.txt"), "utf8");

  /** Đọc bằng cả hai API; khoá độc không có file trong thư mục gốc → cả hai đều phải từ chối, không lộ bí mật. */
  async function readAttempt(fileKey: string): Promise<void> {
    const outcomes = await Promise.allSettled([
      svc.getAsBuffer({ fileKey }),
      (async () => {
        const stream = await svc.getDownloadStream({ fileKey });
        const chunks: Buffer[] = [];
        for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
        return Buffer.concat(chunks);
      })(),
    ]);
    for (const o of outcomes) {
      if (o.status === "fulfilled") expect(o.value.toString("utf8")).not.toContain(SECRET);
    }
    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected"]);
  }

  it.each(MALICIOUS.filter(([, k]) => k.trim() !== ""))(
    "đọc (getAsBuffer/getDownloadStream) khoá độc: %s → từ chối, không lộ file ngoài gốc",
    async (_n, key) => {
      await readAttempt(key);
      await readAttempt(`private-${key}`);
      expect(await readSecret()).toBe(SECRET);
    },
  );

  it.each(MALICIOUS)("xoá khoá độc: %s → không xoá gì ngoài thư mục gốc", async (_n, key) => {
    await Promise.allSettled([svc.delete({ fileKey: key }), svc.delete({ fileKey: `private-${key}` })]);
    expect(await readSecret()).toBe(SECRET);
  });

  it("symlink trong thư mục gốc trỏ ra ngoài → đọc/presign bị từ chối (realpath), file ngoài còn nguyên", async () => {
    const link = path.join(base, "private", VALID_PRIVATE);
    await symlink(path.join(base, "secret.txt"), link);
    const publicLink = path.join(base, "static", VALID_PUBLIC);
    await mkdir(path.join(base, "static"), { recursive: true });
    await symlink(path.join(base, "secret.txt"), publicLink);
    for (const fileKey of [VALID_PRIVATE, VALID_PUBLIC]) {
      await expect(svc.getAsBuffer({ fileKey })).rejects.toThrow(/Invalid file key/);
      await expect(svc.getDownloadStream({ fileKey })).rejects.toThrow(/Invalid file key/);
      await expect(svc.getPresignedDownloadUrl({ fileKey })).rejects.toThrow(/Invalid file key/);
    }
    // xoá chỉ gỡ chính symlink, không đụng đích ngoài thư mục gốc
    await svc.delete({ fileKey: VALID_PRIVATE });
    expect(await readSecret()).toBe(SECRET);
  });

  it("symlink trỏ vào bên trong thư mục gốc và file thường vẫn đọc được (đối chứng — không chặn quá tay)", async () => {
    const out = await svc.upload({
      filename: "a.csv",
      mimeType: "text/csv",
      content: Buffer.from("a,b").toString("base64"),
      access: "private",
    });
    expect((await svc.getAsBuffer({ fileKey: out.key })).toString()).toBe("a,b");
    expect(await svc.getPresignedDownloadUrl({ fileKey: out.key })).toContain("/admin/x/files/");
  });

  it("presigned download khoá độc → từ chối, không trả URL", async () => {
    for (const [, key] of MALICIOUS) {
      await expect(svc.getPresignedDownloadUrl({ fileKey: `private-${key}` })).rejects.toBeDefined();
    }
    expect(await readSecret()).toBe(SECRET);
  });

  it.each(MALICIOUS)(
    "ghi với tên gốc độc (%s) → tên client bị bỏ, file nằm trong thư mục gốc, không tạo file ngoài",
    async (_n, filename) => {
      const before = (await readdir(base)).sort();
      const out = await svc.upload({
        filename,
        mimeType: "text/csv",
        content: Buffer.from("a,b").toString("base64"),
        access: "private",
      });
      expect(isPrivateFileKey(out.key)).toBe(true);
      const after = (await readdir(base)).sort();
      expect(after.filter((e) => !before.includes(e))).toEqual([]);
      expect(await readdir(path.join(base, "private"))).toEqual([out.key]);
      expect(await readSecret()).toBe(SECRET);
    },
  );

  it("ghi với MIME ngoài allowlist hoặc rỗng → từ chối, không ghi", async () => {
    for (const mimeType of ["text/html", "", "../../x"]) {
      await expect(
        svc.upload({ filename: "../x.csv", mimeType, content: "YQ==", access: "private" }),
      ).rejects.toBeDefined();
    }
    expect(await readdir(path.join(base, "private"))).toEqual([]);
  });
});

describe("provider S3 — traversal ở khoá", () => {
  let fake: FakeS3;
  let svc: SharedS3FileService;

  beforeAll(async () => {
    fake = await startFakeS3({
      accessKeyId: "XSHOPTRAVKEY",
      publicBuckets: ["pub"],
      privateBuckets: ["priv"],
    });
    const options: SharedS3Options = {
      endpoint: fake.endpoint,
      region: "us-east-1",
      bucket: "pub",
      private_bucket: "priv",
      file_url: `${fake.endpoint}/pub`,
      access_key_id: "XSHOPTRAVKEY",
      secret_access_key: "x-shop-traversal-test-secret-khong-dung-that",
      force_path_style: true,
      backend_url: "https://api.shop.example",
    };
    svc = new SharedS3FileService(
      { logger: { error: () => undefined, warn: () => undefined, info: () => undefined } } as never,
      options,
    );
  });
  afterAll(async () => {
    await fake.close();
  });

  it.each([...MALICIOUS, ["undefined", undefined] as const, ["null", null] as const])(
    "khoá độc %s → từ chối đọc/presign, xoá là no-op, không gửi request nào tới kho",
    async (_n, key) => {
      const k = key as string;
      const before = fake.requests();
      await expect(svc.getAsBuffer({ fileKey: k })).rejects.toMatchObject({ code: "ENOENT" });
      await expect(svc.getDownloadStream({ fileKey: k })).rejects.toMatchObject({ code: "ENOENT" });
      await expect(svc.getPresignedDownloadUrl({ fileKey: k })).rejects.toMatchObject({ code: "ENOENT" });
      await expect(svc.delete({ fileKey: k })).resolves.toBeUndefined();
      expect(fake.requests()).toBe(before);
    },
  );

  it("ghi với MIME ngoài allowlist/rỗng → từ chối, không gửi request nào", async () => {
    const before = fake.requests();
    for (const mimeType of ["text/html", "", "../../x"]) {
      await expect(
        svc.upload({ filename: "../../x.csv", mimeType, content: "YQ==", access: "private" }),
      ).rejects.toBeDefined();
    }
    expect(fake.requests()).toBe(before);
  });
});
