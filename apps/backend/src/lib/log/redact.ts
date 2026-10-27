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
 * Giới hạn đã biết: CMND 9 số KHÔNG che theo nội dung (trùng số tiền VND 9 chữ số) — chỉ che theo tên trường; tên người
 * trong văn bản tự do không phát hiện được bằng mẫu → không đưa họ tên vào thông điệp log.
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
const MAX_DEPTH = 10;

const norm = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");

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
];
const PII_KEY_EXACT = new Set(["sdt", "tel", "mobile", "dob", "ten"]);

/** `true` nếu giá trị của trường tên `key` phải che toàn bộ. */
export function isSensitiveKey(key: string): boolean {
  const k = norm(key);
  if (k === "") return false;
  if (SECRET_KEY_EXACT.has(k) || PII_KEY_EXACT.has(k)) return true;
  return SECRET_KEY_PARTS.some((p) => k.includes(p)) || PII_KEY_PARTS.some((p) => k.includes(p));
}

const SECRET_PARAM =
  "password|passwd|pwd|pass|secret|client_secret|token|access_token|refresh_token|id_token|api[_-]?key|apikey|signature|sig|vnp_SecureHash|otp|session(?:_?id)?|sid|code_verifier|authorization|cookie";

interface Rule {
  re: RegExp;
  to: string | ((m: string, ...g: string[]) => string);
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
      `(["']?)\\b(${SECRET_PARAM})\\1(\\s{0,8}[:=]\\s{0,8})((?:(?:Bearer|Basic|Token)\\s{1,8})?(?:"[^"]{0,4096}"|'[^']{0,4096}'|[^&\\s,;"'}]{1,4096}))`,
      "gi",
    ),
    to: (_m, q, key, sep, value) => {
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
      return `${q}${key}${q}${sep}${quote}${REDACTED}${quote}`;
    },
  },
  // Trường PII dạng `address=…` / `"address":"…"` trong văn bản (JSON, query, util.inspect).
  {
    re: /(["']?)\b(address(?:_?[12])?|addr|dia_?chi|street|full_?name|first_?name|last_?name|ho_?ten|phone(?:_?number)?|sdt|email|cccd|cmnd)\1(\s{0,8}[:=]\s{0,8})("[^"]{0,4096}"|'[^']{0,4096}'|[^&,;"'}\n]{1,256})/gi,
    to: (_m, q, key, sep, value) => {
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
      return `${q}${key}${q}${sep}${quote}${REDACTED}${quote}`;
    },
  },
  // Chi tiết lỗi ràng buộc Postgres: `Key (email)=(a@b.vn) already exists.`
  {
    re: /\bKey \(([^()]{1,256})\)=\(([^()]{0,1024})\)/g,
    to: (_m, cols, vals) =>
      `Key (${cols})=(${vals
        .split(/,\s{0,4}/)
        .map(shortHash)
        .join(", ")})`,
  },
  { re: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}/g, to: "[EMAIL]" },
  {
    // Đầu số thẻ (IIN): Visa 4, Mastercard 51–55/22–27, Amex 34/37, JCB 35, Discover 60/65 — tránh dấu thời gian 2026….
    re: /(?<![\p{L}\p{N}])(?:4\d|5[1-5]|2[2-7]|3[457]|6[05])(?:[ -]?\d){11,17}(?![\p{L}\p{N}])/gu,
    to: (m) => (luhn(m.replace(/\D/g, "")) ? "[CARD]" : m),
  },
  { re: /(?<![\p{L}\p{N}])0\d{2}(?:[ .-]?\d{3}){3}(?![\p{L}\p{N}])/gu, to: "[CCCD]" },
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
 * Câu SQL của knex/pg trong thông điệp lỗi (`<sql đã chèn giá trị> - <lỗi>`, knex `compileSqlOnError`): giá trị bind gồm cả
 * SỐ (số đo, tiền gắn người), `null`, JSON — mẫu "chuỗi trong nháy" không bắt được. Nên bỏ NGUYÊN danh sách/điều kiện giá
 * trị: giữ động từ + bảng và phần lỗi sau ` - ` CUỐI trong vùng (trước dòng `    at …` của stack).
 * Nhận dạng bằng mẫu có trần (định danh có nháy: không phân biệt hoa thường; không nháy: chỉ viết HOA — tránh câu tiếng
 * Anh "update the set of…"); mọi lượng từ có trần, tìm biên bằng indexOf/search → tuyến tính.
 */
const SQL_STMT =
  /\b(?:insert\s{1,4}into\s{1,4}"[^"\n]{1,128}"|update\s{1,4}"[^"\n]{1,128}"\s{1,4}set(?=\s)|delete\s{1,4}from\s{1,4}"[^"\n]{1,128}")/i;
const SQL_STMT_UPPER = /\b(?:INSERT INTO \w{1,128}|UPDATE \w{1,128} SET(?=\s)|DELETE FROM \w{1,128})/;
/** Định danh không nháy, viết thường (`knex.raw`/migration tự viết): đòi thêm dấu hiệu cú pháp SQL để khỏi bắt câu tiếng Anh. */
const SQL_STMT_BARE =
  /\b(?:insert\s{1,4}into\s{1,4}[\w.]{1,128}\s{0,4}(?:\(|values\s|select\s|default\s)|update\s{1,4}[\w.]{1,128}\s{1,4}set\s{1,4}\w{1,128}\s{0,4}=|delete\s{1,4}from\s{1,4}[\w.]{1,128}\s{1,4}where\s)/i;
const SQL_WHERE = /\swhere\s/i;
/** `select … from bảng_không_nháy where cột = …` viết thường: đòi điều kiện so sánh sau where để khỏi bắt câu tiếng Anh. */
const SQL_SELECT_BARE =
  /\sfrom\s{1,4}[\w.]{1,128}\s{1,4}where\s{1,4}[\w."]{1,128}\s{0,4}(?:=|<|>|!=|in\s|like\s|is\s|between\s)/i;
const STACK_LINE = /\n\s{2,8}at\s/;
const SQL_VALUES_MARK = "[REDACTED]";

interface Statement {
  start: number;
  head: string;
}

const globalOf = (re: RegExp) => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
const WRITE_STMT_RES = [SQL_STMT, SQL_STMT_UPPER, SQL_STMT_BARE].map(globalOf);
const SELECT_START = /\bselect\s/gi;
const SQL_WHERE_G = globalOf(SQL_WHERE);
const STACK_LINE_G = globalOf(STACK_LINE);

/** Kết quả khớp kế tiếp của `re` từ `from` (đặt lại `lastIndex` — các regex `g` dùng chung chỉ trong hàm này). */
function execFrom(re: RegExp, s: string, from: number): RegExpExecArray | null {
  re.lastIndex = from;
  return re.exec(s);
}

/**
 * Duyệt `s` MỘT lượt (mỗi mẫu quét tới trước, không quét lại từ đầu phần còn lại → tuyến tính kể cả khi có hàng nghìn
 * câu): bỏ giá trị ở mọi câu SQL ghi/xoá và `select … where …`; trả `s` nguyên vẹn nếu không có câu nào.
 */
function scrubSqlValues(s: string): string {
  const hasSelect = looksLikeSelect(s) || SQL_SELECT_BARE.test(s);
  // Bộ nhớ đệm khớp kế tiếp của từng mẫu: chỉ tính lại khi vị trí đã nằm trước `pos`.
  const next: (RegExpExecArray | null | undefined)[] = [];
  let selNext: RegExpExecArray | null | undefined;
  let noWhere = false;
  let out = "";
  let pos = 0;
  while (pos < s.length) {
    let best: Statement | null = null;
    WRITE_STMT_RES.forEach((re, i) => {
      let m = next[i];
      if (m === undefined || (m !== null && m.index < pos)) m = next[i] = execFrom(re, s, pos);
      if (m !== null && (best === null || m.index < best.start))
        best = { start: m.index, head: m[0].replace(/[\s(=]+$/, "") };
    });
    if (hasSelect && !noWhere) {
      if (selNext === undefined || (selNext !== null && selNext.index < pos))
        selNext = execFrom(SELECT_START, s, pos);
      const cur = best as Statement | null;
      if (selNext !== null && (cur === null || selNext.index < cur.start)) {
        const w = execFrom(SQL_WHERE_G, s, selNext.index);
        if (w === null)
          noWhere = true; // không còn where nào phía sau → mọi select tiếp theo cũng không có
        else best = { start: selNext.index, head: s.slice(selNext.index, w.index) };
      }
    }
    const found = best as Statement | null;
    if (found === null) break;
    const abs = found.start;
    const stack = execFrom(STACK_LINE_G, s, abs);
    const regionEnd = stack === null ? s.length : stack.index;
    const sep = s.lastIndexOf(" - ", regionEnd - 3);
    const stmtEnd = sep > abs ? sep : regionEnd;
    out += `${s.slice(pos, abs)}${found.head} ${SQL_VALUES_MARK}`;
    pos = Math.max(stmtEnd, abs + found.head.length);
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
  s = scrubSqlValues(s);
  if (SQL_QUOTED.test(s) || SQL_UPPER.test(s) || looksLikeSelect(s)) {
    const memo = new Map<string, string>(); // literal lặp chỉ băm một lần
    s = s.replace(SQL_LITERAL, (lit) => {
      let h = memo.get(lit);
      if (h === undefined) {
        h = `'${shortHash(lit.slice(1, -1).replace(/''/g, "'"))}'`;
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
