// @vitest-environment node
import { resetEnvCacheForTests } from "../env";
import { getProvinces, getWards } from "./address";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  resetEnvCacheForTests();
  vi.unstubAllGlobals();
});

function backend() {
  process.env.XS_DATA_SOURCE = "backend";
  process.env.MEDUSA_BACKEND_URL = "http://backend.test:9000";
  resetEnvCacheForTests();
}

describe("lib/checkout/address (danh mục 2 cấp từ backend)", () => {
  it("tỉnh/thành và phường/xã gọi đúng endpoint, chỉ giữ code+name", async () => {
    backend();
    const f = vi.fn(async (url: string) =>
      String(url).endsWith("/provinces")
        ? new Response(JSON.stringify({ provinces: [{ code: "01", name: "Hà Nội", extra: 1 }] }))
        : new Response(JSON.stringify({ wards: [{ code: "00004", name: "Ba Đình" }] })),
    );
    vi.stubGlobal("fetch", f);
    expect(await getProvinces()).toEqual([{ code: "01", name: "Hà Nội" }]);
    expect(await getWards("01")).toEqual([{ code: "00004", name: "Ba Đình" }]);
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      "http://backend.test:9000/store/x/addresses/provinces",
      "http://backend.test:9000/store/x/addresses/provinces/01/wards",
    ]);
  });

  it("mã tỉnh sai định dạng → null, không gọi mạng; backend 404/lỗi → null/rỗng; fixtures → rỗng", async () => {
    backend();
    const f = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", f);
    expect(await getWards("../x")).toBeNull();
    expect(await getWards("")).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(await getWards("99")).toBeNull();
    expect(await getProvinces()).toEqual([]);
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("down");
    });
    expect(await getProvinces()).toEqual([]);
    process.env.XS_DATA_SOURCE = "fixtures";
    resetEnvCacheForTests();
    expect(await getProvinces()).toEqual([]);
    expect(await getWards("01")).toBeNull();
  });
});
