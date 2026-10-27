import { SETTLEMENT_CONFIG } from "../../modules/settlement/constants";
import { MAX_IMPORT_BYTES } from "../catalog/import";
import { UPLOAD_LIMITS } from "../security/upload";
import { MAX_CATALOG_CSV_BYTES, MAX_SETTLEMENT_CSV_BYTES } from "../../admin/lib/csv-file";
import { msToSecondsCeil } from "@x-shop/domain";
import { sessionAnchorMs, evaluateSession } from "../admin-security/session";

// T-120 (XC-UNITS-009): thay `* 1000`/`* 1024` bằng hằng/hàm đơn vị KHÔNG được đổi giá trị cấu hình.
describe("giá trị cấu hình sau khi thay số ma thuật bằng hằng đơn vị", () => {
  it("giới hạn dung lượng (byte) bằng đúng số cũ", () => {
    expect(UPLOAD_LIMITS.maxFileBytes).toBe(5 * 1024 * 1024);
    expect(UPLOAD_LIMITS.maxRequestBytes).toBe(20 * 1024 * 1024);
    expect(MAX_IMPORT_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_CATALOG_CSV_BYTES).toBe(MAX_IMPORT_BYTES);
    expect(MAX_SETTLEMENT_CSV_BYTES).toBe(1024 * 1024);
    expect(SETTLEMENT_CONFIG.maxFileBytes).toBe(1024 * 1024);
  });

  it("Retry-After làm tròn LÊN theo giây như Math.ceil(ms / 1000) cũ", () => {
    for (const ms of [0, 1, 999, 1000, 1001, 59_999, 60_000, 119_999]) {
      expect(msToSecondsCeil(ms)).toBe(Math.ceil(ms / 1000));
    }
  });

  it("phiên admin: mốc iat (giây) → ms và ngưỡng hết hạn/nhàn rỗi giữ nguyên", () => {
    expect(sessionAnchorMs({ iat: 1_700_000_000 })).toBe(1_700_000_000_000);
    expect(sessionAnchorMs({ iat: 0 })).toBe(0);
    const policy = { maxAgeSeconds: 600, idleSeconds: 60 };
    const anchorMs = 1_000_000;
    const at = (d: number) => ({ anchorMs, lastSeenMs: null, nowMs: anchorMs + d, policy });
    expect(evaluateSession(at(60_000))).toEqual({ ok: true }); // đúng ngưỡng nhàn rỗi 60 s: còn hợp lệ
    expect(evaluateSession(at(60_001))).toEqual({ ok: false, code: "SESSION_IDLE" });
    expect(evaluateSession({ ...at(600_001), lastSeenMs: anchorMs + 600_000 })).toEqual({
      ok: false,
      code: "SESSION_EXPIRED",
    });
  });
});
