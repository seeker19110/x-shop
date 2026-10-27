import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "@medusajs/framework/types";
import { startFakeS3, type FakeS3 } from "../../../../integration-tests/helpers/fake-s3";
import { DEV_BACKEND_URL, fileProviderEntry } from "../config";
import { isPrivateFileKey, isPublicFileKey, PUBLIC_FILE_KEY_PATTERN } from "../key";
import { LOCAL_STORAGE_WARNING, ServerKeyedLocalFileService } from "../provider";
import {
  BucketStore,
  isS3NotFound,
  PRIVATE_CACHE_CONTROL,
  SharedS3FileService,
  type SharedS3Options,
} from "../s3/provider";

/**
 * T-154 — provider S3 dùng chung (lib/upload/s3) và chọn provider theo FILE_STORAGE (lib/upload/config). Kho là server
 * HTTP giả trong tiến trình (integration-tests/helpers/fake-s3.ts) — AWS SDK thật, không mạng ngoài.
 */

const KEY_ID = "XSHOPUNITKEY";
const SECRET = "x-shop-unit-test-secret-khong-dung-that";
const quiet = { error: () => undefined, warn: () => undefined, info: () => undefined } as unknown as Logger;

let fake: FakeS3;
let options: SharedS3Options;

beforeAll(async () => {
  fake = await startFakeS3({ accessKeyId: KEY_ID, publicBuckets: ["pub"], privateBuckets: ["priv"] });
  options = {
    endpoint: fake.endpoint,
    region: "us-east-1",
    bucket: "pub",
    private_bucket: "priv",
    file_url: `${fake.endpoint}/pub`,
    access_key_id: KEY_ID,
    secret_access_key: SECRET,
    force_path_style: true,
    backend_url: "https://api.shop.example",
  };
});

afterAll(async () => {
  await fake.close();
});

const make = (over: Partial<SharedS3Options> = {}) =>
  new SharedS3FileService({ logger: quiet }, { ...options, ...over });

const errOf = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code?: unknown; type?: unknown; message?: unknown; name?: unknown }) => e,
  );

describe("SharedS3FileService — khởi tạo", () => {
  it.each([
    "region",
    "bucket",
    "private_bucket",
    "file_url",
    "access_key_id",
    "secret_access_key",
    "backend_url",
  ] as const)("thiếu %s → từ chối khởi tạo (không chứa giá trị bí mật)", (key) => {
    for (const bad of [undefined, "", "   "]) {
      let message = "";
      try {
        make({ [key]: bad } as Partial<SharedS3Options>);
      } catch (err) {
        message = String((err as Error).message);
      }
      expect(message).toContain(key);
      expect(message).not.toContain(SECRET);
    }
  });

  it("bucket private trùng bucket công khai → từ chối", () => {
    expect(() => make({ private_bucket: "pub" })).toThrow(/khác bucket công khai/);
  });
});

describe("SharedS3FileService — ghi/đọc", () => {
  it("public → bucket công khai, khoá `<ms>-<ULID><đuôi>`, URL công khai; private → bucket private, URL route admin", async () => {
    const svc = make();
    const pubBefore = fake.count("pub");
    const privBefore = fake.count("priv");
    const pub = await svc.upload({
      filename: "../ảnh 🎉.png",
      mimeType: "image/png",
      content: "aGVsbG8=",
      access: "public",
    });
    expect(isPublicFileKey(pub.key)).toBe(true);
    expect(pub.url).toBe(`${fake.endpoint}/pub/${pub.key}`);
    const priv = await svc.upload({
      filename: "x.csv",
      mimeType: "text/csv",
      content: "a,b\nđ,ê\n",
      access: "private",
    });
    expect(isPrivateFileKey(priv.key)).toBe(true);
    expect(priv.url).toBe(`https://api.shop.example/admin/x/files/${priv.key}`);
    expect([fake.count("pub") - pubBefore, fake.count("priv") - privBefore]).toEqual([1, 1]);
    expect((await svc.getAsBuffer({ fileKey: priv.key })).toString("utf8")).toBe("a,b\nđ,ê\n");
    // Không khai access → private (như provider local).
    const implicit = await svc.upload({ filename: "x.json", mimeType: "application/json", content: "{}" });
    expect(isPrivateFileKey(implicit.key)).toBe(true);
  });

  it("object private mang Cache-Control `private, no-store`", async () => {
    const svc = make();
    const priv = await svc.upload({
      filename: "x.csv",
      mimeType: "text/csv",
      content: "a\n",
      access: "private",
    });
    const res = await fetch(`${fake.endpoint}/priv/${priv.key}`, {
      headers: { authorization: `AWS4-HMAC-SHA256 Credential=${KEY_ID}/x` },
    });
    expect(res.headers.get("cache-control")).toBe(PRIVATE_CACHE_CONTROL);
  });

  it("MIME ngoài allowlist (gồm rỗng) → INVALID_DATA, không ghi gì vào kho", async () => {
    const svc = make();
    const before = fake.requests();
    for (const mimeType of ["text/html", "image/svg+xml", "", "application/octet-stream"]) {
      const err = await errOf(svc.upload({ filename: "x", mimeType, content: "x", access: "public" }));
      expect(err?.type).toBe("invalid_data");
    }
    expect(fake.requests()).toBe(before);
  });

  it("getUploadStream: ghi stream file private → khoá đúng mẫu, URL route admin, đọc lại đúng", async () => {
    const svc = make();
    const res = await svc.getUploadStream({ filename: "xuat.csv", mimeType: "text/csv", access: "private" });
    expect(isPrivateFileKey(res.fileKey)).toBe(true);
    expect(res.url).toBe(`https://api.shop.example/admin/x/files/${res.fileKey}`);
    res.writeStream.write("dòng 1\n");
    res.writeStream.end("dòng 2\n");
    const done = await res.promise;
    expect(done).toEqual({ key: res.fileKey, url: res.url });
    expect((await svc.getAsBuffer({ fileKey: res.fileKey })).toString("utf8")).toBe("dòng 1\ndòng 2\n");
  });

  it("provider gốc trả khoá sai mẫu (đổi cách đặt khoá khi nâng cấp) → UNEXPECTED_STATE, xoá object vừa ghi", async () => {
    const svc = make();
    const store = (svc as unknown as { public_: BucketStore }).public_;
    const spyUpload = jest
      .spyOn(store, "upload")
      .mockResolvedValue({ key: "anh-goc-cua-khach.png", url: "http://x/anh-goc-cua-khach.png" });
    const spyDelete = jest.spyOn(store, "deleteKeys");
    const err = await errOf(
      svc.upload({ filename: "x", mimeType: "image/png", content: "eA==", access: "public" }),
    );
    expect(err?.type).toBe("unexpected_state");
    expect(spyDelete).toHaveBeenCalledWith(["anh-goc-cua-khach.png"]);
    spyUpload.mockRestore();
    spyDelete.mockRestore();
  });

  it("getUploadStream với khoá sai mẫu → huỷ luồng, UNEXPECTED_STATE", async () => {
    const svc = make();
    const store = (svc as unknown as { private_: BucketStore }).private_;
    const { PassThrough } = await import("node:stream");
    const writeStream = new PassThrough();
    const spy = jest.spyOn(store, "getUploadStream").mockResolvedValue({
      writeStream,
      promise: Promise.reject(new Error("aborted")),
      url: "http://x/k",
      fileKey: "private-lạ.csv",
    });
    const err = await errOf(svc.getUploadStream({ filename: "x", mimeType: "text/csv", access: "private" }));
    expect(err?.type).toBe("unexpected_state");
    expect(writeStream.destroyed).toBe(true);
    spy.mockRestore();
  });

  it("xoá: lỗi kho (khoá truy cập sai) ném ra — không nuốt như provider gốc của Medusa", async () => {
    const good = make();
    const res = await good.upload({ filename: "x", mimeType: "text/csv", content: "a\n", access: "private" });
    const bad = make({ access_key_id: "SAIKHOA" });
    const err = await errOf(bad.delete({ fileKey: res.key }));
    expect(err?.name).toBe("InvalidAccessKeyId");
    expect((await good.getAsBuffer({ fileKey: res.key })).toString()).toBe("a\n"); // vẫn còn
    await good.delete([{ fileKey: res.key }]);
    expect((await errOf(good.getAsBuffer({ fileKey: res.key })))?.code).toBe("ENOENT");
  });

  it("bucket không tồn tại → lỗi cấu hình nổi lên (không giả làm 'không có file')", async () => {
    const svc = make({ private_bucket: "khong-co" });
    const err = await errOf(
      svc.getAsBuffer({ fileKey: "private-1730000000000-01J9ZQ8Y3M4N5P6Q7R8S9T0VWX.csv" }),
    );
    expect(err?.name).toBe("NoSuchBucket");
    expect(err?.code).not.toBe("ENOENT");
  });

  it("getPresignedDownloadUrl: có → URL (công khai / route admin); không có → NOT_FOUND", async () => {
    const svc = make();
    const pub = await svc.upload({
      filename: "x",
      mimeType: "image/webp",
      content: "eA==",
      access: "public",
    });
    expect(await svc.getPresignedDownloadUrl({ fileKey: pub.key })).toBe(pub.url);
    const priv = await svc.upload({ filename: "x", mimeType: "text/csv", content: "a", access: "private" });
    expect(await svc.getPresignedDownloadUrl({ fileKey: priv.key })).toBe(priv.url);
    await svc.delete({ fileKey: priv.key });
    expect((await errOf(svc.getPresignedDownloadUrl({ fileKey: priv.key })))?.type).toBe("not_found");
  });

  it("getPresignedUploadUrl → NOT_ALLOWED", async () => {
    expect((await errOf(make().getPresignedUploadUrl()))?.type).toBe("not_allowed");
  });
});

describe("isS3NotFound", () => {
  it.each([
    [{ name: "NoSuchKey" }, true],
    [{ name: "NotFound" }, true],
    [{ name: "NoSuchBucket" }, false],
    [{ name: "AccessDenied" }, false],
    [null, false],
    [undefined, false],
    ["NoSuchKey", false],
  ])("%j → %p", (err, expected) => expect(isS3NotFound(err)).toBe(expected));
});

describe("PUBLIC_FILE_KEY_PATTERN", () => {
  it.each([
    ["1730000000000-01J9ZQ8Y3M4N5P6Q7R8S9T0VWX.png", true],
    ["1730000000000-01J9ZQ8Y3M4N5P6Q7R8S9T0VWX.jpg", true],
    ["private-1730000000000-01J9ZQ8Y3M4N5P6Q7R8S9T0VWX.png", false],
    ["1730000000000-01J9ZQ8Y3M4N5P6Q7R8S9T0VWX.html", false],
    ["1730000000000-01j9zq8y3m4n5p6q7r8s9t0vwx.png", false],
    ["173000000000-01J9ZQ8Y3M4N5P6Q7R8S9T0VWX.png", false],
    ["../1730000000000-01J9ZQ8Y3M4N5P6Q7R8S9T0VWX.png", false],
    ["1730000000000-01J9ZQ8Y3M4N5P6Q7R8S9T0VWX.png/x", false],
    ["", false],
  ])("%j → %p", (key, ok) => {
    expect(PUBLIC_FILE_KEY_PATTERN.test(key)).toBe(ok);
    expect(isPublicFileKey(key)).toBe(ok);
  });
  it("không phải chuỗi → false", () => {
    expect(isPublicFileKey(undefined)).toBe(false);
    expect(isPublicFileKey(1730000000000)).toBe(false);
  });
});

describe("fileProviderEntry (T-154 — chọn provider theo FILE_STORAGE)", () => {
  it("local → provider local + PRIVATE_UPLOAD_DIR", () => {
    expect(
      fileProviderEntry({
        privateUploadDir: "/tmp/p",
        backendUrl: undefined,
        fileStorage: { kind: "local" },
      }),
    ).toEqual({ resolve: "./src/lib/upload", id: "local", options: { private_upload_dir: "/tmp/p" } });
  });

  it("s3 → provider S3 dùng chung với đủ tuỳ chọn; backend_url mặc định dev khi vắng", () => {
    const s3 = {
      kind: "s3" as const,
      endpoint: "https://s3.example",
      region: "auto",
      bucket: "pub",
      privateBucket: "priv",
      fileUrl: "https://cdn.example/pub",
      accessKeyId: "AK",
      secretAccessKey: "SK-xxxxxxxx",
      forcePathStyle: false,
    };
    const entry = fileProviderEntry({ privateUploadDir: "/tmp/p", backendUrl: undefined, fileStorage: s3 });
    expect(entry).toEqual({
      resolve: "./src/lib/upload/s3",
      id: "s3",
      options: {
        endpoint: "https://s3.example",
        region: "auto",
        bucket: "pub",
        private_bucket: "priv",
        file_url: "https://cdn.example/pub",
        access_key_id: "AK",
        secret_access_key: "SK-xxxxxxxx",
        force_path_style: false,
        backend_url: DEV_BACKEND_URL,
      },
    });
    const withBackend = fileProviderEntry({
      privateUploadDir: "/x",
      backendUrl: "https://api.example",
      fileStorage: s3,
    });
    expect((withBackend.options as SharedS3Options).backend_url).toBe("https://api.example");
  });
});

describe("provider local (T-154): chỉ dev/test", () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "xshop-local-t154-"));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });
  const opts = () => ({
    upload_dir: path.join(base, "static"),
    private_upload_dir: path.join(base, "private"),
  });

  it("NODE_ENV=production → từ chối khởi tạo (đĩa từng máy không dùng chung)", () => {
    expect(() => new ServerKeyedLocalFileService({}, { ...opts(), node_env: "production" })).toThrow(
      /FILE_STORAGE=s3/,
    );
  });

  it("dev/test → khởi tạo được, in cảnh báo 'chỉ một tiến trình' qua logger", () => {
    const warn = jest.fn();
    new ServerKeyedLocalFileService({ logger: { warn } }, { ...opts(), node_env: "development" });
    expect(warn).toHaveBeenCalledWith(LOCAL_STORAGE_WARNING);
  });

  it("container không có logger (proxy ném lỗi khi đọc) → vẫn khởi tạo được", () => {
    const deps = new Proxy(
      {},
      {
        get: () => {
          throw new Error("not registered");
        },
      },
    );
    expect(() => new ServerKeyedLocalFileService(deps, { ...opts(), node_env: "test" })).not.toThrow();
  });
});
