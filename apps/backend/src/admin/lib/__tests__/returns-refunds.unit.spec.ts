import * as domain from "@x-shop/domain";
import {
  REFUND_STATES,
  RETURN_REASONS,
  RETURN_STATES,
  RETURNS_CONFIG,
} from "../../../modules/returns/constants";
import {
  REFUND_STATE_LABELS,
  RETURN_REASON_LABELS,
  RETURN_SOURCE_LABELS,
  RETURN_STATE_LABELS,
  refundStateLabel,
} from "../labels";
import { PAGE_SIZE, pageInfo } from "../pagination";
import { AdminApiError, describeProblem, toApiError } from "../problem";
import { checkReceive, initialReceiveDrafts } from "../receive";
import {
  isRetryExhausted,
  isReturnRefund,
  recreateRefundBody,
  REFUND_MAX_ATTEMPTS,
  refundActions,
  returnRefundNextSteps,
  type RefundLike,
} from "../refund-actions";

describe("nhãn khớp giá trị server (không sót trạng thái — T-049)", () => {
  it("mọi trạng thái hoàn tiền (kể cả cancelled), trạng thái/lý do đổi trả, nguồn yêu cầu đều có nhãn", () => {
    for (const s of REFUND_STATES)
      expect({ s, label: REFUND_STATE_LABELS[s] }).toEqual({ s, label: expect.any(String) });
    for (const s of RETURN_STATES)
      expect({ s, label: RETURN_STATE_LABELS[s] }).toEqual({ s, label: expect.any(String) });
    for (const s of RETURN_REASONS) expect(RETURN_REASON_LABELS[s]).toEqual(expect.any(String));
    expect(Object.keys(RETURN_SOURCE_LABELS).sort()).toEqual(["carrier", "request"]);
    expect(refundStateLabel("cancelled")).toBe("Đã hủy");
    expect(refundStateLabel("lạ")).toBe("lạ");
  });
});

describe("pageInfo", () => {
  it("trang đầu/giữa/cuối, ca rỗng, offset vượt tổng", () => {
    expect(pageInfo(0, 20, 0)).toEqual({ from: 0, to: 0, count: 0, prevOffset: null, nextOffset: null });
    expect(pageInfo(45, 20, 0)).toEqual({ from: 1, to: 20, count: 45, prevOffset: null, nextOffset: 20 });
    expect(pageInfo(45, 20, 20)).toEqual({ from: 21, to: 40, count: 45, prevOffset: 0, nextOffset: 40 });
    expect(pageInfo(45, 20, 40)).toEqual({ from: 41, to: 45, count: 45, prevOffset: 20, nextOffset: null });
    expect(pageInfo(40, 20, 20)).toEqual({ from: 21, to: 40, count: 40, prevOffset: 0, nextOffset: null });
    // offset lệch (vd. bản ghi vừa biến mất) → trang rỗng nhưng vẫn lùi được.
    expect(pageInfo(5, 20, 20)).toEqual({ from: 0, to: 0, count: 5, prevOffset: 0, nextOffset: null });
    expect(pageInfo(45, 20, 10).prevOffset).toBe(0);
  });
  it("đầu vào hỏng: âm/NaN/không nguyên → 0; limit hỏng → PAGE_SIZE", () => {
    expect(pageInfo(-3, 20, 0)).toEqual({ from: 0, to: 0, count: 0, prevOffset: null, nextOffset: null });
    expect(pageInfo(Number.NaN, 20, -5).count).toBe(0);
    expect(pageInfo(100, 0, 0).to).toBe(PAGE_SIZE);
    expect(pageInfo(100, Number.NaN, 1.5)).toMatchObject({ from: 1, prevOffset: null });
  });
});

describe("checkReceive — nhận hàng từng phần", () => {
  const lines = [
    { line_id: "a", quantity: 2 },
    { line_id: "b", quantity: 1 },
  ];
  it("bản nháp ban đầu = nhận đủ; gửi nguyên → full", () => {
    const drafts = initialReceiveDrafts(lines);
    expect(drafts).toEqual({ a: "2", b: "1" });
    expect(checkReceive(lines, drafts)).toEqual({
      ok: true,
      lines: [
        { line_id: "a", quantity: 2 },
        { line_id: "b", quantity: 1 },
      ],
      total: 3,
      full: true,
    });
  });
  it("nhận thiếu một phần, có dòng 0 → hợp lệ, full=false", () => {
    expect(checkReceive(lines, { a: " 1 ", b: "0" })).toEqual({
      ok: true,
      lines: [
        { line_id: "a", quantity: 1 },
        { line_id: "b", quantity: 0 },
      ],
      total: 1,
      full: false,
    });
  });
  it("vượt số yêu cầu, rỗng, âm, thập phân, chữ → lỗi theo dòng; tổng 0 → lỗi chung", () => {
    const r = checkReceive(lines, { a: "3", b: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.a).toContain("vượt");
      expect(r.errors.b).toContain("Nhập số lượng");
    }
    for (const bad of ["-1", "1.5", "abc", "100"]) {
      const x = checkReceive(lines, { a: bad, b: "1" });
      expect({ bad, ok: x.ok }).toEqual({ bad, ok: false });
    }
    expect(checkReceive(lines, { a: "0", b: "0" })).toEqual({
      ok: false,
      errors: { "*": "Chưa nhận sản phẩm nào." },
    });
    expect(checkReceive([], {})).toEqual({ ok: false, errors: { "*": "Chưa nhận sản phẩm nào." } });
  });
});

describe("refundActions", () => {
  const base: RefundLike = {
    id: "r1",
    state: "requested",
    attempts: 0,
    reason: "other",
    return_id: null,
    requested_by: "u1",
  };
  const at = (patch: Partial<RefundLike>) => ({ ...base, ...patch });

  it("số lượt tối đa khớp cấu hình server", () => {
    expect(REFUND_MAX_ATTEMPTS).toBe(RETURNS_CONFIG.refundMaxAttempts);
  });

  it("requested: duyệt/từ chối; người tạo không tự duyệt; không thực hiện/hủy", () => {
    expect(refundActions(base, { myId: "u2" })).toMatchObject({
      approve: true,
      reject: true,
      selfCreated: false,
      execute: false,
      cancel: false,
      recreate: false,
    });
    expect(refundActions(base, { myId: "u1" }).selfCreated).toBe(true);
    expect(refundActions(base, { myId: null }).selfCreated).toBe(false);
  });

  it("requested theo trả hàng (reason=return hoặc có return_id): không nút từ chối, thay bằng hướng dẫn theo cách hoàn; vẫn duyệt được (T-173)", () => {
    for (const patch of [
      { reason: "return", return_id: "xret_1", method: "provider" },
      { reason: "return", return_id: null, method: "provider" },
      { reason: "other", return_id: "xret_1", method: "provider" },
    ]) {
      const a = refundActions(at(patch), { myId: "u2" });
      expect({ patch, approve: a.approve, reject: a.reject }).toEqual({
        patch,
        approve: true,
        reject: false,
      });
      expect(a.rejectHint).toContain("tạo lại theo trả hàng");
    }
    // Hoàn tay (COD, cổng tắt) không tự vào failed → hướng dẫn KHÔNG nói hủy/tạo lại, mà nói kèm mã chứng từ.
    const manual = refundActions(at({ reason: "return", return_id: "xret_1", method: "manual" }));
    expect(manual).toMatchObject({ approve: true, reject: false });
    expect(manual.rejectHint).toContain("thực hiện kèm mã chứng từ");
    expect(manual.rejectHint).not.toContain("tạo lại");
    // Hoàn hủy đơn / lý do khác vẫn từ chối được; trạng thái khác requested: không nút, không hướng dẫn.
    for (const reason of ["cancellation", "other"]) {
      expect(refundActions(at({ reason }))).toMatchObject({ reject: true, rejectHint: null });
    }
    expect(refundActions(at({ state: "failed", reason: "return", return_id: "xret_1" }))).toMatchObject({
      reject: false,
      rejectHint: null,
      cancel: true,
    });
  });

  it("thông điệp 409 RETURN_REFUND_NOT_REJECTABLE theo next_steps của server; thân thiếu/hỏng → bảo tải lại", () => {
    const msg = (body: object) =>
      describeProblem(toApiError(409, { code: "RETURN_REFUND_NOT_REJECTABLE", title: "x", ...body })).message;
    const provider = msg({
      next_steps: ["approve", "execute", "cancel", "recreate"],
      evidence_required: false,
    });
    expect(provider).toContain("Duyệt rồi thực hiện;");
    expect(provider).toContain("hủy (ghi lý do) rồi tạo lại theo trả hàng");
    const manual = msg({ next_steps: ["approve", "execute"], evidence_required: true });
    expect(manual).toContain("Duyệt rồi thực hiện kèm mã chứng từ.");
    expect(manual).not.toContain("tạo lại");
    expect(msg({ next_steps: ["cancel", "recreate"] })).toContain(
      "Hủy (ghi lý do) rồi tạo lại theo trả hàng.",
    );
    expect(msg({ next_steps: ["execute"] })).toMatch(/Thực hiện\.$/);
    for (const body of [{ next_steps: [] }, {}, { next_steps: "approve" }, { next_steps: ["xoá"] }]) {
      const m = msg(body);
      expect(m).toContain("đã kết thúc");
      expect(m).not.toContain("Duyệt");
    }
  });

  it("isReturnRefund / returnRefundNextSteps của Admin là bản sao đúng của domain (khoá mọi trạng thái × cách hoàn × lượt)", () => {
    for (const reason of ["return", "cancellation", "other", ""]) {
      for (const return_id of ["xret_1", "", null, undefined]) {
        expect({ reason, return_id, v: isReturnRefund({ reason, return_id }) }).toEqual({
          reason,
          return_id,
          v: domain.isReturnRefund({ reason, return_id }),
        });
      }
    }
    for (const state of [...REFUND_STATES, "", "lạ"]) {
      for (const method of ["provider", "manual", ""]) {
        for (const attempts of [0, 1, 2, 3, 4, Number.NaN]) {
          for (const max of [1, 3]) {
            const r = { method, state, attempts };
            expect({ r, max, s: returnRefundNextSteps(r, max) }).toEqual({
              r,
              max,
              s: domain.returnRefundNextSteps(r, max),
            });
          }
        }
      }
    }
  });

  it("approved/unknown: thực hiện; failed còn lượt: thử lại + hủy", () => {
    expect(refundActions(at({ state: "approved" }))).toMatchObject({
      execute: true,
      executeLabel: "Thực hiện",
    });
    expect(refundActions(at({ state: "unknown", attempts: 3 }))).toMatchObject({
      execute: true,
      exhausted: false,
      cancel: false,
    });
    expect(refundActions(at({ state: "failed", attempts: 2 }))).toMatchObject({
      execute: true,
      executeLabel: "Thử lại / hỏi lại cổng",
      exhausted: false,
      cancel: true,
    });
  });

  it("failed hết lượt (attempts ≥ 3, attempts hỏng, hoặc server vừa báo REFUND_RETRY_EXHAUSTED) → ẩn thực hiện, còn hủy", () => {
    for (const attempts of [3, 4, Number.NaN]) {
      expect(refundActions(at({ state: "failed", attempts }))).toMatchObject({
        execute: false,
        executeLabel: null,
        exhausted: true,
        cancel: true,
      });
    }
    expect(
      refundActions(at({ state: "failed", attempts: 1 }), { exhaustedIds: new Set(["r1"]) }),
    ).toMatchObject({ execute: false, exhausted: true });
    expect(isRetryExhausted({ state: "failed", attempts: 2 })).toBe(false);
    expect(isRetryExhausted({ state: "succeeded", attempts: 9 })).toBe(false);
    expect(isRetryExhausted({ state: "failed", attempts: 1 }, 1)).toBe(true);
  });

  it("cancelled: không thao tác; tạo lại chỉ khi reason=return có return_id và chưa có bản hiệu lực", () => {
    const cancelled = at({ state: "cancelled", reason: "return", return_id: "xret_1", attempts: 3 });
    expect(refundActions(cancelled)).toMatchObject({
      approve: false,
      execute: false,
      cancel: false,
      recreate: true,
    });
    expect(refundActions(at({ state: "cancelled", reason: "other" })).recreate).toBe(false);
    expect(refundActions(at({ state: "cancelled", reason: "return", return_id: null })).recreate).toBe(false);
    // Đã có bản mới còn hiệu lực cho cùng yêu cầu trả → không đề nghị tạo nữa; bản đã hủy khác không chặn.
    const live = at({ id: "r2", state: "requested", reason: "return", return_id: "xret_1" });
    const oldCancelled = at({ id: "r0", state: "cancelled", reason: "return", return_id: "xret_1" });
    expect(refundActions(cancelled, { siblings: [cancelled, live] }).recreate).toBe(false);
    expect(refundActions(cancelled, { siblings: [cancelled, oldCancelled] }).recreate).toBe(true);
    for (const s of ["succeeded", "rejected", "processing"]) {
      expect(refundActions(at({ state: s })).execute).toBe(false);
    }
  });

  it("thân tạo lại: reason=return + return_id, không gửi amount; ghi chú rỗng bị bỏ", () => {
    expect(recreateRefundBody({ order_id: "o1", return_id: "xret_1" }, "manual", "  ")).toEqual({
      order_id: "o1",
      reason: "return",
      return_id: "xret_1",
      method: "manual",
    });
    expect(recreateRefundBody({ order_id: "o1", return_id: "xret_1" }, "auto", " chuyển khoản ").note).toBe(
      "chuyển khoản",
    );
    expect(() => recreateRefundBody({ order_id: "o1", return_id: null }, "auto", "")).toThrow();
  });
});

describe("thông điệp lỗi hoàn tiền mới (T-044/T-049)", () => {
  it("hết lượt thử / cổng chưa xác nhận → hướng dẫn tiếng Việt, không phải title thô", () => {
    const exhausted = describeProblem(new AdminApiError(409, "REFUND_RETRY_EXHAUSTED", "raw"));
    expect(exhausted.message).toContain("hết lượt thử");
    const unconfirmed = describeProblem(new AdminApiError(409, "REFUND_PROVIDER_UNCONFIRMED", "raw"));
    expect(unconfirmed.message).toContain("Chưa xác nhận");
  });
});
