import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Logger } from "@medusajs/framework/types";
import { startFakeS3 } from "../../../../integration-tests/helpers/fake-s3";
import { S3_TIMEOUTS, s3RequestHandlerOptions } from "../../infra/timeouts";
import { ACCESS_DENIED_HINT, SharedS3FileService, type SharedS3Options } from "../s3/provider";

/**
 * T-154 (review): kho S3 lỗi/treo không được làm treo hay sập tiến trình.
 *  - Kho nhận TCP mà không trả lời → upload/tải/xoá/kiểm tồn tại lỗi TimeoutError trong hạn (mặc định SDK là vô hạn).
 *  - Ghi stream kiểu bước xuất của Medusa (chờ `drain`, chỉ await `promise` sau khi ghi xong) mà kho từ chối giữa chừng →
 *    bên ghi chạy hết rồi nhận lỗi; không có unhandled rejection (worker có handler lỗi tiến trình → exit).
 *  - Kho trả 403 cho khoá không có (thiếu s3:ListBucket) → không giả làm 404; log nêu nguyên nhân, không chứa khoá.
 */

jest.setTimeout(60_000);

const KEY = "private-1730000000000-01J9ZQ8Y3M4N5P6Q7R8S9T0VWX.csv";
const quiet = { error: () => undefined, warn: () => undefined, info: () => undefined } as unknown as Logger;

const opts = (endpoint: string, over: Partial<SharedS3Options> = {}): SharedS3Options => ({
  endpoint,
  region: "us-east-1",
  bucket: "pub",
  private_bucket: "priv",
  file_url: `${endpoint}/pub`,
  access_key_id: "AKIDFAULTS",
  secret_access_key: "faults-secret-0123456789",
  force_path_style: true,
  backend_url: "https://api.shop.example",
  ...over,
});

/** Kết quả của `p` hoặc "STILL_PENDING" sau `ms`. */
async function settleWithin(p: Promise<unknown>, ms: number) {
  const t0 = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    p.then(
      () => "resolved",
      (e: { name?: string }) => `rejected:${e?.name}`,
    ),
    new Promise<string>((r) => {
      timer = setTimeout(() => r("STILL_PENDING"), ms);
    }),
  ]);
  clearTimeout(timer);
  return { outcome, elapsedMs: Date.now() - t0 };
}

/** Như bước xuất của Medusa 2.22.1 (core-flows export-*: writeToStream). */
const writeToStream = async (ws: NodeJS.WritableStream, data: string) => {
  if (!ws.write(data)) await new Promise((resolve) => ws.once("drain", resolve));
};

async function exportLike(svc: SharedS3FileService, mib: number) {
  const { writeStream, promise } = await svc.getUploadStream({ filename: "x.csv", mimeType: "text/csv" });
  const line = "khach@example.test,Nguyen Van A,0900000000\n".repeat(1000); // ~43 KB
  const rounds = Math.ceil((mib * 1024 * 1024) / line.length);
  for (let i = 0; i < rounds; i++) await writeToStream(writeStream, line);
  writeStream.end();
  return promise;
}

function trackUnhandled() {
  const seen: string[] = [];
  const on = (r: unknown) => seen.push(String((r as { name?: string })?.name));
  process.on("unhandledRejection", on);
  return { seen, stop: () => process.off("unhandledRejection", on) };
}

describe("hạn mặc định", () => {
  it("S3_TIMEOUTS hữu hạn, dương; requestHandler bật throwOnRequestTimeout", () => {
    for (const v of Object.values(S3_TIMEOUTS)) {
      expect(Number.isSafeInteger(v) && v > 0).toBe(true);
    }
    expect(s3RequestHandlerOptions()).toEqual({
      connectionTimeout: S3_TIMEOUTS.connectTimeoutMs,
      requestTimeout: S3_TIMEOUTS.requestTimeoutMs,
      socketTimeout: S3_TIMEOUTS.socketIdleTimeoutMs,
      throwOnRequestTimeout: true,
    });
    expect(s3RequestHandlerOptions({ requestTimeoutMs: 10 }).requestTimeout).toBe(10);
  });
});

describe("kho treo (nhận TCP, không bao giờ trả lời)", () => {
  let server: net.Server;
  const sockets: net.Socket[] = [];
  let endpoint = "";
  beforeAll(async () => {
    server = net.createServer((s) => {
      sockets.push(s);
      s.on("error", () => undefined);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => server.close(r));
  });

  it("upload / getDownloadStream / getAsBuffer / delete / getPresignedDownloadUrl → TimeoutError trong hạn", async () => {
    const svc = new SharedS3FileService(
      { logger: quiet },
      opts(endpoint, {
        timeouts: { connectTimeoutMs: 300, requestTimeoutMs: 300, socketIdleTimeoutMs: 300 },
      }),
    );
    const results = await Promise.all([
      settleWithin(
        svc.upload({ filename: "x", mimeType: "text/csv", content: "a\n", access: "private" }),
        15_000,
      ),
      settleWithin(svc.getDownloadStream({ fileKey: KEY }), 15_000),
      settleWithin(svc.getAsBuffer({ fileKey: KEY }), 15_000),
      settleWithin(svc.delete({ fileKey: KEY }), 15_000),
      settleWithin(svc.getPresignedDownloadUrl({ fileKey: KEY }), 15_000),
    ]);
    for (const r of results) {
      expect(r.outcome).toBe("rejected:TimeoutError");
      expect(r.elapsedMs).toBeLessThan(15_000);
    }
  });
});

describe("ghi stream (xuất) thất bại giữa chừng", () => {
  it("kho không hỗ trợ multipart, xuất 12 MiB → bên ghi chạy hết, nhận lỗi; không unhandled rejection", async () => {
    const fake = await startFakeS3({
      accessKeyId: "AKIDFAULTS",
      publicBuckets: ["pub"],
      privateBuckets: ["priv"],
    });
    const unhandled = trackUnhandled();
    try {
      const svc = new SharedS3FileService({ logger: quiet }, opts(fake.endpoint));
      const r = await settleWithin(exportLike(svc, 12), 20_000);
      await new Promise((res) => setTimeout(res, 200));
      expect(r.outcome).toBe("rejected:NotImplemented");
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.stop();
      await fake.close();
    }
  });

  it.each([1, 12])(
    "kho trả 503 cho mọi request, xuất %i MiB → lỗi SlowDown sau vài lần thử; không treo, không unhandled",
    async (mib) => {
      let hits = 0;
      const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          hits += 1;
          res.statusCode = 503;
          res.setHeader("content-type", "application/xml");
          res.end(
            `<?xml version="1.0" encoding="UTF-8"?><Error><Code>SlowDown</Code><Message>x</Message></Error>`,
          );
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const unhandled = trackUnhandled();
      try {
        const svc = new SharedS3FileService({ logger: quiet }, opts(endpoint));
        const r = await settleWithin(exportLike(svc, mib), 20_000);
        await new Promise((res) => setTimeout(res, 200));
        expect(r.outcome).toBe("rejected:SlowDown");
        expect(hits).toBeGreaterThan(0);
        expect(unhandled.seen).toEqual([]);
      } finally {
        unhandled.stop();
        server.closeAllConnections();
        await new Promise((res) => server.close(res));
      }
    },
  );
});

describe("kho trả 403 cho khoá không có (thiếu s3:ListBucket)", () => {
  it("không đổi thành ENOENT/404; log nêu nguyên nhân, không chứa khoá", async () => {
    const fake = await startFakeS3({
      accessKeyId: "AKIDFAULTS",
      publicBuckets: ["pub"],
      privateBuckets: ["priv"],
      missingKeyStatus: 403,
    });
    const error = jest.fn();
    try {
      const svc = new SharedS3FileService(
        { logger: { ...quiet, error } as unknown as Logger },
        opts(fake.endpoint),
      );
      for (const call of [
        () => svc.getDownloadStream({ fileKey: KEY }),
        () => svc.getAsBuffer({ fileKey: KEY }),
        () => svc.getPresignedDownloadUrl({ fileKey: KEY }),
      ]) {
        const err = await (call() as Promise<unknown>).then(
          () => null,
          (e: { code?: unknown; $metadata?: { httpStatusCode?: number } }) => e,
        );
        expect(err?.code).not.toBe("ENOENT");
        expect(err?.$metadata?.httpStatusCode).toBe(403);
      }
      expect(error).toHaveBeenCalledWith(ACCESS_DENIED_HINT);
      expect(error.mock.calls.flat().join(" ")).not.toContain(KEY);
    } finally {
      await fake.close();
    }
  });
});
