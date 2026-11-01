import { probeLogLines, probeProblemBody } from "../helpers/leak-probe";

const LEAK = /5432|6379|9431/;
// UUID v4 hợp lệ có chứa đúng các chuỗi bị dò (tái hiện hai lần đỏ giả).
const UUID_6379 = "0b8f1c2e-4d3a-4e5f-8a6b-6379ab058693";
const UUID_9431 = "0b8f1c2e-4d3a-4e5f-8a6b-9431ab058693";
const SPAN_5432 = "a5432b0c9d8e7f61";

describe("probeProblemBody", () => {
  it("UUID chứa 6379 → dò không khớp nhầm; ca đối chứng: dò thẳng thì khớp", () => {
    const body = { status: 503, code: "NOT_READY", trace_id: UUID_6379 };
    expect(JSON.stringify(body)).toMatch(LEAK);
    const p = probeProblemBody(body);
    expect(p.traceId).toBe(UUID_6379);
    expect(p.rest).not.toMatch(LEAK);
  });

  it("rò rỉ thật ở trường khác vẫn bị bắt", () => {
    const p = probeProblemBody({ trace_id: UUID_6379, detail: "connect 10.0.0.5:5432" });
    expect(p.rest).toMatch(LEAK);
  });

  it("trace_id chứa thông điệp lỗi (đột biến String(err)) → ném lỗi", () => {
    expect(() => probeProblemBody({ trace_id: "Error: connect ECONNREFUSED 10.0.0.5:5432" })).toThrow(
      /UUID v4/,
    );
  });

  it("trace_id thiếu / null / không phải chuỗi → ném lỗi khi bắt buộc", () => {
    expect(() => probeProblemBody({ status: 500 })).toThrow(/trace_id/);
    expect(() => probeProblemBody({ trace_id: null })).toThrow(/trace_id/);
    expect(() => probeProblemBody({ trace_id: 0 })).toThrow(/trace_id/);
    expect(() => probeProblemBody(undefined)).toThrow();
    expect(() => probeProblemBody("x")).toThrow();
  });

  it("requireTraceId=false: thân thành công không có trace_id; có thì vẫn kiểm", () => {
    expect(probeProblemBody({ status: "ok" }, { requireTraceId: false })).toEqual({
      traceId: undefined,
      rest: '{"status":"ok"}',
    });
    expect(probeProblemBody(undefined, { requireTraceId: false }).rest).toBe('""');
    expect(() => probeProblemBody({ trace_id: "bậy" }, { requireTraceId: false })).toThrow(/UUID v4/);
  });

  it("expectedTraceId: đúng giá trị đã gửi thì qua, khác thì đỏ (kể cả UUID hợp lệ)", () => {
    expect(probeProblemBody({ trace_id: "req-it-123" }, { expectedTraceId: "req-it-123" }).traceId).toBe(
      "req-it-123",
    );
    expect(() => probeProblemBody({ trace_id: UUID_6379 }, { expectedTraceId: "req-it-123" })).toThrow(
      /x-request-id/,
    );
  });

  it("UUID không phải v4 (version/variant sai) → đỏ", () => {
    expect(() => probeProblemBody({ trace_id: "0b8f1c2e-4d3a-1e5f-8a6b-6379ab058693" })).toThrow();
    expect(() => probeProblemBody({ trace_id: "0b8f1c2e-4d3a-4e5f-7a6b-6379ab058693" })).toThrow();
  });
});

describe("probeLogLines", () => {
  const rec = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;

  it("trace_id/span_id ngẫu nhiên chứa 9431/5432 → dò không khớp nhầm", () => {
    const logged =
      rec({ level: "error", msg: "boom trigger", trace_id: UUID_9431, span_id: SPAN_5432 }) +
      rec({ level: "error", msg: `[http] 500 trace_id=${UUID_9431}`, trace_id: UUID_9431 });
    expect(logged).toMatch(LEAK);
    const p = probeLogLines(logged, { expectedTraceId: UUID_9431 });
    expect(p.traceIds).toEqual([UUID_9431, UUID_9431]);
    expect(p.spanIds).toEqual([SPAN_5432]);
    expect(p.rest).toContain("boom trigger");
    expect(p.rest).not.toMatch(LEAK);
  });

  it("rò rỉ thật trong thông điệp vẫn bị bắt; dòng không phải JSON được giữ để dò", () => {
    const p = probeLogLines(rec({ msg: "value 9431", trace_id: UUID_6379 }) + "stdout lạ 5432\n");
    expect(p.rest).toMatch(/9431/);
    expect(p.rest).toMatch(/5432/);
  });

  it("span_id sai (không 16 hex / không phải chuỗi) → ném lỗi", () => {
    expect(() => probeLogLines(rec({ span_id: "xyz" }))).toThrow(/span_id/);
    expect(() => probeLogLines(rec({ span_id: "A5432B0C9D8E7F61" }))).toThrow(/span_id/);
    expect(() => probeLogLines(rec({ span_id: 1234567890123456 }))).toThrow(/span_id/);
    expect(() => probeLogLines(rec({ parent_span_id: "short" }))).toThrow(/parent_span_id/);
  });

  it("trace_id sai định dạng trong log → ném lỗi; khác expectedTraceId → ném lỗi", () => {
    expect(() => probeLogLines(rec({ trace_id: "Error: connect 5432" }))).toThrow(/UUID v4/);
    expect(() => probeLogLines(rec({ trace_id: UUID_6379 }), { expectedTraceId: "req-1" })).toThrow(
      /x-request-id/,
    );
  });

  it("span toàn số 0 và UUID chữ hoa bị từ chối (theo log-schema / randomUUID)", () => {
    expect(() => probeLogLines(rec({ span_id: "0000000000000000" }))).toThrow(/span_id/);
    expect(() => probeLogLines(rec({ trace_id: UUID_6379.toUpperCase() }))).toThrow(/UUID v4/);
  });

  it("expectedTraceId ngắn không bị cắt khỏi message (không che chuỗi cần dò)", () => {
    expect(probeLogLines('{"message":"a 9431"}', { expectedTraceId: "9431" }).rest).toContain("9431");
  });

  it("rỗng / không có ID → rest rỗng, không ném", () => {
    expect(probeLogLines("")).toEqual({ traceIds: [], spanIds: [], rest: "" });
    expect(probeLogLines([])).toEqual({ traceIds: [], spanIds: [], rest: "" });
    expect(probeLogLines([rec({ msg: "Nguyễn" })]).rest).toContain("Nguyễn");
  });
});
