import assert from "node:assert/strict";
import { test } from "node:test";
import { BUDGET, KiB, kind, median, overBudget, percentile, summarizeLab } from "./lib.mjs";

const zero = { js: 0, css: 0, font: 0, image: 0, rsc: 0, html: 0, other: 0 };

test("median/percentile: rỗng → null, một mẫu, chẵn, NaN bị bỏ", () => {
  assert.equal(median([]), null);
  assert.equal(percentile([], 75), null);
  assert.equal(median([7]), 7);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([3, 1, 2, Number.NaN]), 2);
  assert.equal(percentile([1, 2, 3, 4, 5], 75), 4);
  assert.equal(median([0, 0, 0]), 0);
});

test("overBudget: đúng bằng ngân sách là đạt, hơn 1 byte là vượt", () => {
  assert.deepEqual(overBudget({ ...zero, js: BUDGET.js }), []);
  assert.deepEqual(overBudget({ ...zero, js: BUDGET.js + 1 }), ["js"]);
  assert.deepEqual(overBudget({ ...zero, css: 50 * KiB + 1, font: 100 * KiB + 1 }), ["css", "font"]);
  assert.deepEqual(overBudget({ ...zero, image: 900 * KiB + 1 }), ["total"]);
  assert.deepEqual(overBudget(zero), []);
});

test("kind: phân loại theo content-type và đuôi URL", () => {
  assert.equal(kind("text/javascript; charset=UTF-8", "http://x/a"), "js");
  assert.equal(kind("", "http://x/a.woff2?v=1"), "font");
  assert.equal(kind("text/x-component", "http://x/?_rsc=1"), "rsc");
  assert.equal(kind(undefined, "http://x/a.bin"), "other");
  assert.equal(kind("image/avif", "http://x/a"), "image");
});

test("summarizeLab: theo median; thiếu mẫu không được coi là đạt", () => {
  const ok = summarizeLab([
    { lcpMs: 2000, cls: 0, tbtMs: 10 },
    { lcpMs: 2600, cls: 0.05, tbtMs: 20 },
    { lcpMs: 2400, cls: 0.01, tbtMs: 30 },
  ]);
  assert.equal(ok.lcpMedianMs, 2400);
  assert.deepEqual(ok.over, []);
  const bad = summarizeLab([
    { lcpMs: 3000, cls: 0.2, tbtMs: 0 },
    { lcpMs: 2600, cls: 0.2, tbtMs: 0 },
    { lcpMs: 1000, cls: 0, tbtMs: 0 },
  ]);
  assert.deepEqual(bad.over, ["lcp", "cls"]);
  assert.deepEqual(summarizeLab([]).over, ["thiếu mẫu"]);
  assert.deepEqual(summarizeLab([{ lcpMs: Number.NaN, cls: 0, tbtMs: 0 }]).over, ["thiếu mẫu"]);
});
