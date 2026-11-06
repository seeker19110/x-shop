import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * QA-E2E-001: ≥ 3 spec gắn tag Playwright thật `tag: "@smoke"` (không đếm chữ "@smoke" trong chú thích — grep của Gate
 * đếm cả chú thích nên không đủ làm bằng chứng).
 */
const dir = path.dirname(fileURLToPath(import.meta.url));

test('có ít nhất 3 file spec gắn tag: "@smoke" (cú pháp chi tiết test của Playwright)', () => {
  const tagged = readdirSync(dir)
    .filter((f) => f.endsWith(".spec.ts"))
    .filter((f) =>
      /\btag:\s*(?:"@smoke"|'@smoke'|\[[^\]]*["']@smoke["'][^\]]*\])/.test(
        readFileSync(path.join(dir, f), "utf8"),
      ),
    );
  assert.ok(tagged.length >= 3, `chỉ ${tagged.length} spec gắn @smoke: ${tagged.join(", ")}`);
});
