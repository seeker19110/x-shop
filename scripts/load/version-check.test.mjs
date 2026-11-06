import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { parseExpectVersion, verifyVersion, versionUrl } from "./version-check.mjs";

const reply = (status, body) => async () => ({
  status,
  json: async () => {
    if (body === undefined) throw new Error("not json");
    return body;
  },
});
const base = { baseUrl: "https://api.shop.example.vn", token: "tok-secret", expected: "1.2.3" };

test("parseExpectVersion: hai dạng cờ, vắng cờ, thiếu giá trị", () => {
  assert.equal(parseExpectVersion([]), undefined);
  assert.equal(parseExpectVersion(["--expect-version", "1.2.3"]), "1.2.3");
  assert.equal(parseExpectVersion(["--expect-version=1.2.3"]), "1.2.3");
  assert.throws(() => parseExpectVersion(["--expect-version"]));
  assert.throws(() => parseExpectVersion(["--expect-version", "--x"]));
  assert.throws(() => parseExpectVersion(["--expect-version="]));
  assert.throws(() => parseExpectVersion(["--expect-version", ""]));
});

test("versionUrl: https hoặc http loopback; từ chối http ngoài, rác, bỏ đường dẫn thừa", () => {
  assert.equal(versionUrl("https://api.x.vn/some/path?q=1"), "https://api.x.vn/admin/x/version");
  assert.equal(versionUrl("http://localhost:9000"), "http://localhost:9000/admin/x/version");
  assert.equal(versionUrl("http://127.0.0.1:9000"), "http://127.0.0.1:9000/admin/x/version");
  assert.throws(() => versionUrl("http://api.x.vn"));
  assert.throws(() => versionUrl("không-phải-url"));
  assert.throws(() => versionUrl(""));
});

test("verifyVersion: khớp → ok, gửi Bearer, in commit/built_at nếu có", async () => {
  let seen;
  const r = await verifyVersion({
    ...base,
    fetchImpl: async (url, init) => {
      seen = { url, auth: init.headers.authorization };
      return reply(200, { version: "1.2.3", commit: "886beed", built_at: "2026-10-30T08:00:00Z" })();
    },
  });
  assert.equal(r.ok, true);
  assert.match(r.detail, /1\.2\.3.*886beed/);
  assert.deepEqual(seen, { url: "https://api.shop.example.vn/admin/x/version", auth: "Bearer tok-secret" });
});

test("verifyVersion: lệch phiên bản → không ok; không so khớp mờ (tiền tố, hoa/thường)", async () => {
  for (const v of ["1.2.4", "1.2.3-rc.1", "1.2", "V1.2.3", "1.2.3 "]) {
    const r = await verifyVersion({ ...base, fetchImpl: reply(200, { version: v }) });
    assert.equal(r.ok, false, v);
    assert.match(r.detail, /lệch/);
  }
});

test("verifyVersion: 401/403/500, thân không JSON, thiếu/ sai kiểu version, lỗi mạng → không ok, không lộ token", async () => {
  const cases = [
    reply(401, { code: "UNAUTHORIZED" }),
    reply(403, {}),
    reply(500, {}),
    reply(200, undefined),
    reply(200, {}),
    reply(200, { version: "" }),
    reply(200, { version: 123 }),
    reply(200, null),
    async () => {
      throw new Error("ECONNREFUSED");
    },
  ];
  for (const fetchImpl of cases) {
    const r = await verifyVersion({ ...base, fetchImpl });
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.detail, /tok-secret/);
  }
});

test("verifyVersion: cấu hình sai → ném (thiếu token, thiếu phiên bản, URL http ngoài)", async () => {
  await assert.rejects(verifyVersion({ ...base, token: "" }));
  await assert.rejects(verifyVersion({ ...base, token: undefined }));
  await assert.rejects(verifyVersion({ ...base, expected: "" }));
  await assert.rejects(verifyVersion({ ...base, baseUrl: "http://api.x.vn" }));
});

test("CLI smoke.mjs --expect-version: thiếu biến → exit 2, thiếu giá trị cờ → exit 2, không đụng DB", () => {
  const env = { PATH: process.env.PATH, XS_SMOKE_BASE_URL: "", XS_SMOKE_ADMIN_TOKEN: "" };
  const smoke = new URL("./smoke.mjs", import.meta.url).pathname;
  const a = spawnSync("node", [smoke, "--expect-version", "1.0.0"], { env, encoding: "utf8" });
  assert.equal(a.status, 2, a.stderr);
  assert.match(a.stderr, /XS_SMOKE_BASE_URL/);
  const b = spawnSync("node", [smoke, "--expect-version"], { env, encoding: "utf8" });
  assert.equal(b.status, 2, b.stderr);
});

test("CLI smoke.mjs --expect-version: máy chủ giả khớp → 0, lệch → 1, 401 → 1", async () => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const server = createServer((req, res) => {
    const ok = req.url === "/admin/x/version" && req.headers.authorization === "Bearer good";
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { version: "2.0.0" } : { code: "UNAUTHORIZED" }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const smoke = new URL("./smoke.mjs", import.meta.url).pathname;
  const run = (version, token) =>
    new Promise((resolve) => {
      const p = spawn("node", [smoke, "--expect-version", version], {
        env: {
          PATH: process.env.PATH,
          XS_SMOKE_BASE_URL: `http://127.0.0.1:${port}`,
          XS_SMOKE_ADMIN_TOKEN: token,
        },
      });
      p.on("close", resolve);
    });
  try {
    assert.equal(await run("2.0.0", "good"), 0);
    assert.equal(await run("2.0.1", "good"), 1);
    assert.equal(await run("2.0.0", "bad"), 1);
  } finally {
    server.close();
  }
});

test("verifyVersion: fetch gọi với redirect: error (không theo chuyển hướng mang token); redirect bị từ chối → không ok", async () => {
  let init;
  await verifyVersion({
    ...base,
    fetchImpl: async (_url, i) => {
      init = i;
      return { status: 200, json: async () => ({ version: "1.2.3" }) };
    },
  });
  assert.equal(init.redirect, "error");
  const r = await verifyVersion({
    ...base,
    fetchImpl: async () => {
      throw new TypeError("fetch failed: unexpected redirect");
    },
  });
  assert.equal(r.ok, false);
});
