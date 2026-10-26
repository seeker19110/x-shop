import assert from "node:assert/strict";
import { test } from "node:test";
import { collectUsage, evaluate, matchCycle } from "./eol-check.mjs";

const NOW = new Date("2026-10-26T00:00:00Z");

test("collectUsage: đọc node từ .nvmrc, postgres/redis từ image (kể cả có digest); rỗng/null → []", () => {
  const ci = "image: postgres:16-alpine@sha256:abc\n image: redis:7-alpine";
  assert.deepEqual(
    collectUsage({ nvmrc: "22.22.0\n", ciYml: ci }).map((u) => `${u.product}=${u.version}`),
    ["nodejs=22.22.0", "postgresql=16", "redis=7"],
  );
  assert.deepEqual(
    collectUsage({ nvmrc: "v20\n", ciYml: "" }).map((u) => u.version),
    ["20"],
  );
  assert.deepEqual(collectUsage({ nvmrc: null, ciYml: null }), []);
});

test("matchCycle: khớp chính xác, tiền tố, thu hẹp dần; không có → null", () => {
  const cs = [{ cycle: "7.4" }, { cycle: "7.2" }, { cycle: "22" }];
  assert.equal(matchCycle(cs, "7").cycle, "7.4");
  assert.equal(matchCycle(cs, "7.2.1").cycle, "7.2");
  assert.equal(matchCycle(cs, "22.22.0").cycle, "22");
  assert.equal(matchCycle(cs, "9"), null);
  assert.equal(matchCycle(null, "7"), null);
});

test("evaluate: ok / warn (<183 ngày) / eol (quá hạn, hôm qua, true) / unknown", () => {
  assert.equal(evaluate({ eol: false }, NOW).level, "ok");
  assert.equal(evaluate({ eol: "2027-03-01" }, NOW).level, "warn");
  assert.equal(evaluate({ eol: "2028-01-01" }, NOW).level, "ok");
  assert.equal(evaluate({ eol: "2026-10-25" }, NOW).level, "eol");
  assert.equal(evaluate({ eol: "2026-10-26" }, NOW).level, "warn");
  assert.equal(evaluate({ eol: true }, NOW).level, "eol");
  assert.equal(evaluate({ eol: "không-phải-ngày" }, NOW).level, "unknown");
  assert.equal(evaluate(null, NOW).level, "unknown");
});
