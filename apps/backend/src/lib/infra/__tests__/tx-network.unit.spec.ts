import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createBackendProgram, findTxNetworkCalls } from "./tx-network-check";

/**
 * DB-TX-003 (T-092): không gọi mạng bên trong transaction CSDL. Bộ kiểm tĩnh dùng type checker (tx-network-check.ts);
 * ca 1 chứng minh nó bắt được vi phạm (fixture), ca 2 chạy trên toàn bộ mã backend.
 */

const BACKEND = path.resolve(__dirname, "../../../..");
const SRC = path.join(BACKEND, "src");
const FIXTURE = path.join(__dirname, "fixtures", "tx-network-violation.ts");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "admin" || name === "node_modules") continue;
      out.push(...sourceFiles(p));
    } else if (/\.ts$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

jest.setTimeout(120_000);

describe("không gọi mạng trong transaction CSDL (DB-TX-003)", () => {
  it("bộ kiểm bắt được: fetch trực tiếp, gateway VNPAY, gọi gián tiếp qua hàm trong repo; không báo mạng ngoài transaction", () => {
    const program = createBackendProgram(BACKEND, [FIXTURE]);
    const v = findTxNetworkCalls(program, BACKEND, [FIXTURE]);
    const lines = (fn: string) => v.filter((x) => x.via.join(">").includes(fn) || x.via.includes(fn));
    expect(v.map((x) => x.network).sort()).toEqual(["VNPAY gateway", "fetch (HTTP)", "fetch (HTTP)"].sort());
    expect(lines("pingVendor")).toHaveLength(1);
    expect(lines("pingVendor")[0]!.via).toEqual(["pingVendor", "fetch"]);
    expect(lines("queryStatus")).toHaveLength(1);
    // okNetworkOutsideTx (cuối file) không có vi phạm nào.
    const okLine =
      readFileSync(FIXTURE, "utf8")
        .split("\n")
        .findIndex((l) => l.includes("function okNetworkOutsideTx")) + 1;
    expect(okLine).toBeGreaterThan(0);
    expect(v.every((x) => Number(x.transaction.split(":").pop()) < okLine)).toBe(true);
  });

  it("toàn bộ backend (src/, trừ admin và test): 0 lời gọi mạng trong callback transaction", () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(50);
    const program = createBackendProgram(BACKEND, files);
    const violations = findTxNetworkCalls(program, BACKEND, files);
    expect(violations).toEqual([]);
  });
});
