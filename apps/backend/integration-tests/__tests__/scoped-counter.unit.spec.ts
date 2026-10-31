import { runWithLogContext } from "../../src/lib/log/logger";
import { createCountScope } from "../helpers/scoped-counter";

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("createCountScope (T-229)", () => {
  afterEach(() => jest.restoreAllMocks());

  const host = () => ({
    base: 10,
    add(n: number) {
      return this.base + n;
    },
    async later(n: number) {
      await tick();
      return n * 2;
    },
  });

  it("gọi vẫn chạy hàm gốc, giữ this/tham số/giá trị trả về", async () => {
    const h = host();
    const scope = createCountScope();
    scope.counter(h, "add");
    const id = scope.nextTraceId();
    const out = await scope.measure(id, async () => runWithLogContext({ trace_id: id }, () => h.add(5)));
    expect(out).toBe(15);
  });

  it("chỉ đếm lời gọi mang đúng trace_id; job nền/ngoài ngữ cảnh vào outside", async () => {
    const h = host();
    const scope = createCountScope("t");
    const { counter } = scope.counter(h, "add");
    const id = scope.nextTraceId();
    await scope.measure(id, async () => {
      h.add(1); // ngoài ngữ cảnh (job nền chạy chồng)
      runWithLogContext({ trace_id: "khac" }, () => h.add(1)); // request khác
      await runWithLogContext({ trace_id: id }, async () => {
        h.add(1);
        await tick();
        h.add(1); // ngữ cảnh sống qua await
      });
    });
    expect(counter).toEqual({ inRequest: 2, outside: 2 });
  });

  it("không đo (measuring = null) → mọi lời gọi là outside, kể cả khi có trace_id", () => {
    const h = host();
    const scope = createCountScope();
    const { counter } = scope.counter(h, "add");
    runWithLogContext({ trace_id: "x" }, () => h.add(1));
    expect(counter).toEqual({ inRequest: 0, outside: 1 });
  });

  it("measure đặt lại bộ đếm mỗi lần đo và tắt đo kể cả khi fn ném lỗi", async () => {
    const h = host();
    const scope = createCountScope();
    const { counter } = scope.counter(h, "add");
    await scope.measureInProcess(async () => h.add(1));
    expect(counter.inRequest).toBe(1);
    await expect(
      scope.measure("id", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(counter).toEqual({ inRequest: 0, outside: 0 });
    runWithLogContext({ trace_id: "id" }, () => h.add(1));
    expect(counter).toEqual({ inRequest: 0, outside: 1 });
  });

  it("measureInProcess: hàm bất đồng bộ, đếm 0 khi không có lời gọi, ngoài đo vào outside", async () => {
    const h = host();
    const scope = createCountScope();
    const a = scope.counter(h, "add");
    const l = scope.counter(h, "later");
    await scope.measureInProcess(async () => {
      h.add(1);
      return h.later(2);
    });
    expect(a.counter.inRequest).toBe(1);
    expect(l.counter.inRequest).toBe(1);
    await scope.measureInProcess(async () => undefined);
    expect(a.counter).toEqual({ inRequest: 0, outside: 0 });
    h.add(1);
    expect(scope.outsideCalls()).toBe(1);
  });

  it("nextTraceId duy nhất; restoreAllMocks trả hàm gốc", () => {
    const h = host();
    const orig = h.add;
    const scope = createCountScope("p");
    expect(scope.nextTraceId()).not.toBe(scope.nextTraceId());
    scope.counter(h, "add");
    expect(h.add).not.toBe(orig);
    jest.restoreAllMocks();
    expect(h.add).toBe(orig);
  });

  it("hàm đã bị spy (giả lỗi) → xếp lớp đếm lên trên, không đệ quy; restore trả hàm thật", async () => {
    const h = host();
    const orig = h.add;
    const fault = jest.spyOn(h, "add").mockImplementation(function (this: typeof h, n: number) {
      return this.base * 100 + n;
    });
    const scope = createCountScope();
    const { counter } = scope.counter(h, "add");
    const out = await scope.measureInProcess(async () => h.add(1));
    expect(out).toBe(1001);
    expect(counter.inRequest).toBe(1);
    fault.mockRestore();
    expect(h.add).toBe(orig);
  });
});
