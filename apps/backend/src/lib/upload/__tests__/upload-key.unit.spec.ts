import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  extensionForMime,
  generateUploadKey,
  isPrivateFileKey,
  mimeForFileKey,
  ULID_PATTERN,
  UPLOAD_MIME_EXTENSIONS,
} from "../key";
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
      // Không có file nào ngoài thư mục upload; trong thư mục chỉ đúng một file mang khoá vừa trả. Thư mục private (tạo lúc
      // khởi tạo provider — T-141) vẫn rỗng.
      expect((await readdir(base)).sort()).toEqual(["private", "static"]);
      expect(await readdir(priv)).toEqual([]);
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
    expect(await readdir(base)).toEqual(["private"]);
    expect(await readdir(priv)).toEqual([]);
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

/**
 * T-141 (BE-FILE-005, hỗ trợ BE-FILE-004): file private nằm ngoài thư mục công khai `static/`, chỉ tải qua route admin có
 * xác thực + phân quyền `GET /admin/x/files/:key`. URL do provider trả cho file private trỏ về route đó, không về `/static`.
 */
describe("isPrivateFileKey / mimeForFileKey (khoá file private hợp lệ — chống path traversal + chống đoán)", () => {
  const ULID = "01J9ZQ8Y3M4N5P6Q7R8S9T0VWX";
  const OK = `private-1730000000000-${ULID}.csv`;

  it.each([
    [OK, "text/csv"],
    [`private-1730000000000-${ULID}.json`, "application/json"],
    [`private-1730000000000-${ULID}.png`, "image/png"],
    [`private-1730000000000-${ULID}.jpg`, "image/jpeg"],
  ])("%p hợp lệ → %p", (key, mime) => {
    expect(isPrivateFileKey(key)).toBe(true);
    expect(mimeForFileKey(key)).toBe(mime);
  });

  it.each([
    "",
    " ",
    undefined,
    null,
    42,
    `1730000000000-${ULID}.png`, // file công khai
    `private-1730000000000-${ULID}`, // thiếu đuôi
    `private-1730000000000-${ULID}.CSV`,
    `private-1730000000000-${ULID}.html`,
    `private-1730000000000-${ULID}.csv.html`,
    `private-1730000000000-${ULID}.csv/`,
    `private-1730000000000-${ULID.toLowerCase()}.csv`,
    `private-1730000000000-${ULID.slice(1)}.csv`,
    `private-173000000000-${ULID}.csv`, // 12 chữ số
    `private-1730000000000-${ULID}.csv\u0000`,
    `private-1730000000000-${ULID}.csv\n`,
    `../private-1730000000000-${ULID}.csv`,
    `private-1730000000000-${ULID}/../../../etc/passwd`,
    "private-../../etc/passwd",
    "../../etc/passwd",
    "/etc/passwd",
    "..\\..\\windows\\win.ini",
    `%2e%2e%2fprivate-1730000000000-${ULID}.csv`,
    `sub/private-1730000000000-${ULID}.csv`,
    `private-1730000000000-${"I".repeat(26)}.csv`, // I/L/O/U không thuộc Crockford base32
  ])("%p → không phải khoá private", (key) => {
    expect(isPrivateFileKey(key)).toBe(false);
  });

  it("khoá do chính provider sinh luôn khớp mẫu (1000 lần)", () => {
    for (let i = 0; i < 1000; i++) {
      expect(isPrivateFileKey(`private-${Date.now()}-${generateUploadKey("text/csv")}`)).toBe(true);
    }
  });

  it("mimeForFileKey: đuôi ngoài allowlist → null", () => {
    expect(mimeForFileKey("x.html")).toBeNull();
    expect(mimeForFileKey("x")).toBeNull();
    expect(mimeForFileKey(undefined)).toBeNull();
  });
});

describe("ServerKeyedLocalFileService — thư mục private tách khỏi webroot (T-141)", () => {
  let base: string;
  let pub: string;
  let priv: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "xshop-private-"));
    pub = path.join(base, "static");
    priv = path.join(base, "private");
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const make = (opts: Record<string, unknown>) => new ServerKeyedLocalFileService({}, opts);

  it("thiếu private_upload_dir → từ chối khởi tạo (mặc định của Medusa là `static/` công khai)", () => {
    expect(() => make({ upload_dir: pub })).toThrow(/private_upload_dir/);
    expect(() => make({ upload_dir: pub, private_upload_dir: "" })).toThrow(/private_upload_dir/);
    expect(() => make({ upload_dir: pub, private_upload_dir: "   " })).toThrow(/private_upload_dir/);
  });

  it.each([
    ["trùng thư mục công khai", (p: string) => p],
    ["nằm trong thư mục công khai", (p: string) => path.join(p, "private")],
    ["nằm trong thư mục công khai (qua `..`)", (p: string) => path.join(p, "a", "..", "b")],
    ["chứa thư mục công khai", (p: string) => path.dirname(p)],
  ])("private_upload_dir %s → từ chối khởi tạo", (_label, privOf) => {
    expect(() => make({ upload_dir: pub, private_upload_dir: privOf(pub) })).toThrow(/private_upload_dir/);
  });

  it("không có upload_dir: thư mục công khai mặc định `<cwd>/static` cũng được đối chiếu", () => {
    expect(() => make({ private_upload_dir: path.join(process.cwd(), "static", "private") })).toThrow(
      /private_upload_dir/,
    );
    expect(() => make({ private_upload_dir: priv })).not.toThrow();
  });

  it("upload private → file trong thư mục private (không có trong `static/`), URL trỏ route admin có kiểm quyền", async () => {
    const svc = make({
      upload_dir: pub,
      private_upload_dir: priv,
      backend_url: "http://localhost:9000/static",
    });
    const res = await svc.upload({
      filename: "khach-hang.csv",
      mimeType: "text/csv",
      content: "email\nkhach@example.test\n",
      access: "private",
    });
    expect(isPrivateFileKey(res.key)).toBe(true);
    expect(res.url).toBe(`http://localhost:9000/admin/x/files/${res.key}`);
    expect(res.url).not.toContain("/static");
    expect(await readdir(base)).toEqual(["private"]);
    expect(await readdir(priv)).toEqual([res.key]);
  });

  it("upload công khai giữ nguyên hành vi: `static/` + URL `/static/<khoá>`", async () => {
    const svc = make({
      upload_dir: pub,
      private_upload_dir: priv,
      backend_url: "http://localhost:9000/static",
    });
    const res = await svc.upload({
      filename: "a.png",
      mimeType: "image/png",
      content: PNG.toString("base64"),
      access: "public",
    });
    expect(res.url).toBe(`http://localhost:9000/static/${res.key}`);
    expect(await svc.getPresignedDownloadUrl({ fileKey: res.key })).toBe(res.url);
  });

  it("getPresignedDownloadUrl: private → route admin (không /static); không tồn tại → NOT_FOUND", async () => {
    const svc = make({
      upload_dir: pub,
      private_upload_dir: priv,
      backend_url: "https://api.example.vn/static",
    });
    const res = await svc.upload({ filename: "x", mimeType: "text/csv", content: "a\n", access: "private" });
    expect(await svc.getPresignedDownloadUrl({ fileKey: res.key })).toBe(
      `https://api.example.vn/admin/x/files/${res.key}`,
    );
    await svc.delete({ fileKey: res.key });
    await expect(svc.getPresignedDownloadUrl({ fileKey: res.key })).rejects.toThrow(/not found/i);
  });

  it("getUploadStream private (xuất CSV/JSON native) → URL và kết quả promise đều trỏ route admin", async () => {
    const svc = make({
      upload_dir: pub,
      private_upload_dir: priv,
      backend_url: "http://localhost:9000/static",
    });
    const { writeStream, promise, fileKey, url } = await svc.getUploadStream({
      filename: "1730000000000-customer-exports.json",
      mimeType: "application/json",
      access: "private",
    });
    writeStream.end("[]");
    const done = await promise;
    expect(url).toBe(`http://localhost:9000/admin/x/files/${fileKey}`);
    expect(done).toEqual({ key: fileKey, url });
    expect(await readdir(priv)).toEqual([fileKey]);
  });

  it("getUploadStream không khai `access` (mặc định của workflow xuất Medusa) → private", async () => {
    const svc = make({ upload_dir: pub, private_upload_dir: priv });
    const { writeStream, promise, fileKey } = await svc.getUploadStream({
      filename: "x.csv",
      mimeType: "text/csv",
    });
    writeStream.end("a\n");
    await promise;
    expect(isPrivateFileKey(fileKey)).toBe(true);
    expect(await readdir(base)).toEqual(["private"]);
  });

  it("đồng thời: 30 upload private + 30 công khai → mỗi loại đúng thư mục, URL đúng loại", async () => {
    const svc = make({
      upload_dir: pub,
      private_upload_dir: priv,
      backend_url: "http://localhost:9000/static",
    });
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        svc.upload({
          filename: "../../etc/passwd",
          mimeType: i % 2 ? "text/csv" : "image/png",
          content: i % 2 ? `a\n${i}\n` : PNG.toString("base64"),
          access: i % 2 ? "private" : "public",
        }),
      ),
    );
    const priv30 = results.filter((_, i) => i % 2);
    const pub30 = results.filter((_, i) => !(i % 2));
    expect((await readdir(priv)).sort()).toEqual(priv30.map((r) => r.key).sort());
    expect((await readdir(pub)).sort()).toEqual(pub30.map((r) => r.key).sort());
    for (const r of priv30) expect(r.url).toBe(`http://localhost:9000/admin/x/files/${r.key}`);
    for (const r of pub30) expect(r.url).toBe(`http://localhost:9000/static/${r.key}`);
  });

  // Review T-141 🟢3/🟢4: quyền thư mục/file private và symlink vào static/.
  const modeOf = async (p: string) => (await stat(p)).mode & 0o777;

  it("thư mục private chưa có → tạo lúc khởi tạo với quyền 700 (cả thư mục cha mới tạo)", async () => {
    const nested = path.join(priv, "a", "b");
    make({ upload_dir: pub, private_upload_dir: nested });
    expect(await modeOf(nested)).toBe(0o700);
    expect(await modeOf(priv)).toBe(0o700);
  });

  it.each([0o750, 0o755, 0o705, 0o777, 0o701, 0o710].map((m) => [m.toString(8), m] as const))(
    "thư mục có sẵn mở quyền group/other (%s) → từ chối khởi tạo, không tự chmod",
    async (_octal, mode) => {
      await mkdir(priv, { mode: 0o700 });
      await chmod(priv, mode);
      expect(() => make({ upload_dir: pub, private_upload_dir: priv })).toThrow(/group\/other.*chmod 700/);
      expect(await modeOf(priv)).toBe(mode);
    },
  );

  it("thư mục có sẵn quyền 700 → nhận", async () => {
    await mkdir(priv, { mode: 0o700 });
    expect(() => make({ upload_dir: pub, private_upload_dir: priv })).not.toThrow();
  });

  it("đường dẫn private là file, không phải thư mục → từ chối", async () => {
    await writeFile(priv, "x");
    expect(() => make({ upload_dir: pub, private_upload_dir: priv })).toThrow();
  });

  it.each([
    ["symlink trỏ vào static/", (p: string) => path.join(p, "sub")],
    ["symlink trỏ đúng static/", (p: string) => p],
  ])("%s → từ chối (kiểm sau khi theo symlink), không ghi gì vào static", async (_label, targetOf) => {
    await mkdir(path.join(pub, "sub"), { recursive: true, mode: 0o700 });
    await chmod(pub, 0o700);
    await symlink(targetOf(pub), priv);
    expect(() => make({ upload_dir: pub, private_upload_dir: priv })).toThrow(/sau khi theo symlink/);
    expect(await readdir(path.join(pub, "sub"))).toEqual([]);
  });

  it("static/ là symlink tới thư mục chứa private → từ chối", async () => {
    const real = path.join(base, "real");
    await mkdir(path.join(real, "private"), { recursive: true, mode: 0o700 });
    await chmod(real, 0o700);
    await symlink(path.join(real, "private"), pub); // static → real/private
    expect(() => make({ upload_dir: pub, private_upload_dir: path.join(real, "private") })).toThrow(
      /private_upload_dir/,
    );
  });

  it("symlink ra ngoài static/ (vd. volume gắn ở chỗ khác) → nhận, ghi vào đích thật", async () => {
    const vol = path.join(base, "volume");
    await mkdir(vol, { mode: 0o700 });
    await symlink(vol, priv);
    const svc = make({ upload_dir: pub, private_upload_dir: priv });
    const res = await svc.upload({ filename: "x", mimeType: "text/csv", content: "a\n", access: "private" });
    expect(await readdir(vol)).toEqual([res.key]);
  });

  it("file private ghi ra có quyền 600 (upload và stream); file công khai không bị hạ quyền", async () => {
    const svc = make({ upload_dir: pub, private_upload_dir: priv });
    const up = await svc.upload({ filename: "x", mimeType: "text/csv", content: "a\n", access: "private" });
    expect(await modeOf(path.join(priv, up.key))).toBe(0o600);
    const { writeStream, promise, fileKey } = await svc.getUploadStream({
      filename: "x.json",
      mimeType: "application/json",
      access: "private",
    });
    writeStream.end("[]");
    await promise;
    expect(await modeOf(path.join(priv, fileKey))).toBe(0o600);
    const pubRes = await svc.upload({
      filename: "a.png",
      mimeType: "image/png",
      content: PNG.toString("base64"),
      access: "public",
    });
    // Công khai: quyền như một file ghi thường (umask của tiến trình — provider gốc), không qua chmod 600.
    await writeFile(path.join(base, "doi-chung"), "x");
    expect(await modeOf(path.join(pub, pubRes.key))).toBe(await modeOf(path.join(base, "doi-chung")));
  });
});
