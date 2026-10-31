import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Kho S3-compatible TỐI THIỂU chạy trong tiến trình test (T-154) — để test tích hợp `upload` chạy được ở CI/máy không có
 * kho S3 tự host. Một server HTTP thật, client là AWS SDK thật (qua provider của dự án): đủ để chứng minh hai bản sao cùng
 * cấu hình thấy cùng dữ liệu, nhưng KHÔNG thay kiểm thử với kho thật (Garage/SeaweedFS…): chạy lại cùng suite với
 * `XS_TEST_S3_ENDPOINT` (docs/ops/ENV.md).
 *
 * Hỗ trợ (path-style `/<bucket>/<khoá>`): PutObject, GetObject, HeadObject, DeleteObject; bucket lạ → NoSuchBucket.
 * Quyền: request có `Authorization` SigV4 phải mang đúng access key (chữ ký KHÔNG được kiểm — giả lập); request nặc danh chỉ
 * được GET/HEAD trên bucket công khai (như policy `s3:GetObject` cho `*`), còn lại AccessDenied 403.
 * KHÔNG có: multipart (`?uploads` → 501 — file > 5 MiB qua getUploadStream thất bại), kiểm chữ ký SigV4, policy/ACL thật,
 * phiên bản object. Kết quả trên kho giả KHÔNG đủ làm bằng chứng tick BE-FILE-004 — cần chạy với kho thật.
 * `missingKeyStatus: 403` giả lập AWS khi khoá truy cập thiếu `s3:ListBucket` (khoá không có → AccessDenied thay vì 404).
 */
export interface FakeS3Options {
  accessKeyId: string;
  publicBuckets: readonly string[];
  privateBuckets: readonly string[];
  /** Mã trả cho khoá không tồn tại: 404 (mặc định) hoặc 403 AccessDenied (AWS khi thiếu s3:ListBucket). */
  missingKeyStatus?: 404 | 403;
}

export interface FakeS3 {
  endpoint: string;
  /** Số object đang lưu theo bucket (đọc trực tiếp kho, không qua API). */
  count(bucket: string): number;
  /** Tổng số request kho đã nhận (kiểm "không gọi kho"). */
  requests(): number;
  close(): Promise<void>;
}

interface StoredObject {
  body: Buffer;
  contentType: string;
  cacheControl: string | undefined;
}

const xmlError = (res: http.ServerResponse, status: number, code: string, method: string) => {
  res.statusCode = status;
  if (method === "HEAD") return res.end();
  res.setHeader("content-type", "application/xml");
  res.end(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
  );
};

export async function startFakeS3(opts: FakeS3Options): Promise<FakeS3> {
  const buckets = new Map<string, Map<string, StoredObject>>();
  for (const b of [...opts.publicBuckets, ...opts.privateBuckets]) buckets.set(b, new Map());
  const publicSet = new Set(opts.publicBuckets);
  let requestCount = 0;

  const server = http.createServer((req, res) => {
    requestCount += 1;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://fake-s3");
      const [, rawBucket = "", ...rest] = url.pathname.split("/");
      const bucket = decodeURIComponent(rawBucket);
      const key = rest.map(decodeURIComponent).join("/");
      const store = buckets.get(bucket);
      if (store === undefined) return xmlError(res, 404, "NoSuchBucket", method);

      const auth = req.headers.authorization;
      if (auth === undefined) {
        const anonymousRead = publicSet.has(bucket) && (method === "GET" || method === "HEAD");
        if (!anonymousRead) return xmlError(res, 403, "AccessDenied", method);
      } else if (!auth.includes(`Credential=${opts.accessKeyId}/`)) {
        return xmlError(res, 403, "InvalidAccessKeyId", method);
      }
      // SDK v3 gắn `?x-id=<Thao tác>`; tham số khác (multipart `uploads`, `delete` hàng loạt…) chưa hỗ trợ → 501 rõ ràng.
      const unsupported = [...url.searchParams.keys()].some((k) => k !== "x-id");
      if (key === "" || unsupported) return xmlError(res, 501, "NotImplemented", method);

      if (method === "PUT") {
        store.set(key, {
          body: Buffer.concat(chunks),
          contentType: String(req.headers["content-type"] ?? "application/octet-stream"),
          cacheControl: req.headers["cache-control"] as string | undefined,
        });
        res.statusCode = 200;
        res.setHeader("etag", `"${key.length}"`);
        return res.end();
      }
      if (method === "DELETE") {
        store.delete(key);
        res.statusCode = 204;
        return res.end();
      }
      if (method === "GET" || method === "HEAD") {
        const obj = store.get(key);
        if (obj === undefined) {
          if (opts.missingKeyStatus === 403) return xmlError(res, 403, "AccessDenied", method);
          return xmlError(res, 404, method === "HEAD" ? "NotFound" : "NoSuchKey", method);
        }
        res.statusCode = 200;
        res.setHeader("content-type", obj.contentType);
        res.setHeader("content-length", String(obj.body.length));
        if (obj.cacheControl !== undefined) res.setHeader("cache-control", obj.cacheControl);
        return method === "HEAD" ? res.end() : res.end(obj.body);
      }
      return xmlError(res, 405, "MethodNotAllowed", method);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    count: (bucket) => buckets.get(bucket)?.size ?? 0,
    requests: () => requestCount,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
