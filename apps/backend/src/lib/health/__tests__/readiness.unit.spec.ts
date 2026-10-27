import { checkReadiness, coalesce, READINESS_PROBE_TIMEOUT_MS, runProbe } from "../readiness";

const never = () => new Promise<never>(() => undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runProbe", () => {
  it("probe xong trong hạn → true", async () => {
    expect(await runProbe(async () => 1, 50)).toBe(true);
  });

  it("probe reject → false (không ném)", async () => {
    expect(await runProbe(() => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:5432")), 50)).toBe(
      false,
    );
  });

  it("probe ném đồng bộ → false", async () => {
    expect(
      await runProbe(() => {
        throw new Error("boom");
      }, 50),
    ).toBe(false);
  });

  it("probe treo → false sau đúng hạn, không chờ lời gọi gốc", async () => {
    const t0 = Date.now();
    expect(await runProbe(never, 60)).toBe(false);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(55);
    expect(elapsed).toBeLessThan(500);
  });

  it("probe reject SAU khi quá hạn → không thành unhandledRejection", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(await runProbe(() => sleep(40).then(() => Promise.reject(new Error("muộn"))), 10)).toBe(false);
      await sleep(80);
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("hạn mặc định ngắn (≤ 2 s)", () => {
    expect(READINESS_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(READINESS_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
  });
});

describe("checkReadiness", () => {
  it("rỗng → ready", async () => {
    expect(await checkReadiness({}, 10)).toEqual({ ready: true, failed: [] });
  });

  it("mọi probe đạt → ready", async () => {
    expect(await checkReadiness({ database: async () => 1, redis: async () => "PONG" }, 50)).toEqual({
      ready: true,
      failed: [],
    });
  });

  it("một phụ thuộc hỏng → không ready, chỉ nêu tên (không thông điệp lỗi)", async () => {
    const r = await checkReadiness(
      { database: async () => 1, redis: () => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:6379")) },
      50,
    );
    expect(r).toEqual({ ready: false, failed: ["redis"] });
  });

  it("probe chạy song song: hai probe treo → tổng ≈ một hạn", async () => {
    // Đồng hồ giả: đo wall-clock (< 150 ms) từng đỏ khi máy tải nặng (328 ms). Tiến đúng MỘT hạn mà đã có kết quả
    // ⇒ hai hạn chạy cùng lúc; chạy tuần tự sẽ cần hai hạn (160 ms) nên còn treo.
    jest.useFakeTimers();
    try {
      let r: Awaited<ReturnType<typeof checkReadiness>> | undefined;
      void checkReadiness({ database: never, redis: never }, 80).then((v) => (r = v));
      await jest.advanceTimersByTimeAsync(80);
      expect(r).toEqual({ ready: false, failed: ["database", "redis"] });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("coalesce", () => {
  it("20 lời gọi đồng thời cùng khoá → chạy probe đúng 1 lần, cùng kết quả", async () => {
    const key = {};
    let runs = 0;
    const run = async () => {
      runs += 1;
      await sleep(30);
      return { ready: true, failed: [] };
    };
    const results = await Promise.all(Array.from({ length: 20 }, () => coalesce(key, run)));
    expect(runs).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it("lượt trước xong → lượt sau chạy mới (không cache kết quả cũ)", async () => {
    const key = {};
    let healthy = false;
    const run = async () => ({ ready: healthy, failed: healthy ? [] : ["database"] });
    expect((await coalesce(key, run)).ready).toBe(false);
    healthy = true;
    expect((await coalesce(key, run)).ready).toBe(true);
  });

  it("lượt reject → lượt sau vẫn chạy được", async () => {
    const key = {};
    await expect(coalesce(key, () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await coalesce(key, async () => ({ ready: true, failed: [] }))).toEqual({
      ready: true,
      failed: [],
    });
  });

  it("khoá khác nhau → không gộp", async () => {
    let runs = 0;
    const run = async () => {
      runs += 1;
      await sleep(10);
      return { ready: true, failed: [] };
    };
    await Promise.all([coalesce({}, run), coalesce({}, run)]);
    expect(runs).toBe(2);
  });
});
