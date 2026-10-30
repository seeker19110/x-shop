// @vitest-environment node
import { resetEnvCacheForTests } from "../env";
import { getProvinces, getWards } from "./address";

const saved = { ...process.env };
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  process.env.XS_DATA_SOURCE = "backend";
  process.env.MEDUSA_BACKEND_URL = "http://backend.test:9000";
  resetEnvCacheForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...saved };
  resetEnvCacheForTests();
});

function hangingFetch() {
  return vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  );
}

describe("address (danh mục): timeout và retry GET (FE-STATE-005, XC-PERF-006)", () => {
  it("backend treo: hết hạn 5 s: tỉnh/thành 2 lần gọi, phường/xã 1 lần, rồi trả rỗng/unavailable (không treo render)", async () => {
    const f = hangingFetch();
    vi.stubGlobal("fetch", f);
    const p = getProvinces();
    await vi.advanceTimersByTimeAsync(5000 + 500 + 5000);
    expect(await p).toEqual([]);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);

    const g = hangingFetch();
    vi.stubGlobal("fetch", g);
    const w = getWards("01");
    await vi.advanceTimersByTimeAsync(5000);
    expect(await w).toEqual({ status: "unavailable" });
    expect(g).toHaveBeenCalledTimes(1); // client đã retry qua route → server không nhân thêm
  });

  it("503 tạm thời rồi 200: retry một lần ra dữ liệu; 404 không retry", async () => {
    const f = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ provinces: [{ code: "01", name: "Hà Nội" }] })));
    vi.stubGlobal("fetch", f);
    const p = getProvinces();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toEqual([{ code: "01", name: "Hà Nội" }]);
    expect(f).toHaveBeenCalledTimes(2);

    const nf = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", nf);
    expect(await getWards("99")).toEqual({ status: "not_found" });
    expect(nf).toHaveBeenCalledTimes(1);
  });
});
