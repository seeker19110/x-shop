import { z } from "zod";
import {
  IdParams,
  pathId,
  readParams,
  readQuery,
  readQueryBag,
  sendInvalidInput,
  sendParamNotFound,
} from "../request-input";

describe("request-input (BASE-SEC-001: params/query qua schema)", () => {
  describe("readParams + IdParams", () => {
    it("id hợp lệ → data", () => {
      expect(readParams({ params: { id: "ord_01" } }, IdParams)).toEqual({
        ok: true,
        data: { id: "ord_01" },
      });
    });

    it.each([
      ["thiếu", {}],
      ["params undefined", undefined],
      ["rỗng", { id: "" }],
      ["mảng", { id: ["a", "b"] }],
      ["object", { id: { $ne: 1 } }],
      ["số", { id: 5 }],
      ["null", { id: null }],
      ["quá dài (129)", { id: "x".repeat(129) }],
    ])("id %s → lỗi theo trường", (_name, params) => {
      const r = readParams({ params }, IdParams);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]?.param).toBe("id");
    });

    it("đúng 128 ký tự và Unicode vẫn hợp lệ", () => {
      expect(readParams({ params: { id: "x".repeat(128) } }, IdParams).ok).toBe(true);
      expect(readParams({ params: { id: "đơn-hàng-😀" } }, IdParams).ok).toBe(true);
    });
  });

  describe("readQuery", () => {
    const Q = z.object({ cart_id: z.string().min(1).max(10).optional() });

    it("thiếu / rỗng object → ok với trường vắng", () => {
      expect(readQuery({ query: {} }, Q)).toEqual({ ok: true, data: {} });
      expect(readQuery({ query: undefined }, Q)).toEqual({ ok: true, data: {} });
    });

    it("?a=1&a=2 (mảng) và ?a[b]=1 (object) bị từ chối thay vì ép chuỗi", () => {
      expect(readQuery({ query: { cart_id: ["1", "2"] } }, Q).ok).toBe(false);
      expect(readQuery({ query: { cart_id: { b: "1" } } }, Q).ok).toBe(false);
    });

    it("rỗng, sai kiểu, quá dài → lỗi tại đúng trường", () => {
      for (const v of ["", 3, null, "x".repeat(11)]) {
        const r = readQuery({ query: { cart_id: v } }, Q);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.map((e) => e.param)).toEqual(["cart_id"]);
      }
    });

    it("khoá lạ bị bỏ (object) hoặc bị từ chối (strictObject)", () => {
      expect(readQuery({ query: { x: "1" } }, Q)).toEqual({ ok: true, data: {} });
      expect(readQuery({ query: { x: "1" } }, z.strictObject({})).ok).toBe(false);
    });
  });

  describe("readQueryBag", () => {
    it("object → giữ nguyên giá trị (bộ đọc có allowlist riêng kiểm tiếp)", () => {
      const q = { a: ["1", "2"], b: "x", c: { d: 1 } };
      expect(readQueryBag({ query: q })).toEqual({ ok: true, data: q });
    });
    it("không phải object → lỗi", () => {
      expect(readQueryBag({ query: "a=1" }).ok).toBe(false);
      expect(readQueryBag({ query: [] }).ok).toBe(false);
    });
    it("thiếu query → bag rỗng", () => {
      expect(readQueryBag({})).toEqual({ ok: true, data: {} });
    });
  });

  it("pathId: tham số max tuỳ biến", () => {
    expect(pathId(3).safeParse("abcd").success).toBe(false);
    expect(pathId(3).safeParse("abc").success).toBe(true);
  });

  it("sendInvalidInput → 422 VALIDATION problem+json kèm lỗi theo trường", () => {
    const headers: Record<string, string> = {};
    let status = 0;
    let body = "";
    const res = {
      req: {},
      status(s: number) {
        status = s;
        return res;
      },
      setHeader(k: string, v: string) {
        headers[k] = v;
        return res;
      },
      send(b: string) {
        body = b;
      },
    };
    sendInvalidInput(res as never, [{ param: "id", reason: "x" }]);
    expect(status).toBe(422);
    expect(headers["Content-Type"]).toContain("application/problem+json");
    const parsed = JSON.parse(body) as { code: string; errors: unknown[]; status: number };
    expect(parsed).toMatchObject({ code: "VALIDATION", status: 422, errors: [{ param: "id", reason: "x" }] });
  });

  it("sendParamNotFound → 404 NOT_FOUND problem+json (không phân biệt sai dạng với không có)", () => {
    let status = 0;
    let body = "";
    const res = {
      req: {},
      status(s: number) {
        status = s;
        return res;
      },
      setHeader() {
        return res;
      },
      send(b: string) {
        body = b;
      },
    };
    sendParamNotFound(res as never);
    expect(status).toBe(404);
    expect(JSON.parse(body)).toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});
