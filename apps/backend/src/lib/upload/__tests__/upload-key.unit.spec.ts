import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extensionForMime, generateUploadKey, ULID_PATTERN, UPLOAD_MIME_EXTENSIONS } from "../key";
import { ServerKeyedLocalFileService } from "../provider";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** Tên client độc/lạ — không byte nào được lọt vào khoá. */
const HOSTILE_NAMES = [
  "../../etc/passwd",
  "..\\..\\windows\\win.ini",
  "/etc/passwd",
  "ảnh đẹp 🎉 áo dài.png",
  "é.png", // NFD
  "shell.php.png",
  "photo.png.php",
  "x.PNG.html",
  "a\u0000b.png",
  "line\r\nbreak.png",
  "%2e%2e%2fsecret.png",
  "",
  " ",
  ".",
  "..",
  "x".repeat(5000) + ".png",
];

const KEY_ONLY = /^[0-9A-HJKMNP-TV-Z]{26}\.(jpg|png|webp|avif|csv|json)$/;

describe("extensionForMime", () => {
  it.each([
    ["image/jpeg", ".jpg"],
    ["image/png", ".png"],
    ["image/webp", ".webp"],
    ["image/avif", ".avif"],
    ["text/csv", ".csv"],
    ["application/json", ".json"],
    ["IMAGE/PNG", ".png"],
    [" image/png ; charset=binary", ".png"],
    ["text/csv; charset=utf-8", ".csv"],
  ])("%p → %p", (mime, ext) => expect(extensionForMime(mime)).toBe(ext));

  it.each([
    "",
    "   ",
    undefined,
    null,
    0,
    "image/svg+xml",
    "text/html",
    "application/xhtml+xml",
    "application/pdf",
    "application/octet-stream",
    "image/jpg", // không chuẩn
    "image/*",
    "__proto__",
    "constructor",
    "toString",
    "image/png/../../x",
  ])("%p → null (ngoài allowlist)", (mime) => expect(extensionForMime(mime)).toBeNull());

  it("allowlist chỉ chứa đuôi một chấm, chữ thường", () => {
    for (const ext of Object.values(UPLOAD_MIME_EXTENSIONS)) expect(ext).toMatch(/^\.[a-z0-9]+$/);
  });
});

describe("generateUploadKey", () => {
  it("sinh `<ULID><đuôi chuẩn>`", () => {
    const key = generateUploadKey("image/jpeg");
    expect(key).toMatch(KEY_ONLY);
    expect(key.endsWith(".jpg")).toBe(true);
    expect(ULID_PATTERN.test(key.slice(0, 26))).toBe(true);
  });

  it("MIME rỗng/ngoài allowlist → INVALID_DATA, không sinh khoá", () => {
    for (const mime of ["", undefined, "text/html", "image/svg+xml"]) {
      expect(() => generateUploadKey(mime)).toThrow(/Loại file không được nhận/);
    }
  });

  it("bộ sinh id trả giá trị không phải ULID (vd chứa `../`) → từ chối", () => {
    expect(() => generateUploadKey("image/png", () => "../../etc/passwd")).toThrow(/không phải ULID/);
    expect(() => generateUploadKey("image/png", () => "")).toThrow(/không phải ULID/);
  });

  it("1000 khoá sinh liên tiếp đều khác nhau", () => {
    const keys = new Set(Array.from({ length: 1000 }, () => generateUploadKey("image/png")));
    expect(keys.size).toBe(1000);
  });
});

describe("ServerKeyedLocalFileService", () => {
  let base: string;
  let pub: string;
  let priv: string;
  let svc: ServerKeyedLocalFileService;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "xshop-upload-"));
    pub = path.join(base, "static");
    priv = path.join(base, "private");
    svc = new ServerKeyedLocalFileService(
      {},
      { upload_dir: pub, private_upload_dir: priv, backend_url: "http://localhost:9000/static" },
    );
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  /** Khoá provider local: `[private-]<Date.now()>-<ULID><đuôi>`. */
  const expectServerKey = (key: string, ext: string, isPrivate = false) => {
    expect(key).toMatch(new RegExp(`^${isPrivate ? "private-" : ""}\\d{13}-[0-9A-HJKMNP-TV-Z]{26}\\${ext}$`));
    expect(key).not.toContain("..");
    expect(key).not.toMatch(/[\\/]/);
  };

  it.each(HOSTILE_NAMES.map((n) => [n]))(
    "upload tên %j → khoá do server sinh, file nằm trong thư mục upload",
    async (filename) => {
      const res = await svc.upload({
        filename,
        mimeType: "image/png",
        content: PNG.toString("base64"),
        access: "public",
      });
      expectServerKey(res.key, ".png");
      expect(res.url).toBe(`http://localhost:9000/static/${res.key}`);
      // Không có file nào ngoài thư mục upload; trong thư mục chỉ đúng một file mang khoá vừa trả.
      expect(await readdir(base)).toEqual(["static"]);
      expect(await readdir(pub)).toEqual([res.key]);
      expect(await readFile(path.join(pub, res.key))).toEqual(PNG);
    },
  );

  it("đuôi kép theo tên client bị bỏ — đuôi lấy theo MIME", async () => {
    const res = await svc.upload({
      filename: "avatar.php.jpg.html",
      mimeType: "image/jpeg",
      content: PNG.toString("base64"),
      access: "public",
    });
    expectServerKey(res.key, ".jpg");
  });

  it("private → tiền tố `private-`, đọc/xoá lại được bằng khoá trả về", async () => {
    const res = await svc.upload({
      filename: "../../../root/.ssh/id_rsa",
      mimeType: "text/csv",
      content: "a,b\n1,2\n",
      access: "private",
    });
    expectServerKey(res.key, ".csv", true);
    expect((await svc.getAsBuffer({ fileKey: res.key })).toString("utf8")).toBe("a,b\n1,2\n");
    await svc.delete({ fileKey: res.key });
    expect(await readdir(priv)).toEqual([]);
  });

  it("MIME ngoài allowlist → từ chối, không ghi file", async () => {
    await expect(
      svc.upload({ filename: "x.png", mimeType: "text/html", content: "<script>", access: "public" }),
    ).rejects.toThrow(/Loại file không được nhận/);
    await expect(
      svc.upload({ filename: "x.png", mimeType: "", content: "", access: "public" }),
    ).rejects.toThrow(/Loại file không được nhận/);
    expect(await readdir(base)).toEqual([]);
  });

  it("getUploadStream (export CSV của Medusa) cũng dùng khoá server sinh", async () => {
    const { writeStream, promise, fileKey } = await svc.getUploadStream({
      filename: "../../evil/../export.csv",
      mimeType: "text/csv",
      access: "private",
    });
    writeStream.end("id\n1\n");
    const res = await promise;
    expectServerKey(fileKey, ".csv", true);
    expect(res.key).toBe(fileKey);
    expect(await readdir(base)).toEqual(["private"]);
  });

  it("getPresignedUploadUrl không trả tên client làm khoá", async () => {
    const res = await svc.getPresignedUploadUrl({ filename: "../../etc/passwd", mimeType: "image/webp" });
    expect(res.key).toMatch(KEY_ONLY);
    await expect(svc.getPresignedUploadUrl({ filename: "../../etc/passwd" })).rejects.toThrow(
      /Loại file không được nhận/,
    );
  });

  it("đồng thời: 50 upload cùng tên `../../etc/passwd` → 50 khoá khác nhau, không ghi đè", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        svc.upload({
          filename: "../../etc/passwd",
          mimeType: "image/png",
          content: Buffer.concat([PNG, Buffer.from([i])]).toString("base64"),
          access: "public",
        }),
      ),
    );
    const keys = results.map((r) => r.key);
    expect(new Set(keys).size).toBe(50);
    expect((await readdir(pub)).sort()).toEqual([...keys].sort());
  });
});
