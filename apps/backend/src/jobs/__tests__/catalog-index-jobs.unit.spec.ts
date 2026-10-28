import type { MedusaContainer } from "@medusajs/framework/types";
import { resetShutdownStateForTest, shutdownState } from "../../lib/lifecycle/shutdown";
import catalogIndexDrainJob from "../catalog-index-drain";
import catalogIndexRebuildJob from "../catalog-index-rebuild";

/**
 * T-094/D-081: job catalog không bắt đầu việc gì khi tiến trình đang tắt. Job worker vẫn nhận tick trong lúc readiness
 * 503 và Medusa chờ job đang chạy xong trước khi đóng pool — một câu đọc read model bị chặn (khoá bảng/DB chậm) hoặc
 * rebuild ~50 s là đủ vượt trần tắt êm → thoát mã 1 (shutdown.spec "SIGTERM khi lượt xả catalog đang chờ khoá" đỏ khi
 * tick phút rơi vào lúc tắt).
 */

const mockMarkExpired = jest.fn(async () => 0);
const mockDrainForJob = jest.fn(async () => 0);
const mockRebuild = jest.fn(async () => ({}));

jest.mock("../../lib/catalog/indexer", () => ({
  markExpiredPrices: (...a: unknown[]) => mockMarkExpired(...(a as [])),
  drainCatalogIndexForJob: (...a: unknown[]) => mockDrainForJob(...(a as [])),
  rebuildCatalogIndex: (...a: unknown[]) => mockRebuild(...(a as [])),
}));

const container = {} as MedusaContainer;

beforeEach(() => {
  resetShutdownStateForTest();
  jest.clearAllMocks();
});
afterAll(() => resetShutdownStateForTest());

describe("job catalog khi đang tắt", () => {
  it("bình thường: job xả đánh dấu giá hết hạn rồi xả; job rebuild chạy rebuild", async () => {
    await catalogIndexDrainJob(container);
    await catalogIndexRebuildJob(container);
    expect(mockMarkExpired).toHaveBeenCalledTimes(1);
    expect(mockDrainForJob).toHaveBeenCalledTimes(1);
    expect(mockRebuild).toHaveBeenCalledTimes(1);
  });

  it("đang tắt: không đọc/ghi gì (không markExpiredPrices, không xả, không rebuild)", async () => {
    shutdownState().draining = true;
    await catalogIndexDrainJob(container);
    await catalogIndexRebuildJob(container);
    expect(mockMarkExpired).not.toHaveBeenCalled();
    expect(mockDrainForJob).not.toHaveBeenCalled();
    expect(mockRebuild).not.toHaveBeenCalled();
  });
});
