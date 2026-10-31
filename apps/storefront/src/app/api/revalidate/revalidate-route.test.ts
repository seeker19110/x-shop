// @vitest-environment node
import { catalogRevalidate as protocol } from "@x-shop/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRevalidate, NonceStore, REVALIDATE_PROFILE } from "../../../lib/catalog/revalidate";
import { resetEnvCacheForTests } from "../../../lib/env";

/**
 * T-142 (D-070): route `/api/revalidate` — chữ ký HMAC + mốc thời gian + nonce chống phát lại, rồi `revalidateTag` hết hạn
 * ngay. Chữ ký dựng bằng đúng hàm của backend (`@x-shop/domain` catalogRevalidate) — hai phía không lệch nhau.
 */

const revalidateTag = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidateTag }));

const SECRET = "khoa-revalidate-thu-nghiem-0123456789abcdef";
const NOW = Date.UTC(2026, 9, 27, 3, 0, 0);
let nonceSeq = 0;

function signed(
  bodyObj: unknown,
  opts: {
    secret?: string;
    ts?: number;
    nonce?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const body = opts.body ?? JSON.stringify(bodyObj);
  const ts = String(Math.floor((opts.ts ?? NOW) / 1000));
  const nonce = opts.nonce ?? `nonce-${String(++nonceSeq).padStart(16, "0")}`;
  return new Request("http://sf.test/api/revalidate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [protocol.REVALIDATE_HEADERS.timestamp]: ts,
      [protocol.REVALIDATE_HEADERS.nonce]: nonce,
      [protocol.REVALIDATE_HEADERS.signature]: protocol.signRevalidate(
        opts.secret ?? SECRET,
        ts,
        nonce,
        body,
      ),
      ...opts.headers,
    },
    body,
  });
}

const GOOD = { id: "catalog.revalidate:w:1", tags: ["catalog:list", "product:ao-so-mi"] };

function deps(over: Partial<Parameters<typeof handleRevalidate>[1]> = {}) {
  const revalidate = vi.fn();
  return { revalidate, d: { secret: SECRET, nonces: new NonceStore(), revalidate, now: () => NOW, ...over } };
}

const code = async (res: Response) => ((await res.json()) as { code?: string }).code;

describe("handleRevalidate — được phép", () => {
  it("chữ ký đúng → 200, revalidate từng tag (bỏ trùng), no-store", async () => {
    const { revalidate, d } = deps();
    const res = await handleRevalidate(signed({ ...GOOD, tags: [...GOOD.tags, "catalog:list"] }), d);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ revalidated: 2 });
    expect(revalidate.mock.calls.map((c) => c[0])).toEqual(["catalog:list", "product:ao-so-mi"]);
  });

  it("lệch giờ trong ngưỡng (cả hai chiều) vẫn nhận", async () => {
    const { d } = deps();
    const tol = protocol.REVALIDATE_TOLERANCE_S * 1000;
    expect((await handleRevalidate(signed(GOOD, { ts: NOW - tol }), d)).status).toBe(200);
    expect((await handleRevalidate(signed(GOOD, { ts: NOW + tol }), d)).status).toBe(200);
  });

  it("idempotent: cùng nội dung gửi lại với nonce MỚI (backend retry) → 200 lần nữa", async () => {
    const { revalidate, d } = deps();
    expect((await handleRevalidate(signed(GOOD), d)).status).toBe(200);
    expect((await handleRevalidate(signed(GOOD), d)).status).toBe(200);
    expect(revalidate).toHaveBeenCalledTimes(4);
  });
});

describe("handleRevalidate — bị từ chối", () => {
  it("chữ ký sai (khoá khác, thân bị sửa, thiếu header, mốc quá hạn) → 401 chung, không revalidate", async () => {
    const { revalidate, d } = deps();
    const tampered = signed(GOOD);
    const cases: Request[] = [
      signed(GOOD, { secret: `${SECRET}-khac` }),
      new Request(tampered.url, {
        method: "POST",
        headers: tampered.headers,
        body: JSON.stringify({ ...GOOD, tags: ["catalog"] }),
      }),
      signed(GOOD, { headers: { [protocol.REVALIDATE_HEADERS.signature]: "" } }),
      new Request("http://sf.test/api/revalidate", { method: "POST", body: JSON.stringify(GOOD) }),
      signed(GOOD, { ts: NOW - (protocol.REVALIDATE_TOLERANCE_S + 1) * 1000 }),
      signed(GOOD, { ts: NOW + (protocol.REVALIDATE_TOLERANCE_S + 1) * 1000 }),
    ];
    for (const req of cases) {
      const res = await handleRevalidate(req, d);
      expect(res.status).toBe(401);
      expect(await code(res)).toBe("INVALID_SIGNATURE");
    }
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("phát lại đúng request (cùng nonce) → 409, không revalidate lần hai", async () => {
    const { revalidate, d } = deps();
    const req = signed(GOOD, { nonce: "nonce-phat-lai-000000001" });
    const again = req.clone();
    expect((await handleRevalidate(req, d)).status).toBe(200);
    const res = await handleRevalidate(again, d);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("REPLAYED");
    expect(revalidate).toHaveBeenCalledTimes(2);
  });

  it("đồng thời: 10 bản phát lại cùng nonce gửi cùng lúc → đúng một 200, chín 409", async () => {
    const { revalidate, d } = deps();
    const base = signed(GOOD, { nonce: "nonce-dong-thoi-0000001" });
    const statuses = await Promise.all(
      Array.from({ length: 10 }, () => handleRevalidate(base.clone(), d).then((r) => r.status)),
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    expect(revalidate).toHaveBeenCalledTimes(2);
  });

  it("chữ ký sai KHÔNG ghi nonce (kẻ không có khoá không làm đầy bộ nhớ / chặn trước nonce thật)", async () => {
    const { d } = deps();
    const nonce = "nonce-cuop-truoc-000001";
    expect((await handleRevalidate(signed(GOOD, { nonce, secret: `${SECRET}x` }), d)).status).toBe(401);
    expect(d.nonces.size).toBe(0);
    expect((await handleRevalidate(signed(GOOD, { nonce }), d)).status).toBe(200);
  });

  it("thân sai (sau khi chữ ký đúng) → 400: không JSON, thiếu tag, tag lạ, quá nhiều tag, id rỗng", async () => {
    const { revalidate, d } = deps();
    const bodies = [
      { body: "không phải json" },
      { obj: { id: "x", tags: [] } },
      { obj: { id: "x", tags: ["orders"] } },
      { obj: { id: "x", tags: ["product:a b"] } },
      {
        obj: {
          id: "x",
          tags: Array.from({ length: protocol.REVALIDATE_MAX_TAGS + 1 }, (_, i) => `product:p${i}`),
        },
      },
      { obj: { id: "", tags: ["catalog"] } },
      { obj: ["catalog"] },
    ];
    for (const b of bodies) {
      const res = await handleRevalidate(signed(b.obj, { body: b.body }), d);
      expect(res.status).toBe(400);
    }
    expect(revalidate).not.toHaveBeenCalled();
  });

  /** Thân chunked (không Content-Length) đếm số byte đã bị kéo khỏi luồng. */
  function endless(totalBytes: number) {
    const CHUNK = 64 * 1024;
    const state = { pulled: 0 };
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (state.pulled >= totalBytes) return c.close();
        state.pulled += CHUNK;
        c.enqueue(new Uint8Array(CHUNK).fill(0x61));
      },
    });
    return { body, state };
  }

  it("thân chunked không Content-Length quá trần → 413 sau khi đọc ~trần, không đọc hết (review T-142)", async () => {
    const { d } = deps();
    const total = 64 * 1024 * 1024;
    const { body, state } = endless(total);
    const req = signed(null, { body: "" });
    const chunked = new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body,
      duplex: "half",
    } as RequestInit);
    expect(chunked.headers.get("content-length")).toBeNull();
    expect((await handleRevalidate(chunked, d)).status).toBe(413);
    expect(state.pulled).toBeLessThanOrEqual(protocol.REVALIDATE_MAX_BODY_BYTES + 3 * 64 * 1024);
  });

  it("không có header chữ ký → 401 mà KHÔNG đọc thân", async () => {
    const { d } = deps();
    const { body, state } = endless(64 * 1024 * 1024);
    const req = new Request("http://sf.test/api/revalidate", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    expect((await handleRevalidate(req, d)).status).toBe(401);
    expect(state.pulled).toBeLessThanOrEqual(2 * 64 * 1024); // chỉ phần luồng tự nạp trước, không đọc thêm
  });

  it("thân quá lớn → 413 (theo content-length khai báo hoặc số byte thật)", async () => {
    const { d } = deps();
    const big = JSON.stringify({
      id: "x",
      tags: ["catalog"],
      pad: "đ".repeat(protocol.REVALIDATE_MAX_BODY_BYTES),
    });
    expect((await handleRevalidate(signed(null, { body: big }), d)).status).toBe(413);
    const declared = signed(GOOD, {
      headers: { "content-length": String(protocol.REVALIDATE_MAX_BODY_BYTES + 1) },
    });
    expect((await handleRevalidate(declared, d)).status).toBe(413);
  });

  it("webhook tắt (không có khoá) → 503", async () => {
    const { d } = deps({ secret: undefined });
    const res = await handleRevalidate(signed(GOOD), d);
    expect(res.status).toBe(503);
    expect(await code(res)).toBe("REVALIDATE_DISABLED");
  });

  it("bộ nhớ nonce đầy (chưa có nonce hết hạn để dọn) → 503 + Retry-After; nonce hết hạn được dọn", async () => {
    const nonces = new NonceStore(2);
    let now = NOW;
    const { d } = deps({ nonces, now: () => now });
    expect((await handleRevalidate(signed(GOOD), d)).status).toBe(200);
    expect((await handleRevalidate(signed(GOOD), d)).status).toBe(200);
    const full = await handleRevalidate(signed(GOOD), d);
    expect(full.status).toBe(503);
    expect(full.headers.get("retry-after")).toBe("5");
    now = NOW + (protocol.REVALIDATE_TOLERANCE_S + 1) * 1000;
    expect((await handleRevalidate(signed(GOOD, { ts: now }), d)).status).toBe(200);
    expect(nonces.size).toBe(1);
  });
});

describe("route POST /api/revalidate", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    revalidateTag.mockReset();
    resetEnvCacheForTests();
  });
  afterEach(() => {
    process.env = { ...saved };
    resetEnvCacheForTests();
  });

  it("đọc khoá từ env server và gọi revalidateTag(tag, { expire: 0 }) — hết hạn ngay, không SWR", async () => {
    process.env.CATALOG_REVALIDATE_SECRET = SECRET;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const { POST } = await import("./route");
      const res = await POST(signed(GOOD));
      expect(res.status).toBe(200);
      expect(revalidateTag.mock.calls).toEqual([
        ["catalog:list", REVALIDATE_PROFILE],
        ["product:ao-so-mi", REVALIDATE_PROFILE],
      ]);
      expect(REVALIDATE_PROFILE).toEqual({ expire: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("env không có khoá → 503, không gọi revalidateTag", async () => {
    delete process.env.CATALOG_REVALIDATE_SECRET;
    const { POST } = await import("./route");
    expect((await POST(signed(GOOD))).status).toBe(503);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
