import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { MedusaContainer } from "@medusajs/framework/types";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { isNonEmpty } from "@x-shop/domain";
import { directRequestInputAccess, projectSources } from "../helpers/request-input-scan";
import seedXShop from "../../src/scripts/seed";
import { createAdmin, createMfaAdmin, noThrow, storeHeaders, type AdminAccount } from "../helpers/auth";

jest.setTimeout(600 * 1000);

/**
 * T-085 — quét MỌI route tùy biến (`src/api/{store/x,admin/x,x}/**\/route.ts`, cùng nguồn với scripts/check-openapi.mjs):
 *  - danh sách route trong mã = danh sách của check-openapi = OpenAPI; route công khai (OpenAPI không đòi danh tính) = allowlist
 *    đã duyệt dưới đây, mỗi mục có lý do (BE-AUTH-009, BE-API-009);
 *  - không danh tính → admin 401, đơn (token đơn) 404 như không tồn tại; admin không vai trò → 403 (PRF-WEB-004);
 *  - route ghi: có schema runtime (route đọc thân) hoặc không đọc thân; thân xấu (JSON hỏng, sai kiểu, quá dài, Unicode lạ,
 *    null, mảng, `__proto__`, Content-Type sai, Idempotency-Key xấu) → 4xx, không 5xx (BASE-SEC-001, BE-API-003);
 *  - route đọc: query thù địch (mảng, object lồng, số khổng lồ, ký tự điều khiển, chuỗi dài) → không 5xx.
 * Thêm route mới mà không phân loại ở đây → test đỏ.
 */

type Kind = "admin" | "order-token" | "public";
type Method = "get" | "post" | "put" | "patch" | "delete";

const ROOT = join(__dirname, "../../../..");
const API_DIR = join(__dirname, "../../src/api");

/**
 * Route không đòi danh tính người dùng (OpenAPI: chỉ publishable key hoặc `security: []`) — allowlist đã duyệt. Quyền với
 * tài nguyên (giỏ, đơn) vẫn kiểm trong route; mục nào thêm vào đây phải có lý do.
 */
const APPROVED_PUBLIC: Record<string, string> = {
  "get /store/x/products": "catalog công khai",
  "get /store/x/products/{handle}": "catalog công khai",
  "get /store/x/search": "catalog công khai",
  "get /store/x/categories": "catalog công khai",
  "get /store/x/addresses/provinces": "danh mục địa chỉ công khai",
  "get /store/x/addresses/provinces/{code}/wards": "danh mục địa chỉ công khai",
  "post /store/x/checkout/quote": "mua không cần tài khoản; quyền với giỏ kiểm bằng assertCartAccess",
  "post /store/x/checkout/submit": "mua không cần tài khoản; quyền với giỏ + Idempotency-Key",
  "get /store/x/checkout/attempts/{id}": "chỉ phiên sở hữu giỏ (cart_id + assertCartAccess), khác → 404",
  "post /store/x/checkout/attempts/{id}/recheck": "chỉ phiên sở hữu giỏ, khác → 404; 1 lần/10 s",
  "post /store/x/orders/lookup":
    "tra cứu đơn bằng mã + SĐT/email, rate limit (AT20), không phân biệt có/không",
  "post /store/x/orders/session": "đổi link token (ký) lấy token phiên đơn, rate limit",
  "get /x/webhooks/vnpay/ipn": "IPN VNPAY — kiểm chữ ký HMAC-SHA512 + số tiền + idempotent",
  "post /x/webhooks/shipping/ghn":
    "callback GHN — không tin nội dung, tra lại vận đơn qua API có token; rate limit",
  "get /x/health": "liveness, không chạm phụ thuộc, không lộ phiên bản",
  "get /x/readyz": "readiness, không lộ chi tiết (T-079)",
};

/** Route ghi KHÔNG đọc thân (hành động chỉ theo :param + phiên/token) — thân gửi kèm bị bỏ qua. */
const NO_BODY_WRITES = new Set([
  "post /admin/x/orders/{id}/confirm-cod",
  "post /admin/x/orders/{id}/shipments",
  "post /admin/x/imports/{id}/commit",
  "post /store/x/orders/{display_ref}/cancel",
  "post /store/x/orders/{display_ref}/recheck",
]);

/**
 * Ngoại lệ có chủ đích của ca thân xấu: route → tên ca → kỳ vọng thay cho 4xx (kèm lý do). Kiểm chặt hơn 4xx: phải đúng hành vi.
 */
const BAD_BODY_EXCEPTIONS: Record<
  string,
  Record<string, (res: { status: number; data: Record<string, unknown> }) => boolean>
> = {
  // text/plain là cách gửi CSV hợp lệ (lib/http/read-body.ts) — "abc=1" là một CSV sai: preview lưu kết quả kiểm có lỗi theo
  // dòng, KHÔNG ghi catalog, không commit được.
  "post /admin/x/imports/preview": {
    "Content-Type sai": (res) => res.status === 201 && res.data.can_commit === false,
  },
};

/**
 * Dấu hiệu validate bằng schema runtime trong file route (helper dùng zod hoặc parser giao thức có kiểm).
 * `importSettlementBatch` (lib/settlement/http.ts): `parseQuery` + `readCsvBody` (≤ 1 MB, UTF-8, CSV có kiểm).
 * `parseStorePage` (lib/http/pagination.ts, T-121): allowlist `limit`/`offset`, chỉ nhận chuỗi số thập phân (mảng/object/
 * số mũ/âm → lỗi), trả danh sách lỗi cho 422 — cùng loại với `parseListingQuery`; có unit test riêng.
 * `parseCheckoutBody` (lib/checkout/http.ts, T-188): parse bằng schema zod chung `@x-shop/domain/validation`, lỗi → 422.
 */
const VALIDATOR =
  /\b(parseBody|parseCheckoutBody|parseInput|safeParse|readCsvBody|importSettlementBatch|parseListingQuery|parseStorePage|handleGhnCallback|handleVnpayIpn)\s*\(/;

const SRC_DIR = join(__dirname, "../../src");

/**
 * Ngoại lệ có lý do cho truy cập trực tiếp `req.params`/`req.query` (khoá: đường dẫn tính từ `src/`). Trống: mọi đầu vào
 * đã qua schema. Thêm mục = giải thích vì sao helper schema không dùng được.
 */
const DIRECT_INPUT_ALLOWLIST: Record<string, string> = {};

interface Inventory {
  code: string[];
  spec: Record<string, { security: unknown }>;
}

/** Danh sách route của scripts/check-openapi.mjs (routesInCode) + security từng thao tác trong OpenAPI. */
function inventoryFromScripts(): Inventory {
  const script = `
    import { readFileSync } from "node:fs";
    import { parse } from "yaml";
    import { routesInCode } from "./scripts/check-openapi.mjs";
    const spec = parse(readFileSync("docs/design/openapi.yaml", "utf8"));
    const out = {};
    for (const [p, item] of Object.entries(spec.paths ?? {}))
      for (const m of ["get", "post", "put", "patch", "delete"])
        if (item?.[m]) out[m + " " + p] = { security: item[m].security ?? spec.security ?? null };
    process.stdout.write(JSON.stringify({ code: [...routesInCode("apps/backend/src/api")].sort(), spec: out }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return JSON.parse(out) as Inventory;
}

/** Quét trực tiếp cây route (đối chiếu với check-openapi) — trả cả file nguồn để kiểm tĩnh. */
function scanRoutes(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    // Dirent thay vì statSync rồi readFileSync (CodeQL js/file-system-race): loại file lấy từ cùng một lần đọc thư mục.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name;
      const p = join(dir, name);
      if (entry.isDirectory()) walk(p);
      else if (name === "route.ts") {
        const rel = relative(API_DIR, dirname(p)).split(sep).join("/");
        const path = "/" + rel.replace(/\[([^\]]+)\]/g, "{$1}");
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(
          /export\s+(?:async\s+function|function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g,
        ))
          out.set(`${m[1]!.toLowerCase()} ${path}`, src);
      }
    }
  };
  for (const root of ["store/x", "admin/x", "x"]) walk(join(API_DIR, root));
  return out;
}

function kindOf(security: unknown): Kind {
  const s = JSON.stringify(security ?? []);
  if (s.includes("admin")) return "admin";
  if (s.includes("orderAccess")) return "order-token";
  return "public";
}

const DUMMY: Record<string, string> = {
  id: "xs_khong_ton_tai_01",
  display_ref: "XS-ZZZZZZ",
  code: "khong-ton-tai",
  handle: "khong-ton-tai",
};
const concrete = (path: string) => path.replace(/\{(\w+)\}/g, (_m, k: string) => DUMMY[k] ?? "khong-ton-tai");

let ipSeq = 0;
const newIp = () => `203.0.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;

/** Thân xấu gửi tới mọi route ghi. `raw` = chuỗi gửi nguyên văn với Content-Type cho trước. */
const LONG = "x".repeat(200_000);
const BAD_BODIES: Array<{ name: string; raw: string; type?: string; headers?: Record<string, string> }> = [
  { name: "JSON hỏng", raw: '{"cart_id": "c1",,' },
  { name: "null", raw: "null" },
  { name: "mảng", raw: "[]" },
  { name: "chuỗi", raw: '"x"' },
  { name: "số", raw: "123" },
  {
    name: "sai kiểu mọi trường",
    raw: JSON.stringify({
      cart_id: 1,
      cart_version: "x",
      quote_id: [],
      payment_method: {},
      contact: "x",
      address: 1,
      lines: "x",
      items: {},
      amount: "1e309",
      quantity: -1,
      reason: 9,
      note: [],
      role: 7,
      code: [],
      name: {},
      email: 5,
      phone: {},
      order_id: null,
      return_id: [],
      decision: null,
      outcome: 1,
      handle: { $ne: null },
    }),
  },
  { name: "chuỗi rất dài", raw: JSON.stringify({ reason: LONG, cart_id: LONG, name: LONG }) },
  {
    name: "Unicode lạ",
    raw: JSON.stringify({ reason: "\u0000\ud800‮😀﻿", cart_id: "\u0000", name: "‮" }),
  },
  { name: "__proto__", raw: '{"__proto__":{"isAdmin":true},"constructor":{"prototype":{"x":1}}}' },
  { name: "Content-Type sai", raw: "abc=1", type: "text/plain" },
  {
    name: "Idempotency-Key xấu",
    raw: "{}",
    headers: { "idempotency-key": `${"k".repeat(300)} ; drop` },
  },
];

const HOSTILE_QUERY =
  "q[]=a&q[]=b&page_size=abc&limit=-1&offset=1e309&cart_id[x]=1&order_id[]=1&code[a]=b&role[]=x" +
  "&price_min=99999999999999999999999&price_max=-5&from=not-a-date&to[]=x&state[]=x&category=%00%E2%80%AE" +
  `&size[]=${"S".repeat(20)}&color[$ne]=x&sort=__proto__&status[]=1&kind[]=x&q2=${"x".repeat(8_000)}`;

/**
 * 400 từ lớp biên chung, trước khi tới route (không phụ thuộc đơn/tài nguyên nào — không phải kênh dò): body-parser (thân
 * không phải JSON object, T-088), NUL (`rejectNulBytes`), tham số đường dẫn mã hoá hỏng (`INVALID_PATH`).
 */
const isEdgeReject = (res: { status: number; data: Record<string, unknown> }) =>
  res.status === 400 &&
  (res.data.detail === "Thân yêu cầu không phải JSON hợp lệ" ||
    res.data.code === "INVALID_CHARACTERS" ||
    res.data.code === "INVALID_PATH");

interface Res {
  status: number;
  data: Record<string, unknown>;
  headers: Record<string, string>;
}
interface Api {
  request(config: Record<string, unknown>): Promise<Res>;
}

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let store: Record<string, string>;
    let noRole: AdminAccount;
    let inventory: Inventory;
    let scanned: Map<string, string>;

    beforeAll(async () => {
      container = getContainer();
      await seedXShop({ container });
      store = await storeHeaders(container);
      noRole = await createAdmin(rawApi, container, { roles: [] });
      inventory = inventoryFromScripts();
      scanned = scanRoutes();
    });

    const send = (method: Method, url: string, headers: Record<string, string>, data?: string) =>
      api.request({
        method,
        url,
        headers: { ...store, "x-forwarded-for": newIp(), ...headers },
        ...(data !== undefined && { data, transformRequest: [(d: unknown) => d] }),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        ...noThrow,
      });

    const routes = () => inventory.code.map((r) => r as `${Method} ${string}`);
    const split = (r: string) => {
      const i = r.indexOf(" ");
      return { method: r.slice(0, i) as Method, path: r.slice(i + 1) };
    };
    const kind = (r: string) => kindOf(inventory.spec[r]?.security);
    const isWrite = (r: string) => !r.startsWith("get ");

    describe("kho route", () => {
      it("route trong mã = check-openapi.mjs (routesInCode) = OpenAPI; ≥ 50 route", () => {
        expect([...scanned.keys()].sort()).toEqual(inventory.code);
        expect(Object.keys(inventory.spec).sort()).toEqual(inventory.code);
        expect(inventory.code.length).toBeGreaterThanOrEqual(50);
      });

      it("route công khai (OpenAPI không đòi danh tính) = allowlist đã duyệt", () => {
        const pub = inventory.code.filter((r) => kind(r) === "public").sort();
        expect(pub).toEqual(Object.keys(APPROVED_PUBLIC).sort());
      });

      it("mọi route /admin/x đòi phiên admin; mọi route đơn sau tra cứu đòi token đơn (theo OpenAPI)", () => {
        for (const r of inventory.code) {
          const { path } = split(r);
          if (path.startsWith("/admin/x/")) expect({ r, kind: kind(r) }).toEqual({ r, kind: "admin" });
          else if (/^\/store\/x\/orders\/\{display_ref\}/.test(path))
            expect({ r, kind: kind(r) }).toEqual({ r, kind: "order-token" });
          else expect({ r, kind: kind(r) }).toEqual({ r, kind: "public" });
        }
      });

      it("route ghi đọc thân → có schema runtime; route ghi không schema → không đọc req.body", () => {
        const problems: string[] = [];
        for (const r of inventory.code.filter(isWrite)) {
          const src = scanned.get(r)!;
          if (NO_BODY_WRITES.has(r)) {
            if (/req\.body\b/.test(src)) problems.push(`${r}: khai không đọc thân nhưng có req.body`);
          } else if (!VALIDATOR.test(src)) {
            problems.push(`${r}: không thấy validate schema (${VALIDATOR.source})`);
          }
        }
        expect(problems).toEqual([]);
      });

      it("[BASE-SEC-001, BE-API-003] không route/lớp HTTP dự án truy cập thẳng req.params/req.query — chỉ qua readParams/readQuery (zod)", () => {
        const files = projectSources(SRC_DIR); // toàn bộ src/**/*.ts (route, lib, middleware, subscriber, script)
        expect(files.size).toBeGreaterThan(100);
        const problems: string[] = [];
        for (const [name, src] of files) {
          if (isNonEmpty(DIRECT_INPUT_ALLOWLIST[name])) continue;
          for (const hit of directRequestInputAccess(src, name)) problems.push(`${name}: ${hit}`);
        }
        expect(problems).toEqual([]);
        // Allowlist không được thừa: mục nào không còn truy cập trực tiếp phải bị xoá.
        for (const name of Object.keys(DIRECT_INPUT_ALLOWLIST))
          expect(directRequestInputAccess(files.get(name) ?? "")).not.toEqual([]);
      });

      it("bộ dò truy cập trực tiếp bắt đủ các dạng (kể cả alias/ép kiểu/destructuring) và bỏ qua chú thích", () => {
        const bad = [
          "const id = req.params.id as string;",
          'const id = String(req.params.id ?? "");',
          "const q = req.query;",
          "const { query } = req;",
          "const { params, scope } = req;",
          "const t = (req.query as { token?: unknown }).token;",
          "const x = (req as Foo).query.x;",
          'const x = req["query"].x;',
          "const x = req?.params?.id;",
          "const x = request.query.x;",
          "Object.keys(req.query)",
          "const x = req!.query.x;",
          "const x = req!.params.id;",
          "export function f({ query }: MedusaRequest) { return query.x }",
          "export const g = ({ params }: MedusaStoreRequest) => params.id;",
          "const x = (<any>req).query;",
          "const x = (req satisfies MedusaRequest).query.x;",
          'const u = "a//b"; const x = req.query.x;',
          "const { query } = req as MedusaRequest;",
          "const x = req[k];",
          "const x = (req as unknown as R)\n  .params.id;",
        ];
        for (const src of bad)
          expect({ src, hits: directRequestInputAccess(src).length > 0 }).toEqual({ src, hits: true });
        const good = [
          "const p = readParams(req, IdParams);",
          "const q = readQuery(req, Q);",
          "// req.params.id — chú thích",
          "/** GET /x/:id?cart_id= — req.query.cart_id */",
          "req.queryConfig.fields",
          "const m = req.scope.resolve(X);",
          'const s = "req.query.x"; const t = `req.params`;',
          "const { scope } = req;",
          "const x = other.query.y;",
        ];
        for (const src of good)
          expect({ src, hits: directRequestInputAccess(src) }).toEqual({ src, hits: [] });
      });

      it("route có tham số đường dẫn đọc nó qua readParams (hoặc requireOrderAccess cho :display_ref)", () => {
        const problems: string[] = [];
        for (const r of inventory.code) {
          if (!/\{\w+\}/.test(r)) continue;
          if (!/\b(readParams|requireOrderAccess)\s*\(/.test(scanned.get(r)!)) problems.push(r);
        }
        expect(problems).toEqual([]);
      });
    });

    describe("authn/authz theo loại route", () => {
      it("[api5-bfla admin:*] [api1-bola order:*] không danh tính: admin → 401, đơn → 404 như không tồn tại, công khai → không 401/403; không route nào 5xx", async () => {
        const seen: Array<{ r: string; status: number }> = [];
        for (const r of routes()) {
          const { method, path } = split(r);
          const res = await send(method, concrete(path), {}, isWrite(r) ? "{}" : undefined);
          seen.push({ r, status: res.status });
          expect({ r, server: res.status >= 500 }).toEqual({ r, server: false });
          const k = kind(r);
          if (k === "admin") {
            // 401 do middleware `authenticate` native của Medusa trả (chạy trước middleware dự án) — thân JSON
            // `{message}` không phải problem+json (câu hỏi mở T-085); kiểm không lộ chi tiết.
            expect({ r, status: res.status }).toEqual({ r, status: 401 });
            expect(JSON.stringify(res.data)).not.toMatch(/at .*\.(js|ts)|\/home\/|\/var\/|SELECT /);
          } else if (k === "order-token") {
            expect({ r, status: res.status }).toEqual({ r, status: 404 });
          } else {
            expect({ r, status: res.status }).not.toEqual({ r, status: 401 });
            expect({ r, status: res.status }).not.toEqual({ r, status: 403 });
          }
        }
        expect(seen.length).toBe(inventory.code.length);
      });

      it("route ghi công khai không thao tác khi thiếu dữ liệu sở hữu (không 2xx với thân rỗng)", async () => {
        for (const r of routes().filter((x) => isWrite(x) && kind(x) === "public")) {
          const { method, path } = split(r);
          const res = await send(method, concrete(path), {}, "{}");
          expect({ r, ok: res.status >= 200 && res.status < 300 }).toEqual({ r, ok: false });
        }
      });

      it("[api5-bfla admin:*] admin đã đăng nhập nhưng không vai trò → 403 FORBIDDEN ở mọi route /admin/x", async () => {
        for (const r of routes().filter((x) => kind(x) === "admin")) {
          const { method, path } = split(r);
          const res = await send(method, concrete(path), noRole.headers, isWrite(r) ? "{}" : undefined);
          expect({ r, status: res.status, code: res.data.code }).toEqual({
            r,
            status: 403,
            code: "FORBIDDEN",
          });
        }
      });
    });

    describe("đầu vào xấu → 4xx, không 5xx", () => {
      it("route ghi × thân xấu (admin: owner đã qua MFA để tới được lớp validate)", async () => {
        const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
        const failures: string[] = [];
        for (const r of routes().filter(isWrite)) {
          const { method, path } = split(r);
          const auth = kind(r) === "admin" ? owner.headers : {};
          for (const b of BAD_BODIES) {
            const res = await send(
              method,
              concrete(path),
              {
                "content-type": b.type ?? "application/json",
                ...auth,
                ...b.headers,
              },
              b.raw,
            );
            const exceptions = BAD_BODY_EXCEPTIONS[r];
            const exception =
              exceptions && Object.hasOwn(exceptions, b.name) ? exceptions[b.name] : undefined;
            if (exception) {
              if (!exception(res))
                failures.push(`${r} [${b.name}] → ${res.status} (ngoại lệ không đúng kỳ vọng)`);
              continue;
            }
            if (res.status < 400 || res.status > 499) failures.push(`${r} [${b.name}] → ${res.status}`);
            else if (
              kind(r) === "order-token" &&
              res.status !== 404 &&
              res.status !== 413 &&
              !isEdgeReject(res)
            )
              // Không token đơn: 404 như không tồn tại TRƯỚC mọi kiểm thân (AT20) — không lộ schema cho người không có quyền.
              // Trừ 400 của lớp biên chung (isEdgeReject) — trước khi tới route, không phụ thuộc đơn nào.
              failures.push(`${r} [${b.name}] → ${res.status} (không token phải 404)`);
            else if (res.status !== 413 && kind(r) !== "public") {
              // Lỗi của handler/route: problem+json có trace_id.
              if (
                !String(res.headers["content-type"]).includes("problem+json") ||
                typeof res.data.trace_id !== "string" ||
                res.data.trace_id === ""
              )
                failures.push(`${r} [${b.name}] → ${res.status} không phải problem+json có trace_id`);
            }
          }
        }
        expect(failures).toEqual([]);
      });

      it("route đọc × query thù địch → không 5xx", async () => {
        const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
        const failures: string[] = [];
        for (const r of routes().filter((x) => !isWrite(x))) {
          const { method, path } = split(r);
          const auth = kind(r) === "admin" ? owner.headers : {};
          const res = await send(method, `${concrete(path)}?${HOSTILE_QUERY}`, auth);
          if (res.status >= 500) failures.push(`${r} → ${res.status}`);
        }
        expect(failures).toEqual([]);
      });

      it("route có tham số đường dẫn × giá trị thù địch → 4xx, không 5xx (admin: owner; đơn: không token → 404)", async () => {
        const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
        const values = [
          "x".repeat(4_000),
          "%00",
          "%27%20OR%201%3D1--",
          "%2E%2E%2F%2E%2E%2Fetc%2Fpasswd",
          encodeURIComponent("đơn\u202e😀"),
          "%E0%A4%A",
          "__proto__",
        ];
        const failures: string[] = [];
        for (const r of routes().filter((x) => /\{\w+\}/.test(x))) {
          const { method, path } = split(r);
          const auth = kind(r) === "admin" ? owner.headers : {};
          for (const v of values) {
            const url = path.replace(/\{\w+\}/g, v);
            const res = await send(method, url, auth, isWrite(r) ? "{}" : undefined);
            if (res.status < 400 || res.status > 499)
              failures.push(`${r} [${v.slice(0, 24)}] → ${res.status}`);
            else if (kind(r) === "order-token" && res.status !== 404 && !isEdgeReject(res))
              failures.push(`${r} [${v.slice(0, 24)}] → ${res.status} (không token phải 404)`);
          }
        }
        expect(failures).toEqual([]);
      });

      it("[BASE-SEC-001] tham số/query sai hình dạng (thiếu, rỗng, mảng, object, sai kiểu, quá dài) → 404/422 có problem+json, không 5xx", async () => {
        const owner = await createMfaAdmin(rawApi, container, { roles: ["owner"] });
        const admin = owner.headers;
        const long = (n: number) => "x".repeat(n);
        const cases: Array<{
          name: string;
          method: Method;
          url: string;
          headers: Record<string, string>;
          status: number;
          code: string;
        }> = [
          // Public: attempt thuộc phiên sở hữu giỏ — mọi hình dạng sai đều là "không thấy" (không lộ gì).
          ...[
            ["thiếu cart_id", ""],
            ["cart_id rỗng", "?cart_id="],
            ["cart_id lặp (?a=1&a=2)", "?cart_id=a&cart_id=b"],
            ["cart_id object", "?cart_id[x]=1"],
            ["cart_id quá dài", `?cart_id=${long(101)}`],
          ].map(([name, qs]) => ({
            name: `attempts: ${name}`,
            method: "get" as Method,
            url: `/store/x/checkout/attempts/att_1${qs}`,
            headers: {},
            status: 404,
            code: "NOT_FOUND",
          })),
          {
            name: "products/:handle quá dài",
            method: "get",
            url: `/store/x/products/${long(201)}`,
            headers: {},
            status: 404,
            code: "NOT_FOUND",
          },
          {
            name: "wards/:code không phải số",
            method: "get",
            url: "/store/x/addresses/provinces/abc/wards",
            headers: {},
            status: 404,
            code: "NOT_FOUND",
          },
          // Admin: id quá dài không khớp tài nguyên nào → 404 NOT_FOUND (như id không tồn tại).
          ...(
            [
              ["get", "/admin/x/settlements/batches/"],
              ["get", "/admin/x/returns/"],
              ["get", "/admin/x/imports/"],
              ["get", "/admin/x/products/PID/publish-check".replace("PID", long(129))],
            ] as Array<[Method, string]>
          ).map(([method, base]) => ({
            name: `id quá dài ${base.slice(0, 32)}`,
            method,
            url: base.endsWith("/") ? `${base}${long(129)}` : base,
            headers: admin,
            status: 404,
            code: "NOT_FOUND",
          })),
          {
            name: "refunds?order_id lặp",
            method: "get",
            url: "/admin/x/refunds?order_id=a&order_id=b",
            headers: admin,
            status: 422,
            code: "VALIDATION",
          },
          {
            name: "refunds?order_id rỗng",
            method: "get",
            url: "/admin/x/refunds?order_id=",
            headers: admin,
            status: 422,
            code: "VALIDATION",
          },
          {
            name: "refunds?order_id quá dài",
            method: "get",
            url: `/admin/x/refunds?order_id=${long(129)}`,
            headers: admin,
            status: 422,
            code: "VALIDATION",
          },
          {
            name: "audit?limit lặp",
            method: "get",
            url: "/admin/x/audit?limit=1&limit=2",
            headers: admin,
            status: 422,
            code: "VALIDATION",
          },
          {
            name: "audit?action object",
            method: "get",
            url: "/admin/x/audit?action[x]=1",
            headers: admin,
            status: 422,
            code: "VALIDATION",
          },
          {
            name: "settlements/batches?limit mảng",
            method: "get",
            url: "/admin/x/settlements/batches?limit=1&limit=2",
            headers: admin,
            status: 422,
            code: "VALIDATION",
          },
          {
            name: "returns?limit mảng",
            method: "get",
            url: "/admin/x/returns?limit=1&limit=2",
            headers: admin,
            status: 422,
            code: "VALIDATION",
          },
        ];
        const failures: string[] = [];
        for (const c of cases) {
          const res = await send(c.method, c.url, c.headers);
          const ct = String(res.headers["content-type"] ?? "");
          if (res.status !== c.status || res.data.code !== c.code || !ct.includes("application/problem+json"))
            failures.push(`${c.name} → ${res.status} ${String(res.data.code)} (${ct})`);
        }
        expect(failures).toEqual([]);
      });
    });
  },
});
