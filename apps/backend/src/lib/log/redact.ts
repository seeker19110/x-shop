/**
 * Che bí mật + PII trước khi ghi log (BASE-ERR-007, SEC-SECRET-007, CMP-PRIV-008, T-090).
 *
 * Hai lớp:
 *  1. Theo TÊN trường (không phân biệt hoa thường, bỏ `_`/`-`/`.`): mật khẩu, token, cookie, phiên, khoá, chữ ký, chuỗi kết
 *     nối, số thẻ… và PII (email, SĐT, địa chỉ, CCCD/CMND, họ tên, ngày sinh) → cả giá trị (kể cả object/mảng) thành
 *     `[REDACTED]`.
 *  2. Theo NỘI DUNG chuỗi (mọi chuỗi còn lại, kể cả `message`, stack): Bearer/Basic, JWT, mật khẩu trong URL, `khoá=giá trị`
 *     kiểu query/JSON, email, số thẻ (Luhn), CCCD 12 số, SĐT Việt Nam (0/84/+84, có dấu cách/chấm/gạch), địa chỉ Việt Nam
 *     (số nhà + đường/ngõ/hẻm, hoặc ≥ 2 cấp hành chính phường/xã, quận/huyện, tỉnh/thành phố — có dấu hoặc không dấu).
 *
 * Không thay đổi đầu vào (trả bản sao). Vòng tham chiếu → `[Circular]`; sâu quá `MAX_DEPTH` → `[Truncated]`.
 * CMND 9 số chỉ che theo nội dung khi có từ khoá đi kèm (CMND/CMT/chứng minh…; D-066) — 9 chữ số trần trùng số tiền VND.
 * Địa chỉ IP chỉ che khi đi sau khoá (`client_ip=`, `x-forwarded-for:`…) hoặc theo tên trường (T-136).
 * Giới hạn đã biết: tên người trong văn bản tự do và IP trần không phát hiện được bằng mẫu → không đưa họ tên/IP vào
 * thông điệp log (danh sách mẫu: scripts/fixtures/pii-samples.json).
 */

import { createHmac } from "node:crypto";

export const REDACTED = "[REDACTED]";

let hashKey = "x-shop-dev-log-hash";
/**
 * Khoá HMAC cho giá trị "băm ngắn" (literal SQL, chi tiết `Key (...)=(...)`): còn đối chiếu được (tính HMAC của id đã
 * biết rồi so) mà không lộ giá trị. Logger ứng dụng đặt từ cấu hình (lib/log/app-logger.ts).
 */
export function setLogHashKey(key: string): void {
  if (key.length > 0) hashKey = key;
}
/** `[h:xxxxxxxx]` — 8 hex đầu của HMAC-SHA256. */
export function shortHash(value: string): string {
  return `[h:${createHmac("sha256", hashKey).update(value).digest("hex").slice(0, 8)}]`;
}
const HASHED = /^\[h:[0-9a-f]{8}\]$/;
/**
 * `shortHash` trừ khi giá trị ĐÃ là `[h:xxxxxxxx]`: đường object thường che từng trường rồi logger che lại cả chuỗi — băm
 * lần hai làm mất khả năng đối chiếu (review T-151 vòng 3).
 */
function hashOnce(value: string): string {
  return HASHED.test(value) ? value : shortHash(value);
}
const MAX_DEPTH = 10;

/** Bỏ dấu (NFD + `đ`→`d`) để khoá tiếng Việt có dấu (`mật khẩu`, `họ tên`) chuẩn về `matkhau`, `hoten` (T-136). */
const norm = (key: string) =>
  key
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]/g, "");

/** Khoá chứa một trong các đoạn này (sau chuẩn hoá) là bí mật. */
const SECRET_KEY_PARTS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "authorization",
  "cookie",
  "apikey",
  "privatekey",
  "credential",
  "securehash",
  "connectionstring",
  "databaseurl",
  "redisurl",
  "cardnumber",
  "recoverycode",
  "mfacode",
  "otpcode",
  "sessionid",
  "encryptionkey",
  "hashsecret",
  "matkhau",
];
/** Khoá NGẮN chỉ khớp nguyên văn (tránh `pin` ⊂ `shipping`, `pan` ⊂ `company`, `sid` ⊂ `inside`). */
const SECRET_KEY_EXACT = new Set([
  "pwd",
  "pass",
  "auth",
  "session",
  "sid",
  "otp",
  "totp",
  "cvv",
  "cvc",
  "pan",
  "pin",
  "dsn",
  "jwt",
  "bearer",
  "signature",
  "sig",
  "hmac",
  "salt",
]);
const PII_KEY_PARTS = [
  "email",
  "phone",
  "sodienthoai",
  "address",
  "diachi",
  "street",
  "cccd",
  "cmnd",
  "nationalid",
  "citizenid",
  "idnumber",
  "passport",
  "fullname",
  "firstname",
  "lastname",
  "middlename",
  "recipientname",
  "receivername",
  "customername",
  "hoten",
  "dateofbirth",
  "birthday",
  "birthdate",
  "ngaysinh",
  "clientip",
  "remoteaddr",
  "remoteip",
  "realip",
  "forwardedfor",
  "ipaddress",
  "ipaddr",
];
const PII_KEY_EXACT = new Set(["sdt", "tel", "mobile", "dob", "ten", "ip"]);

/** `true` nếu giá trị của trường tên `key` phải che toàn bộ. */
export function isSensitiveKey(key: string): boolean {
  const k = norm(key);
  if (k === "") return false;
  if (SECRET_KEY_EXACT.has(k) || PII_KEY_EXACT.has(k)) return true;
  return SECRET_KEY_PARTS.some((p) => k.includes(p)) || PII_KEY_PARTS.some((p) => k.includes(p));
}

const SECRET_PARAM =
  "password|passwd|pwd|pass|secret|client_secret|token|access_token|refresh_token|id_token|api[_-]?key|apikey|signature|sig|vnp_SecureHash|otp|session(?:_?id)?|sid|code_verifier|authorization|cookie|m[aậ]t[ _-]?kh[aẩ]u";

/**
 * Nháy quanh khoá/giá trị kể cả dạng đã thoát (`\\"password\\":\\"x\\"` — JSON nằm trong chuỗi rồi `JSON.stringify` lần nữa,
 * T-136). `ESC_QUOTED`: `\\"` mở → tới nháy kép kế (nháy của cặp đóng; các `\\` đứng trước nó nằm trong phần bị che).
 */
const QKEY = String.raw`\\{0,7}["']?`;
const ESC_QUOTED = String.raw`\\{1,7}"[^"]{0,4096}"?`;
/** Giữ kiểu nháy của giá trị đã che (`"`, `'`, `\"`, hoặc không nháy). */
function quoteOf(value: string): string {
  const m = /^(?:\\{1,7}"|"|')/.exec(value);
  return m === null ? "" : m[0];
}

interface Rule {
  re: RegExp;
  to: string | ((m: string, ...g: string[]) => string);
}

/** `k: v<sep>k2: v2<sep>` → giá trị băm (giữ tên cột và dấu phân cách). */
function hashPairs(pairs: string, sep: string): string {
  return pairs
    .split(sep)
    .map((p) => {
      const i = p.indexOf(": ");
      return i === -1 ? p : `${p.slice(0, i + 2)}${hashOnce(p.slice(i + 2))}`;
    })
    .join(sep);
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const IPV4 = String.raw`\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?`;
const IPV6 = String.raw`[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}`;
const IP_ONE = String.raw`(?:${IPV4}|${IPV6})`;
const IP_LIST = String.raw`${IP_ONE}(?:\s{0,3},\s{0,3}${IP_ONE}){0,15}`;

/**
 * Thứ tự quan trọng: bí mật có cấu trúc trước, số thẻ/CCCD trước SĐT (SĐT là chuỗi số ngắn hơn).
 * MỌI lượng từ đều có trần (không `+`/`*` mở) → thời gian tuyến tính theo độ dài, không ReDoS trên đầu vào đối nghịch
 * (đường dẫn, thông điệp lỗi do client điều khiển) — test hiệu năng trong redact.unit.spec.ts.
 */
const RULES: Rule[] = [
  {
    re: /\b(Bearer|Basic|Token)\s{1,8}[A-Za-z0-9._~+/=-]{6,4096}/gi,
    to: (_m, scheme) => `${scheme} ${REDACTED}`,
  },
  { re: /\beyJ[A-Za-z0-9_-]{5,4096}\.[A-Za-z0-9_-]{5,4096}\.[A-Za-z0-9_-]{5,4096}/g, to: REDACTED },
  // Khoá API dạng tiền tố (Stripe-like `sk_live_…`, `pk_test_…`, `rk_…`, `whsec_…`).
  { re: /\b(?:(?:sk|pk|rk)_(?:live|test)|whsec)_[A-Za-z0-9]{8,256}/g, to: REDACTED },
  // Khoá API của Medusa: `sk_` + 64 hex (secret), `pk_` + hex (publishable) — che cả token.
  { re: /\b(?:sk|pk)_[0-9a-f]{32,128}\b/g, to: REDACTED },
  {
    re: /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s:@/]{0,256}:[^\s@/]{1,256}@/gi,
    to: (_m, scheme) => `${scheme}${REDACTED}@`,
  },
  // Mã OTP/MFA/khôi phục kèm số: "otp 123456", "mfa code=654321", "mã OTP: 112233".
  {
    re: /\b((?:mã\s{1,3})?(?:otp|totp|mfa(?:[ _-]?code)?|recovery[ _-]?code))(\s{0,3}[:=]?\s{0,3})\d{4,10}(?![\d-])/giu,
    to: (_m, key, sep) => `${key}${sep}${REDACTED}`,
  },
  {
    re: new RegExp(
      `(${QKEY})\\b(${SECRET_PARAM})\\1(\\s{0,8}[:=]\\s{0,8})((?:(?:Bearer|Basic|Token)\\s{1,8})?(?:${ESC_QUOTED}|"[^"]{0,4096}"|'[^']{0,4096}'|[^&\\s,;"'}]{1,4096}))`,
      "gi",
    ),
    to: (_m, q, key, sep, value) => {
      const quote = quoteOf(value);
      return `${q}${key}${q}${sep}${quote}${REDACTED}${quote}`;
    },
  },
  // Trường PII dạng `address=…` / `"address":"…"` trong văn bản (JSON, query, util.inspect).
  {
    re: new RegExp(
      `(${QKEY})\\b(address(?:_?[12])?|addr|dia_?chi|street|full_?name|first_?name|last_?name|ho_?ten|h[oọ][ _-]?t[eê]n|recipient_?name|receiver_?name|customer_?name|phone(?:_?number)?|sdt|email|cccd|cmnd)\\1(\\s{0,8}[:=]\\s{0,8})(${ESC_QUOTED}|"[^"]{0,4096}"|'[^']{0,4096}'|[^&,;"'}\\n]{1,256})`,
      "gi",
    ),
    to: (_m, q, key, sep, value) => {
      const quote = quoteOf(value);
      return `${q}${key}${q}${sep}${quote}${REDACTED}${quote}`;
    },
  },
  // Chi tiết lỗi ràng buộc Postgres: `Key (email)=(a@b.vn) already exists.`
  {
    re: /\bKey \(([^()]{1,256})\)=\(([^()]{0,1024})\)/g,
    to: (_m, cols, vals) =>
      `Key (${cols})=(${vals
        .split(/,\s{0,4}/)
        .map(hashOnce)
        .join(", ")})`,
  },
  // Medusa `dbErrorMapper` chép giá trị khoá từ detail vào văn xuôi (review T-151 vòng 3): unique → `<Bảng> with k: v, …,
  // already exists.`; FK → `You tried to set relationship k: v,k2: v2, but such entity does not exist`. Băm từng giá trị.
  {
    re: /( with )((?:[\w.]{1,64}: [^,\n]{0,256}, ){1,32})(already exists\.)/g,
    to: (_m, lead, pairs, tail) => `${lead}${hashPairs(pairs, ", ")}${tail}`,
  },
  {
    re: /(You tried to set relationship )([\w.]{1,64}: [^,\n]{0,256}(?:,[\w.]{1,64}: [^,\n]{0,256}){0,31})(, but such entity does not exist)/g,
    to: (_m, lead, pairs, tail) => `${lead}${hashPairs(pairs, ",")}${tail}`,
  },
  { re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}/g, to: "[EMAIL]" },
  {
    // Đầu số thẻ (IIN): Visa 4, Mastercard 51–55/22–27, Amex 34/37, JCB 35, Discover 60/65 — tránh dấu thời gian 2026….
    re: /(?<![\p{L}\p{N}])(?:4\d|5[1-5]|2[2-7]|3[457]|6[05])(?:[ -]?\d){11,17}(?![\p{L}\p{N}])/gu,
    to: (m) => (luhn(m.replace(/\D/g, "")) ? "[CARD]" : m),
  },
  { re: /(?<![\p{L}\p{N}])0\d{2}(?:[ .-]?\d{3}){3}(?![\p{L}\p{N}])/gu, to: "[CCCD]" },
  // Địa chỉ IP chỉ che khi đi sau khoá (`client_ip=…`, `"ip":"…"`, `x-forwarded-for: a, b`): IP trần trong văn bản trùng
  // chuỗi phiên bản/host DB nội bộ (T-136). Danh sách IP (XFF) che hết.
  {
    re: new RegExp(
      `(${QKEY})\\b(client[_-]?ip|remote[_-]?(?:addr(?:ess)?|ip)|real[_-]?ip|x-real-ip|x-forwarded-for|forwarded[_-]?for|ip(?:[_-]?addr(?:ess)?)?)\\1(\\s{0,8}[:=]\\s{0,8})(\\\\{0,7}["']?)${IP_LIST}`,
      "gi",
    ),
    to: (_m, q, key, sep, quote) => `${q}${key}${q}${sep}${quote}[IP]`,
  },
  // CMND 9 số chỉ che khi có từ khoá đi kèm (D-066): 9 chữ số trần trùng số tiền VND. Khoảng giữa từ khoá và số ≤ 16 ký tự
  // không chứa chữ số/xuống dòng ("CMND số", "chứng minh nhân dân số").
  {
    re: /\b(cmnd|cmtnd|cmt|chứng minh(?: nhân dân| thư)?|chung minh(?: nhan dan| thu)?)([^\d\n]{0,16})\d{3}[ .-]?\d{3}[ .-]?\d{3}(?!\d)/gi,
    to: (_m, kw, gap) => `${kw}${gap}[CMND]`,
  },
  { re: /(?<![\p{L}\p{N}+.])(?:\+84|84|0)(?![.])(?:[ .-]?\d){9,10}(?![\p{N}])/gu, to: "[PHONE]" },
];

/**
 * Thông điệp chứa câu SQL (lỗi knex/MikroORM chép câu lệnh kèm giá trị vào `err.message`): mọi chuỗi trong nháy đơn có
 * thể là họ tên/địa chỉ không nhận ra bằng mẫu → che hết.
 */
const SQL_QUOTED =
  /\b(?:insert\s{1,4}into\s{1,4}"|update\s{1,4}"[^"\n]{1,128}"\s{1,4}set\s|delete\s{1,4}from\s{1,4}")/i;
/** SQL viết hoa không nháy định danh (`INSERT INTO t`, `UPDATE t SET c =`, `SELECT … FROM t`) — phân biệt hoa thường. */
const SQL_UPPER = /\b(?:INSERT INTO \w{1,128}|UPDATE \w{1,128} SET \w{1,128}\s{0,4}=|DELETE FROM \w{1,128})/;
/** SELECT: kiểm hai mẫu độc lập (tuyến tính) thay vì `select…from` một mẫu (bậc hai khi `select` lặp). */
function looksLikeSelect(s: string): boolean {
  return (
    (/\bselect\s/i.test(s) && /\sfrom\s{1,4}"/i.test(s)) || (/\bSELECT\s/.test(s) && /\sFROM \w/.test(s))
  );
}
/** Tuyến tính (hai nhánh khác ký tự đầu), không trần — chạy SAU khi chuỗi đã bị cắt `MAX_TEXT` nên cặp nháy không lệch. */
const SQL_LITERAL = /'(?:[^']|'')*'/g;

/**
 * Câu SQL của knex/pg/MikroORM trong thông điệp lỗi (`<sql đã chèn giá trị> - <lỗi>`: knex `compileSqlOnError`, MikroORM
 * `execute` qua `formatQuery`): giá trị gồm cả SỐ (số đo, tiền gắn người), `null`, JSON — mẫu "chuỗi trong nháy" không đủ.
 *
 * Cách làm (T-151, sau hai vòng bộ phân tích theo mệnh đề sinh hồi quy): KHÔNG phân tích `set`/`where`/`join`/`limit`…
 * Nhận ra đầu câu rồi bỏ NGUYÊN phần thân tới ` - ` CUỐI (ngoài nháy) của vùng; chỉ giữ:
 *  - ghi/xoá: đoạn đầu đã khớp (`insert into "t"`, `update "t" [as "x"] set`, `delete from "t" [as "x"]`, `merge into "t"`,
 *    `call p`, `with "v" as (`) + `[REDACTED]`;
 *  - `select`: `select [REDACTED] from "<bảng đầu tiên>" [REDACTED]` (danh sách chọn cũng bỏ — có thể chứa literal).
 *
 * Vùng của câu = từ câu tới biên đầu tiên NGOÀI nháy, sau xuống dòng thật hoặc đã thoát (`\n` của JSON.stringify): dòng
 * stack `    at …`, `Caused by:`, `[errors N]` (logger nối chuỗi cause), ` - detail: `/` - hint: `/` - where: ` (MikroORM
 * nối chi tiết pg vào message — ` - ` cuối TRƯỚC biên này mới là dấu tách lỗi). Literal do client điều khiển có thể chứa
 * `\n    at` nên biên trong nháy không tính. Bộ quét hiểu: `'…'` (kể cả `''`), `E'…'` (thoát bằng `\`), `"định danh"` (dấu
 * `'` bên trong không mở nháy; xuống dòng kết thúc), `$tag$…$tag$` (không đóng → nháy tới hết).
 *
 * Nhận dạng (mọi lượng từ có trần; khoảng trắng tới 64 — SQL viết tay nhiều dòng thụt lề): động từ + định danh (có nháy,
 * kể cả đã thoát `\"`/`\\\"` và `"schema"."bảng"`, hoặc trần) + dấu hiệu cú pháp ngay sau (`(`/`values (`/`select`/`default`
 * cho insert, `set <cột> =`/`set (` cho update, `where`/`using`/`returning` cho delete) để khỏi bắt câu văn ("Insert into
 * "orders" failed", "update the set of…"). `select` cần: lời gọi hàm/số/literal/ngoặc ngay sau (`select pg_advisory…(`),
 * hoặc `from` kế tiếp có định danh trong nháy/`from (`, hoặc `FROM` viết hoa, hoặc (bảng trần) `where <cột> <so sánh>`.
 *
 * Tuyến tính: ứng viên `select` được nhận/loại CHỈ bằng các khớp regex đã nhớ (mỗi mẫu chỉ quét tới); chỉ câu ĐÃ NHẬN mới
 * được quét vùng và luôn bị tiêu thụ tới cuối câu. Thêm trần cứng: tổng ký tự quét ≤ `SCAN_BUDGET × độ dài`; vượt trần →
 * bỏ toàn bộ phần còn lại sau động từ (đóng an toàn).
 *
 * Giới hạn đã biết (còn lọt): (1) SQL KHÔNG kèm ` - <lỗi>` mà có phép trừ ` - ` ngoài nháy (`set "a" = "a" - 5`) — phần
 * sau phép trừ cuối được giữ (thông điệp lỗi knex/MikroORM luôn có ` - <lỗi>`); (2) `select` bảng trần không có `where
 * <so sánh>` ngay sau (`select a from t join u on …`, `where a is null and h = 5`, `where (h = 5)` — chỉ ở SQL viết tay
 * viết thường) không phân biệt được với câu văn; (3) câu đứng một mình không có dấu hiệu: `values (…)` (trùng câu văn
 * "Allowed values ('a')"), `copy`/`truncate`/`lock` (không mang giá trị); (4) `E'…\'…'` viết tay đã qua JSON.stringify
 * (`\\'`) bị hiểu sai biên nháy; (5) phần lỗi sau ` - ` của Postgres (vd `invalid input syntax for type integer: "abc"`)
 * giữ nguyên — chỉ qua các mẫu nội dung chung (`Key (…)=(…)`, `Failing row contains (…)` được băm riêng); (6) trong
 * `Failing row contains (…)` Postgres in giá trị KHÔNG nháy — giá trị text/jsonb chứa dạng biên (`\n    at `, `\n - hint: `,
 * `\nCaused by:`, `\n[errors N]`) cắt hàng sớm, các cột sau biên giữ nguyên (cần vi phạm CHECK/NOT NULL + dữ liệu cố ý
 * soạn; review T-151 vòng 4).
 */
const QIDENT = String.raw`\\{0,7}"[^"\n]{1,128}"`;
const SQL_IDENT = String.raw`(?:${QIDENT}(?:\.${QIDENT})?|[\w.]{1,128})`;
const SQL_COL = String.raw`(?:${QIDENT}|\w{1,128})`;
const SQL_ALIAS = String.raw`(?:\s{1,64}(?:as\s{1,64})?${SQL_IDENT})?`;
const WRITE_STMT = new RegExp(
  String.raw`\b(?:insert\s{1,64}into\s{1,64}${SQL_IDENT}(?:\s{1,64}as\s{1,64}${SQL_IDENT})?(?=\s{0,64}(?:\(|values\s{0,64}\(|select\s|default\s|overriding\s))` +
    String.raw`|update\s{1,64}(?:only\s{1,64})?${SQL_IDENT}${SQL_ALIAS}\s{1,64}set(?=\s{1,64}(?:${SQL_COL}\s{0,64}=|\())` +
    String.raw`|delete\s{1,64}from\s{1,64}(?:only\s{1,64})?${SQL_IDENT}${SQL_ALIAS}(?=\s{1,64}(?:where|using|returning)\s)` +
    String.raw`|merge\s{1,64}into\s{1,64}${SQL_IDENT}${SQL_ALIAS}(?=\s{1,64}using\s)` +
    String.raw`|call\s{1,64}${SQL_IDENT}(?=\s{0,64}\()` +
    // CTE (`with "v" as (values …) insert …`, `WITH hit AS (INSERT …)`): giá trị có thể nằm trước câu ghi.
    String.raw`|with\s{1,64}(?:recursive\s{1,64})?${SQL_IDENT}(?:\s{0,64}\([^()]{0,1024}\))?\s{1,64}as\s{1,64}(?:(?:not\s{1,64})?materialized\s{1,64})?\()`,
  "gi",
);
const SELECT_START = /\bselect\s/gi;
const FROM_RE = new RegExp(String.raw`\sfrom\s{1,64}(?:${SQL_IDENT}|\()`, "gi");
const FROM_QUOTED = /^\sfrom\s{1,64}(?:\\{0,7}"|\()/i;
const FROM_UPPER = /^\sFROM\s/;
const WHERE_RE = /\swhere\s/gi;
/** `where <cột> =|<|>|!=|in (` — dấu hiệu SELECT thật khi bảng không có nháy (khỏi bắt câu văn "…from catalog where price is high"). */
const WHERE_CMP = new RegExp(String.raw`\swhere\s{1,64}${SQL_IDENT}\s{0,64}(?:=|<|>|!=|in\s{0,3}\()`, "iy");
/** Bảng trần: `where` phải ở gần `from` (một tên bảng + vài join) — xa hơn là câu văn. */
const MAX_BARE_WHERE = 2048;
const BOUNDARY_TAIL = String.raw`(?:\s{2,8}at\s|Caused by:|\[errors \d{1,3}\]| - (?:detail|hint|where): )`;
/** Biên vùng sau xuống dòng thật. */
const REGION_BOUNDARY = new RegExp(String.raw`\n${BOUNDARY_TAIL}`, "y");
/** Biên vùng sau xuống dòng đã thoát (`\n` hai ký tự — chuỗi đã qua JSON.stringify). */
const ESCAPED_BOUNDARY = new RegExp(String.raw`\\n${BOUNDARY_TAIL}`, "y");
/** Biên (thật hoặc đã thoát), tìm tới — cho luật `Failing row contains (…)`. */
const ANY_BOUNDARY = new RegExp(String.raw`(?:\n|\\n)${BOUNDARY_TAIL}`, "g");
/** `select` chắc chắn là SQL dù không có `from` nhận ra được: theo sau là lời gọi hàm, số, literal, ngoặc. */
const SELECT_VALUE = /\s{1,64}(?:[\w.]{1,128}\s{0,8}\(|-?\d|'|E'|\$|\()/y;
const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]{0,62})?\$/y;
const IDENT_CHAR = /[A-Za-z0-9_$]/;
const SQL_VALUES_MARK = "[REDACTED]";
/** Trần tổng số ký tự bộ quét vùng được đọc, theo bội số độ dài chuỗi (thực tế ≤ 3 lần/vùng). */
const SCAN_BUDGET = 4;

/** Khớp kế tiếp của regex `g` từ `from`. */
function execFrom(re: RegExp, s: string, from: number): RegExpExecArray | null {
  re.lastIndex = from;
  return re.exec(s);
}

const OUT = 0;
const SINGLE = 1;
const ESCAPED = 2; // E'…'
const DOUBLE = 3;

interface Region {
  /** Biên vùng (ngoài nháy) hoặc hết chuỗi. */
  end: number;
  /** Vị trí ` - ` cuối ngoài nháy trong vùng; −1 nếu không có. */
  sep: number;
  /** `probe` nằm ngoài nháy (dùng để chỉ giữ tên bảng khi `from` thật sự thuộc câu, không nằm trong literal). */
  probeOut: boolean;
}

/** Quét vùng của câu bắt đầu ở `from`. `null` = hết ngân sách (`budget.left`). */
function scanRegion(s: string, from: number, probe: number, budget: { left: number }): Region | null {
  let state = OUT;
  let sep = -1;
  let probeOut = false;
  for (let i = from; i < s.length; i++) {
    if (--budget.left < 0) return null;
    const c = s.charCodeAt(i);
    if (state === SINGLE || state === ESCAPED) {
      if (state === ESCAPED && c === 92) i++;
      else if (c === 39) {
        if (s.charCodeAt(i + 1) === 39) i++;
        else state = OUT;
      }
      continue;
    }
    if (state === DOUBLE) {
      if (c === 34) state = OUT;
      // Định danh không chứa xuống dòng: `"` lẻ (trong phần lỗi) không được nuốt biên vùng phía sau.
      if (c !== 10) continue;
      state = OUT;
    }
    if (i === probe) probeOut = true;
    if (c === 39) {
      const e = s.charCodeAt(i - 1) | 32;
      state = i - 1 >= from && e === 101 && !IDENT_CHAR.test(s[i - 2] ?? "") ? ESCAPED : SINGLE;
    } else if (c === 34) state = DOUBLE;
    else if (c === 36 && !IDENT_CHAR.test(s[i - 1] ?? "")) {
      DOLLAR_TAG.lastIndex = i;
      const m = DOLLAR_TAG.exec(s);
      if (m !== null) {
        const close = s.indexOf(m[0], i + m[0].length);
        budget.left -= (close === -1 ? s.length : close) - i;
        if (budget.left < 0) return null;
        if (close === -1) return { end: s.length, sep, probeOut }; // không đóng → nháy tới hết
        i = close + m[0].length - 1;
      }
    } else if (c === 10) {
      REGION_BOUNDARY.lastIndex = i;
      if (REGION_BOUNDARY.test(s)) return { end: i, sep, probeOut };
    } else if (c === 92 && s.charCodeAt(i + 1) === 110) {
      ESCAPED_BOUNDARY.lastIndex = i;
      if (ESCAPED_BOUNDARY.test(s)) return { end: i, sep, probeOut };
    } else if (c === 32 && s.startsWith(" - ", i)) sep = i;
  }
  return { end: s.length, sep, probeOut };
}

function whereHasComparison(s: string, whereAt: number): boolean {
  WHERE_CMP.lastIndex = whereAt;
  return WHERE_CMP.test(s);
}

/** Cuối câu: ` - ` cuối ngoài nháy (sau `min`) nếu có, không thì biên vùng. */
const stmtEnd = (r: Region, min: number) => (r.sep >= min ? r.sep : r.end);

/**
 * Duyệt `s` MỘT lượt: bỏ thân mọi câu SQL ghi/xoá/select nhận ra được; trả `s` nguyên vẹn nếu không có câu nào.
 */
function scrubSqlValues(s: string): string {
  let write: RegExpExecArray | null | undefined;
  let sel: RegExpExecArray | null | undefined;
  let from: RegExpExecArray | null | undefined;
  let where: RegExpExecArray | null | undefined;
  const fresh = (m: RegExpExecArray | null | undefined, re: RegExp, at: number) =>
    m === undefined || (m !== null && m.index < at) ? execFrom(re, s, at) : m;
  const budget = { left: SCAN_BUDGET * s.length + 1024 };
  let out = "";
  let pos = 0;
  while (pos < s.length) {
    write = fresh(write, WRITE_STMT, pos);
    sel = fresh(sel, SELECT_START, pos);
    if (sel !== null && (write === null || sel.index < write.index)) {
      const at = sel.index;
      const verb = s.slice(at, at + 6);
      from = fresh(from, FROM_RE, at + 6);
      SELECT_VALUE.lastIndex = at + 6;
      const strong = SELECT_VALUE.test(s);
      // `from` thuộc câu ghi phía sau (`… select an option; insert into "t" select … from "u"`) → không phải của select này.
      let fromOk = from !== null && (write === null || from.index < write.index);
      const fromEnd = from === null ? -1 : from.index + from[0].length;
      if (fromOk && !FROM_QUOTED.test(from![0]) && !FROM_UPPER.test(from![0])) {
        where = fresh(where, WHERE_RE, fromEnd);
        fromOk =
          where !== null &&
          where.index - fromEnd < MAX_BARE_WHERE &&
          (write === null || where.index < write.index) &&
          whereHasComparison(s, where.index);
      }
      if (!strong && !fromOk) {
        sel = execFrom(SELECT_START, s, at + 6); // không phải câu SQL → ứng viên kế (không quét vùng)
        continue;
      }
      const r = scanRegion(s, at, fromOk ? from!.index : -1, budget);
      if (r === null) {
        out += `${s.slice(pos, at)}${verb} ${SQL_VALUES_MARK}`;
        pos = s.length;
        break;
      }
      const end = stmtEnd(r, at);
      const tableIn = fromOk && r.probeOut && fromEnd <= end;
      let head = `${verb} ${SQL_VALUES_MARK}`;
      if (tableIn) {
        head += ` ${from![0].slice(1)}`;
        if (/\S/.test(s.slice(fromEnd, end))) head += ` ${SQL_VALUES_MARK}`;
      }
      out += s.slice(pos, at) + head;
      pos = Math.max(end, tableIn ? fromEnd : at + 6);
      continue;
    }
    if (write === null) break;
    const abs = write.index;
    const headEnd = abs + write[0].length;
    const r = scanRegion(s, headEnd, -1, budget);
    out += `${s.slice(pos, abs)}${write[0]} ${SQL_VALUES_MARK}`;
    if (r === null) {
      pos = s.length;
      break;
    }
    pos = Math.max(stmtEnd(r, headEnd), headEnd);
  }
  return out + s.slice(pos);
}

const FAILING_ROW = "Failing row contains (";
/**
 * Chi tiết lỗi CHECK/NOT NULL của Postgres: `Failing row contains (fmm_1, moi, null, 173, 91, …).` chép NGUYÊN hàng (số đo,
 * JSON họ tên/địa chỉ) — có ở `\n - detail:` MikroORM nối vào message và ở trường `detail` riêng của lỗi. Băm từng giá trị
 * (như `Key (…)=(…)`), giữ `null`. Hàng kết thúc ở `)` CUỐI trước biên vùng (giá trị có thể chứa `)`/`, `/xuống dòng);
 * không có `)` → băm tới biên. Tuyến tính: mỗi lần tìm đi tới, lần sau bắt đầu sau phần đã xử lý.
 */
function hashFailingRows(s: string): string {
  let at = s.indexOf(FAILING_ROW);
  if (at === -1) return s;
  let out = "";
  let pos = 0;
  let boundary: RegExpExecArray | null | undefined;
  while (at !== -1) {
    const open = at + FAILING_ROW.length;
    if (boundary === undefined || (boundary !== null && boundary.index < open)) {
      ANY_BOUNDARY.lastIndex = open;
      boundary = ANY_BOUNDARY.exec(s);
    }
    const end = boundary === null ? s.length : boundary.index;
    const close = s.lastIndexOf(")", end - 1);
    const stop = close >= open ? close : end;
    const row = s
      .slice(open, stop)
      .split(", ")
      .map((v) => (v === "null" || v === "" ? v : hashOnce(v)))
      .join(", ");
    out += s.slice(pos, open) + row;
    pos = stop;
    at = s.indexOf(FAILING_ROW, stop);
  }
  return out + s.slice(pos);
}

/** Trần độ dài chuỗi đưa vào bộ che/log (đủ cho stack nhiều tầng cause); phần thừa bị cắt và ghi số ký tự bỏ. */
export const MAX_TEXT = 32_768;

/** Chữ cái đầu hoa hoặc thường: `cap("phường")` → `[Pp]hường`. */
const cap = (w: string) => `[${w[0]!.toUpperCase()}${w[0]!}]${w.slice(1)}`;
const ADMIN_WORDS = [
  "phường",
  "phuong",
  "xã",
  "thị trấn",
  "thi tran",
  "quận",
  "quan",
  "huyện",
  "huyen",
  "thị xã",
  "thi xa",
  "tỉnh",
  "tinh",
  "thành phố",
  "thanh pho",
  "thôn",
  "thon",
  "ấp",
  "xóm",
  "xom",
  "tổ dân phố",
];
const STREET_WORDS = "đường|duong|phố|pho|ngõ|ngo|ngách|ngach|hẻm|hem|kiệt|kiet|thôn|thon|ấp|xóm|xom|tổ";
// Biên trái gồm cả nháy/`=`/`:`/`[` — địa chỉ trong chuỗi SQL, JSON.stringify, util.inspect.
const B = "(?:^|[\\s,('\"\\[])";
/** Cấp hành chính có tên/số theo sau: `Phường Bến Thành`, `quận 1`, `P. Bến Thành`, `Q.1`, `TP.HCM`, `TP Hồ Chí Minh`. */
const ADMIN_STRICT = new RegExp(
  `${B}(?:(?:${ADMIN_WORDS.map(cap).join("|")})\\s{1,4}(?:\\p{Lu}|\\d)|(?:P|Q|H|TX|TP|Tp)\\.\\s?(?:\\p{Lu}|\\d)|TP\\s?(?:HCM|\\p{Lu}))`,
  "u",
);
/** Trong một cụm địa chỉ đã mở: từ khoá hành chính ở bất kỳ dạng nào (kể cả viết thường không dấu). */
const ADMIN_LOOSE = new RegExp(`${B}(?:${ADMIN_WORDS.join("|")}|tp)(?=[\\s\\d.,)]|$)`, "iu");
/** Số nhà + đường/ngõ/hẻm/thôn…: đủ để coi là địa chỉ. */
const STREET_STRONG = new RegExp(
  `${B}(?:(?:số|so|Số|So)\\s{0,3})?\\d{1,6}[a-zA-Z]?(?:\\/\\d{1,6}[a-zA-Z]?){0,4}\\s{1,4}(?:${STREET_WORDS})(?![\\p{L}\\p{N}])`,
  "iu",
);
/** Số nhà + tên viết hoa (`12 Nguyễn Trãi`): chỉ tính khi đứng cạnh một đoạn địa chỉ khác. */
const HOUSE_WEAK = new RegExp(
  `${B}(?:(?:số|Số)\\s{0,3})?\\d{1,6}[a-zA-Z]?(?:\\/\\d{1,6}[a-zA-Z]?){0,4}\\s{1,4}\\p{Lu}\\p{Ll}`,
  "u",
);

/**
 * Địa chỉ VN trong văn bản tự do: tách theo `,`/`;`/xuống dòng. Cụm mở bằng đoạn "chặt" (số nhà + đường, cấp hành chính có
 * tên, số nhà + tên riêng), nối tiếp bằng đoạn chặt hoặc có từ khoá hành chính. Cụm có số nhà + đường, hoặc ≥ 2 đoạn →
 * thay cả cụm bằng `[ADDRESS]`. Một đoạn lẻ kiểu "Thử lại 3 Lần" không bị che.
 */
/** Vị trí bắt đầu địa chỉ trong một đoạn (bỏ ký tự biên mà mẫu `B` nuốt). */
function addressStart(seg: string): number {
  let best = seg.length;
  for (const re of [STREET_STRONG, ADMIN_STRICT, HOUSE_WEAK]) {
    const m = re.exec(seg);
    if (m !== null) {
      const lead = /^[\s,('"[]/.test(m[0]) ? 1 : 0;
      best = Math.min(best, m.index + lead);
    }
  }
  return best;
}

function redactAddress(s: string): string {
  const strict = (p: string) => STREET_STRONG.test(p) || ADMIN_STRICT.test(p) || HOUSE_WEAK.test(p);
  if (!strict(s)) return s;
  const parts = s.split(/([,;\n]{1,16})/);
  const out: string[] = [];
  let i = 0;
  while (i < parts.length) {
    const seg = parts[i]!;
    if (strict(seg)) {
      let j = i + 2;
      let hits = 1;
      let street = STREET_STRONG.test(seg);
      let admin = ADMIN_STRICT.test(seg);
      while (j < parts.length && (strict(parts[j]!) || ADMIN_LOOSE.test(parts[j]!))) {
        street ||= STREET_STRONG.test(parts[j]!);
        admin ||= ADMIN_STRICT.test(parts[j]!) || ADMIN_LOOSE.test(parts[j]!);
        hits += 1;
        j += 2;
      }
      // Hai đoạn "số + Tên" liền nhau ("2 Áo Thun, 1 Quần Jean") chưa đủ — cần thêm cấp hành chính hoặc số nhà + đường.
      if (street || (hits >= 2 && admin)) {
        // Giữ phần chữ đứng trước địa chỉ trong đoạn đầu ("giao: 25/3 hẻm…" → "giao: [ADDRESS]").
        out.push(`${seg.slice(0, addressStart(seg))}[ADDRESS]`);
        i = j - 1; // dấu phân cách ngay sau cụm (nếu có) giữ nguyên
        continue;
      }
      // Cụm không đạt → mọi cụm con bắt đầu muộn hơn cũng không đạt (street/admin/hits chỉ giảm): giữ nguyên cả cụm,
      // nhảy qua — tránh quét lại bậc hai.
      out.push(...parts.slice(i, j - 1));
      i = j - 1;
      continue;
    }
    out.push(seg);
    i += 1;
  }
  return out.join("");
}

/** Che bí mật/PII trong một chuỗi. */
export function redactText(input: string): string {
  let s =
    input.length > MAX_TEXT ? `${input.slice(0, MAX_TEXT)}…[cắt ${input.length - MAX_TEXT} ký tự]` : input;
  s = hashFailingRows(scrubSqlValues(s));
  if (SQL_QUOTED.test(s) || SQL_UPPER.test(s) || looksLikeSelect(s)) {
    const memo = new Map<string, string>(); // literal lặp chỉ băm một lần
    s = s.replace(SQL_LITERAL, (lit) => {
      let h = memo.get(lit);
      if (h === undefined) {
        h = `'${hashOnce(lit.slice(1, -1).replace(/''/g, "'"))}'`;
        memo.set(lit, h);
      }
      return h;
    });
  }
  for (const { re, to } of RULES) {
    s = s.replace(re, to as (m: string, ...g: string[]) => string);
  }
  return redactAddress(s);
}

/**
 * Bản sao đã che của giá trị bất kỳ (object, mảng, Error, chuỗi…). Error → `{ type, message, stack }` đã che (khoá có thể
 * enumerable như `config.headers.authorization` của lỗi HTTP cũng được duyệt).
 */
export function redactLog(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return redactText(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";
  seen.add(value);
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (Array.isArray(value)) return value.map((v) => redactLog(v, depth + 1, seen));
    if (value instanceof Error) {
      const out: Record<string, unknown> = { type: value.name, message: redactText(value.message) };
      if (typeof value.stack === "string") out.stack = redactText(value.stack);
      for (const [k, v] of Object.entries(value)) {
        out[k] = isSensitiveKey(k) ? REDACTED : redactLog(v, depth + 1, seen);
      }
      return out;
    }
    if (value instanceof Map) {
      return redactLog(Object.fromEntries(value), depth, seen);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redactLog(v, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
