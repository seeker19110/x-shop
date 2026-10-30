import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import react from "eslint-plugin-react";
import testingLibrary from "eslint-plugin-testing-library";
import jest from "eslint-plugin-jest";
import vitest from "eslint-plugin-vitest";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * BASE-DATA-003 (T-082): cấm lấy mặc định bằng `||` và cấm điều kiện ngầm trên giá trị nullable nguyên thuỷ.
 * - prefer-nullish-coalescing: `a || d` khi `a` có thể null/undefined → dùng `a ?? d`; nếu cố ý thay cả ""/0/false
 *   thì viết tường minh (`s === "" ? d : s`), để người đọc thấy rõ 0/rỗng là hợp lệ hay không.
 * - strict-boolean-expressions:
 *   · allowNullableString/Number/Boolean/Enum = false: `if (s)` với `s: string | undefined` gộp "thiếu" với "" (và
 *     `n: number | null` gộp với 0 — tiền/số lượng 0 là hợp lệ) → phải viết `s !== undefined`, `s === ""`, `n !== null`.
 *   · allowNullableObject = true: object/mảng/hàm không bao giờ falsy, nên `if (obj)` chỉ có một nghĩa (khác null).
 *   · allowString/allowNumber = true (mặc định): `if (s)` với `s: string` KHÔNG nullable chỉ có một nghĩa (khác "");
 *     không có nhầm lẫn thiếu-vs-rỗng mà luật này nhắm tới.
 *   · allowAny = false: `any` trong điều kiện phải ép kiểu tường minh.
 * @param {{ files: string[]; project: string[] }[]} scopes
 */
function typedNullishRules(scopes) {
  return scopes.map(({ files, project }) => ({
    files,
    languageOptions: {
      parserOptions: { project, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        {
          allowString: true,
          allowNumber: true,
          allowNullableObject: true,
          allowNullableBoolean: false,
          allowNullableString: false,
          allowNullableNumber: false,
          allowNullableEnum: false,
          allowAny: false,
        },
      ],
    },
  }));
}

/**
 * SEC-SECRET-007 / CMP-PRIV-008 (T-183): không truyền NGUYÊN object người dùng/đơn/giỏ vào logger hay `track()` —
 * object đó mang PII/bí mật mà bộ che theo tên trường không bắt hết. Cho phép thuộc tính đã chọn (`order.id`) hoặc
 * giá trị đã che (`redact(x)`). Sink = `logger|logger_|log|console` (cả `ctx.logger.x`, `this.logger_.x`) và `track()`.
 * Vật bị cấm (RAW): `req|request|body|customer|order|address|cart|payload` và `req.body|headers|query|params`.
 * Bắt RAW khi nó là: đối số trực tiếp của sink; hoặc, ở bất kỳ độ sâu bên trong lời gọi sink, là giá trị thuộc tính
 * (`{ order }`, `{ data: { order } }`), phần tử mảng (`[order]`), spread (`{ ...order }`), biểu thức template
 * (`${order}`), hoặc đối số `JSON.stringify(...)`/`String(...)`.
 * Giới hạn (không phân tích luồng dữ liệu): bí danh `const o = order; logger.info(o)` và hàm bọc tự viết lọt luật —
 * xem docs/security/log-trace-secrets.md.
 */
const SINK_NAMES = "/^(logger_?|log|console)$/";
const LOG_SINKS = `CallExpression:matches([callee.object.name=${SINK_NAMES}], [callee.object.property.name=${SINK_NAMES}], [callee.name='track'])`;
const RAW_OBJECT_NODES = [
  "Identifier[name=/^(req|request|body|customer|order|address|cart|payload)$/]",
  "MemberExpression[object.name=/^(req|request)$/][property.name=/^(body|headers|query|params)$/]",
];
const RAW_OBJECT_MESSAGE =
  "Không log/track nguyên object req/body/customer/order/address/cart/payload (SEC-SECRET-007, CMP-PRIV-008): chọn thuộc tính cần (order.id) hoặc che bằng redact().";
const RAW_OBJECT_POSITIONS = [
  `${LOG_SINKS} > NODE.arguments`, // đối số trực tiếp
  `${LOG_SINKS} Property > NODE.value`, // { order } · { data: { order } }
  `${LOG_SINKS} ArrayExpression > NODE.elements`, // [order]
  `${LOG_SINKS} SpreadElement > NODE.argument`, // { ...order }
  `${LOG_SINKS} TemplateLiteral > NODE.expressions`, // `${order}`
  `${LOG_SINKS} CallExpression[callee.object.name='JSON'][callee.property.name='stringify'] > NODE.arguments`,
  `${LOG_SINKS} CallExpression[callee.name='String'] > NODE.arguments`,
];
const LOG_RAW_OBJECT_SYNTAX = RAW_OBJECT_POSITIONS.flatMap((position) =>
  RAW_OBJECT_NODES.map((node) => ({ selector: position.replace("NODE", node), message: RAW_OBJECT_MESSAGE })),
);

/** Luật `no-restricted-syntax` chung cho mọi file (mã sản phẩm thêm UNITS_RESTRICTED_SYNTAX). */
const BASE_RESTRICTED_SYNTAX = [
  ...LOG_RAW_OBJECT_SYNTAX,
  {
    selector:
      "CallExpression[callee.property.name='catch'][arguments.0.type=/^(Arrow)?FunctionExpression$/][arguments.0.body.type='BlockStatement'][arguments.0.body.body.length=0]",
    message:
      "Không nuốt lỗi bằng .catch(() => {}) (BASE-ERR-001): xử lý, chuyển tiếp có ngữ cảnh hoặc ghi log.",
  },
  // XC-UNITS-001: thời điểm lưu/trao đổi là UTC RFC 3339 có offset; hiển thị theo múi giờ đi qua Intl.DateTimeFormat
  // với timeZone tường minh, không qua toLocale* (phụ thuộc locale/múi giờ máy chạy).
  {
    selector:
      "CallExpression[callee.property.name=/^toLocale/][callee.object.type='NewExpression'][callee.object.callee.name='Date']",
    message:
      "Cấm new Date().toLocale* (XC-UNITS-001): lưu/trao đổi bằng toISOString(); hiển thị bằng Intl.DateTimeFormat có timeZone tường minh.",
  },
  {
    selector: "CallExpression[callee.property.name=/^toLocale(Date|Time)String$/]",
    message:
      "Cấm toLocaleDateString/toLocaleTimeString (XC-UNITS-001): dùng Intl.DateTimeFormat có timeZone tường minh.",
  },
  {
    selector:
      "NewExpression[callee.name='Date'][arguments.0.value=type(string)]:not([arguments.0.value=/(Z|[+-][0-9]{2}:[0-9]{2})$/])",
    message:
      "Cấm dựng Date từ chuỗi không offset (XC-UNITS-001): chuỗi phải RFC 3339 có Z hoặc ±hh:mm (chuỗi ngày trần/không offset đọc theo múi giờ máy).",
  },
  {
    selector:
      "CallExpression[callee.object.name='Date'][callee.property.name='parse'][arguments.0.value=type(string)]:not([arguments.0.value=/(Z|[+-][0-9]{2}:[0-9]{2})$/])",
    message: "Cấm Date.parse chuỗi không offset (XC-UNITS-001): chuỗi phải RFC 3339 có Z hoặc ±hh:mm.",
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length>=2]",
    message:
      "Cấm new Date(năm, tháng, …) (XC-UNITS-001): dựng theo giờ địa phương của máy; dùng Date.UTC(...) hoặc chuỗi RFC 3339 có offset.",
  },
  {
    selector:
      "NewExpression[callee.name='Date'] > TemplateLiteral.arguments > TemplateElement[tail=true]:not([value.raw=/(Z|[+-][0-9]{2}:[0-9]{2})$/])",
    message: "Cấm dựng Date từ template chuỗi không offset (XC-UNITS-001).",
  },
];

/**
 * XC-UNITS-009 (T-120): không "số ma thuật" đổi đơn vị trong mã sản phẩm — dùng hằng/hàm ở
 * `packages/domain/src/units.ts` (bản sao: `apps/storefront/src/lib/units.ts`, `apps/backend/src/admin/lib/units.ts`). Bắt `x * 1000`, `x / 1000`,
 * `1024 * x`, `n / 1024`… (kể cả `1_000`, `1e3`, `0x3e8`, `1000n`, `y *= 1000`). Hệ số làm tròn/đếm không phải đơn vị: đặt tên hằng riêng (vd `DURATION_MS_SCALE`).
 */
const UNITS_MAGIC = ":matches(Literal[value=1000], Literal[value=1024])"; // so theo giá trị: bắt cả 1e3, 0x3e8, 1000.0, 1000n
const UNITS_MESSAGE =
  "Số ma thuật đổi đơn vị (XC-UNITS-009): dùng hằng/hàm ở units.ts (secondsToMs, msToSecondsCeil, kibToBytes, mibToBytes…).";
const UNITS_DURATION_MESSAGE =
  "Hằng thời lượng viết tay (XC-UNITS-009, T-160): dùng minutesToMs/hoursToMs/daysToMs/SECONDS_PER_HOUR… ở units.ts thay cho 60_000/3_600_000/86_400_000/3600/86400.";
// Giá trị đúng bằng 1 phút/1 giờ/1 ngày (ms hoặc giây) — hằng thời lượng hay bị gõ tay; so theo giá trị (60_000, 6e4…).
const UNITS_DURATION_SYNTAX = [
  {
    selector:
      ":matches(Literal[value=60000], Literal[value=3600000], Literal[value=86400000], Literal[value=3600], Literal[value=86400]):not([raw=/^[^0-9]/])",
    message: UNITS_DURATION_MESSAGE,
  },
];
const UNITS_RESTRICTED_SYNTAX = [
  { selector: `BinaryExpression[operator=/^[*\\/]$/] > ${UNITS_MAGIC}`, message: UNITS_MESSAGE },
  {
    selector: "AssignmentExpression[operator=/^[*\\/]=$/]:matches([right.value=1000], [right.value=1024])",
    message: UNITS_MESSAGE,
  },
];

/**
 * FE-SEC-002 (T-178): thuộc tính JSX `href`/`src`/`srcSet` (và `action`/`formAction` của form/button/input) chỉ nhận (a) chuỗi literal, (b) template route nội bộ bắt đầu bằng "/",
 * (c) lời gọi helper đã khai. Template phải có ký tự thứ hai khác "/" và "\\" (chặn `/${u}` thành `//evil`). Spread
 * (`{...props}`) không bị bắt — cố ý để nguyên, review tay. Mọi giá trị khác (biến, `obj.href`, `a ?? b`…) phải đi qua `safeHref`/`safeImgSrc`/`safeUrl`.
 * Helper route nội bộ cho phép (tự dựng đường dẫn "/…" từ handle/bộ lọc, không nhận URL ngoài): hrefFor, categoryHref,
 * productHref. Thêm helper mới phải sửa danh sách này (cố ý: thêm một cửa vào là quyết định có xem xét).
 */
const SAFE_URL_HELPERS =
  "safeUrl|safeHref|safeImgSrc|safeSrcSet|safePaymentUrl|hrefFor|categoryHref|productHref";
const SAFE_URL_VALUES = `Literal, TemplateLiteral[quasis.0.value.raw=/^[/][^/\\\\]/], CallExpression[callee.name=/^(${SAFE_URL_HELPERS})$/]`;
const URL_ATTRIBUTE_SYNTAX = [
  {
    selector: `JSXAttribute[name.name=/^(href|src|srcSet)$/] > JSXExpressionContainer.value > :not(${SAFE_URL_VALUES})`,
    message:
      "href/src/srcSet nhận biểu thức không an toàn (FE-SEC-002): bọc bằng safeHref()/safeImgSrc()/safeSrcSet()/safeUrl() ở lib/safe-url.ts, hoặc dùng helper route nội bộ (hrefFor, categoryHref, productHref), hoặc template bắt đầu bằng '/'.",
  },
  {
    // `action`/`formAction` chỉ là URL trên form/button/input (prop `action` của component khác là ReactNode — không bắt).
    // Hàm Server Action/`useActionState` (định danh `action` hoặc kết thúc bằng `Action`) không phải URL nên được qua.
    selector: `JSXOpeningElement[name.name=/^(form|button|input)$/] > JSXAttribute[name.name=/^(action|formAction)$/] > JSXExpressionContainer.value > :not(${SAFE_URL_VALUES}, Identifier[name=/^(action|[A-Za-z]+Action)$/])`,
    message:
      "action/formAction của form/button/input nhận biểu thức không an toàn (FE-SEC-002): bọc bằng safeHref() hoặc dùng hàm Server Action (định danh `action`/`…Action`).",
  },
];

const RAW_FETCH_MESSAGE =
  "Không gọi fetch trực tiếp trong component/src/lib (FE-STATE-001/005, XC-PERF-006): dùng clientFetch (lib/client-fetch.ts) hoặc fetchWithRetry (lib/http/retry.ts) — có timeout, retry lỗi tạm thời, huỷ khi unmount.";

/**
 * Mọi THAM CHIẾU `fetch` lấy từ global object (không chỉ lời gọi): `window.fetch`, `globalThis?.fetch`, `self["fetch"]`,
 * `` window[`fetch`] ``, và destructuring `const { fetch } = window` / `({ fetch: f } = globalThis)`. Giới hạn: bí danh
 * (`const w = window; w.fetch`) và ép kiểu (`(window as X).fetch`) không bắt — review tay.
 */
const GLOBAL_OBJECTS = "/^(globalThis|window|self)$/";
const FETCH_KEY = "[key.name='fetch'], [key.value='fetch']";
const RAW_FETCH_REFERENCE_SYNTAX = [
  `MemberExpression[object.name=${GLOBAL_OBJECTS}][computed=false][property.name='fetch']`,
  `MemberExpression[object.name=${GLOBAL_OBJECTS}][computed=true]:matches([property.value='fetch'], [property.type='TemplateLiteral'][property.expressions.length=0][property.quasis.0.value.cooked='fetch'])`,
  `VariableDeclarator[init.name=${GLOBAL_OBJECTS}] > ObjectPattern.id > Property:matches(${FETCH_KEY})`,
  `AssignmentExpression[right.name=${GLOBAL_OBJECTS}] > ObjectPattern.left > Property:matches(${FETCH_KEY})`,
].map((selector) => ({ selector, message: RAW_FETCH_MESSAGE }));

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.medusa/**",
      "**/coverage/**",
      "**/coverage-integration/**",
      ".xtemplates/**",
      ".claude/**",
      "**/*.config.{js,mjs,cjs}",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.{js,mjs}", "e2e/**/*.{js,mjs}"],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["apps/storefront/**/*.{ts,tsx}"],
    settings: { next: { rootDir: "apps/storefront/" } },
    plugins: { "react-hooks": reactHooks, "@next/next": nextPlugin },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
  {
    // FE-SEC-001 / SEC-WEB-004: mọi điểm tắt escape của React phải có eslint-disable kèm lý do (JSON-LD đã serialize).
    files: ["apps/storefront/**/*.{ts,tsx}"],
    plugins: { react },
    rules: { "react/no-danger": "error" },
  },
  {
    // FE-TEST-001: truy vấn theo vai trò/nhãn; getByTestId chỉ khi không còn lựa chọn và có eslint-disable kèm lý do.
    files: ["apps/storefront/**/*.test.{ts,tsx}"],
    plugins: { "testing-library": testingLibrary },
    rules: {
      // Theo FE-TEST-001: hai rule blueprint nêu tên + vài rule bắt lỗi thật; no-node-access để dành (nhiều test cũ).
      "testing-library/prefer-screen-queries": "error",
      "testing-library/no-container": "error",
      "testing-library/no-await-sync-queries": "error",
      "testing-library/no-wait-for-multiple-assertions": "error",
      "testing-library/no-promise-in-fire-event": "error",
      "no-restricted-properties": [
        "error",
        ...["get", "getAll", "query", "queryAll", "find", "findAll"].map((p) => ({
          property: `${p}ByTestId`,
          message:
            "Dùng getByRole/getByLabelText/getByText; ByTestId chỉ khi không còn lựa chọn khác (FE-TEST-001).",
        })),
      ],
    },
  },
  {
    // Cưỡng chế QA-STATIC-004 / BASE-ERR-001: không any, không ts-comment trần, mọi disable có lý do.
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { "@eslint-community/eslint-comments": eslintComments },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
          minimumDescriptionLength: 10,
        },
      ],
      "@eslint-community/eslint-comments/require-description": ["error", { ignore: [] }],
      "@eslint-community/eslint-comments/disable-enable-pair": ["error", { allowWholeFile: true }],
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
      "@eslint-community/eslint-comments/no-unused-disable": "error",
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-restricted-syntax": ["error", ...BASE_RESTRICTED_SYNTAX],
    },
  },
  {
    // Mã chạy sản phẩm: không console debug (QA-STATIC-005); dùng logger/analytics có chủ đích.
    files: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.ts"],
    ignores: ["**/*.test.{ts,tsx}", "**/__tests__/**"],
    rules: { "no-console": "error" },
  },
  {
    // Bundle Admin chạy trong trình duyệt: index `@x-shop/domain` kéo `node:fs`/`node:crypto` làm `medusa build` hỏng
    // (RollupError). Chỉ `import type` được phép; cần giá trị thì dùng bản sao ở admin/lib (format, presence, units).
    files: ["apps/backend/src/admin/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}", "**/__tests__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@x-shop/domain",
              allowTypeImports: true,
              message:
                "Admin không được import giá trị từ @x-shop/domain (kéo node:fs vào bundle trình duyệt); dùng bản sao ở admin/lib hoặc `import type`.",
            },
          ],
        },
      ],
    },
  },
  {
    // XC-UNITS-009: số ma thuật đổi đơn vị chỉ được nằm trong module đơn vị. Ghi đè no-restricted-syntax nên phải
    // lặp luật chung. T-160: gỡ ngoại lệ lib/outbox/retry.ts (đã thay `* 1000` bằng secondsToMs).
    files: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.ts"],
    ignores: [
      "**/*.test.{ts,tsx}",
      "**/__tests__/**",
      "packages/domain/src/units.ts",
      "apps/storefront/src/lib/units.ts",
      "apps/backend/src/admin/lib/units.ts",
    ],
    rules: { "no-restricted-syntax": ["error", ...BASE_RESTRICTED_SYNTAX, ...UNITS_RESTRICTED_SYNTAX] },
  },
  {
    // XC-UNITS-009 (T-160): hằng thời lượng 1 phút/1 giờ/1 ngày viết tay bị chặn ở backend lib/modules/jobs (đã dọn xong).
    // Ngoại lệ có thời hạn: modules/checkout/service.ts đang do tác vụ khác sửa — gỡ dòng ignore khi nó thay xong (T-169)
    // (workflows/, storefront, domain chưa dọn nên chưa nằm trong phạm vi luật này). Lặp luật chung vì ghi đè no-restricted-syntax.
    files: ["apps/backend/src/{lib,modules,jobs}/**/*.ts"],
    ignores: ["**/*.test.ts", "**/__tests__/**", "apps/backend/src/modules/checkout/service.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...BASE_RESTRICTED_SYNTAX,
        ...UNITS_RESTRICTED_SYNTAX,
        ...UNITS_DURATION_SYNTAX,
      ],
    },
  },
  {
    // FE-SEC-002 (T-178): siết cổng — thêm luật href/src cho mã storefront (không test). Ghi đè no-restricted-syntax
    // nên lặp luật chung + units (cùng ngoại lệ file units như khối XC-UNITS-009).
    files: ["apps/storefront/src/**/*.tsx"],
    ignores: ["**/*.test.tsx", "**/__tests__/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...BASE_RESTRICTED_SYNTAX,
        ...UNITS_RESTRICTED_SYNTAX,
        ...URL_ATTRIBUTE_SYNTAX,
      ],
    },
  },
  {
    // FE-STATE-001/005, XC-PERF-006 (T-189): I/O mạng trong component chỉ qua lib/client-fetch (timeout + retry lỗi tạm
    // thời + huỷ khi unmount). Cấm `fetch(` trần (no-restricted-globals), `globalThis|window|self.fetch` (no-restricted-syntax).
    // Ghi đè hai luật nên lặp luật chung + units + URL (khối trên) và parseFloat (khối cuối).
    files: ["apps/storefront/src/components/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}", "**/__tests__/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...BASE_RESTRICTED_SYNTAX,
        ...UNITS_RESTRICTED_SYNTAX,
        ...URL_ATTRIBUTE_SYNTAX,
        ...RAW_FETCH_REFERENCE_SYNTAX,
      ],
    },
  },
  {
    // FE-STATE-005, XC-PERF-006 (T-228): mở rộng cấm fetch trần (gọi + tham chiếu qua globalThis|window|self) sang
    // apps/storefront/src/lib — I/O chỉ qua lib/http/retry (fetchWithRetry: timeout + retry lỗi tạm thời) hoặc
    // lib/client-fetch. Ngoại lệ: lib/http/retry.ts (chính là lớp bọc), lib/pwa/sw-harness.ts (sw-harness giả lập sự kiện `fetch`
    // của Service Worker để test — không phải I/O mạng của ứng dụng), và test. Ghi đè no-restricted-syntax nên lặp luật
    // chung + units + URL; units.ts (không dính units) ở khối riêng bên dưới.
    files: ["apps/storefront/src/lib/**/*.{ts,tsx}"],
    ignores: [
      "**/*.test.{ts,tsx}",
      "**/__tests__/**",
      "apps/storefront/src/lib/http/retry.ts",
      "apps/storefront/src/lib/pwa/sw-harness.ts",
      "apps/storefront/src/lib/units.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...BASE_RESTRICTED_SYNTAX,
        ...UNITS_RESTRICTED_SYNTAX,
        ...URL_ATTRIBUTE_SYNTAX,
        ...RAW_FETCH_REFERENCE_SYNTAX,
      ],
    },
  },
  {
    files: ["apps/storefront/src/lib/units.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...BASE_RESTRICTED_SYNTAX,
        ...URL_ATTRIBUTE_SYNTAX,
        ...RAW_FETCH_REFERENCE_SYNTAX,
      ],
    },
  },
  {
    // Test vitest: không .only/.skip, mỗi test có assertion (QA-STRAT-008, QA-COV-004).
    files: ["apps/storefront/**/*.test.{ts,tsx}", "packages/domain/**/*.test.ts"],
    plugins: { vitest },
    rules: {
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "error",
      // fc.assert (fast-check) là khẳng định thuộc tính, tính như assertion.
      "vitest/expect-expect": [
        "error",
        { assertFunctionNames: ["expect", "expectTypeOf", "fc.assert", "assert*"] },
      ],
    },
  },
  {
    // Test jest của backend (unit + integration).
    files: ["apps/backend/**/*.{spec,test}.ts", "apps/backend/integration-tests/**/*.ts"],
    plugins: { jest },
    rules: {
      "jest/no-focused-tests": "error",
      "jest/no-disabled-tests": "error",
      "jest/expect-expect": ["error", { assertFunctionNames: ["expect", "expect*", "assert*"] }],
    },
  },
  // BASE-DATA-003: phân biệt thiếu (null/undefined) với rỗng ("") và 0/false. Hai luật cần thông tin kiểu nên chỉ
  // chạy trên mã TS thuộc một tsconfig; bật dần theo gói (T-082).
  ...typedNullishRules([
    { files: ["packages/domain/src/**/*.ts"], project: ["packages/domain/tsconfig.json"] },
    {
      // tsconfig.typecheck.json phủ cả __tests__ và đọc domain từ src (không cần build trước); Admin có tsconfig riêng.
      files: ["apps/backend/src/**/*.{ts,tsx}"],
      project: ["apps/backend/tsconfig.typecheck.json", "apps/backend/src/admin/tsconfig.json"],
    },
    {
      // T-200: mã TS ngoài src/ của backend — test tích hợp và file chạy production (cấu hình Medusa, OTel).
      // tsconfig.typecheck.json include "**/*" nên đã phủ các file này.
      files: [
        "apps/backend/integration-tests/**/*.ts",
        "apps/backend/medusa-config.ts",
        "apps/backend/instrumentation.ts",
      ],
      project: ["apps/backend/tsconfig.typecheck.json"],
    },
    {
      // tsconfig.eslint.json = tsconfig.json + điều kiện @x-shop/source: lint không cần build domain trước.
      // T-200: next.config.ts (cấu hình build/runtime) — tsconfig.eslint.json include thêm file này.
      files: ["apps/storefront/src/**/*.{ts,tsx}", "apps/storefront/next.config.ts"],
      project: ["apps/storefront/tsconfig.eslint.json"],
    },
    // T-200: kịch bản e2e (Playwright) — e2e/tsconfig.json phủ *.ts và *.d.mts.
    { files: ["e2e/**/*.ts"], project: ["e2e/tsconfig.json"] },
  ]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "Tiền là số nguyên VND (BASE-DATA-005)." },
      ],
    },
  },
  {
    // T-189/T-228: `fetch(` trần bị cấm trong component và src/lib (trừ retry.ts, pwa/sw-harness.ts) (phần `globalThis|window|self.fetch` ở khối no-restricted-syntax phía
    // trên). Đặt SAU khối no-restricted-globals chung vì ghi đè nó (lặp parseFloat).
    files: ["apps/storefront/src/components/**/*.{ts,tsx}", "apps/storefront/src/lib/**/*.{ts,tsx}"],
    ignores: [
      "**/*.test.{ts,tsx}",
      "**/__tests__/**",
      "apps/storefront/src/lib/http/retry.ts",
      "apps/storefront/src/lib/pwa/sw-harness.ts",
    ],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "Tiền là số nguyên VND (BASE-DATA-005)." },
        { name: "fetch", message: RAW_FETCH_MESSAGE },
      ],
    },
  },
);
