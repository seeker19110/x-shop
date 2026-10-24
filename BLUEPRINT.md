---
title: Blueprint dự án
kind: blueprint
profile: web-app
industries: [ecommerce]
extra: []
scale: M
generated: 2026-10-24
backlog: BLUEPRINT-BACKLOG.md
features: [auth, payment, pii]
---

# Blueprint dự án

> Sinh bởi `xt.py compose` ngày 2026-10-24 — hồ sơ **web-app**, ngành **ecommerce**, quy mô **M**.
> Trạng thái: `[ ]` chưa · `[x]` đạt kèm `— Kiểm: `<lệnh chạy lại được>`` (không có lệnh thì `— Bằng chứng: <file|URL>`)
> · `[~]` kèm `— Không áp dụng: <điều kiện>` hoặc
> `— Miễn: <lý do>` (MUST thêm `Duyệt: "<lời chủ dự án>" <ngày>` hoặc link — LOOP-STOP-024).
> Kiểm tiến độ: `python3 .xtemplates/scripts/xt.py blueprint-status BLUEPRINT.md --strict --run` (còn MUST chưa đạt hoặc lệnh kiểm
> đỏ → exit 1; `loop verify` chạy lại cùng các lệnh trước khi autopilot dừng — LOOP-DESIGN-023).
> File này chỉ chứa MUST ở quy mô M; SHOULD/MAY ở [`BLUEPRINT-BACKLOG.md`](BLUEPRINT-BACKLOG.md) — không chặn verdict, `blueprint-status` đọc cả hai, ghép lại thì mục chuyển file theo ID (ADR-0012).
> Feature: auth, payment, pii — mục thiết yếu của các fact này là MUST ở quy mô M dù ghi `MUST@L`; ghép lại phải truyền lại đúng `--feature` (ADR-0030).

| Mức | Số mục |
|---|---|
| MUST | 490 |
| SHOULD | 1353 |

### Cấu hình, biến môi trường và bí mật

Nguồn khung: [`01-baseline/configuration-and-secrets.md`](.xtemplates/framework/01-baseline/configuration-and-secrets.md)

- [ ] `BASE-CFG-001` **MUST** Mọi giá trị thay đổi theo môi trường (URL, cổng, khoá, cờ) đọc từ **biến môi trường** (hoặc file được inject lúc chạy), không hard-code trong mã hay commit vào repo. → Kiểm: grep mã không có URL CSDL/host nội bộ/khoá dạng literal; app chạy được chỉ với env + mã. · Nguồn: 12-factor III
- [ ] `BASE-CFG-002` **MUST** Cấu hình được **validate lúc khởi động** bằng schema (kiểu, bắt buộc/tuỳ chọn, phạm vi, định dạng URL); thiếu hoặc sai → thoát với mã ≠ 0 và thông báo nêu **tên biến** (không in giá trị). → Kiểm: khởi động với env trống → exit ≠ 0, stderr liệt kê biến thiếu; test đơn vị cho schema; grep `process.env.`/`os.environ[` ngoài module env = 0. · Nguồn: catalog 09 §1.4 (validate env bằng zod); ASVS 5.0 V13; 12-factor III
- [ ] `BASE-CFG-003` **MUST** Có `.env.example` (hoặc file tương đương) commit, liệt kê **mọi** biến với mô tả và giá trị giả; `.env`, `.env.*.local`, `*.pem`, `*.key` nằm trong `.gitignore`. → Kiểm: CI so khớp tập khoá trong `.env.example` với schema (lệch = đỏ); `git ls-files .env` rỗng; `git check-ignore .env` trả `.env`. · Nguồn: 12-factor III; OWASP Secrets Management CS
- [ ] `BASE-CFG-005` **MUST** Object cấu hình khi in/dump (`--print-config`, log khởi động, trang debug, `repr`/`toString`) **che trường bí mật**; schema đánh dấu trường nào là bí mật. Nguyên tắc "bí mật không vào log/lỗi/URL": xem [`SEC-SECRET-007`](.xtemplates/framework/12-security/secrets-management.md) và [`BASE-ERR-007`](.xtemplates/framework/01-baseline/errors-and-logging.md). → Kiểm: test `JSON.stringify(config)`/`repr(settings)` cho `***` ở mọi trường bí mật. · Nguồn: OWASP Logging CS
- [ ] `BASE-CFG-006` **MUST** Bí mật không truyền qua **tham số dòng lệnh** (lộ trong `ps`, lịch sử shell); nhận qua env, file (`--token-file`), hoặc stdin. → Kiểm: CLI không có cờ `--password <value>`; tài liệu nêu cách truyền an toàn. · Nguồn: clig.dev (Secrets); OWASP Secrets Management CS
- [ ] `BASE-CFG-007` **MUST** Phần mềm có tuỳ chọn mạng/bảo mật (dịch vụ, ứng dụng, CLI gọi mạng): giá trị mặc định của các tuỳ chọn đó là **an toàn**: `DEBUG` tắt, bind `127.0.0.1`, TLS verify bật, CORS đóng, không khoá mặc định; prod không phụ thuộc "ai đó nhớ đổi". → Kiểm: khởi động không đặt biến tuỳ chọn → cấu hình hiệu lực được in (đã che) khớp bảng mặc định an toàn trong tài liệu. · Nguồn: P7; catalog 12 §3i
- [ ] `BASE-CFG-008` **MUST** Ứng dụng có bundle phía client (web/mobile/desktop): biến môi trường được **phân loại** hai lớp: công khai (được nhúng vào client/bundle, vd tiền tố `NEXT_PUBLIC_`/`VITE_`/`PUBLIC_`/`EXPO_PUBLIC_`) và bí mật (chỉ server); không bí mật nào (service key, secret, token, mật khẩu) có tiền tố công khai. → Kiểm: schema env tách `client`/`server` (vd `@t3-oss/env-nextjs`) làm build đỏ khi lệch; lint tên: tiền tố công khai + tên chứa `SECRET|KEY|TOKEN|PASSWORD` (trừ allowlist) → đỏ; quét bundle `dist/`/`.next/static` bằng gitleaks/pattern (`sk_live|service_role|AKIA|-----BEGIN`) = 0. · Nguồn: catalog 09 §1.4; Next.js env docs; Vite env docs

### Đúng dữ liệu: thời gian, tiền, đơn vị, mã hoá ký tự, ca biên

Nguồn khung: [`01-baseline/data-correctness.md`](.xtemplates/framework/01-baseline/data-correctness.md)

- [ ] `BASE-DATA-001` **MUST** Mọi file mã nguồn, cấu hình, template và dữ liệu văn bản là UTF-8 (không BOM, trừ nơi bắt buộc); CSDL và kết nối khai báo UTF-8 (`utf8mb4`/`UTF8`); HTTP response có `charset=utf-8`. → Kiểm: `.editorconfig` `charset = utf-8`; `file --mime-encoding` trên repo không có `iso-8859`/`utf-16`; test tích hợp lưu và đọc lại chuỗi `"Tiếng Việt 🇻🇳"` nguyên vẹn. · Nguồn: RFC 8259 §8.1; W3C i18n (UTF-8 declarations)
- [ ] `BASE-DATA-002` **MUST** Chuỗi do người nhập được **chuẩn hoá NFC ở biên trước khi lưu** (sàn mọi quy mô); so sánh làm khoá (NFC + case-fold) và sắp xếp theo locale theo [`XC-UNITS-012`](.xtemplates/framework/18-cross-cutting/units-time-and-money.md). → Kiểm: test: `"Việt"` dạng NFD và NFC nhập vào được lưu thành cùng một chuỗi NFC; `unicodedata.normalize`/`String.prototype.normalize`/`golang.org/x/text/unicode/norm` xuất hiện ở lớp validate. · Nguồn: UAX #15 (rev. 58, Unicode 18.0.0); OWASP Input Validation CS (normalization)
- [ ] `BASE-DATA-003` **MUST** Phân biệt **thiếu** (`null`/`None`/`undefined`), **rỗng** (`""`, `[]`) và **0/false** trong kiểu dữ liệu, schema CSDL và API; không dùng `||`/`or` để lấy mặc định cho giá trị có thể hợp lệ là 0/rỗng. → Kiểm: lint `strict-boolean-expressions`/`prefer-nullish-coalescing` (TS), `pyright strictOptional`; test cho đầu vào `0`, `""`, `[]`, `null` ở mỗi trường số/chuỗi/danh sách tuỳ chọn. · Nguồn: khung cũ `quality-supplements.md` N2 §6
- [ ] `BASE-DATA-005` **MUST** Sàn mọi quy mô cho tiền: **không bao giờ float/double**, luôn kèm mã ISO 4217; cách biểu diễn (mặc định số nguyên đơn vị nhỏ nhất, decimal scale cố định chỉ khi có ADR), làm tròn và phân bổ theo [`XC-UNITS-005`](.xtemplates/framework/18-cross-cutting/units-time-and-money.md) đến `XC-UNITS-007`. → Kiểm: schema CSDL không có cột tiền kiểu `FLOAT/REAL/DOUBLE`; lint cấm `parseFloat`/`float(` ở module tiền. · Nguồn: [`XC-UNITS-005`](.xtemplates/framework/18-cross-cutting/units-time-and-money.md)
- [ ] `BASE-DATA-006` **MUST** Sàn mọi quy mô cho thời gian: thời điểm lưu/trao đổi bằng **UTC** với kiểu có múi giờ, định dạng RFC 3339; múi giờ IANA, sự kiện tương lai, đồng hồ đơn điệu theo [`XC-UNITS-001`](.xtemplates/framework/18-cross-cutting/units-time-and-money.md) đến `XC-UNITS-004`. → Kiểm: schema không có `timestamp without time zone` cho thời điểm; lint cấm `datetime.now()` naive/`new Date().toString()` ở lớp lưu. · Nguồn: [`XC-UNITS-001`](.xtemplates/framework/18-cross-cutting/units-time-and-money.md)
- [ ] `BASE-DATA-008` **MUST** Sàn mọi quy mô: thao tác ghi có thể bị gửi lại (tạo đơn/thanh toán, webhook, job, tool của agent) là **idempotent** — nhận lại cùng yêu cầu → cùng kết quả, không tạo bản ghi/tính tiền thứ hai; cơ chế (khoá idempotency, `UNIQUE`) theo [`ARC-INT-001`](.xtemplates/framework/05-architecture/integration-patterns.md). → Kiểm: test gửi cùng request hai lần (và đồng thời) → một bản ghi, cùng response. · Nguồn: [`ARC-INT-001`](.xtemplates/framework/05-architecture/integration-patterns.md); catalog 23 §4.1 (SePay HMAC + idempotent)
- [ ] `BASE-DATA-009` **MUST** Sàn mọi quy mô: thao tác nhiều bước trên dữ liệu là **tất cả hoặc không** — transaction CSDL trong một kho; xuyên kho/dịch vụ hoặc có tác động ra ngoài thì outbox/saga có bù trừ theo [`ARC-INT-003`](.xtemplates/framework/05-architecture/integration-patterns.md) và `ARC-INT-006`; không để trạng thái nửa vời. → Kiểm: test giả lỗi ở bước giữa → không có bản ghi mồ côi. · Nguồn: P3; [`../09-database/transactions-and-consistency.md`](.xtemplates/framework/09-database/transactions-and-consistency.md)
- [ ] `BASE-DATA-010` **MUST** Ràng buộc nhất quán quan trọng (duy nhất, khoá ngoại, không âm, enum) được **CSDL/kho** thực thi, không chỉ ở mã ứng dụng. → Kiểm: schema/migration có `UNIQUE`, `FK`, `CHECK`; test chèn vi phạm trực tiếp vào CSDL bị từ chối. · Nguồn: [`../09-database/data-modeling.md`](.xtemplates/framework/09-database/data-modeling.md)

### Phụ thuộc: lockfile, cập nhật, license, lỗ hổng

Nguồn khung: [`01-baseline/dependencies.md`](.xtemplates/framework/01-baseline/dependencies.md)

- [ ] `BASE-DEP-001` **MUST** Mọi phụ thuộc khai báo trong manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `*.csproj`) và **lockfile được commit** (`package-lock.json`/`pnpm-lock.yaml`, `uv.lock`/`requirements.txt` có hash, `go.sum`, `Cargo.lock`, `packages.lock.json`). → Kiểm: `git ls-files` có lockfile; `.gitignore` không chứa lockfile; CI đỏ nếu thiếu. · Nguồn: 12-factor II
- [ ] `BASE-DEP-002` **MUST** CI và build sản phẩm cài **đóng băng** từ lockfile; manifest lệch lockfile → thất bại, không tự sửa lockfile. → Kiểm: workflow dùng `npm ci`/`--frozen-lockfile`/`--locked`/`--require-hashes`/`-mod=readonly`; test: sửa manifest không cập nhật lock → CI đỏ. · Nguồn: npm ci docs; pip secure installs; Go modules reference (`-mod=readonly`)
- [ ] `BASE-DEP-003` **MUST** Runtime/ngôn ngữ dùng phiên bản còn **được hỗ trợ bảo mật** (Node 22/24 LTS, Python ≥ 3.11, Go hai bản mới nhất, .NET 8/10 LTS, Java LTS…) và được ghim trong file phiên bản; không phụ thuộc runtime cài sẵn. → Kiểm: `.nvmrc`/`.python-version`/`mise.toml`/`go.mod go` tồn tại; CI đối chiếu với `https://endoflife.date/api/<product>.json` (`eol` > hôm nay + 90 ngày) hằng tuần. · Nguồn: endoflife.date API; nodejs.org previous releases; devguide.python.org versions
- [ ] `BASE-DEP-004` **MUST** Quét lỗ hổng phụ thuộc trong CI trên **mỗi PR** và **theo lịch** (ít nhất hằng tuần); mức high/critical chưa xử lý chặn merge; ngoại lệ ghi file có `cve`, `reason`, `approved_by`, `expires`. → Kiểm: `osv-scanner scan source -r . --config osv-scanner.toml` exit 0; file ngoại lệ không có mục quá hạn (script kiểm). · Nguồn: OWASP Vulnerable Dependency Management CS; OpenSSF Badge `vulnerabilities_fixed_60_days`
- [ ] `BASE-DEP-005` **MUST** License của mọi phụ thuộc (kể cả transitive) được **biết** và nằm trong allowlist; gói không rõ license hoặc copyleft/không OSI phải có quyết định ghi lại trước khi dùng. → Kiểm: `license-checker`/`pip-licenses`/`go-licenses`/`cargo deny check licenses` với allowlist trong repo = 0 vi phạm; ngoại lệ ở `license-exceptions.json` có `approved_by`/`expires`. · Nguồn: [`../16-compliance-privacy/licensing-and-ip.md`](.xtemplates/framework/16-compliance-privacy/licensing-and-ip.md); catalog 23 §2.5
- [ ] `BASE-DEP-006` **MUST** Trước khi thêm phụ thuộc mới: kiểm repo không archive, có bảo trì trong 12 tháng, license hợp lệ, không bật telemetry gửi dữ liệu mặc định, có cách thay thế trong stdlib hay không; ghi một dòng lý do trong PR. → Kiểm: PR template có mục "Phụ thuộc mới: tên · license · lý do · thay thế đã xét"; CI so `git diff origin/<base> -- <lockfile>`, có gói mới mà mục "Phụ thuộc mới" trong mô tả PR trống → đỏ. · Nguồn: evidence-and-sources.md luật 7; catalog README §18, §21
- [ ] `BASE-DEP-007` **MUST** Cập nhật phụ thuộc **tự động và có nhịp**: Dependabot/Renovate bật cho mọi hệ sinh thái trong repo (gói, `github-actions`, `docker`), gom nhóm minor/patch, giới hạn số PR mở. → Kiểm: `.github/dependabot.yml` (`version: 2`) hoặc `renovate.json` liệt kê đủ `package-ecosystem` có trong repo; có PR bot trong 30 ngày gần nhất. · Nguồn: Dependabot configuration options; Scorecard Dependency-Update-Tool
- [ ] `BASE-DEP-008` **MUST** Phụ thuộc tải lúc build/CI (action, base image, binary, model) được ghim theo **SHA/digest/checksum**, không chỉ tag; chi tiết và SBOM ở [`../12-security/supply-chain.md`](.xtemplates/framework/12-security/supply-chain.md). → Kiểm: `pinact run --check`; `FROM image@sha256:`; `sha256sum -c` cho binary tải về. · Nguồn: GitHub Actions security hardening; Scorecard Pinned-Dependencies
- [ ] `BASE-DEP-009` **MUST** Quét lỗ hổng **image/container và hệ điều hành** (không chỉ gói ngôn ngữ) cho artefact triển khai. → Kiểm: `trivy image`/`grype` trong CI build image, 0 high/critical chưa duyệt. · Nguồn: OWASP Vulnerable Dependency Management CS (Trivy, Grype)

### Tài liệu tối thiểu (README · runbook · ADR · CHANGELOG)

Nguồn khung: [`01-baseline/documentation-minimum.md`](.xtemplates/framework/01-baseline/documentation-minimum.md)

- [ ] `BASE-DOC-001` **MUST** `README.md` ở gốc có các mục: mô tả một đoạn (vấn đề + cho ai), yêu cầu môi trường (runtime + phiên bản), cách cài & chạy, cách chạy test, cấu hình cần đặt (trỏ `.env.example`), cách đóng góp/liên hệ, license. → Kiểm: script kiểm tồn tại heading theo danh sách (`check:readme`); lệnh cài/chạy/test trong README được CI thực thi (xem BASE-DOC-005). · Nguồn: OpenSSF Badge `documentation_basics`; GitHub community profile
- [ ] `BASE-DOC-003` **MUST** Quyết định kiến trúc/công nghệ quan trọng có **ADR** trong `docs/adr/` theo mẫu [`../templates/ADR.md`](.xtemplates/framework/templates/ADR.md) (MADR 4.0.0: bối cảnh, lựa chọn đã xét, quyết định, hệ quả); ADR cũ không sửa, đổi ý thì viết ADR mới "supersedes". → Kiểm: `ls docs/adr/*.md` ≥ 1 (ADR chọn stack); mỗi file có các heading bắt buộc; chi tiết [`../05-architecture/decision-records.md`](.xtemplates/framework/05-architecture/decision-records.md). · Nguồn: MADR 4.0.0; lifecycle.md G2
- [ ] `BASE-DOC-004` **MUST** Phần mềm được triển khai có **runbook**: cách deploy/rollback, lệnh chẩn đoán, cảnh báo nào nghĩa là gì, liên hệ trực, bí mật nằm ở đâu (không phải giá trị). → Kiểm: `docs/RUNBOOK.md` (hoặc `docs/ops/`) tồn tại theo mẫu; mỗi alert trong cấu hình alert có mục tương ứng trong runbook. · Nguồn: [`../15-operations/incident-response.md`](.xtemplates/framework/15-operations/incident-response.md); OpenSSF Badge `documentation_basics`
- [ ] `BASE-DOC-005` **MUST** Lệnh "cài → chạy → test" trong README được **CI chạy thật** từ clone sạch (smoke) để tài liệu không lệch mã. → Kiểm: job CI `readme-smoke` thực thi đúng các lệnh (trích từ block ```bash có nhãn hoặc từ `xt.yaml`/`runtime.yaml`), exit 0. · Nguồn: P1; evidence-and-sources.md luật 5
- [ ] `BASE-DOC-006` **MUST** Liên kết nội bộ trong tài liệu trỏ tới file có thật; liên kết ngoài không chết. → Kiểm: `lychee --offline` (nội bộ, chặn merge) + `lychee` có mạng (cron, cảnh báo) = 0 lỗi. · Nguồn: conventions.md §7
- [ ] `BASE-DOC-007` **MUST** Tài liệu mô tả **giao diện bên ngoài** (API/CLI/SDK/định dạng file/sự kiện) được **sinh từ nguồn sự thật** (OpenAPI/proto/docstring/`--help`) hoặc kiểm khớp bằng test; không có bảng tham số viết tay riêng. → Kiểm: CI chạy generator tài liệu (OpenAPI, `--help`, typedoc…) rồi `git diff --exit-code` trên thư mục docs được sinh. · Nguồn: OpenSSF Badge `documentation_interface`; P5
- [ ] `BASE-DOC-008` **MUST** Có file trạng thái dự án (`PROGRESS.md` theo [`../templates/PROGRESS.md`](.xtemplates/framework/templates/PROGRESS.md), ≤ 8 KB, 4 mục) để phiên sau tiếp tục; SHA/ngày ghi trong đó phải là tổ tiên của HEAD. → Kiểm: `xt.py progress-check` chạy trong CI. Mục sàn; luật đầy đủ ở nhà [`LOOP-HARNESS-004`/`005`](.xtemplates/framework/11-autonomous-loop/harness-files.md). · Nguồn: catalog 21 §8 điểm 9, 23 §2.1

### Xử lý lỗi và ghi log có cấu trúc

Nguồn khung: [`01-baseline/errors-and-logging.md`](.xtemplates/framework/01-baseline/errors-and-logging.md)

- [ ] `BASE-ERR-001` **MUST** Không có lỗi bị nuốt: không `catch {}` rỗng, không `except: pass`, không `_ = err`, không `.catch(() => {})`; mỗi nhánh bắt lỗi hoặc xử lý, hoặc chuyển tiếp có ngữ cảnh, hoặc ghi log mức phù hợp. → Kiểm: lint (`no-empty`, ruff `S110`/`BLE001`, `errcheck`, `clippy::let_underscore_must_use`) 0 vi phạm; grep `except:\s*pass|catch\s*\(\w*\)\s*\{\s*\}` rỗng. · Nguồn: OWASP Error Handling CS
- [ ] `BASE-ERR-002` **MUST** Có **handler lỗi toàn cục** (middleware/exception handler/`process.on('unhandledRejection')`/`sys.excepthook`/`recover` ở biên goroutine) ghi log đầy đủ và trả phản hồi chung; tiến trình không chết im lặng. → Kiểm: server: test gây exception chưa bắt → log `ERROR` kèm stack, phản hồi 500/RFC 9457 kèm `trace_id`, không stack trong phản hồi, handler tiếp tục; CLI/thư viện: test lỗi → exit ≠ 0 + một dòng stderr dễ hiểu, stack chỉ khi bật `--debug`/biến debug. · Nguồn: OWASP Error Handling CS; ASVS 5.0 V16
- [ ] `BASE-ERR-003` **MUST** Phản hồi lỗi cho người dùng **không chứa** stack trace, đường dẫn, phiên bản framework, câu SQL, tên bảng, địa chỉ nội bộ; có **mã tham chiếu** (request/trace id) để tra log. → Kiểm: server: test 500 và 4xx → body RFC 9457 kèm `trace_id`, không khớp regex `(Traceback|at .*\.(js|py|java)|SELECT |/home/|/var/)`; CLI/thư viện: test lỗi → exit ≠ 0 + một dòng stderr dễ hiểu (không khớp regex trên), stack chỉ khi bật `--debug`/biến debug. · Nguồn: OWASP Error Handling CS; ASVS 5.0 V16; CWE-209
- [ ] `BASE-ERR-004` **MUST** Mọi lời gọi ra ngoài (HTTP, CSDL, queue, tiến trình con, tool) có **timeout tường minh**; không có lời gọi mạng không timeout. → Kiểm: grep client/driver cấu hình `timeout`; test với server treo → lỗi timeout trong giới hạn. · Nguồn: [`../08-backend/reliability-and-errors.md`](.xtemplates/framework/08-backend/reliability-and-errors.md)
- [ ] `BASE-ERR-005` **MUST** Dịch vụ chạy dài/server: log ở dạng **có cấu trúc** (một JSON/dòng) ra **stdout**, không tự ghi/xoay file, không gửi thẳng tới dịch vụ bên ngoài từ mã ứng dụng. CLI: theo [`PRF-CLI-003`](.xtemplates/framework/02-profiles/cli-tool.md) (stdout dữ liệu, stderr thông báo). → Kiểm: chạy app, `head -1 | jq .` parse được; không có `FileHandler`/`fs.appendFile` cho log trong mã sản phẩm. · Nguồn: 12-factor XI
- [ ] `BASE-ERR-006` **MUST** Dịch vụ chạy dài/server: mỗi bản ghi có tối thiểu: `timestamp` RFC 3339 UTC (`Z`, độ phân giải ≥ ms), `level` (tên + số theo OTel), `message`, `service`, `version`, `env`; với request: `request_id`/`trace_id`, `span_id`. CLI: theo [`PRF-CLI-003`](.xtemplates/framework/02-profiles/cli-tool.md) (stdout dữ liệu, stderr thông báo). → Kiểm: test schema log (JSON Schema) trên mẫu log từ test tích hợp; 100 % bản ghi hợp lệ. · Nguồn: OTel Logs Data Model; OWASP Logging CS (when/where/who/what)
- [ ] `BASE-ERR-007` **MUST** Không ghi vào log: mật khẩu, token/session id, API key, khoá mã hoá, chuỗi kết nối, số thẻ, dữ liệu sức khoẻ/giấy tờ định danh; PII thường (email, tên) chỉ khi cần và đã pseudonymize. → Kiểm: redaction cấu hình tại logger (pino `redact`, structlog processor) cho các khoá `password|token|authorization|cookie|secret|key`; test ghi object có `password` → log hiện `[REDACTED]`; gitleaks quét mẫu log CI. · Nguồn: OWASP Logging CS (data to exclude); ASVS 5.0 V16
- [ ] `BASE-ERR-008` **MUST** Dữ liệu từ bên ngoài đưa vào log được **encode/escape** (loại CR/LF, ký tự điều khiển) để chống log injection; log không bao giờ được render như HTML. → Kiểm: test ghi chuỗi chứa `\n[ERROR] fake` → một bản ghi JSON duy nhất, chuỗi nằm trong trường, không tạo dòng mới. · Nguồn: OWASP Logging CS (log injection); CWE-117
- [ ] `BASE-ERR-009` **MUST** Ngoại lệ ghi log kèm `exception.type`, `exception.message`, `exception.stacktrace` (tên trường theo OTel) và **chuỗi nguyên nhân** (`cause`/`__cause__`/`%w`) không bị cắt. → Kiểm: test ném lỗi bọc lỗi → log có đủ ba trường và nguyên nhân gốc. · Nguồn: OTel semconv exceptions (Stable)
- [ ] `BASE-ERR-010` **MUST** Lỗi ở **cổng bảo mật** (auth, authz, validate, chữ ký) → **thất bại đóng**: từ chối, không fallback cho qua; lỗi phụ thuộc không quan trọng → degrade có kiểm soát và ghi log. → Kiểm: test giả lỗi backend auth → 401/403, không 200; danh sách điểm fail-open (nếu có) ghi trong THREAT-MODEL kèm lý do. · Nguồn: P7 (principles.md)
- [ ] `BASE-ERR-011` **MUST** Lỗi mức `ERROR`/`FATAL` được **thu thập và cảnh báo** (Sentry/GlitchTip/OTel collector → alert) trong vòng phút; không "mù" trên production. → Kiểm: tạo lỗi thử trên staging → alert đến kênh trực; chi tiết ở [`../15-operations/slo-and-alerting.md`](.xtemplates/framework/15-operations/slo-and-alerting.md). · Nguồn: P10

### Cổng chất lượng tối thiểu (lint · format · type · test · CI)

Nguồn khung: [`01-baseline/quality-gates.md`](.xtemplates/framework/01-baseline/quality-gates.md)

- [ ] `BASE-GATE-001` **MUST** Có đúng năm lệnh chuẩn `format` · `lint` · `typecheck` · `test` · `build` (hoặc tương đương của ngôn ngữ) được khai báo ở **một** nơi máy đọc được (`package.json#scripts`, `Makefile`, `justfile`, `noxfile`, `runtime.yaml`); mỗi lệnh có trong `xt.yaml`, lệnh không áp dụng ghi `""` kèm chú thích lý do. Nhà của bộ khoá `xt.yaml`: [`LOOP-HARNESS-008`](.xtemplates/framework/11-autonomous-loop/harness-files.md) — `scripts/dev-task.sh` chạy các khoá `format · lint · typecheck · test · build · format_file` (`gate` = build → typecheck → lint → test; `lint` nên gồm kiểm format); CI mẫu gọi thêm `e2e` qua dev-task (D-115); khoá khác (`install`, `dev`, `migrate`, `init`, `smoke`…) agent đọc và chạy trực tiếp. → Kiểm: `xt.yaml` có đủ năm khoá, khoá `""` có chú thích lý do; chạy từng lệnh không rỗng từ clone sạch, exit 0; tên lệnh được CI và hook gọi nguyên văn (grep workflow). · Nguồn: 12-factor II; catalog 23 §3.3 (`runtime.yaml`)
- [ ] `BASE-GATE-002` **MUST** Formatter chạy ở chế độ kiểm (`--check`) trong CI và chế độ sửa ở hook; định dạng là **tất định** (cùng input → cùng output). → Kiểm: CI `format --check` exit 0; chạy `format` hai lần không tạo diff. · Nguồn: OpenSSF Badge `warnings`
- [ ] `BASE-GATE-003` **MUST** Linter chạy với **0 cảnh báo** (cảnh báo = lỗi) trên toàn repo; rule tắt phải có comment lý do tại chỗ hoặc trong config. → Kiểm: `lint` exit 0 với `--max-warnings 0` / `-D warnings` / `TreatWarningsAsErrors`; grep `eslint-disable|noqa|#nosec|allow(` không có dòng thiếu lý do. · Nguồn: OpenSSF Badge `warnings_fixed`, `warnings_strict`
- [ ] `BASE-GATE-004` **MUST** Type-checker ở chế độ nghiêm (nếu ngôn ngữ có): TypeScript `strict: true`, không `any` ngầm; pyright/mypy `strict`; Rust `clippy -D warnings`; Go `go vet`. → Kiểm: file config có cờ nghiêm; `typecheck` exit 0 trong CI. · Nguồn: khung cũ `01-process-and-standards.md` nguyên tắc 2
- [ ] `BASE-GATE-005` **MUST** Có bộ test tự động chạy bằng một lệnh, **tất định** (không phụ thuộc giờ máy, mạng, thứ tự) và CI chạy **toàn bộ** trên mỗi PR. → Kiểm: `test` exit 0; chạy 3 lần liên tiếp cùng commit cho cùng kết quả; CI không có `continue-on-error` ở bước test. · Nguồn: OpenSSF Badge `test`, `test_continuous_integration`
- [ ] `BASE-GATE-006` **MUST** CI chạy lại **mọi** cổng của hook cục bộ (hook có thể bị `--no-verify`); không có cổng nào chỉ tồn tại ở máy dev. → Kiểm: đối chiếu danh sách hook trong `.pre-commit-config.yaml`/`lefthook.yml` với bước trong workflow CI — mỗi hook có bước CI tương ứng. · Nguồn: pre-commit docs (CI); catalog 13 §4c
- [ ] `BASE-GATE-007` **MUST** Nhánh mặc định yêu cầu CI xanh (required status check) trước khi merge, và lỗi do **kết hợp** hai PR (mỗi PR xanh riêng) bị bắt trước khi tới môi trường deploy, theo một trong hai cách: (a) "up to date" với nhánh đích trước khi merge (`strict_required_status_checks_policy: true` — merge tuần tự, mỗi merge buộc PR khác cập nhật và chạy lại CI); hoặc (b) — mặc định của mẫu dự án đích, cho PR merge song song (D-116) — `strict: false` kèm CI chạy lại trên mỗi push nhánh mặc định, deploy (nếu có) chỉ từ commit có CI xanh trên nhánh đó, nhánh mặc định đỏ thì sửa/revert trước khi merge PR khác. → Kiểm: ruleset JSON có `required_status_checks`; nếu `strict_required_status_checks_policy: false` thì workflow CI có `push: branches: [main]`. · Nguồn: GitHub rulesets; Scorecard Branch-Protection, CI-Tests; D-116
- [ ] `BASE-GATE-008` **MUST** Build từ clone sạch (`git clone` → cài phụ thuộc đóng băng → `build`) thành công trong CI; không phụ thuộc file cục bộ hay cache có sẵn để xanh. → Kiểm: job CI dùng runner mới, không `continue-on-error`; `build` exit 0. · Nguồn: 12-factor II, V
- [ ] `BASE-GATE-009` **MUST** Thay đổi **cấu hình cổng** (lint/type/coverage/CI/hook/ruleset) đi PR riêng, có lý do trong mô tả; agent tự động không được tự nới. → Kiểm: hook PreToolUse/CODEOWNERS yêu cầu review người cho đường dẫn `eslint.config.*`, `tsconfig*.json`, `pyproject.toml[tool.*]`, `.github/workflows/**`, `.pre-commit-config.yaml`. · Nguồn: catalog 12 §3, 23 §4.3 ("làm cổng xanh bằng nới cấu hình")
- [ ] `BASE-GATE-010` **MUST** CI chạy trên runner có `permissions:` tối thiểu (`contents: read` mặc định) và action bên thứ ba ghim theo SHA đầy đủ. → Kiểm: `actionlint` + `pinact run --check` exit 0; mọi workflow có khối `permissions:` cấp đầu. · Nguồn: GitHub Actions security hardening; chi tiết ở [`../12-security/supply-chain.md`](.xtemplates/framework/12-security/supply-chain.md)
- [ ] `BASE-GATE-019` **MUST** Ruleset nhánh mặc định không có ai (kể cả admin/bot) trong bypass list; review bắt buộc trước merge theo [`WF-GIT-011`](.xtemplates/framework/10-workflow/git-and-branching.md). → Kiểm: ruleset JSON có `bypass_actors: []` (ruleset dạng code theo `WF-GIT-002`). · Nguồn: GitHub rulesets; Scorecard Branch-Protection

### Repo, phiên bản và lịch sử thay đổi

Nguồn khung: [`01-baseline/repo-and-versioning.md`](.xtemplates/framework/01-baseline/repo-and-versioning.md)

- [ ] `BASE-REPO-001` **MUST** Toàn bộ mã nguồn, cấu hình, migration, tài liệu, script build/CI nằm trong một repo Git có remote; không có "file chỉ ở máy tôi". → Kiểm: `git ls-files` liệt kê đủ các file cần để build từ clone mới; CI build từ `git clone` sạch xanh. · Nguồn: 12-factor I (Codebase)
- [ ] `BASE-REPO-002` **MUST** Có `.gitignore` phù hợp stack; không commit artefact build, `node_modules/`, `.venv/`, file IDE, file `.env*` chứa giá trị thật. → Kiểm: `git ls-files | grep -E '(^|/)(node_modules|dist|build|\.venv)/|(^|/)\.env($|\.)' | grep -vE '(^|/)\.env\.example$'` ra 0 dòng (`.env.example` được commit theo [`BASE-CFG-003`](.xtemplates/framework/01-baseline/configuration-and-secrets.md)); hook pre-commit chặn file bị ignore. · Nguồn: 12-factor III
- [ ] `BASE-REPO-003` **MUST** Có `.gitattributes` với `* text=auto` (và `eol=lf` cho script shell) để line ending không khác nhau giữa Windows/macOS/Linux. → Kiểm: file `.gitattributes` tồn tại; `git ls-files --eol | grep 'w/crlf'` chỉ ra file được khai báo `eol=crlf` tường minh. · Nguồn: git gitattributes `text`/`eol`
- [ ] `BASE-REPO-004` **MUST** Có file `LICENSE` ở gốc (kể cả repo riêng tư: ghi rõ "Proprietary"/chủ sở hữu) và trường license trong manifest gói khớp với file. → Kiểm: `LICENSE` tồn tại; `package.json`/`pyproject.toml`/`Cargo.toml` có `license` là SPDX id (hoặc `UNLICENSED`/`LicenseRef-Proprietary`) khớp. · Nguồn: SPDX License List 3.29.0; OpenSSF Badge `license_location`
- [ ] `BASE-REPO-005` **MUST** Commit message theo **Conventional Commits 1.0.0**: `type(scope)!: mô tả`, `BREAKING CHANGE:` footer khi vỡ tương thích; subject ≤ 72 ký tự. → Kiểm: commitlint (hoặc regex trong hook `commit-msg`) chạy ở local và lặp lại trong CI trên mọi commit của PR. · Nguồn: Conventional Commits 1.0.0 §1, §12–13
- [ ] `BASE-REPO-006` **MUST** Mỗi phiên bản phát hành có **một định danh duy nhất** theo SemVer 2.0.0 hoặc CalVer đã chọn, ghi trong một nguồn duy nhất (manifest gói hoặc file `VERSION`) và gắn **annotated tag** trùng giá trị. → Kiểm: `git tag -l 'v*'` có tag cho bản mới nhất; `git cat-file -t <tag>` = `tag`; giá trị trong manifest == tag. · Nguồn: SemVer 2.0.0 §2–8; OpenSSF Badge `version_unique`, `version_tags`
- [ ] `BASE-REPO-007` **MUST** Có `CHANGELOG.md` theo Keep a Changelog 1.1.0: mục `Unreleased` ở đầu, mỗi bản có ngày ISO 8601 (`YYYY-MM-DD`), nhóm Added/Changed/Deprecated/Removed/Fixed/Security, bản mới nhất trước; ghi chú người đọc được, không dán `git log`. → Kiểm: CI kiểm `CHANGELOG.md` có heading `## [Unreleased]` và heading bản mới nhất trùng tag; hoặc file sinh bởi release-please/git-cliff trong PR phát hành. · Nguồn: Keep a Changelog 1.1.0; OpenSSF Badge `release_notes`
- [ ] `BASE-REPO-008` **MUST** Nhánh mặc định được bảo vệ: không force-push, không xoá, mọi thay đổi qua PR (kể cả làm một mình). → Kiểm: ruleset/branch protection đọc qua API (`gh api repos/{o}/{r}/rulesets`) có `non_fast_forward`, `deletion`, `pull_request`; cấu hình lưu dạng code trong `.github/rulesets/*.json`. · Nguồn: GitHub rulesets; Scorecard Branch-Protection
- [ ] `BASE-REPO-013` **MUST** Không force-push và không rewrite lịch sử (`rebase`, `amend`, `reset`) trên **nhánh dùng chung** (nhánh chính, nhánh có người/agent khác làm, nhánh đã có PR được review); chỉ rewrite nhánh cá nhân chưa chia sẻ — quy tắc chi tiết ở [`WF-GIT-009`](.xtemplates/framework/10-workflow/git-and-branching.md). → Kiểm: ruleset theo Kiểm của `BASE-REPO-008`; quy ước nhánh dùng chung ghi trong `CONTRIBUTING.md`/`AGENTS.md`. · Nguồn: P8; AGENTS.md mục Luật bất biến

### Bảo mật tối thiểu cho mọi phần mềm

Nguồn khung: [`01-baseline/security-minimum.md`](.xtemplates/framework/01-baseline/security-minimum.md)

- [ ] `BASE-SEC-001` **MUST** Mọi đầu vào ngoài ranh giới tin cậy được validate **allowlist** bằng schema runtime (kiểu, độ dài, định dạng, phạm vi, ngữ nghĩa và quan hệ như `end ≥ start`) ở server/tiến trình xử lý, không chỉ ở client/UI — sàn cho mọi loại phần mềm kể cả CLI/thư viện; chi tiết web ở [`SEC-WEB-002`](.xtemplates/framework/12-security/appsec-web.md). → Kiểm: mỗi entrypoint có schema; test gửi input xấu (sai kiểu, quá dài, Unicode lạ, null, quan hệ sai) nhận lỗi 4xx/exit code có kiểm soát. · Nguồn: OWASP Input Validation CS; ASVS 5.0 V2
- [ ] `BASE-SEC-002` **MUST** Sàn mọi quy mô: không có bí mật (API key, mật khẩu, token, private key) trong mã nguồn, cấu hình commit, lịch sử Git, Dockerfile/image, log hay artefact build; quét, pre-commit, xoay khi lộ theo [`SEC-SECRET-001`](.xtemplates/framework/12-security/secrets-management.md) đến `SEC-SECRET-011`. → Kiểm: gitleaks/trufflehog toàn lịch sử = 0; `grep -rE 'AKIA[0-9A-Z]{16}|-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----'` sạch. · Nguồn: OWASP Secrets Management CS
- [ ] `BASE-SEC-004` **MUST** Mọi kênh mạng ra/vào dùng TLS (HTTPS, TLS 1.2+); không tắt xác minh chứng chỉ (`verify=False`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `InsecureSkipVerify`). → Kiểm: grep mã + cấu hình không có cờ tắt verify; test tích hợp gọi `http://` tới dịch vụ ngoài bị chặn/đổi hướng. · Nguồn: ASVS 5.0 V12
- [ ] `BASE-SEC-005` **MUST** Không có tài khoản/mật khẩu mặc định (`admin/admin`), không khoá cứng trong mã; thiếu bí mật bắt buộc → từ chối khởi động theo [`SEC-SECRET-004`](.xtemplates/framework/12-security/secrets-management.md) (validate cấu hình: [`BASE-CFG-002`](.xtemplates/framework/01-baseline/configuration-and-secrets.md)). → Kiểm: grep không có `admin/admin`, `changeme`, `SECRET_KEY = "..."`; tài khoản quản trị đầu tiên tạo qua bước khởi tạo có mật khẩu do người đặt. · Nguồn: ASVS 5.0 V13; catalog 11 §1c, 12 §3i
- [ ] `BASE-SEC-006` **MUST** Tiến trình chạy với **quyền tối thiểu**: không root trong container, không `sudo` trong script runtime, token/khoá chỉ có scope cần; quyền token CI theo [`BASE-GATE-010`](.xtemplates/framework/01-baseline/quality-gates.md). → Kiểm: `Dockerfile` có `USER` không phải root; IAM/token scope liệt kê trong tài liệu. · Nguồn: P7; GitHub Actions security hardening
- [ ] `BASE-SEC-007` **MUST** Lệnh hệ thống, truy vấn, đường dẫn, template được xây **tham số hoá**, không nối chuỗi từ input: truy vấn tham số, `subprocess` dạng mảng không `shell=True`, path join + kiểm `realpath` nằm trong thư mục cho phép, output encoding theo ngữ cảnh — sàn cho mọi loại phần mềm; chi tiết web ở [`SEC-WEB-001`](.xtemplates/framework/12-security/appsec-web.md). → Kiểm: SAST (CodeQL/Semgrep/bandit/gosec) 0 phát hiện injection; test path traversal `../` bị chặn. · Nguồn: ASVS 5.0 V1, V5; OWASP Injection Prevention CS
- [ ] `BASE-SEC-009` **MUST** Có **kênh báo lỗ hổng** và người nhận: `SECURITY.md` (public) hoặc mục trong README/RUNBOOK (private), kèm cam kết phản hồi ban đầu ≤ 14 ngày. → Kiểm: file tồn tại, có địa chỉ liên hệ hoạt động; repo public bật private vulnerability reporting. · Nguồn: OpenSSF Badge `vulnerability_report_process`, `vulnerability_report_response`; Scorecard Security-Policy
- [ ] `BASE-SEC-010` **MUST** Dịch vụ nghe cổng mạng: bind `127.0.0.1` mặc định; bind `0.0.0.0` chỉ khi có xác thực bắt buộc; không publish cổng CSDL/cache ra Internet. → Kiểm: cấu hình mặc định grep `host`/`bind`; `docker compose` không map cổng DB ra host ở prod; scan cổng từ ngoài chỉ thấy cổng công khai dự kiến. · Nguồn: catalog 12 §3b, §3i (mặc định quyết định rủi ro)
- [ ] `BASE-SEC-011` **MUST** Có threat model tối thiểu (tài sản, ranh giới tin cậy, kẻ tấn công, mối đe doạ, biện pháp) được cập nhật khi thêm tích hợp/ranh giới mới. → Kiểm: `docs/THREAT-MODEL.md` tồn tại theo mẫu [`../templates/THREAT-MODEL.md`](.xtemplates/framework/templates/THREAT-MODEL.md); mỗi mối đe doạ mức cao có biện pháp có bằng chứng (test/config). · Nguồn: lifecycle.md G4; [`../12-security/threat-modeling.md`](.xtemplates/framework/12-security/threat-modeling.md)
- [ ] `BASE-SEC-013` **MUST** Dữ liệu cá nhân/nhạy cảm được **phân loại** và tối thiểu hoá: chỉ thu cái cần, mã hoá at-rest cho lớp nhạy cảm, thời hạn lưu. → Kiểm: bảng phân loại trong `PROJECT.md`/DPIA; schema đánh dấu cột PII; chi tiết [`../09-database/sensitive-data-and-access.md`](.xtemplates/framework/09-database/sensitive-data-and-access.md). · Nguồn: ASVS 5.0 V14; [`../16-compliance-privacy/privacy-by-design.md`](.xtemplates/framework/16-compliance-privacy/privacy-by-design.md)

### Tiêu chuẩn tiếp cận (WCAG 2.2, EN 301 549, Section 508)

Nguồn khung: [`04-standards/accessibility-standards.md`](.xtemplates/framework/04-standards/accessibility-standards.md)

- [ ] `STD-A11Y-001` **MUST** Khai báo chuẩn và mức nhắm tới (`WCAG 2.2 AA`) trong `PROJECT.md`. → Kiểm: `grep -E "WCAG 2\.2 AA" PROJECT.md` khớp. · Nguồn: WCAG 2.2 Conformance
- [ ] `STD-A11Y-002` **MUST** Quét axe trong E2E với đủ tag tới `wcag22aa`, 0 vi phạm mức critical/serious trên mọi trang/màn chính. → Kiểm: cấu hình `AxeBuilder.withTags([... 'wcag22aa'])` trong test; job CI xanh. · Nguồn: WCAG 2.2 (SC AA)
- [ ] `STD-A11Y-004` **MUST** Luồng chính được kiểm tay bằng bàn phím và ít nhất một trình đọc màn hình, ghi biên bản (người, ngày, luồng, kết quả) trong `GO-NO-GO.md`. → Kiểm: mục "Kiểm tay a11y" trong `GO-NO-GO.md` không trống. · Nguồn: WCAG 2.2 SC 2.1.1, 4.1.2
- [ ] `STD-A11Y-005` **MUST** Sản phẩm cho khu vực công EU có trang tuyên bố tiếp cận công khai ghi phiên bản EN 301 549 áp dụng. → Kiểm: `curl -s https://<domain>/accessibility-statement` trả 200 và chứa "EN 301 549". · Nguồn: Directive (EU) 2016/2102 Art. 7; EN 301 549

### Chuẩn API & web (OpenAPI 3.1, RFC 9457, OAuth 2.1, OIDC, JSON Schema, HTTP)

Nguồn khung: [`04-standards/api-and-web-standards.md`](.xtemplates/framework/04-standards/api-and-web-standards.md)

- [ ] `STD-API-001` **MUST** Mọi HTTP API công khai/đối tác có file OpenAPI trong repo khai báo `openapi: 3.1.x` hoặc `3.2.x`. → Kiểm: `grep -E "^openapi: 3\.(1|2)\.[0-9]+" openapi.yaml`. · Nguồn: OAS 3.2.1 §4.1 (OpenAPI Object)
- [ ] `STD-API-005` **MUST** Uỷ quyền OAuth: PKCE bắt buộc cho mọi client, không cấp implicit (`response_type=token`) và không ROPC (`grant_type=password`). → Kiểm: test tích hợp gửi `response_type=token` nhận lỗi; cấu hình authorization server `require_pkce: true`. · Nguồn: draft-ietf-oauth-v2-1-16 (PKCE, bỏ implicit/ROPC)
- [ ] `STD-API-006` **MUST** Đăng nhập OIDC validate ID token đầy đủ: chữ ký, `iss`, `aud`, `exp`, `nonce`. → Kiểm: unit test với token sửa từng trường đều bị từ chối. · Nguồn: OIDC Core 1.0 §3.1.3.7
- [ ] `STD-API-008` **MUST** Thay đổi phá vỡ hợp đồng (xoá field, đổi kiểu, bỏ endpoint) bị chặn ở PR trừ khi tăng major version. → Kiểm: job `oasdiff breaking base.yaml head.yaml` exit 0 hoặc PR có nhãn `breaking` + bump major. · Nguồn: SemVer 2.0.0 §8 (xem [`process-and-quality-standards.md`](.xtemplates/framework/04-standards/process-and-quality-standards.md))

### Chuẩn dữ liệu & quyền riêng tư (ISO 27701, GDPR, PDPL VN, NIST Privacy)

Nguồn khung: [`04-standards/data-privacy-standards.md`](.xtemplates/framework/04-standards/data-privacy-standards.md)

- [ ] `STD-PRIV-001` **MUST** Khai báo luật và chuẩn quyền riêng tư áp dụng (số hiệu + ngày hiệu lực) trong `PROJECT.md`. → Kiểm: `grep -E "91/2025/QH15|2016/679" PROJECT.md` khớp ít nhất 1. · Nguồn: Luật 91/2025/QH15; GDPR
- [ ] `STD-PRIV-002` **MUST** Có kiểm kê dữ liệu cá nhân (`docs/compliance/data-inventory.csv`: hệ thống, bảng/cột, loại cơ bản/nhạy cảm, mục đích, cơ sở pháp lý, thời hạn lưu) đối chiếu máy với schema. → Kiểm: script so cột gắn nhãn `pii` trong schema/migration với inventory, 0 cột thiếu. · Nguồn: Luật 91/2025/QH15 (phân loại dữ liệu); GDPR Art. 30
- [ ] `STD-PRIV-004` **MUST** Quyền chủ thể (truy cập, xoá, rút đồng ý, hạn chế xử lý) là luồng có E2E test. → Kiểm: test đặt tên `rights-access`, `rights-delete`, `rights-withdraw-consent` chạy trong CI. · Nguồn: Luật 91/2025/QH15 Đ.4 kh.1; GDPR Art. 15–21
- [ ] `STD-PRIV-005` **MUST** Thời hạn lưu theo từng loại dữ liệu được job tự động thực thi. → Kiểm: job xoá/ẩn danh có lịch; test seed bản ghi quá hạn → sau job không còn. · Nguồn: GDPR Art. 5(1)(e); Luật 91/2025/QH15 (xoá khi hết mục đích)

### Chuẩn quy trình & chất lượng (ISO 25010, SemVer, Conventional Commits, SLSA, SBOM, DORA)

Nguồn khung: [`04-standards/process-and-quality-standards.md`](.xtemplates/framework/04-standards/process-and-quality-standards.md)

- [ ] `STD-PROC-001` **MUST** `PROJECT.md` có bảng yêu cầu chất lượng theo đặc tính ISO/IEC 25010:2023 với số đo và ngưỡng cho ít nhất 3 đặc tính (vd performance efficiency: p95 < 300 ms; reliability: SLO 99,9%; security: ASVS L2). → Kiểm: `grep -c "25010" PROJECT.md` ≥ 1 và bảng có ≥ 3 hàng ngưỡng số. · Nguồn: ISO/IEC 25010:2023
- [ ] `STD-PROC-002` **MUST** Phiên bản phát hành theo SemVer 2.0.0, tag Git `vX.Y.Z`. → Kiểm: `git tag --list 'v*' | grep -vE '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'` rỗng. · Nguồn: SemVer 2.0.0 §2, §9, §10
- [ ] `STD-PROC-003` **MUST** Thay đổi phá vỡ API công khai chỉ đi với tăng MAJOR và ghi `BREAKING CHANGE:` trong commit. → Kiểm: CI so sánh hợp đồng (oasdiff/API Extractor/`go-apidiff`) đỏ khi breaking mà version không tăng major. · Nguồn: SemVer 2.0.0 §8; Conventional Commits 1.0.0 (footer BREAKING CHANGE)
- [ ] `STD-PROC-004` **MUST** Mọi commit vào nhánh chính (và tiêu đề PR khi squash) theo Conventional Commits, subject ≤ 72 ký tự. → Kiểm: commitlint (`@commitlint/config-conventional`) chạy trong CI job `pr-policy`, exit 0. · Nguồn: Conventional Commits 1.0.0

### Tiêu chuẩn bảo mật (OWASP ASVS/MASVS/Top 10, NIST SSDF, CIS, ISO 27001)

Nguồn khung: [`04-standards/security-standards.md`](.xtemplates/framework/04-standards/security-standards.md)

- [ ] `STD-SEC-001` **MUST** Khai báo chuẩn bảo mật nhắm tới kèm phiên bản và mức (vd `ASVS 5.0.0 L2`) trong `PROJECT.md`. → Kiểm: `grep -E "ASVS 5\.0\.0 L[123]" PROJECT.md` khớp. · Nguồn: ASVS 5.0.0 ch.1 (Assessment and Verification)
- [ ] `STD-SEC-003` **MUST** Threat model web có bảng A01–A10:2025 → biện pháp hoặc "không áp dụng + lý do". → Kiểm: `grep -cE "A(0[1-9]|10):2025" THREAT-MODEL.md` ≥ 10. · Nguồn: OWASP Top 10:2025
- [ ] `STD-SEC-004` **MUST** API công khai có test authz đặt tên theo API1 (BOLA) và API5 (BFLA) chạy trong CI. → Kiểm: `grep -rE "api1-bola|api5-bfla" tests/` ≥ 2 và job CI chạy chúng. · Nguồn: OWASP API Security Top 10 2023 API1, API5
- [ ] `STD-SEC-007` **MUST** Hạ tầng tự vận hành (OS, container, K8s, cloud account, DB) quét theo CIS Benchmark Level 1, 0 FAIL hoặc mỗi FAIL có miễn trừ ghi lý do. → Kiểm: job CI/cron chạy `kube-bench`/`prowler`/`docker-bench-security`, báo cáo lưu artifact. · Nguồn: CIS Benchmarks (Level 1)

### Chọn kiểu kiến trúc: monolith · modular · microservices · serverless · event-driven

Nguồn khung: [`05-architecture/architecture-styles.md`](.xtemplates/framework/05-architecture/architecture-styles.md)

- [ ] `ARC-STYLE-001` **MUST** Kiểu kiến trúc được chốt bằng một ADR ở G2–G4, có ≥ 2 phương án cân nhắc và mục "điều kiện đọc lại". → Kiểm: tồn tại `docs/adr/*` chứa tiêu đề quyết định kiến trúc, có heading "Phương án đã cân nhắc" (hoặc "Considered Options") và heading điều kiện đọc lại. · Nguồn: [`decision-records.md`](.xtemplates/framework/05-architecture/decision-records.md) · lifecycle G4
- [ ] `ARC-STYLE-002` **MUST** Dự án mới mặc định là một đơn vị triển khai (modular monolith); mọi dịch vụ tách thêm phải nêu bằng chứng (đội/tải/cách ly) trong ADR. → Kiểm: số deployable trong CI/IaC = 1, hoặc mỗi deployable thêm được trỏ tới một ADR có mục "Bằng chứng tách". · Nguồn: catalog 13 §6b (CRM 6 service vs modular monolith)
- [ ] `ARC-STYLE-003` **MUST** Mỗi đơn vị triển khai đọc cấu hình từ biến môi trường, không đọc file cấu hình chứa bí mật trong image. → Kiểm: `grep` không thấy chuỗi kết nối/khoá trong source; Dockerfile không `COPY .env`; cổng bí mật ở [`../12-security/secrets-management.md`](.xtemplates/framework/12-security/secrets-management.md). · Nguồn: 12-factor III
- [ ] `ARC-STYLE-006` **MUST** Khi đã tách dịch vụ: mỗi bảng/collection chỉ có đúng một dịch vụ ghi; dịch vụ khác đọc qua API hoặc sự kiện. → Kiểm: bảng ánh xạ `bảng → dịch vụ sở hữu` trong `docs/architecture/`; test tích hợp xác nhận tài khoản CSDL của dịch vụ B không có quyền INSERT/UPDATE vào bảng của A. · Nguồn: microservices.io Database per Service (xem Nguồn)

### Ranh giới, module hoá, C4, hexagonal, luật phụ thuộc

Nguồn khung: [`05-architecture/boundaries-and-modularity.md`](.xtemplates/framework/05-architecture/boundaries-and-modularity.md)

- [ ] `ARC-MOD-003` **MUST** Lõi nghiệp vụ không import framework web, ORM, HTTP client, SDK đám mây. → Kiểm: luật `forbidden` của dependency-cruiser/import-linter/ArchUnit từ `domain|application` tới `infra|api|framework` ở mức `error`, chạy trong CI. · Nguồn: Clean Architecture (Dependency Rule) · Hexagonal Architecture
- [ ] `ARC-MOD-004` **MUST** Không có vòng phụ thuộc giữa các module/miền. → Kiểm: luật `circular: true` (dependency-cruiser) / contract `acyclic siblings` (import-linter) / `beFreeOfCycles()` (ArchUnit) ở mức lỗi, CI exit ≠ 0 khi vi phạm. · Nguồn: tài liệu công cụ (xem Nguồn)
- [ ] `ARC-MOD-005` **MUST** Mỗi module chỉ được import từ điểm xuất công khai của module khác, không import đường dẫn nội bộ. → Kiểm: luật `forbidden` `from: <module A> to: <module B>/(?!index)` hoặc contract `protected`; ESLint `no-restricted-imports` cho đường dẫn `**/internal/**`. · Nguồn: import-linter contract types
- [ ] `ARC-MOD-008` **MUST** Thư mục cấp một của source chia theo miền nghiệp vụ; tên miền trùng với bounded context trong `PROJECT.md`/spec. → Kiểm: danh sách thư mục `src/*` ⊆ danh sách miền trong `docs/architecture/domains.md`; script so khớp trong CI. · Nguồn: [`../17-product-project/specification.md`](.xtemplates/framework/17-product-project/specification.md)

### Quyết định kiến trúc (ADR) và quản trị thay đổi kiến trúc

Nguồn khung: [`05-architecture/decision-records.md`](.xtemplates/framework/05-architecture/decision-records.md)

- [ ] `ARC-ADR-001` **MUST** Repo có thư mục `docs/adr/` với mẫu và ≥ 1 ADR chọn stack (G2) trước khi dựng nền (G5). → Kiểm: `ls docs/adr/0001-*.md`; ADR có heading "Phương án đã cân nhắc"/"Considered Options" với ≥ 2 mục. · Nguồn: [`../00-method/lifecycle.md`](.xtemplates/framework/00-method/lifecycle.md) G2 · MADR 4.0.0
- [ ] `ARC-ADR-002` **MUST** ADR đánh số tăng dần 4 chữ số, không trùng, không tái sử dụng số; tên file `NNNN-<slug-kebab>.md`. → Kiểm: script liệt kê số và báo trùng/khoảng trống bất thường; regex tên file trong CI. · Nguồn: khung cũ `.claude/commands/adr.md` (`git show 1b80fe4:.claude/commands/adr.md`)
- [ ] `ARC-ADR-003` **MUST** Mỗi ADR có đủ: Status · Date · Context and Problem Statement · Considered Options (≥ 2) · Decision Outcome · Consequences. → Kiểm: script lint heading (grep) chạy trong CI; 0 file thiếu. · Nguồn: MADR 4.0.0 (required: Context, Considered Options, Decision Outcome)
- [ ] `ARC-ADR-004` **MUST** ADR đã *accepted* không bị sửa nội dung; thay đổi chỉ được ở dòng Status/liên kết "superseded by". → Kiểm: CI so diff file `docs/adr/*.md` đã accepted ở nhánh gốc — chỉ cho phép thay đổi dòng Status/links; hook `ask` khi sửa file ADR có `status: accepted`. · Nguồn: khung cũ ADR template ("KHÔNG sửa ADR cũ") · evidence-and-sources luật 12

### Tích hợp: đồng bộ/bất đồng bộ, idempotency, outbox, saga, webhook

Nguồn khung: [`05-architecture/integration-patterns.md`](.xtemplates/framework/05-architecture/integration-patterns.md)

- [ ] `ARC-INT-001` **MUST** Mọi endpoint/handler tạo hoặc ghi có tác động (POST, lệnh, job) nhận khoá idempotency và trả cùng kết quả cho cùng khoá trong cửa sổ lưu. → Kiểm: test gửi 2 request cùng `Idempotency-Key` → 1 bản ghi/1 giao dịch, response thứ hai bằng response đầu; bảng/khoá lưu idempotency có TTL. · Nguồn: RFC 9110 §9.2.2 · draft-ietf-httpapi-idempotency-key-header-07
- [ ] `ARC-INT-003` **MUST** Thay đổi dữ liệu và việc phát sự kiện/tác động phụ được ghi trong **cùng một transaction** qua bảng outbox; không gọi broker/HTTP bên trong transaction. → Kiểm: grep không có client broker/HTTP trong khối transaction; test tắt broker → bản ghi outbox vẫn tạo và được gửi sau khi broker lên. · Nguồn: microservices.io Transactional outbox
- [ ] `ARC-INT-005` **MUST** Consumer khử trùng theo `message_id`/`event_id` (bảng `processed_messages` hoặc khoá duy nhất) vì relay là at-least-once. → Kiểm: test phát cùng message 2 lần → tác động 1 lần; ràng buộc UNIQUE trên id đã xử lý. · Nguồn: microservices.io Transactional outbox (duplicate delivery)
- [ ] `ARC-INT-008` **MUST** Webhook vào: xác minh chữ ký HMAC-SHA256 trên **payload thô** (không re-serialize), so sánh thời gian hằng, từ chối khi `timestamp` ngoài cửa sổ chấp nhận, khử trùng theo `webhook-id`. → Kiểm: test 4 ca: chữ ký sai → 401; timestamp cũ → 400; id lặp → 200 không xử lý lại; payload re-serialize → vẫn verify đúng vì dùng raw body. · Nguồn: Standard Webhooks 1.0.0 · catalog 23 §4.1 (SePay HMAC + idempotent)

### Độ bền và mở rộng: timeout, retry, circuit breaker, stateless, cache, hàng đợi

Nguồn khung: [`05-architecture/resilience-and-scalability.md`](.xtemplates/framework/05-architecture/resilience-and-scalability.md)

- [ ] `ARC-RES-001` **MUST** Mọi client HTTP/gRPC/CSDL/hàng đợi cấu hình timeout kết nối và timeout yêu cầu tường minh; không dùng mặc định vô hạn. → Kiểm: grep cấu hình client (`timeout`, `connect_timeout`, `statement_timeout`) ≠ 0/none; test mock phụ thuộc treo → lỗi timeout trong ngưỡng. · Nguồn: AWS Builders' Library (timeouts) · PostgreSQL `statement_timeout`
- [ ] `ARC-RES-002` **MUST** Retry chỉ cho lỗi có thể qua (timeout, kết nối, 5xx, 429 có `Retry-After`) và chỉ cho thao tác idempotent; có backoff mũ, trần thời gian chờ, trần số lần, jitter. → Kiểm: cấu hình thư viện resilience có `maxAttempts`, `backoff`, `jitter`; test 4xx không retry, test 503 retry đúng số lần. · Nguồn: AWS Builders' Library (backoff + jitter)
- [ ] `ARC-RES-005` **MUST** Tiến trình phục vụ không giữ trạng thái giữa request (phiên, upload tạm, khoá, cache "nguồn sự thật"); scale ≥ 2 bản sao không đổi hành vi. → Kiểm: E2E luồng chính với 2 bản sao và sticky session tắt (ARC-STYLE-004); không ghi file ngoài thư mục tạm. · Nguồn: 12-factor VI
- [ ] `ARC-RES-009` **MUST** Tiến trình tắt êm: nhận SIGTERM → ngừng nhận request mới → hoàn tất request/job đang chạy trong thời hạn → thoát; không mất job giữa chừng. → Kiểm: test gửi SIGTERM khi đang xử lý → request hoàn tất, job trả lại hàng đợi; cấu hình grace period của orchestrator ≥ thời hạn. · Nguồn: 12-factor IX · [`../08-backend/reliability-and-errors.md`](.xtemplates/framework/08-backend/reliability-and-errors.md)

### Tiếp cận (a11y) theo WCAG 2.2 AA và nền tảng mobile

Nguồn khung: [`06-design-ux/accessibility.md`](.xtemplates/framework/06-design-ux/accessibility.md)

- [ ] `UX-A11Y-001` **MUST** Mọi trang/màn hình qua quét axe-core với tag `wcag2a`, `wcag2aa`, `wcag21aa`, `wcag22aa` không có vi phạm (`violations.length === 0`). → Kiểm: `@axe-core/playwright` trong mọi smoke test E2E; CI đỏ nếu vi phạm. · Nguồn: WCAG 2.2 AA
- [ ] `UX-A11Y-002` **MUST** Tương phản chữ ≥ 4.5:1 (chữ lớn ≥ 3:1 — chữ lớn chỉ khi ≥ 24 px, hoặc ≥ 18,66 px **và** đậm; chữ thường 18–23 px vẫn cần 4.5:1); thành phần UI và trạng thái (viền input, icon, focus) ≥ 3:1 với nền kề. → Kiểm: `xt.py contrast` trên token (`UX-DS-003`) + axe rule `color-contrast` ở cả hai theme. · Nguồn: WCAG 2.2 SC 1.4.3, 1.4.11
- [ ] `UX-A11Y-003` **MUST** Toàn bộ chức năng dùng được bằng bàn phím; không bẫy focus (trừ dialog modal có Esc để thoát). → Kiểm: E2E luồng chính chỉ dùng `keyboard.press('Tab'|'Enter'|'Escape')`; axe rule `focus-order-semantics`. · Nguồn: WCAG 2.2 SC 2.1.1, 2.1.2
- [ ] `UX-A11Y-011` **MUST** Mọi ô nhập có nhãn gắn chương trình (`<label for>`, `aria-labelledby`); placeholder không thay nhãn. → Kiểm: axe rule `label`; lint `label-has-associated-control`. · Nguồn: WCAG 2.2 SC 1.3.1, 3.3.2

### UX cho tính năng AI: minh bạch, streaming, xác nhận, sửa sai

Nguồn khung: [`06-design-ux/ai-ux.md`](.xtemplates/framework/06-design-ux/ai-ux.md)

- [ ] `UX-AI-001` **MUST** Người dùng được thông báo rõ đang tương tác với AI tại lần tương tác đầu (và mỗi phiên), bằng chữ nhìn thấy, không chỉ icon. → Kiểm: E2E mở tính năng AI → phần tử `[data-ai-disclosure]` hiển thị text nhãn; axe không vi phạm. · Nguồn: EU AI Act Art. 50(1), 50(5)
- [ ] `UX-AI-002` **MUST** Nội dung do AI tạo (văn bản, ảnh, âm thanh, video) có nhãn nhìn thấy và metadata máy đọc được. → Kiểm: API trả `generated_by: "ai"` + `model_family` (không tên model trong UI người dùng cuối nếu không cần); E2E mỗi message AI có nhãn; media có manifest/tag. · Nguồn: EU AI Act Art. 50(2), 50(4)
- [ ] `UX-AI-004` **MUST** Hành động có tác dụng phụ (gửi, mua, xoá, ghi, gọi API ngoài) do AI đề xuất phải hiển thị bản xem trước chính xác và chờ người dùng xác nhận; không có "tự động chấp nhận" mặc định. → Kiểm: E2E agent đề xuất gửi email → không có request gửi cho tới khi bấm Xác nhận; config `autoApprove` mặc định false. · Nguồn: [`../13-ai-engineering/agentic-systems.md`](.xtemplates/framework/13-ai-engineering/agentic-systems.md) (HITL)
- [ ] `UX-AI-007` **MUST** Link, nút, mã, lệnh trong output AI được render như dữ liệu không tin cậy: sanitize HTML, không tự thực thi, link ngoài hiện domain. → Kiểm: test đưa output chứa `<script>`/`javascript:`/markdown link lừa → không chạy, hiển thị domain thật. · Nguồn: [`../12-security/ai-security.md`](.xtemplates/framework/12-security/ai-security.md); [`../07-frontend/client-security.md`](.xtemplates/framework/07-frontend/client-security.md)

### Nội dung, microcopy, ngôn ngữ, tiếng Việt có dấu

Nguồn khung: [`06-design-ux/content-and-microcopy.md`](.xtemplates/framework/06-design-ux/content-and-microcopy.md)

- [ ] `UX-CONTENT-001` **MUST** Mọi chuỗi hiển thị là tiếng Việt có dấu (hoặc đúng ngôn ngữ đích); không chuỗi không dấu kiểu "Dang nhap", "Khong tim thay". → Kiểm: script `check:vi-diacritics` quét file message/`src` với danh sách từ không dấu hay gặp (`dang nhap|khong|thanh cong|loi|tai khoan|mat khau`) = 0 kết quả. · Nguồn: TCVN 6909:2001; QĐ 72/2002/QĐ-TTg
- [ ] `UX-CONTENT-002` **MUST** Chuỗi lưu trữ và so sánh ở dạng Unicode NFC; input tiếng Việt được chuẩn hoá NFC trước khi lưu/tìm kiếm. → Kiểm: test đơn vị `"Việt".normalize('NFD') → normalize('NFC')` khớp giá trị lưu; API lớp biên gọi `normalize('NFC')`. · Nguồn: UAX #15 (rev. 58, Unicode 18.0.0)
- [ ] `UX-CONTENT-005` **MUST** Không dark pattern: không mặc định bật tuỳ chọn bất lợi (tự gia hạn, chia sẻ dữ liệu), huỷ dễ bằng đăng ký, không confirmshaming ("Không, tôi không muốn tiết kiệm"), không đếm ngược/khan hiếm giả, không hỏi lại liên tục sau khi đã từ chối. → Kiểm: review checklist dark-pattern trong PR template cho màn hình thanh toán/đăng ký/đồng ý; E2E luồng huỷ gói ≤ số bước luồng đăng ký. · Nguồn: DSA Reg. (EU) 2022/2065 Art. 25; FTC "Bringing Dark Patterns to Light" (09/2022); Luật 19/2023/QH15 Đ.10
- [ ] `UX-CONTENT-006` **MUST** Giá và chi phí hiển thị đầy đủ trước bước xác nhận (thuế, phí, gia hạn); không "phí ẩn" xuất hiện ở bước cuối. → Kiểm: E2E luồng thanh toán: tổng ở bước đầu = tổng ở bước xác nhận. · Nguồn: Luật 19/2023/QH15; FTC 2022

### Trực quan hoá dữ liệu (biểu đồ, KPI, readout)

Nguồn khung: [`06-design-ux/data-visualization.md`](.xtemplates/framework/06-design-ux/data-visualization.md)

- [ ] `UX-VIZ-002` **MUST** Mỗi biểu đồ có **bảng dữ liệu** hoặc **mô tả văn bản thay thế** nêu xu hướng và số chính; thông tin không mã hoá chỉ bằng màu (thêm nhãn trực tiếp, hình dạng hoặc kiểu nét); màu chuỗi/điểm đạt ≥ 3:1 với nền ở **cả hai theme**. → Kiểm: test mỗi biểu đồ có `<table>` hoặc `aria-describedby` trỏ tới mô tả; axe không báo lỗi `svg-img-alt`; script tính tỷ lệ màu chuỗi so nền hai theme ≥ 3; ảnh chụp thang xám vẫn phân biệt được các chuỗi. · Nguồn: WCAG 2.2 SC 1.1.1, 1.4.1, 1.4.11 (<https://www.w3.org/TR/WCAG22/>); `seeker19110/stored` 06 §7b.2 (diagram-design: verifier tương phản/a11y)

### Design system, token, typography, spacing, theme sáng/tối

Nguồn khung: [`06-design-ux/design-system-and-tokens.md`](.xtemplates/framework/06-design-ux/design-system-and-tokens.md)

- [ ] `UX-DS-001` **MUST** Token gốc nằm ở đúng một file/thư mục trong repo (DTCG JSON hoặc `theme.css`); mọi đầu ra khác được sinh bằng script. → Kiểm: lệnh `build:tokens` chạy trong CI; diff đầu ra sinh = 0 sau khi chạy lại. · Nguồn: DTCG 2025.10
- [ ] `UX-DS-002` **MUST** Component không hard-code mã màu (`#hex`, `rgb()`, tên màu) hay class màu primitive (`bg-blue-500`); chỉ dùng token ngữ nghĩa. → Kiểm: stylelint `color-no-hex` + script `check:hex-hardcode` (grep `#[0-9a-fA-F]{3,8}` trong `src/components`) = 0 kết quả. · Nguồn: WCAG 2.2 SC 1.4.3 (gián tiếp)
- [ ] `UX-DS-003` **MUST** Mọi cặp nền/chữ và nền/viền-điều-khiển trong bộ token đạt tương phản AA ở **cả hai theme**. → Kiểm: `python3 .xtemplates/scripts/xt.py contrast <theme.css> [--pairs contrast-pairs.txt]` exit 0 — đọc custom properties `:root` và `.dark`/`[data-theme=dark]`/`prefers-color-scheme: dark`, tự suy cặp (`--X-foreground`/`--on-X` trên `--X`, `--foreground` trên `--background`, `--ring` ≥ 3:1), cặp khác khai ở `--pairs`; chữ < 4,5:1 hoặc phi văn bản < 3:1 → đỏ (không làm tròn lên), không có cặp nào để kiểm cũng đỏ; đọc cả thân `@theme`/`@theme inline` của Tailwind v4; token gốc là DTCG JSON thì chạy trên CSS đã sinh (`UX-DS-001`). · Nguồn: WCAG 2.2 SC 1.4.3, 1.4.11
- [ ] `UX-DS-006` **MUST** Font chính có subset tiếng Việt (`unicode-range` U+1EA0–1EF9, U+0102–0103, U+0110–0111, U+01A0–01B0…) và fallback stack hiển thị đủ dấu. → Kiểm: E2E render chuỗi "Tiếng Việt có dấu: ắ ầ ẩ ẫ ậ ờ ỡ ợ ừ ữ ự" chụp ảnh so với baseline; không ô vuông/tofu. · Nguồn: MDN `unicode-range`

### Chuyển động, hình ảnh, chống 'AI slop', kiểm bằng máy

Nguồn khung: [`06-design-ux/motion-and-visual-quality.md`](.xtemplates/framework/06-design-ux/motion-and-visual-quality.md)

- [ ] `UX-VISUAL-001` **MUST** Mọi animation dịch chuyển/zoom/parallax/auto-play được giảm hoặc thay bằng fade khi `prefers-reduced-motion: reduce`. → Kiểm: Playwright `emulateMedia({ reducedMotion: 'reduce' })` → không phần tử nào có `transform` animation đang chạy (`getAnimations()` lọc transform = 0); CSS có khối `@media (prefers-reduced-motion: reduce)`. · Nguồn: MDN `prefers-reduced-motion`; WCAG 2.2 SC 2.3.3
- [ ] `UX-VISUAL-002` **MUST** Không nội dung nhấp nháy quá 3 lần/giây; chuyển động tự động > 5 s có nút dừng. → Kiểm: review animation `infinite`; carousel/video nền có nút Pause (E2E). · Nguồn: WCAG 2.2 SC 2.3.1, 2.2.2
- [ ] `UX-VISUAL-006` **MUST** Ảnh/icon trang trí có `alt=""`/`aria-hidden`; icon có nghĩa có tên tiếp cận; không emoji làm icon. → Kiểm: axe `image-alt`, `svg-img-alt`; script regex emoji trong JSX/template UI = 0. · Nguồn: WCAG 2.2 SC 1.1.1
- [ ] `UX-VISUAL-007` **MUST** Mọi ảnh/minh hoạ có quyền sử dụng ghi trong `assets/CREDITS.md` (nguồn, license); ảnh AI tạo gắn nhãn. → Kiểm: script so khớp file trong `public/images` với dòng trong CREDITS = 100%. · Nguồn: [`../16-compliance-privacy/licensing-and-ip.md`](.xtemplates/framework/16-compliance-privacy/licensing-and-ip.md)

### Responsive, mobile-first, vùng chạm, bố cục

Nguồn khung: [`06-design-ux/responsive-and-mobile-first.md`](.xtemplates/framework/06-design-ux/responsive-and-mobile-first.md)

- [ ] `UX-RESP-001` **MUST** Không cuộn ngang ở bề rộng 320 CSS px trên mọi trang/màn hình; không mất nội dung/chức năng. → Kiểm: Playwright viewport 320×800 cho mỗi route trong sitemap: `scrollWidth <= clientWidth`. · Nguồn: WCAG 2.2 SC 1.4.10
- [ ] `UX-RESP-002` **MUST** Thẻ viewport `width=device-width, initial-scale=1` và không `user-scalable=no`/`maximum-scale<2`. → Kiểm: grep meta viewport trong layout; axe rule `meta-viewport`. · Nguồn: WCAG 2.2 SC 1.4.4
- [ ] `UX-RESP-005` **MUST** Chức năng không phụ thuộc hover: mọi menu/tooltip/hành động mở được bằng chạm hoặc focus. → Kiểm: E2E project mobile (touch) mở được mọi menu; CSS hover chỉ bọc trong `@media (hover: hover)`. · Nguồn: MDN `@media (hover)`; WCAG 2.2 SC 1.4.13
- [ ] `UX-RESP-008` **MUST** Luồng chính chạy xanh trên **hai** project E2E: desktop và mobile (thiết bị giả lập Playwright). → Kiểm: `playwright.config` có projects `desktop` + `mobile`; CI chạy cả hai. · Nguồn: khung cũ `quality-supplements.md` Nhóm 2 mục 1; [`../14-testing-quality/e2e-and-accessibility.md`](.xtemplates/framework/14-testing-quality/e2e-and-accessibility.md)

### Bốn trạng thái UI, phản hồi, lỗi, loading, rỗng

Nguồn khung: [`06-design-ux/ui-states-and-feedback.md`](.xtemplates/framework/06-design-ux/ui-states-and-feedback.md)

- [ ] `UX-STATE-001` **MUST** Mỗi component/màn hình hiển thị dữ liệu có đủ 4 trạng thái: loading, empty, error, success. → Kiểm: Storybook có 4 story (`Loading`, `Empty`, `Error`, `Default`) cho mỗi component dữ liệu; script đếm story thiếu = 0. · Nguồn: khung cũ `quality-supplements.md` Nhóm 2 mục 5
- [ ] `UX-STATE-005` **MUST** Thông báo lỗi không chứa stack trace, SQL, tên bảng, mã lỗi thư viện; có nút "Thử lại" hoặc đường đi khác. → Kiểm: E2E mock API trả 500 → text lỗi không khớp regex `(Error:|at .*\.js|SELECT|Exception|TypeError)`; có nút Thử lại hoạt động. · Nguồn: OWASP (không lộ chi tiết nội bộ); [`../01-baseline/errors-and-logging.md`](.xtemplates/framework/01-baseline/errors-and-logging.md)
- [ ] `UX-STATE-006` **MUST** Nút gửi bị vô hiệu + hiện trạng thái đang gửi trong khi request chạy; không thể double-submit. → Kiểm: E2E click nhanh 2 lần → chỉ 1 request (đếm qua `page.waitForRequest`); API có idempotency key cho tạo mới (nguyên tắc: [`ARC-INT-001`](.xtemplates/framework/05-architecture/integration-patterns.md); hợp đồng header `Idempotency-Key`: [`../08-backend/api-design.md`](.xtemplates/framework/08-backend/api-design.md)).
- [ ] `UX-STATE-008` **MUST** Hành động không thể hoàn tác có dialog xác nhận nêu rõ đối tượng và hậu quả; nút xác nhận ghi đúng động từ; nút huỷ là mặc định khi nhấn Esc. → Kiểm: E2E xoá vĩnh viễn → dialog có tên đối tượng; Esc đóng không xoá. · Nguồn: WAI-ARIA APG Dialog

### Build, tooling, lint/format/type, env công khai

Nguồn khung: [`07-frontend/build-and-tooling.md`](.xtemplates/framework/07-frontend/build-and-tooling.md)

- [ ] `FE-BUILD-001` **MUST** Node và package manager ghim: `.nvmrc`/`.node-version` + `engines.node` + `packageManager`; CI dùng đúng bản; lockfile commit, cài bằng `npm ci`/`--frozen-lockfile`. → Kiểm: CI step `node --version` khớp `.nvmrc`; `git ls-files | grep -c lock` = 1; `npm ci` không sửa lockfile (`git diff --exit-code`). · Nguồn: endoflife.date Node.js
- [ ] `FE-BUILD-003` **MUST** Build production không bỏ qua lỗi: không `ignoreBuildErrors`/`ignoreDuringBuilds`/`skipLibCheck` để che lỗi dự án; `build` chạy sau `typecheck` + `lint`. → Kiểm: grep cấu hình = 0; thứ tự job trong CI. · Nguồn: catalog 09 §1.4
- [ ] `FE-BUILD-004` **MUST** Lint + format một cấu hình, 0 cảnh báo (`--max-warnings 0`), chạy ở pre-commit (staged) và CI (toàn bộ), cùng phiên bản (lockfile). → Kiểm: `biome ci .` hoặc `eslint . --max-warnings 0 && prettier --check .` xanh; hook pre-commit tồn tại (`lefthook.yml`/`.husky/`).
- [ ] `FE-BUILD-005` **MUST** Env có schema tách `client`/`server`; biến client chỉ qua tiền tố công khai; thiếu/sai kiểu → build/khởi động fail; không `process.env.X!` ngoài module env. → Kiểm: test chạy build với env thiếu → exit ≠ 0; grep `process.env\.` ngoài `env.ts` = 0 (trừ cấu hình). · Nguồn: Next.js env docs; Vite env docs; [`../01-baseline/configuration-and-secrets.md`](.xtemplates/framework/01-baseline/configuration-and-secrets.md)

### Bảo mật phía client: XSS, CSP, token, storage, dependency

Nguồn khung: [`07-frontend/client-security.md`](.xtemplates/framework/07-frontend/client-security.md)

- [ ] `FE-SEC-001` **MUST** Không có DOM sink nhận dữ liệu chưa sanitize: mọi `dangerouslySetInnerHTML|v-html|{@html}|innerHTML=|bypassSecurityTrust|insertAdjacentHTML|document.write` đi kèm `DOMPurify.sanitize` (hoặc Trusted Types policy) và chú thích lý do. → Kiểm: lint `react/no-danger` (hoặc rule tương đương) ở mức error với `eslint-disable` có lý do; grep sink → mỗi kết quả nằm trong module `safe-html` duy nhất; test fixture XSS (`<img onerror>`, `<svg/onload>`, `javascript:`) không thực thi. · Nguồn: OWASP XSS Prevention Cheat Sheet
- [ ] `FE-SEC-002` **MUST** URL từ dữ liệu ngoài được allowlist scheme `http(s):`/`mailto:` sau khi canonicalize; không render `javascript:`/`data:` vào `href`/`src`. → Kiểm: hàm `safeUrl()` dùng chung + test; grep `href={` với biến không qua `safeUrl` = 0 (lint tuỳ chỉnh). · Nguồn: OWASP XSS Prevention; Vue Security guide
- [ ] `FE-SEC-003` **MUST** CSP cho script là strict: nonce (per-response, không do middleware gắn tự động vào mọi `<script>`) hoặc hash + `'strict-dynamic'`; `object-src 'none'`; `base-uri 'none'`; không `'unsafe-inline'`/`'unsafe-eval'` cho `script-src`; `frame-ancestors` đặt. → Kiểm: `curl -I` có header; E2E Playwright không có lỗi console `Refused to execute`; test cấu hình parse header và assert các directive. · Nguồn: OWASP CSP Cheat Sheet
- [ ] `FE-SEC-005` **MUST** Token phiên/refresh không lưu trong localStorage/sessionStorage/IndexedDB/cookie đọc được bằng JS. → Kiểm: E2E sau đăng nhập: `Object.keys(localStorage)` và `document.cookie` không chứa token (regex JWT `^eyJ`); cookie phiên có `HttpOnly; Secure; SameSite`. · Nguồn: OWASP HTML5 Security Cheat Sheet; [`../08-backend/authn-authz.md`](.xtemplates/framework/08-backend/authn-authz.md)

### Form, validation, lỗi, a11y form, upload

Nguồn khung: [`07-frontend/forms-and-validation.md`](.xtemplates/framework/07-frontend/forms-and-validation.md)

- [ ] `FE-FORM-001` **MUST** Một schema cho mỗi form được import/sinh ở cả client và server; server validate lại mọi request. → Kiểm: test import cùng module schema ở handler server và component; test gửi request bỏ qua client (curl) với dữ liệu sai → 400/422 có lỗi theo field. · Nguồn: P5, P6; Standard Schema v1
- [ ] `FE-FORM-002` **MUST** Mỗi ô nhập có `<label>` gắn chương trình; lỗi gắn qua `aria-describedby` + `aria-invalid="true"`; thông điệp lỗi nói cách sửa. → Kiểm: axe rule `label`, `aria-valid-attr-value`; E2E submit sai → ô có `aria-invalid` và `aria-describedby` trỏ tới phần tử chứa lỗi. · Nguồn: WAI Forms tutorial; WCAG 2.2 SC 3.3.1, 3.3.3
- [ ] `FE-FORM-007` **MUST** Không double-submit: nút gửi vô hiệu + trạng thái đang gửi; mutation tạo mới có idempotency key. → Kiểm: E2E bấm 2 lần → 1 request; server nhận cùng key trả cùng kết quả (xem [`../08-backend/api-design.md`](.xtemplates/framework/08-backend/api-design.md)).
- [ ] `FE-FORM-010` **MUST** Form mutation được bảo vệ CSRF (SameSite cookie + token/`Origin` check phía server). → Kiểm: xem [`../12-security/appsec-web.md`](.xtemplates/framework/12-security/appsec-web.md); E2E POST không token → 403.

### Kiểm thử frontend: component, visual, E2E, a11y

Nguồn khung: [`07-frontend/frontend-testing.md`](.xtemplates/framework/07-frontend/frontend-testing.md)

- [ ] `FE-TEST-001` **MUST** Component có tương tác có test (Testing Library hoặc story `play`) dùng truy vấn theo vai trò/nhãn; `getByTestId` chỉ khi không có lựa chọn khác và có chú thích. → Kiểm: lint `testing-library/prefer-screen-queries`, `testing-library/no-container`; grep `getByTestId` / tổng truy vấn ≤ 10%. · Nguồn: Testing Library — Priority
- [ ] `FE-TEST-002` **MUST** E2E luồng chính (đăng nhập → thao tác lõi → kết quả) chạy trên **hai** project desktop và mobile, có quét axe sau mỗi bước. → Kiểm: `playwright.config` có 2 project + `AxeBuilder`; CI chạy cả hai. · Nguồn: [`../06-design-ux/responsive-and-mobile-first.md`](.xtemplates/framework/06-design-ux/responsive-and-mobile-first.md); [`../06-design-ux/accessibility.md`](.xtemplates/framework/06-design-ux/accessibility.md)
- [ ] `FE-TEST-003` **MUST** Test tất định: thời gian giả (`vi.useFakeTimers`/`page.clock`), random có seed, locale/timezone cố định (`TZ=UTC`, `LANG`), mạng mock ở unit/component. → Kiểm: chạy test 3 lần liên tiếp cùng kết quả (`--repeat-each=3` cho Playwright); cấu hình `TZ` trong script test.
- [ ] `FE-TEST-006` **MUST** Mỗi bug UI được sửa kèm test tái hiện (đỏ trước, xanh sau) ở tầng thấp nhất có thể. → Kiểm: PR fix có file test mới/sửa; CI job "regression" chạy. · Nguồn: P12

### Hiệu năng: Core Web Vitals, bundle, ảnh, font, ngân sách

Nguồn khung: [`07-frontend/performance-web-vitals.md`](.xtemplates/framework/07-frontend/performance-web-vitals.md)

- [ ] `FE-PERF-001` **MUST** Core Web Vitals field đạt "tốt" ở p75: LCP ≤ 2 500 ms, INP ≤ 200 ms, CLS ≤ 0,1, tách mobile và desktop, trên trang chính. → Kiểm: dashboard RUM p75 theo 28 ngày (hoặc CrUX nếu đủ lưu lượng) cho ≥ 3 URL chính. · Nguồn: web.dev Web Vitals
- [ ] `FE-PERF-002` **MUST** Lighthouse mobile trên PR cho ≥ 3 URL chính: Performance ≥ 0,9; audit `largest-contentful-paint` ≤ 2 500 ms, `cumulative-layout-shift` ≤ 0,1, `total-blocking-time` theo ngưỡng dự án (lab proxy cho INP); 3 lần chạy, lấy median. → Kiểm: `lighthouserc` có `numberOfRuns: 3`, `aggregationMethod: median`, assert `error`; CI fail khi vi phạm. · Nguồn: Lighthouse CI configuration; Lighthouse scoring
- [ ] `FE-PERF-004` **MUST** Ngân sách bundle ghi trong repo và chặn: entry JS gzip ≤ ngân sách đã chốt (đặt trong `.size-limit.json`), chunk route không vượt trần. → Kiểm: `size-limit` chạy trong CI, fail khi vượt; ngân sách ghi lý do trong `docs/PERF-BUDGET.md`.
- [ ] `FE-PERF-009` **MUST** Script bên thứ ba không chặn render: `async/defer`, nạp sau tương tác/idle; tổng kích thước bên thứ ba có ngân sách. → Kiểm: Lighthouse `third-party-summary`, `render-blocking-resources`; danh sách cho phép trong `docs/THIRD-PARTY.md`. · Nguồn: [`client-security.md`](.xtemplates/framework/07-frontend/client-security.md) (SRI/CSP cho script ngoài)

### Render (SSR/SSG/CSR/ISR), routing, hydration

Nguồn khung: [`07-frontend/rendering-and-routing.md`](.xtemplates/framework/07-frontend/rendering-and-routing.md)

- [ ] `FE-RENDER-001` **MUST** Mỗi route được xếp vào một chế độ render (tĩnh / cache dùng chung / stream động / CSR) trong bảng `docs/ROUTES.md` kèm lý do. → Kiểm: file tồn tại; số route trong bảng = số route thực (script so với cây `app/`/`routes/`).
- [ ] `FE-RENDER-002` **MUST** Response chứa nội dung theo người dùng có `Cache-Control: private` (hoặc `no-store` với dữ liệu nhạy cảm) và không nằm trong cache CDN/ISR dùng chung. → Kiểm: E2E hai phiên khác nhau gọi cùng URL → nội dung khác; header `Cache-Control` khớp regex `private|no-store`; không `s-maxage` trên route có cookie phiên. · Nguồn: MDN HTTP Caching
- [ ] `FE-RENDER-003` **MUST** Không đọc cookie/header/searchParams/`Date.now()`/random bên trong hàm/component được cache dùng chung (`use cache`, ISR, `routeRules` cache). → Kiểm: lint tuỳ chỉnh hoặc review: file có `'use cache'` không import `cookies|headers`; Next dev overlay không báo `blocking-route`/`blocking-prerender-*`. · Nguồn: Next.js Caching (Cache Components)
- [ ] `FE-RENDER-005` **MUST** Kiểm tra xác thực/phân quyền cho route bảo vệ thực hiện ở server (proxy/middleware/loader/action) trước khi trả dữ liệu; client guard chỉ là UX. → Kiểm: curl không cookie tới route bảo vệ → 302/401, không có dữ liệu trong body. · Nguồn: [`../08-backend/authn-authz.md`](.xtemplates/framework/08-backend/authn-authz.md)

### State, data fetching, cache phía client, đồng bộ server

Nguồn khung: [`07-frontend/state-and-data-fetching.md`](.xtemplates/framework/07-frontend/state-and-data-fetching.md)

- [ ] `FE-STATE-001` **MUST** Mọi fetch dữ liệu server đi qua một lớp (thư viện query hoặc loader/server component của framework); không `useEffect(() => fetch())` trong component. → Kiểm: lint `@tanstack/eslint-plugin-query` 5.104.2 bật; grep `useEffect[\s\S]{0,200}fetch\(` trong `src/components` = 0.
- [ ] `FE-STATE-003` **MUST** Mỗi mutation khai báo invalidation (key/tag) hoặc cập nhật cache trực tiếp; sau mutation thành công UI phản ánh dữ liệu mới không cần reload. → Kiểm: E2E tạo/sửa/xoá → danh sách cập nhật không `page.reload()`; review `onSuccess/onSettled` có `invalidateQueries`. · Nguồn: TanStack Query Optimistic Updates
- [ ] `FE-STATE-005` **MUST** Retry chỉ với lỗi tạm thời (mạng, 408/429/5xx) có backoff và giới hạn; không retry 4xx (trừ 408/429); mutation không retry mặc định trừ khi idempotent. → Kiểm: cấu hình `retry: (count, err) => isTransient(err) && count < 3`; test 400 → không retry (đếm request). · Nguồn: [`../08-backend/reliability-and-errors.md`](.xtemplates/framework/08-backend/reliability-and-errors.md)
- [ ] `FE-STATE-008` **MUST** Không lưu token phiên, PII hay dữ liệu nhạy cảm trong store bền (localStorage/IndexedDB/persist) ngoài danh sách đã duyệt. → Kiểm: grep `persist(` / `localStorage.setItem` → danh sách key đối chiếu `docs/CLIENT-STORAGE.md`; test không có key chứa `token|session|email`. · Nguồn: [`client-security.md`](.xtemplates/framework/07-frontend/client-security.md)

### Thiết kế API: REST/GraphQL/gRPC, lỗi RFC 9457, phân trang, versioning, OpenAPI

Nguồn khung: [`08-backend/api-design.md`](.xtemplates/framework/08-backend/api-design.md)

- [ ] `BE-API-001` **MUST** Có hợp đồng API máy đọc được (OpenAPI 3.1+/`.proto`/GraphQL SDL) commit trong repo, là nguồn sự thật duy nhất cho endpoint, kiểu dữ liệu, mã lỗi. → Kiểm: file spec tồn tại; CI chạy linter spec (`spectral lint`/`buf lint`) exit 0. · Nguồn: ASVS 5.0 V4
- [ ] `BE-API-003` **MUST** Mọi đầu vào (body, query, path, header, cookie) được validate lúc chạy bằng schema (zod / pydantic / go-playground validator / Bean Validation) trước khi vào logic nghiệp vụ. → Kiểm: test gửi body thiếu trường, sai kiểu, quá dài → 400/422 có cấu trúc, không 500. · Nguồn: ASVS 5.0 V2, OWASP REST Security Cheat Sheet
- [ ] `BE-API-008` **MUST** Hợp đồng HTTP của idempotency cho POST có thể bị gửi lại (thanh toán, đặt hàng, gửi tin): header `Idempotency-Key`; thiếu key ở endpoint bắt buộc → 400; cùng key + cùng payload → trả lại response cũ; cùng key + payload khác → 422; request cùng key đang xử lý → 409; key lưu ở store dùng chung **≥ 24 giờ**; ghi trong OpenAPI. Nguyên tắc: xem [`ARC-INT-001`](.xtemplates/framework/05-architecture/integration-patterns.md) và `ARC-INT-002`. → Kiểm: test gửi 2 lần cùng key → 1 bản ghi, cùng response; payload khác → 422; gửi đồng thời → 409. · Nguồn: draft-ietf-httpapi-idempotency-key-header-07, Stripe Idempotent requests
- [ ] `BE-API-009` **MUST** Mọi endpoint không công khai kiểm xác thực + phân quyền ở server theo [`authn-authz.md`](.xtemplates/framework/08-backend/authn-authz.md); endpoint công khai được liệt kê rõ trong spec (`security: []`). → Kiểm: test gọi không token → 401; token người khác → 403/404; script liệt kê route không có guard = danh sách công khai đã duyệt. · Nguồn: ASVS 5.0 V4, V8

### Xác thực, phiên, token, phân quyền (RBAC/ABAC), đa yếu tố

Nguồn khung: [`08-backend/authn-authz.md`](.xtemplates/framework/08-backend/authn-authz.md)

- [ ] `BE-AUTH-001` **MUST** Băm mật khẩu bằng Argon2id với tham số ≥ OWASP (m=19456 KiB, t=2, p=1 hoặc tương đương); scrypt/bcrypt (cost ≥ 10, giới hạn 72 byte) chỉ khi nền tảng không có Argon2id; lưu tham số trong chuỗi PHC để nâng cấp dần. → Kiểm: test đọc hash có tiền tố `$argon2id$` và tham số đúng; không có `md5`/`sha1`/`sha256` mật khẩu trong code. · Nguồn: OWASP Password Storage Cheat Sheet, RFC 9106, ASVS 5.0 V6
- [ ] `BE-AUTH-003` **MUST** Giới hạn đăng nhập thất bại theo tài khoản (không chỉ IP): khoá/trì hoãn luỹ tiến, trần ≤ 100 lần thất bại liên tiếp; thông báo lỗi chung ("sai tài khoản hoặc mật khẩu") và thời gian phản hồi đồng đều để không lộ tài khoản tồn tại. → Kiểm: test 20 lần sai → bị chặn; so sánh body/thời gian giữa user tồn tại và không tồn tại. · Nguồn: NIST SP 800-63B-4, OWASP Authentication Cheat Sheet
- [ ] `BE-AUTH-004` **MUST** Session ID ≥ 128 bit từ CSPRNG; cookie phiên có `__Host-` + `Secure` + `HttpOnly` + `SameSite` (Lax/Strict); phiên lưu và vô hiệu ở server khi logout; tạo lại ID sau đăng nhập/đổi đặc quyền. → Kiểm: test logout rồi dùng lại cookie → 401; ID trước/sau đăng nhập khác nhau; `Set-Cookie` có đủ thuộc tính. · Nguồn: OWASP Session Management Cheat Sheet, ASVS 5.0 V7
- [ ] `BE-AUTH-009` **MUST** Mọi endpoint/handler không công khai (gồm Server Action, RPC, GraphQL resolver, WebSocket handshake, job trigger) kiểm xác thực và phân quyền ở server; `user_id` lấy từ phiên/token, không từ body/query. → Kiểm: test gọi với `user_id` khác trong body → vẫn thao tác trên user của token; scan route không guard = allowlist. · Nguồn: ASVS 5.0 V8, OWASP Authorization Cheat Sheet
- [ ] `BE-AUTH-010` **MUST** Kiểm quyền theo object cho mọi truy cập có ID (IDOR): truy vấn luôn kèm điều kiện sở hữu/tenant (`WHERE id = ? AND tenant_id = ?` hoặc RLS/policy engine); trả 404 hoặc 403 nhất quán. → Kiểm: test người dùng A đọc/sửa/xoá bản ghi của B qua ID → 403/404; test chạy cho mọi tài nguyên có ID. · Nguồn: OWASP Authorization Cheat Sheet, ASVS 5.0 V8

### Job nền, hàng đợi, lịch, idempotency, retry, DLQ

Nguồn khung: [`08-backend/background-jobs-and-queues.md`](.xtemplates/framework/08-backend/background-jobs-and-queues.md)

- [ ] `BE-JOB-001` **MUST** Mọi job có **`job_key` duy nhất theo nghiệp vụ** (vd `send-invoice:{invoice_id}`) làm khoá idempotency khi enqueue và khi xử lý, hoặc thao tác tự nhiên idempotent; chạy lại không tạo trùng. Nguyên tắc: xem [`ARC-INT-001`](.xtemplates/framework/05-architecture/integration-patterns.md). → Kiểm: test enqueue cùng job hai lần / chạy handler hai lần → một kết quả. · Nguồn: catalog 21 §8 (outbox/receipt)
- [ ] `BE-JOB-003` **MUST** Retry job hữu hạn: số lần cấu hình được, **mặc định 3–5**, backoff mũ có jitter và trần thời gian chờ; lỗi vĩnh viễn (4xx nghiệp vụ, validate) không retry mà vào **DLQ ngay**. Nguyên tắc retry: xem [`ARC-RES-002`](.xtemplates/framework/05-architecture/resilience-and-scalability.md). → Kiểm: unit test hàm tính delay (tăng mũ, có jitter, có trần); test lỗi 4xx nghiệp vụ → không retry, có bản ghi DLQ. · Nguồn: AWS Builders' Library Timeouts, retries and backoff with jitter
- [ ] `BE-JOB-004` **MUST** Có dead-letter queue/bảng `failed_jobs` giữ payload + lỗi + số lần thử; retention DLQ dài hơn hàng đợi gốc; có cảnh báo khi DLQ > 0 trong N phút và quy trình redrive ghi trong runbook. → Kiểm: test job fail hết lượt xuất hiện trong DLQ; rule cảnh báo tồn tại ([`../15-operations/slo-and-alerting.md`](.xtemplates/framework/15-operations/slo-and-alerting.md)). · Nguồn: AWS SQS Dead-letter queues
- [ ] `BE-JOB-007` **MUST** Payload job chỉ chứa ID và tham số tối thiểu, validate bằng schema khi worker nhận; không chứa bí mật, không chứa object đã serialize dễ lệch phiên bản. → Kiểm: schema payload có test; grep payload không có `password`/`token`. · Nguồn: P6

### Cache: tầng, key, TTL, vô hiệu hoá, stampede

Nguồn khung: [`08-backend/caching.md`](.xtemplates/framework/08-backend/caching.md)

- [ ] `BE-CACHE-001` **MUST** Phản hồi chứa dữ liệu theo người dùng/phiên có `Cache-Control: private` hoặc `no-store` và không được cache ở CDN/proxy/cache ứng dụng theo key không chứa định danh người dùng. → Kiểm: test E2E đăng nhập 2 user, gọi cùng URL → không nhận dữ liệu của nhau; header kiểm bằng test. · Nguồn: RFC 9111 §5.2.2.5, §5.2.2.7; catalog 09 §1.4
- [ ] `BE-CACHE-002` **MUST** Mọi entry cache ứng dụng có TTL hữu hạn; không `SET` không có `EX`/`PX` ngoài allowlist có lý do. → Kiểm: grep/lint wrapper cache bắt buộc tham số TTL; `redis-cli --scan` + `TTL` ngẫu nhiên không trả `-1` ngoài allowlist. · Nguồn: P7
- [ ] `BE-CACHE-005` **MUST** Cache hỏng/không kết nối được → ứng dụng fallback về nguồn (có giới hạn/circuit breaker), không 500; timeout gọi cache ngắn (vd ≤ 50–100 ms). → Kiểm: test tắt Redis → endpoint vẫn 200; timeout cấu hình rõ. · Nguồn: [`reliability-and-errors.md`](.xtemplates/framework/08-backend/reliability-and-errors.md)
- [ ] `BE-CACHE-007` **MUST** Chiến lược vô hiệu hoá được ghi cho từng loại cache (TTL / sự kiện / phiên bản) và có test: cập nhật dữ liệu → đọc sau đó không nhận bản cũ quá ngưỡng cho phép. → Kiểm: test cập nhật rồi đọc trong cùng test; tài liệu trong spec/ADR. · Nguồn: P5

### File, upload, lưu trữ đối tượng, xử lý ảnh/video, quét

Nguồn khung: [`08-backend/files-and-media.md`](.xtemplates/framework/08-backend/files-and-media.md)

- [ ] `BE-FILE-001` **MUST** Validate kiểu file bằng magic bytes (libmagic/`file-type`) **và** allowlist đuôi theo nhu cầu nghiệp vụ; `Content-Type` client chỉ là gợi ý; đuôi kép/ký tự lạ bị từ chối. → Kiểm: test upload `.php` đổi tên `.png`, file PNG đuôi `.jpg`, `a.jpg.exe` → từ chối. · Nguồn: OWASP File Upload Cheat Sheet, ASVS 5.0 V5
- [ ] `BE-FILE-003` **MUST** Tên lưu do server sinh (UUID/ULID + đuôi chuẩn hoá), không dùng tên người dùng trong đường dẫn; tên gốc chỉ lưu trong metadata đã sanitize (giới hạn độ dài, bỏ ký tự điều khiển/đường dẫn). → Kiểm: test tên `../../etc/passwd` → key lưu không chứa `..`; DB lưu tên gốc đã lọc. · Nguồn: OWASP File Upload Cheat Sheet
- [ ] `BE-FILE-004` **MUST** File lưu ngoài webroot/ở object storage private; không thực thi được (không có quyền execute, không serve qua thư mục có handler script). → Kiểm: bucket policy không public; test GET trực tiếp URL không ký → 403. · Nguồn: OWASP File Upload Cheat Sheet
- [ ] `BE-FILE-005` **MUST** Upload và tải xuống đều kiểm xác thực + phân quyền theo bản ghi sở hữu ([`authn-authz.md`](.xtemplates/framework/08-backend/authn-authz.md)); presigned GET hết hạn ngắn (phút–giờ, tối đa theo nền tảng, S3 CLI ≤ 7 ngày), không tái dùng làm "link công khai". → Kiểm: test user B lấy presigned URL file của A → 403; URL hết hạn → 403. · Nguồn: AWS S3 presigned URLs, OWASP Authorization Cheat Sheet

### Tích hợp bên thứ ba, webhook vào/ra, chữ ký, replay

Nguồn khung: [`08-backend/integrations-and-webhooks.md`](.xtemplates/framework/08-backend/integrations-and-webhooks.md)

- [ ] `BE-INT-002` **MUST** Webhook vào — phần vận hành: secret ký theo từng vendor × môi trường, chấp nhận **≥ 2 secret cùng lúc** trong thời gian xoay (không downtime), chữ ký sai → 400/401. Nguyên tắc (HMAC trên raw body, so sánh hằng thời gian, timestamp, khử trùng): xem [`ARC-INT-008`](.xtemplates/framework/05-architecture/integration-patterns.md). → Kiểm: test body sửa 1 byte → 400; test chữ ký với secret cũ trong thời gian xoay → 200. · Nguồn: Standard Webhooks v1.0.0, Stripe Webhooks, GitHub Validating webhook deliveries
- [ ] `BE-INT-004` **MUST** Receiver webhook khử trùng theo đúng header ID của vendor (`webhook-id`/`X-GitHub-Delivery`/`event.id`), lưu ở store dùng chung với **TTL ≥ cửa sổ retry của vendor**; sự kiện trùng → 2xx không xử lý lại; không dựa vào thứ tự sự kiện. Nguyên tắc khử trùng consumer: xem [`ARC-INT-005`](.xtemplates/framework/05-architecture/integration-patterns.md). → Kiểm: test gửi cùng sự kiện 2 lần → 1 side effect; test sự kiện đến sai thứ tự → trạng thái cuối đúng. · Nguồn: Stripe Webhooks (duplicate events, ordering), GitHub Best practices
- [ ] `BE-INT-007` **MUST** Gọi API vendor có tác dụng phụ gửi **`Idempotency-Key` của vendor** (Stripe…) khi vendor hỗ trợ, khoá dẫn xuất từ id intent để mọi lần thử lại/reconcile dùng cùng khoá; tôn trọng 429 `Retry-After` của vendor. Nguyên tắc retry: xem [`ARC-RES-002`](.xtemplates/framework/05-architecture/resilience-and-scalability.md); timeout sau khi gửi = không biết → [`ARC-INT-011`](.xtemplates/framework/05-architecture/integration-patterns.md). → Kiểm: test mô phỏng timeout sau khi vendor nhận → lần gọi lại cùng khoá, không tạo trùng; test 429 → chờ đúng `Retry-After`. · Nguồn: catalog 23 §4.4 ("504 = có thể đã chạy"), §4.5; RFC 6585
- [ ] `BE-INT-010` **MUST** URL webhook ra do khách hàng cấu hình: chỉ `https://`, chặn SSRF (resolve DNS rồi từ chối IP private/loopback/link-local/metadata, không theo redirect), timeout 15–30 s, giới hạn kích thước phản hồi. → Kiểm: test đăng ký `http://169.254.169.254` hoặc hostname resolve về 10.x → bị từ chối. · Nguồn: Standard Webhooks (SSRF), OWASP SSRF Prevention

### Realtime: WebSocket, SSE, pub/sub, streaming

Nguồn khung: [`08-backend/realtime-and-streaming.md`](.xtemplates/framework/08-backend/realtime-and-streaming.md)

- [ ] `BE-RT-001` **MUST** Xác thực tại handshake (cookie phiên hoặc token ngắn hạn qua header/subprotocol — không qua query string lọt log) và phân quyền theo kênh/room theo [`authn-authz.md`](.xtemplates/framework/08-backend/authn-authz.md); kết nối không hợp lệ bị đóng trước khi nhận thông điệp. → Kiểm: test kết nối không token → 401/đóng; test subscribe room của tenant khác → từ chối. · Nguồn: RFC 6455 §10.5, ASVS 5.0 V4
- [ ] `BE-RT-002` **MUST** WebSocket: kiểm `Origin` tại handshake theo allowlist (chống CSWSH); SSE/WebSocket chỉ qua TLS (`wss://`/`https://`). → Kiểm: test handshake với `Origin` lạ → 403; cấu hình không nhận `ws://` ngoài dev. · Nguồn: RFC 6455 §10.2
- [ ] `BE-RT-003` **MUST** Mọi thông điệp vào có schema + giới hạn kích thước (`maxPayload`, vd 64 KB–1 MB theo nhu cầu) + giới hạn tốc độ theo kết nối; vượt → đóng với mã 1008/1009. → Kiểm: test gửi frame vượt `maxPayload` → đóng 1009; test 1000 msg/giây → bị giới hạn. · Nguồn: RFC 6455 §7.4.1, P6
- [ ] `BE-RT-004` **MUST** Backpressure phía gửi: theo dõi `bufferedAmount`/hàng đợi mỗi kết nối; vượt ngưỡng → coalesce/bỏ sự kiện không quan trọng hoặc đóng kết nối chậm; không `send` vô điều kiện. → Kiểm: test client không đọc → server đóng kết nối sau ngưỡng, RSS không tăng tuyến tính. · Nguồn: WHATWG WebSockets (`bufferedAmount`)

### Độ tin cậy: timeout, retry, graceful shutdown, health, rate limit

Nguồn khung: [`08-backend/reliability-and-errors.md`](.xtemplates/framework/08-backend/reliability-and-errors.md)

- [ ] `BE-REL-001` **MUST** Mọi client HTTP/DB/cache/queue có timeout kết nối và timeout request cấu hình rõ, không dùng mặc định vô hạn của thư viện. → Kiểm: lint/grep client tạo không có timeout = 0 (vd `fetch` không `AbortSignal.timeout`, `requests.get` không `timeout=`, `http.Client{}` không `Timeout`, pool DB không `connect_timeout`/`statement_timeout`). · Nguồn: AWS Builders' Library Timeouts, retries and backoff with jitter
- [ ] `BE-REL-003` **MUST** Chính sách retry phía dịch vụ: **mặc định 3 lần** mỗi request, trần tổng thời gian, tôn trọng `Retry-After`; POST không idempotent timeout → không retry tự động. Nguyên tắc (chỉ lỗi tạm, chỉ thao tác idempotent, backoff mũ + jitter): xem [`ARC-RES-002`](.xtemplates/framework/05-architecture/resilience-and-scalability.md). → Kiểm: unit test chính sách retry; test lỗi 400/409 → không retry; test POST không idempotent timeout → không retry tự động. · Nguồn: RFC 9110 §9.2.2, Google SRE Handling Overload (3 lần/request)
- [ ] `BE-REL-004` **MUST** Tắt êm: nhận SIGTERM → readiness trả lỗi/ngừng nhận kết nối mới → chờ request đang chạy xong (trần < grace period của nền tảng, vd 30 s) → đóng pool DB/queue → thoát 0; không `process.exit()` tức thì. → Kiểm: test gửi SIGTERM khi có request chậm đang chạy → request hoàn tất 200, tiến trình thoát trong grace. · Nguồn: Kubernetes Pod lifecycle (SIGTERM → grace 30 s → SIGKILL)
- [ ] `BE-REL-006` **MUST** Giới hạn tốc độ trên endpoint công khai, xác thực, gửi OTP/email và endpoint đắt: token bucket theo `user_id`/API key, fallback IP; trả 429 + `Retry-After` (+ `RateLimit`/`RateLimit-Policy` nếu dùng); đếm ở store dùng chung khi nhiều instance. → Kiểm: test vượt ngưỡng → 429 có `Retry-After`; test 2 instance chia sẻ bộ đếm. · Nguồn: RFC 6585 §4, draft-ietf-httpapi-ratelimit-headers-11

### Sao lưu, khôi phục, PITR, diễn tập, RPO/RTO

Nguồn khung: [`09-database/backup-and-recovery.md`](.xtemplates/framework/09-database/backup-and-recovery.md)

- [ ] `DB-BACKUP-001` **MUST** RPO và RTO cho mỗi kho dữ liệu được chủ sản phẩm chốt và ghi trong repo, kèm cơ chế đáp ứng. → Kiểm: `docs/ops/RPO-RTO.md` có bảng kho → RPO → RTO → cơ chế → lần diễn tập gần nhất. · Nguồn: NIST SP 800-34 Rev.1 (RPO/RTO)
- [ ] `DB-BACKUP-002` **MUST** Backup tự động theo lịch, không phụ thuộc người nhớ chạy; thất bại → cảnh báo tới kênh có người trực. → Kiểm: cron/job/nền tảng có lịch; test cố ý làm backup fail → cảnh báo đến. · Nguồn: catalog 09 §1 (`[BLOCKER]` backup có test restore)
- [ ] `DB-BACKUP-003` **MUST** Đã khôi phục thử từ backup vào môi trường tách biệt ít nhất một lần trước khi ra mắt, ghi ngày, thời gian khôi phục đo được và cách kiểm dữ liệu. → Kiểm: `docs/ops/restore-drills.md` có bản ghi (ngày, backup dùng, RTO đo, kiểm tra đã làm, người làm). · Nguồn: lifecycle G8 ("backup đã thử khôi phục") · khung cũ `01-process-and-standards.md` GĐ6
- [ ] `DB-BACKUP-004` **MUST** Backup lưu ở vị trí tách biệt khỏi máy chủ CSDL (tài khoản/vùng/nhà cung cấp khác), mã hoá at rest, quyền ghi tối thiểu; tài khoản ứng dụng không có quyền xoá backup. → Kiểm: cấu hình đích backup (bucket khác tài khoản, KMS/`repo-cipher-type`); IAM policy không có `Delete*` cho tài khoản backup-writer. · Nguồn: OWASP Database Security Cheat Sheet (mã hoá backup, quyền hạn chế) · [`sensitive-data-and-access.md`](.xtemplates/framework/09-database/sensitive-data-and-access.md)

### Mô hình dữ liệu, chuẩn hoá, khoá, kiểu dữ liệu, soft-delete, audit

Nguồn khung: [`09-database/data-modeling.md`](.xtemplates/framework/09-database/data-modeling.md)

- [ ] `DB-MODEL-001` **MUST** Kiểu cột mốc thời gian theo CSDL: `timestamptz` (PostgreSQL) / `TIMESTAMP` lưu UTC + ứng dụng đặt `time_zone='+00:00'` (MySQL) / RFC 3339 UTC `TEXT` hoặc epoch ms `INTEGER` (SQLite); `timestamp without time zone` chỉ cho cột "giờ tường" có ghi lý do. Nguyên tắc (UTC, tz IANA): xem [`XC-UNITS-001`](.xtemplates/framework/18-cross-cutting/units-time-and-money.md). → Kiểm: lint schema (grep `timestamp without time zone`/`timestamp(` trong migration) = 0 ngoài allowlist có comment; test chèn `'2026-01-01T00:00:00+07:00'` đọc ra đúng tức thời. · Nguồn: PostgreSQL 18 §8.5.1.3 (timestamptz lưu UTC)
- [ ] `DB-MODEL-002` **MUST** Kiểu cột tiền: `bigint` (số nguyên đơn vị nhỏ nhất) + cột `currency char(3)` ISO 4217; `numeric(p,s)` scale cố định chỉ ở cột có ADR (tỷ giá, đơn giá dưới đơn vị nhỏ nhất); không `real`/`double precision`/`float`, không kiểu `money` (phụ thuộc `lc_monetary`). Nguyên tắc: xem [`XC-UNITS-005`](.xtemplates/framework/18-cross-cutting/units-time-and-money.md). → Kiểm: lint schema cấm kiểu `real|double precision|float|money` ở cột có tên/nghĩa tiền; mọi cột tiền `numeric` có trong danh sách của ADR. · Nguồn: PostgreSQL 18 §8.1.2 numeric, §8.2 money (locale/lc_monetary)
- [ ] `DB-MODEL-004` **MUST** Mọi FK khai báo `ON DELETE` tường minh (`RESTRICT`/`CASCADE`/`SET NULL`), có index trên cột FK. → Kiểm: truy vấn catalog liệt kê FK không có index / FK không ghi hành động; CI đỏ khi > 0. · Nguồn: PostgreSQL 18 CREATE TABLE (referential actions; `NO ACTION` mặc định)
- [ ] `DB-MODEL-005` **MUST** Cột không được rỗng là `NOT NULL`; bất biến nghiệp vụ đơn giản là `CHECK` (số lượng ≥ 0, `ends_at > starts_at`, trạng thái ∈ tập); tính duy nhất là `UNIQUE` (kể cả duy nhất theo tenant). → Kiểm: test chèn dữ liệu xấu ở tầng CSDL bị từ chối (không qua ORM); script đếm cột nullable không có lý do. · Nguồn: P6 · P7

### Index, truy vấn, N+1, EXPLAIN, pool kết nối

Nguồn khung: [`09-database/indexing-and-query-performance.md`](.xtemplates/framework/09-database/indexing-and-query-performance.md)

- [ ] `DB-PERF-001` **MUST** Mọi cột trong `WHERE`/`JOIN`/`ORDER BY` của truy vấn trên đường nóng (endpoint lõi, job thường xuyên) có index phù hợp, chứng minh bằng `EXPLAIN (ANALYZE, BUFFERS)` không Seq Scan trên bảng lớn. → Kiểm: file `docs/db/explain/<query>.txt` cho mỗi truy vấn lõi, cập nhật khi đổi; test tự động chạy EXPLAIN và fail nếu plan chứa `Seq Scan` trên bảng trong danh sách lớn. · Nguồn: PostgreSQL 18 §14.1 Using EXPLAIN
- [ ] `DB-PERF-004` **MUST** Pool kết nối có giới hạn trên tường minh ở mọi tiến trình; tổng `pool_size × số tiến trình` + dự phòng ≤ `max_connections`; có timeout lấy kết nối. → Kiểm: cấu hình pool (`max`, `acquireTimeout`/`pool_timeout`) trong repo; bảng tính tổng kết nối trong `docs/db/connections.md`; cảnh báo khi `numbackends` > 80% (ngưỡng đội chọn, ghi nguồn). · Nguồn: PgBouncer config · PostgreSQL `max_connections`
- [ ] `DB-PERF-005` **MUST** `statement_timeout` đặt ở mức vai trò ứng dụng (không phải `postgresql.conf` toàn cục) và `idle_in_transaction_session_timeout` bật để không giữ khoá/chặn vacuum. → Kiểm: `ALTER ROLE app SET statement_timeout = …` trong migration; `SHOW idle_in_transaction_session_timeout` ≠ 0 cho vai trò app. · Nguồn: PostgreSQL 18 runtime-config-client (khuyến nghị không đặt toàn cục)
- [ ] `DB-PERF-008` **MUST** Autovacuum bật; bảng ghi nhiều có tham số autovacuum riêng; có cảnh báo tuổi XID (wraparound) và bloat. → Kiểm: `SHOW autovacuum` = on; cảnh báo `age(datfrozenxid)` trước ngưỡng 2^31 (PostgreSQL cảnh báo ở 40 triệu còn lại, từ chối ở 3 triệu); dashboard dead tuples. · Nguồn: PostgreSQL 18 §24.1 Routine Vacuuming

### Migration có phiên bản, lũy đẳng, đường lùi, expand/contract

Nguồn khung: [`09-database/migrations.md`](.xtemplates/framework/09-database/migrations.md)

- [ ] `DB-MIG-001` **MUST** Mọi thay đổi schema là file migration có phiên bản trong repo, áp bằng công cụ, không sửa tay trên môi trường chung. → Kiểm: bảng lịch sử migration (`schema_migrations`/`flyway_schema_history`/`alembic_version`…) khớp file trong repo; script drift (`atlas schema diff` / `supabase db diff` / `prisma migrate diff`) = rỗng trong CI. · Nguồn: P5 · catalog 23 §4.3 (Supabase migrations)
- [ ] `DB-MIG-003` **MUST** Migration đã áp lên môi trường chung không được sửa; CI/hook chặn sửa file migration cũ. → Kiểm: checksum của công cụ (Flyway/Liquibase/Atlas) hoặc script so SHA file migration với nhánh chính; hook `deny` khi sửa `migrations/<đã áp>`. · Nguồn: catalog 23 §4.3 (`protect-config.sh`) · `research/2026-10-13-stored-catalog-extraction.md`
- [ ] `DB-MIG-008` **MUST** Không đổi kiểu/đổi tên cột đang dùng tại chỗ; dùng expand/contract: cột mới → code ghi cả hai → backfill theo lô → chuyển đọc → xoá cũ ở phát hành sau. → Kiểm: squawk rule `ban-drop-column`/`renaming-column`/`changing-column-type` chặn trong CI; PR contract trỏ PR expand đã phát hành. · Nguồn: PostgreSQL 18 ALTER TABLE (ALTER TYPE rewrite + double disk)
- [ ] `DB-MIG-011` **MUST** Trước migration chạm dữ liệu production: backup/snapshot mới (hoặc PITR đã kiểm) và kế hoạch lùi ghi trong PR. → Kiểm: PR template có mục "Backup trước migrate: <link>"; runbook deploy có bước kiểm backup. · Nguồn: [`backup-and-recovery.md`](.xtemplates/framework/09-database/backup-and-recovery.md) · khung cũ `01-process-and-standards.md` GĐ6

### Tìm kiếm toàn văn, vector, hybrid, phân trang kết quả

Nguồn khung: [`09-database/search-and-vector.md`](.xtemplates/framework/09-database/search-and-vector.md)

- [ ] `DB-SEARCH-001` **MUST** Index tìm kiếm/vector tái dựng được từ nguồn sự thật bằng một lệnh; thời gian tái dựng đo và ghi. → Kiểm: `scripts/reindex.*` tồn tại; test CI tái dựng trên dữ liệu mẫu rồi truy vấn mẫu trả đúng; thời gian trong `docs/ops/RPO-RTO.md`. · Nguồn: P5 · [`backup-and-recovery.md`](.xtemplates/framework/09-database/backup-and-recovery.md) DB-BACKUP-018
- [ ] `DB-SEARCH-002` **MUST** Đồng bộ CSDL → index (ngoài Postgres) đi qua outbox/CDC hoặc job lũy đẳng; không ghi index trong cùng request ghi CSDL. → Kiểm: grep client search không nằm trong transaction/handler ghi; test tắt search engine → ghi CSDL vẫn thành công, index bắt kịp sau. · Nguồn: [`../05-architecture/integration-patterns.md`](.xtemplates/framework/05-architecture/integration-patterns.md) ARC-INT-003
- [ ] `DB-SEARCH-003` **MUST** Kết quả tìm kiếm chỉ chứa bản ghi người dùng có quyền thấy: lọc tenant/ACL ở truy vấn (pre-filter) hoặc index theo tenant; không lọc sau top-k. → Kiểm: test người dùng A tìm từ khoá chỉ có trong dữ liệu B → 0 kết quả; với pgvector có lọc: `hnsw.iterative_scan` bật hoặc partial index theo tenant. · Nguồn: pgvector README (filtering/iterative scan) · [`sensitive-data-and-access.md`](.xtemplates/framework/09-database/sensitive-data-and-access.md)
- [ ] `DB-SEARCH-004` **MUST** FTS PostgreSQL dùng cột `tsvector` lưu sẵn (generated/trigger) + GIN; truy vấn dùng đúng cấu hình với cột; không `to_tsvector()` tính lại mỗi truy vấn trên bảng lớn. → Kiểm: schema có cột `search_vector tsvector GENERATED ALWAYS AS (...) STORED` + `USING GIN`; EXPLAIN truy vấn tìm kiếm dùng Bitmap Index Scan. · Nguồn: PostgreSQL 18 §12 Full Text Search

### Dữ liệu nhạy cảm: mã hoá, RLS, quyền tối thiểu, mặt nạ, xoá

Nguồn khung: [`09-database/sensitive-data-and-access.md`](.xtemplates/framework/09-database/sensitive-data-and-access.md)

- [ ] `DB-SEC-002` **MUST** Ứng dụng kết nối bằng vai trò riêng, không superuser/không owner bảng, chỉ có `SELECT/INSERT/UPDATE/DELETE` trên bảng cần; migration dùng vai trò khác. → Kiểm: `SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname='app'` = false; `\dp` không có quyền thừa; `DATABASE_URL` runtime ≠ `MIGRATION_DATABASE_URL`. · Nguồn: OWASP Database Security Cheat Sheet (least privilege, tài khoản riêng)
- [ ] `DB-SEC-003` **MUST** Kết nối CSDL qua TLS với xác minh chứng chỉ (`sslmode=verify-full`/tương đương), máy chủ từ chối kết nối không mã hoá; không `trust`/`password` trong `pg_hba.conf`. → Kiểm: `pg_hba.conf` chỉ `hostssl` + `scram-sha-256`; connection string có `sslmode=verify-full`; test kết nối `sslmode=disable` bị từ chối. · Nguồn: OWASP Database Security Cheat Sheet (TLS 1.2+)
- [ ] `DB-SEC-004` **MUST** Bí mật kết nối không trong code/log; xoay được không downtime (ứng dụng đọc lại); log truy vấn không in tham số nhạy cảm. → Kiểm: gitleaks 0 phát hiện; `log_statement` ≠ all ở production hoặc tham số bị che; runbook xoay mật khẩu đã thử. · Nguồn: [`../12-security/secrets-management.md`](.xtemplates/framework/12-security/secrets-management.md)
- [ ] `DB-SEC-007` **MUST** Dữ liệu nhiều tenant/user được bảo vệ bằng RLS: mọi bảng có `tenant_id`/`user_id` bật `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy `USING` và `WITH CHECK` theo biến phiên đặt bằng `SET LOCAL` trong transaction. → Kiểm: script catalog: 0 bảng có `tenant_id` mà `relrowsecurity = false` hoặc `relforcerowsecurity = false`; test tích hợp: phiên tenant A `SELECT/UPDATE/DELETE` bảng → 0 dòng của B, `INSERT` với `tenant_id` B bị từ chối. · Nguồn: PostgreSQL 18 §5.9 Row Security Policies · CREATE POLICY (USING/WITH CHECK, PERMISSIVE/RESTRICTIVE)

### Giao dịch, cô lập, khoá, idempotency, tính nhất quán

Nguồn khung: [`09-database/transactions-and-consistency.md`](.xtemplates/framework/09-database/transactions-and-consistency.md)

- [ ] `DB-TX-001` **MUST** Luồng đọc-rồi-ghi có điều kiện (số dư, tồn kho, hạn mức, ghế/slot) được bảo vệ bằng `FOR UPDATE` hoặc `SERIALIZABLE`, chứng minh bằng test đồng thời. → Kiểm: test chạy ≥ 2 giao dịch song song (threads/processes) cùng trừ → tổng đúng, không âm; test đỏ khi bỏ khoá (mutation thủ công ghi trong PR). · Nguồn: PostgreSQL 18 §13.2 (Read Committed không chặn lost update giữa hai read-modify-write)
- [ ] `DB-TX-002` **MUST** Mọi transaction ở `REPEATABLE READ`/`SERIALIZABLE` được bọc retry toàn bộ khi SQLSTATE `40001` (serialization) và `40P01` (deadlock), có trần số lần + backoff. → Kiểm: helper `run_in_tx(retry_on=['40001','40P01'])` dùng ở mọi nơi (grep không có `BEGIN ISOLATION LEVEL` ngoài helper); test chèn `40001` → chạy lại thành công. · Nguồn: PostgreSQL 18 §13.2.3 (ứng dụng phải retry serialization failure)
- [ ] `DB-TX-003` **MUST** Không gọi mạng/HTTP/LLM/hàng đợi/chờ người dùng **bên trong transaction CSDL** (giữ khoá, cạn pool, mất bản ghi khi crash sau lời gọi); `idle_in_transaction_session_timeout` bật. Nguyên tắc outbox cho tác động phụ: xem [`ARC-INT-003`](.xtemplates/framework/05-architecture/integration-patterns.md). → Kiểm: lint/semgrep rule cấm client HTTP/broker trong khối transaction; cấu hình `idle_in_transaction_session_timeout` (DB-PERF-005). · Nguồn: PostgreSQL 18 §13.3.4 (giữ transaction mở khi chờ người dùng là "bad idea")
- [ ] `DB-TX-004` **MUST** Khoá idempotency/mã giao dịch ngoài (mã thanh toán, `webhook-id`) có ràng buộc `UNIQUE` ở CSDL; xử lý trùng bằng `ON CONFLICT`/bắt lỗi unique, không bằng `SELECT` rồi `INSERT`. → Kiểm: schema có UNIQUE; test chèn trùng đồng thời (2 tiến trình) → đúng một bản ghi. · Nguồn: ARC-INT-001 · catalog 23 §4.1 (SePay idempotent)

### CI/CD: job gate, required check, cache, bảo mật pipeline

Nguồn khung: [`10-workflow/ci-cd-pipeline.md`](.xtemplates/framework/10-workflow/ci-cd-pipeline.md)

- [ ] `WF-CI-001` **MUST** Có job `quality` gom mọi cổng chất lượng (một job luôn chạy; nếu tách job con thì `needs` mọi job cổng và fail khi bất kỳ job con không `success`). Ruleset đòi đúng 2 required check `quality` · `gitleaks` (không có `merge-gate` — máy không bật auto-merge nên không còn gì để chặn, ADR-0036); `protection-guard` và quét lỗ hổng phụ thuộc là job con trong `quality.needs` (repo khung giữ thêm context `protection-guard`, `dep-audit` riêng — D-116, D-117); mỗi context phải là job có thật, `protection-guard` đối chiếu tên ([`git-and-branching.md`](.xtemplates/framework/10-workflow/git-and-branching.md)). → Kiểm: `.github/rulesets/main.json` có đủ 2 context đó (mẫu dự án đích: [`../templates/ruleset-main.json`](.xtemplates/framework/templates/ruleset-main.json)); `protection-guard` đỏ khi context không khớp job nào trong `.github/workflows/`; nếu tách job con, `quality` có `if: always()` kiểm `needs` (không `!cancelled()`: run bị huỷ thì `quality` thành `skipped`, mà job bị điều kiện bỏ qua báo "Success" — required check tính đạt). · Nguồn: catalog 23 §2.5 (gate aggregator ADR-0003), 13 §4b
- [ ] `WF-CI-003` **MUST** `permissions:` khai báo tường minh ở cấp workflow với mặc định `contents: read`; job cần ghi (release, comment) tự nâng tối thiểu; không dùng `write-all`. → Kiểm: actionlint/zizmor không cảnh báo thiếu permissions; grep `permissions: write-all` = 0. · Nguồn: GitHub Security hardening for Actions
- [ ] `WF-CI-004` **MUST** Không nội suy input không tin cậy (`github.event.pull_request.title/body`, branch name, issue) trực tiếp vào `run:`; đưa qua `env:` và quote; `pull_request_target`/`workflow_run` không checkout code PR. → Kiểm: zizmor `template-injection`/`dangerous-triggers` = 0 finding. · Nguồn: GitHub Security hardening (script injection)
- [ ] `WF-CI-005` **MUST** Action bên thứ ba ghim full commit SHA (kèm comment version); Dependabot ecosystem `github-actions` bật; chi tiết chuỗi cung ứng ở [`../12-security/supply-chain.md`](.xtemplates/framework/12-security/supply-chain.md). → Kiểm: `pinact`/zizmor `unpinned-uses` = 0; `dependabot.yml` có `github-actions`. · Nguồn: GitHub Security hardening (pin SHA)

### Code review: người + AI, checklist, SLA, ranh giới

Nguồn khung: [`10-workflow/code-review.md`](.xtemplates/framework/10-workflow/code-review.md)

- [ ] `WF-REVIEW-001` **MUST** PR chỉ được xin review khi cổng máy đã xanh (lint, format, type, test, scan); reviewer được phép từ chối review PR đỏ. → Kiểm: job `quality` là required check; PR template có mục "CI xanh". · Nguồn: P9
- [ ] `WF-REVIEW-002` **MUST** Mỗi PR có mô tả: mục tiêu, link spec/issue, **cách đã xác minh** (lệnh + kết quả/exit code hoặc link CI), rủi ro và cách rollback; thiếu → chưa đủ điều kiện review. → Kiểm: `pr-policy` job kiểm các mục bắt buộc trong body. · Nguồn: catalog 23 §2.5 (mục bắt buộc Summary/Validation/Risk)
- [ ] `WF-REVIEW-005` **MUST** Finding mức `blocker` phải được sửa hoặc bác bỏ có lý do trước merge; `required_review_thread_resolution` bật; tác giả không tự resolve thread blocker của người khác. → Kiểm: ruleset có `required_review_thread_resolution: true`; review log. · Nguồn: GitHub Rulesets
- [ ] `WF-REVIEW-007` **MUST** Vùng nhạy cảm (auth, payment, migration, `.github/`, hook, ruleset, secrets, crypto, PII) luôn có người review là code owner; không fast-lane; không auto-merge — trừ khi chủ dự án chọn `merge_autonomy: L3` (PR làn chuẩn — vùng nhạy cảm theo đường dẫn, PII qua nhãn `risk:pii` hoặc `merge_risk_paths` — review sạch ở đúng head rồi máy merge ghim head, ADR-0015/ADR-0024/ADR-0036 của repo khung): khi đó miễn cho `.github/`, hook, ruleset, migration (ghi `[~] — Miễn:` kèm lý do); auth, payment, secrets, crypto, PII vẫn người review và merge ở mọi mức (`LOOP-STOP-005`, ADR-0016). → Kiểm: CODEOWNERS có mục; `require_code_owner_review` hoặc guard kiểm đường dẫn ↔ reviewer. · Nguồn: catalog 23 §2.6 (auth/payment/crypto luôn lane kiến trúc)

### Tài liệu sống: ADR, runbook, docs-as-code, tươi bằng máy

Nguồn khung: [`10-workflow/documentation-workflow.md`](.xtemplates/framework/10-workflow/documentation-workflow.md)

- [ ] `WF-DOC-001` **MUST** Tài liệu ở dạng text trong repo (Markdown/AsciiDoc), thay đổi hành vi đi cùng PR với cập nhật tài liệu liên quan; không có "sẽ cập nhật docs sau". → Kiểm: PR template mục "Docs cập nhật/không cần (lý do)"; `pr-policy` cảnh báo khi đổi public API/CLI/config mà không chạm `docs/`. · Nguồn: Write the Docs — Docs as Code
- [ ] `WF-DOC-002` **MUST** Link check nội bộ + ngoại trong CI: mọi link tương đối trỏ file có thật; link ngoài không 404 (cache, retry, allowlist domain chặn bot). → Kiểm: `lychee` hoặc `scripts/check-links.py` exit 0. · Nguồn: P5
- [ ] `WF-DOC-008` **MUST** Runbook vận hành (`docs/ops/RUNBOOK.md` theo [`../templates/RUNBOOK.md`](.xtemplates/framework/templates/RUNBOOK.md)) cho: deploy, rollback, khôi phục backup, xoay secret, sự cố thường gặp — mỗi mục có lệnh thật và ngày diễn tập gần nhất ≤ 6 tháng. → Kiểm: lint runbook có trường `last_drilled`; cảnh báo quá hạn. · Nguồn: lifecycle G8, [`../15-operations/incident-response.md`](.xtemplates/framework/15-operations/incident-response.md)

### Môi trường dev/staging/prod, cấu hình, secrets theo môi trường

Nguồn khung: [`10-workflow/environments-and-config.md`](.xtemplates/framework/10-workflow/environments-and-config.md)

- [ ] `WF-ENV-006` **MUST** Cùng artefact/image cho staging và prod (tag theo commit SHA), chỉ cấu hình khác; không build riêng cho prod. → Kiểm: digest image staging == prod cho cùng release; log deploy ghi digest. · Nguồn: 12-factor V
- [ ] `WF-ENV-008` **MUST** Deploy prod qua gate: `environment: production` có required reviewers (≠ người kích), deployment branches giới hạn `main`/tag; staging tự động. → Kiểm: cấu hình environment có reviewer + prevent self-review; log deploy có người duyệt. · Nguồn: GitHub Managing environments for deployment
- [ ] `WF-ENV-010` **MUST** Dữ liệu staging/preview là seed/synthetic hoặc đã ẩn danh hoá; không copy PII prod; quy trình ẩn danh có kiểm. → Kiểm: script seed/anonymize trong repo; quét PII mẫu trên staging = 0; xem [`../16-compliance-privacy/privacy-by-design.md`](.xtemplates/framework/16-compliance-privacy/privacy-by-design.md).
- [ ] `WF-ENV-012` **MUST** Thay đổi cấu hình prod có dấu vết (ai, khi nào, giá trị cũ/mới đã che bí mật) và đảo ngược được; cấu hình hạ tầng là code ([`../15-operations/infrastructure-as-code.md`](.xtemplates/framework/15-operations/infrastructure-as-code.md)). → Kiểm: audit log secret manager/IaC history; không sửa tay trên console không qua PR (policy).

### Git, nhánh, commit, PR nhỏ, lịch sử sạch

Nguồn khung: [`10-workflow/git-and-branching.md`](.xtemplates/framework/10-workflow/git-and-branching.md)

- [ ] `WF-GIT-001` **MUST** Không push thẳng nhánh chính; mọi thay đổi qua PR (kể cả một người, kể cả bot/agent). → Kiểm: ruleset nhánh mặc định có rule `pull_request`; `git log --merges`/`--first-parent main` không có commit ngoài squash PR. · Nguồn: GitHub Rulesets
- [ ] `WF-GIT-002` **MUST** Ruleset nhánh chính lưu dưới dạng code (`.github/rulesets/main.json`), gồm: cấm xoá, cấm force-push (`non_fast_forward`), `pull_request` (resolve thread, chỉ squash — hoặc rebase theo ngoại lệ có ADR của `WF-GIT-005`), `required_status_checks` trỏ tới các job có thật `quality`, `gitleaks` (ADR-0036; `protection-guard`, quét phụ thuộc là job con của `quality`; repo khung thêm hai context đó — D-116, D-117), không đòi "up to date" theo `BASE-GATE-007`; `bypass_actors: []`. → Kiểm: file tồn tại (mẫu dự án đích `framework/templates/ruleset-main.json`); `GET /repos/{o}/{r}/rules/branches/main` chứa đủ 4 loại rule. · Nguồn: GitHub REST Rules, khung cũ `rulesets/main.json`
- [ ] `WF-GIT-003` **MUST** Job CI `protection-guard` **đỏ** khi required check trong ruleset không khớp tên job thật trong `.github/workflows/` (chống khoá nhánh do đổi tên job) và **cảnh báo** (không đỏ) khi ruleset chưa hiệu lực trên nhánh mặc định; dự án đã import ruleset đổi `::warning` thành `exit 1` để ép. → Kiểm: job tồn tại; test đổi tên job `quality` trong nhánh thử → guard đỏ; nhánh mặc định thiếu rule → log có `::warning`. · Nguồn: khung cũ `ci.yml` job `protection-guard` (commit `1b80fe4`)
- [ ] `WF-GIT-010` **MUST** `.gitignore` đủ (build, env, secrets, IDE, OS); không commit `.env`, khoá, dump dữ liệu; secret scan ở hook + CI toàn lịch sử theo [`../12-security/secrets-management.md`](.xtemplates/framework/12-security/secrets-management.md). → Kiểm: `gitleaks git --log-opts="--all"` sạch; `.env` không có trong `git ls-files`.

### Phát hành, SemVer, CHANGELOG, tag, rollback

Nguồn khung: [`10-workflow/release-and-versioning.md`](.xtemplates/framework/10-workflow/release-and-versioning.md)

- [ ] `WF-REL-001` **MUST** Phiên bản theo SemVer 2.0.0 và được sinh tự động từ Conventional Commits (release-please/changesets/semantic-release), không sửa tay số phiên bản trong PR tính năng. → Kiểm: workflow release tồn tại; `git log` không có commit tay "bump version" ngoài Release PR. · Nguồn: SemVer 2.0.0, Conventional Commits 1.0.0
- [ ] `WF-REL-003` **MUST** Mỗi phát hành có tag `vX.Y.Z` bất biến trỏ đúng commit đã qua `quality`, GitHub Release kèm ghi chú và artefact/checksum; không xoá/dời tag đã công bố. → Kiểm: ruleset tag `v*` cấm xoá/cập nhật; `gh release view vX.Y.Z` có asset + checksum. · Nguồn: GitHub Rulesets (tag target)
- [ ] `WF-REL-004` **MUST** Kế hoạch rollback ghi trong Release/runbook: bản trước là gì, lệnh lùi (deploy artefact cũ/đổi tag image), migration đi kèm tương thích ngược (expand/contract) hoặc có đường lùi; **đã diễn tập** rollback trước khi lên prod lần đầu và sau mỗi thay đổi cơ chế deploy. → Kiểm: `docs/ops/RUNBOOK` mục rollback có ngày diễn tập; migration PR link [`../09-database/migrations.md`](.xtemplates/framework/09-database/migrations.md). · Nguồn: P8, lifecycle G7
- [ ] `WF-REL-007` **MUST** Release có smoke test tự động sau deploy (luồng chính, health, phiên bản trả về khớp tag) và cửa sổ theo dõi (error rate, latency) với tiêu chí auto-rollback hoặc người quyết trong N phút. → Kiểm: job post-deploy smoke; cảnh báo theo [`../15-operations/slo-and-alerting.md`](.xtemplates/framework/15-operations/slo-and-alerting.md); runbook ghi ngưỡng lùi.

### Spec-driven: spec là hợp đồng, tiêu chí chấp nhận, truy vết

Nguồn khung: [`10-workflow/spec-driven-development.md`](.xtemplates/framework/10-workflow/spec-driven-development.md)

- [ ] `WF-SDD-001` **MUST** Mỗi tính năng (user-visible hoặc chạm dữ liệu/API/quyền) có file spec theo [`../templates/SPEC.md`](.xtemplates/framework/templates/SPEC.md) với frontmatter `status`, `approved_by`, `approved_at`; chỉ `status: approved` (hoặc "Approved for implementation") mới được bắt đầu code. → Kiểm: script liệt kê spec thiếu trường/status; PR `feat:` link spec có `status: approved`. · Nguồn: catalog 23 §2.5 (`pr-policy`: feat phải link spec Approved)
- [ ] `WF-SDD-002` **MUST** Tiêu chí chấp nhận viết dạng máy kiểm được (Given/When/Then hoặc bảng input→output), mỗi tiêu chí có ID (`AC-xx`), bao gồm ca biên (rỗng/null/quá dài/race/UTC/tiền) và ca lỗi. → Kiểm: lint spec: mục "Tiêu chí chấp nhận" có ≥ 1 `AC-` và ≥ 1 ca lỗi; xem [`../17-product-project/specification.md`](.xtemplates/framework/17-product-project/specification.md). · Nguồn: lifecycle G3
- [ ] `WF-SDD-003` **MUST** Mỗi `AC-xx` có test tham chiếu ID (tên test hoặc tag) **viết từ spec**, không chỉ test agent sinh từ diff; PR `feat` liệt kê map AC → test. → Kiểm: script grep `AC-\d+` trong test ↔ spec = phủ 100% AC bắt buộc; `pr-policy` kiểm mục map. · Nguồn: khung cũ spec §B3.1a (test viết mù từ spec), P1

### Đội, WIP, định nghĩa sẵn sàng/hoàn thành, bàn giao

Nguồn khung: [`10-workflow/team-and-wip.md`](.xtemplates/framework/10-workflow/team-and-wip.md)

- [ ] `WF-TEAM-003` **MUST** Definition of Ready trước khi bắt đầu task: tiêu chí chấp nhận đo được, không câu hỏi mở quan trọng, phụ thuộc xác định, thiết kế/luồng đủ rõ (wireframe nếu UI), phạm vi gói trong một PR; chưa Ready → hỏi, không code. → Kiểm: issue template có checklist DoR; nhãn `ready` chỉ gán khi đủ; agent kiểm DoR ở đầu task (hook/skill). · Nguồn: khung cũ `01-process-and-standards.md` GĐ1 DoR
- [ ] `WF-TEAM-004` **MUST** Definition of Done có bằng chứng: tiêu chí chấp nhận có test xanh (link CI), cổng máy xanh, trạng thái lỗi/rỗng/tải xử lý, không secret/rác, tự review diff, docs cập nhật, deploy thử (staging/preview) OK; tick DoD không kèm bằng chứng = chưa Done. → Kiểm: PR template DoD mỗi mục có chỗ ghi bằng chứng; blueprint tick theo bằng chứng (`xt.py blueprint-status --strict`). · Nguồn: Scrum Guide 2020 (Definition of Done), P1
- [ ] `WF-TEAM-005` **MUST** Bàn giao (cuối phiên/cuối ngày/đổi người): cập nhật `PROGRESS.md` mục Đang làm / Tiếp theo / Bàn giao với lệnh để tiếp tục và những gì **chưa xác minh**; không bàn giao bằng chat. → Kiểm: `PROGRESS.md` thay đổi cùng commit cuối phiên; hook SessionStart nạp được; định dạng và độ tươi theo [`LOOP-HARNESS-004`](.xtemplates/framework/11-autonomous-loop/harness-files.md)/[`005`](.xtemplates/framework/11-autonomous-loop/harness-files.md). · Nguồn: [`documentation-workflow.md`](.xtemplates/framework/10-workflow/documentation-workflow.md), `/handover`
- [ ] `WF-TEAM-007` **MUST** Khi có ≥ 2 người: approval ≥ 1 từ người khác tác giả; CODEOWNERS cho vùng nhạy cảm; luân phiên review để không một người là nút thắt. → Kiểm: ruleset `required_approving_review_count ≥ 1`; thống kê review phân bố (không > 70% một người). · Nguồn: [`git-and-branching.md`](.xtemplates/framework/10-workflow/git-and-branching.md), [`code-review.md`](.xtemplates/framework/10-workflow/code-review.md)

### Ngân sách context/token, compaction, bàn giao phiên

Nguồn khung: [`11-autonomous-loop/context-and-token-budget.md`](.xtemplates/framework/11-autonomous-loop/context-and-token-budget.md)

- [ ] `LOOP-CTX-001` **MUST** SessionStart chỉ nạp 4 mục của `PROGRESS.md` (Đang làm · Tiếp theo · Quyết định · Bàn giao phiên) để phiên sau tiếp tục; định dạng và độ tươi theo [`LOOP-HARNESS-004`](.xtemplates/framework/11-autonomous-loop/harness-files.md)/[`LOOP-HARNESS-005`](.xtemplates/framework/11-autonomous-loop/harness-files.md). → Kiểm: chạy `session-start.sh` với PROGRESS mẫu chỉ in 4 mục đó (cắt ở 8 KB). · Nguồn: stored 03 §6; `.claude/hooks/session-start.sh`
- [ ] `LOOP-CTX-002` **MUST** Mỗi lần chạy headless hoặc `loop init` khai trần: `--max-iterations`/`--hours` và (headless) `--max-turns` + `--max-budget-usd`. → Kiểm: `.autopilot/state.json` có `max_iterations`, `deadline`; JSON headless có `total_cost_usd`. · Nguồn: [`loop-design.md`](.xtemplates/framework/11-autonomous-loop/loop-design.md)
- [ ] `LOOP-CTX-006` **MUST** Mọi thứ cần cho phiên sau nằm trong repo (PLAN, PROGRESS, SPEC, ADR, evidence hoặc link CI), không phụ thuộc trí nhớ phiên trước. → Kiểm: phiên mới với chỉ `AGENTS.md` + PROGRESS tiếp tục được đúng task (test bằng phiên thật). · Nguồn: stored 03 §6
- [ ] `LOOP-CTX-017` **MUST** Bàn giao chỉ khi chạm ≥ 80% **trần máy** (vòng/giờ/tiền), không vì context: context đầy → compaction có checkpoint rồi làm tiếp; khi bàn giao: chỗ dở + bước kế tiếp + SHA vào PROGRESS, commit + push, không mở task mới. → Kiểm: `.claude/settings.json` có hook `PreCompact`; PROGRESS "Bàn giao phiên" chỉ cập nhật khi `loop status --json` `iterations/max_iterations` ≥ 0.8 hoặc verdict `budget`. · Nguồn: ADR-0009, stored 21 §10

### Phản hồi về khung từ dự án đích

Nguồn khung: [`11-autonomous-loop/framework-feedback.md`](.xtemplates/framework/11-autonomous-loop/framework-feedback.md)

- [ ] `LOOP-FB-003` **MUST** Phản hồi không chứa bí mật, dữ liệu người dùng, tên khách hàng hay mã nguồn của dự án — chỉ triệu chứng, bước tái hiện tối thiểu, cách khắc phục; ghi qua `xt.py feedback` (gộp một dòng, `redact`) và người xem lại trước commit. → Kiểm: `gitleaks detect` sạch trên `docs/xtemplates-feedback/`; review PR có mục này. · Nguồn: ADR-0010, `CMP-VN-004`

### File harness: PLAN · PROGRESS · BLUEPRINT · evidence · state

Nguồn khung: [`11-autonomous-loop/harness-files.md`](.xtemplates/framework/11-autonomous-loop/harness-files.md)

- [ ] `LOOP-HARNESS-001` **MUST** `PLAN.md` dùng đúng cú pháp parser: mỗi task một dòng bắt đầu bằng `- [ ]` rồi mã `T-NNN` trong backtick, việc, và `Gate:` theo sau là lệnh trong backtick; không lồng danh sách con. → Kiểm: `xt.py loop status` không báo "PLAN không có task"; số task parse được = số dòng `T-`.
- [ ] `LOOP-HARNESS-002` **MUST** Lệnh Gate của mỗi task lấy từ `xt.yaml`/`dev-task.sh` hoặc là lệnh test cụ thể, chạy được trên máy sạch; không ghi "kiểm tay". → Kiểm: `grep -c 'Gate: `' docs/autopilot/PLAN.md` = số task; mỗi Gate chạy được trong CI.
- [ ] `LOOP-HARNESS-003` **MUST** `PLAN.md` ghi đủ 4 con số theo [`LOOP-DESIGN-001`](.xtemplates/framework/11-autonomous-loop/loop-design.md) (trần vòng · ngân sách tiền/token · timeout mỗi lệnh kiểm · hạn chót) và danh sách điểm dừng bắt buộc dự kiến trước cổng duyệt. → Kiểm: mục "Ngân sách" và "Điểm dừng" tồn tại; trần vòng và hạn khớp tham số `loop init`.
- [ ] `LOOP-HARNESS-008` **MUST** Nhà của bộ khoá `xt.yaml` (mẫu: [`../templates/xt.yaml`](.xtemplates/framework/templates/xt.yaml)): khai `lint`, `test`, `typecheck`, `build` (chuỗi rỗng nếu không áp dụng); agent không suy diễn lệnh từ README. `scripts/dev-task.sh` chỉ chạy các khoá `format · lint · typecheck · test · build · format_file` (`gate` = build→typecheck→lint→test — cổng đầy đủ, CI chạy đúng lệnh này) và `format_check · test_fast` (`gate-fast` = format_check→lint→typecheck→test_fast, test liên quan file đổi qua `XT_CHANGED_FILES`, test_fast trống → `test`; hook commit chạy nó khi `commit_gate: fast`, vắng = `full` = `gate`; cổng đầy đủ chạy một lần trước khi mở PR/đẩy); `e2e`/`e2e_setup` (`dev-task.sh e2e`) do CI mẫu gọi (D-115); khoá khác (`install`, `dev`, `coverage`, `migrate`, `init`, `smoke`, `audit`…) là lệnh khai báo để agent **đọc và chạy trực tiếp**, dev-task không chạy. Khi autopilot đang chạy, `lint`/`test` rỗng hoặc no-op (`true`, `:`, `exit 0`, `echo …`) làm cổng **đỏ** (ADR-0011 của repo khung). Ở quy mô M/L cổng còn phải đạt sàn `LOOP-HARNESS-023`. → Kiểm: `scripts/dev-task.sh gate` chạy đúng lệnh khai; `xt.yaml` tồn tại ở gốc; `xt.py loop init` không in `Cổng sẽ ĐỎ`. · Nguồn: stored 23 §3.3

### Thiết kế vòng lặp: 4 con số, tiêu chí dừng máy kiểm, bằng chứng

Nguồn khung: [`11-autonomous-loop/loop-design.md`](.xtemplates/framework/11-autonomous-loop/loop-design.md)

- [ ] `LOOP-DESIGN-001` **MUST** Nhà của "4 con số": vòng lặp khai đủ trước khi chạy trần vòng · ngân sách tiền/token · timeout mỗi lệnh kiểm · hạn chót. → Kiểm: `.autopilot/state.json` có `max_iterations` và `deadline` (từ `loop init --max-iterations N --hours H`); lệnh headless có `--max-turns` + `--max-budget-usd`; `XT_RECORD_TIMEOUT` (mặc định 1800 s) ghi trong `PLAN.md`. · Nguồn: stored 21 §10
- [ ] `LOOP-DESIGN-003` **MUST** Task chỉ được tick `[x]` sau khi `xt.py loop record --task T-xxx -- <đúng lệnh Gate>` trả exit 0. → Kiểm: `.autopilot/evidence/T-xxx.json` có `exit_code: 0` và `cmd` bằng chuỗi Gate; `loop status` không trả `verify`.
- [ ] `LOOP-DESIGN-004` **MUST** Tín hiệu dừng đọc từ file trạng thái/bằng chứng, không từ chuỗi model in ra (promise string) hay phán quyết của model đánh giá transcript. → Kiểm: `.claude/settings.json` có Stop hook gọi `xt.py loop hook-stop`; không có hook nào grep `<promise>`; `/goal` nếu dùng chỉ là lớp phụ. · Nguồn: stored 23 §2.2
- [ ] `LOOP-DESIGN-008` **MUST** Có phát hiện không-tiến-triển ngoài trần vòng: Stop hook không chặn vô hạn khi model không gọi tool. → Kiểm: `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` giữ mặc định 8 (không đặt `0`); `hook-stop` tăng `iterations` mỗi lần chặn. · Nguồn: Claude Code docs env-vars

### Vòng tối ưu hiệu năng trong autopilot: đo → profile → một thay đổi → máy quyết giữ/hoàn tác

Nguồn khung: [`11-autonomous-loop/optimization-loop.md`](.xtemplates/framework/11-autonomous-loop/optimization-loop.md)

- [ ] `LOOP-OPT-001` **MUST** Task tối ưu chỉ mở khi có **mục tiêu số kèm điều kiện đo** ([`XC-PERF-001`](.xtemplates/framework/18-cross-cutting/performance-engineering.md)) hoặc ngân sách đang bị vượt; không có số thì không tối ưu. → Kiểm: dòng task trong `PLAN.md` nêu mục tiêu số và Gate chứa `perf compare`. · Nguồn: ý "ngân sách trước, đo sau" của `QA-PERF`.
- [ ] `LOOP-OPT-002` **MUST** **Bộ đo khoá:** harness đo, bộ test tương đương hành vi, input đo, **script Gate và công cụ chấm (`xt.py perf`)** nằm ngoài quyền sửa của agent trong task tối ưu — Gate chạy bản của commit gốc; Gate chạy `perf guard --locked …` và đỏ khi diff đụng chúng (kể cả xoá). → Kiểm: Gate lấy từ commit gốc (`git show <base>:…`) và chạy `perf guard --base <base> --locked '<glob bộ đo>' --locked '<script Gate>'` exit 0 bằng `xt.py` của commit gốc. · Nguồn: autoresearch (`prepare.py` "không sửa"); METR 2025-06-05 (hàm chấm bị ghi đè/thay stub).
- [ ] `LOOP-OPT-003` **MUST** **Máy quyết giữ hay hoàn tác:** chỉ giữ thay đổi khi `perf compare` = `improved` trên ≥ 10 mẫu mỗi bên (hoặc `--exact` cho đại lượng tất định), baseline đo lại trên commit gốc cùng lượt và cùng máy, **và** toàn bộ test xanh; còn lại hoàn tác — agent không tự nhận "nhanh hơn". → Kiểm: evidence `loop record` của Gate có exit 0 từ `perf compare`; Gate không đọc baseline từ file agent sửa được. · Nguồn: benchstat (Mann-Whitney U, α = 0,05, ≥ 10 lần); autoresearch (giữ nếu metric tốt hơn).
- [ ] `LOOP-OPT-004` **MUST** **Một giả thuyết, một thay đổi, một lần đo:** ghi kỳ vọng và falsifier trước khi đo ([`LOOP-DESIGN-021`](.xtemplates/framework/11-autonomous-loop/loop-design.md) áp dụng cho số đo); gộp nhiều thay đổi thì không biết cái nào có tác dụng, cái nào gây hại. → Kiểm: mô tả PR/`PERF-LOG.md` có giả thuyết + falsifier có trước số đo (đối chiếu thứ tự commit).

### Điều phối: subagent, worktree, song song, không lồng

Nguồn khung: [`11-autonomous-loop/orchestration-and-subagents.md`](.xtemplates/framework/11-autonomous-loop/orchestration-and-subagents.md)

- [ ] `LOOP-ORCH-001` **MUST** Chỉ phiên chính điều phối; subagent không gọi subagent (vòng lặp phát triển; sản phẩm agentic theo [`AI-AGENTIC-007`](.xtemplates/framework/13-ai-engineering/agentic-systems.md)). → Kiểm: `.claude/agents/*.md` không có `Agent` trong `tools:` **hoặc** môi trường đặt `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`. · Nguồn: stored 23 §4.4; Claude Code env-vars
- [ ] `LOOP-ORCH-003` **MUST** Subagent không được cấp quyền/tool rộng hơn phiên chính và không tự nâng mức tin cậy T0–T4 của hành động. → Kiểm: `xt.py harness-check` exit 0 (lệnh tự viết `python3 -c` bị guard chặn); `tools:` của agent là tập con; hành động T3–T4 trong output subagent bị phiên chính đưa về điểm dừng (`xt.py loop block`). · Nguồn: [`stop-points-and-escalation.md`](.xtemplates/framework/11-autonomous-loop/stop-points-and-escalation.md)
- [ ] `LOOP-ORCH-004` **MUST** Kết quả "xanh" do subagent khai chỉ được tick task sau khi phiên chính chạy lại Gate bằng `xt.py loop record`. → Kiểm: `.autopilot/evidence/T-xxx.json` tồn tại cho task đã tick; `loop status` không trả `verify`.
- [ ] `LOOP-ORCH-009` **MUST** Hành động đối ngoại (push, publish, gửi thông báo) không giao cho subagent; chỉ phiên chính làm; guard chặn hành động không đảo ngược, không hỏi (ADR-0018). → Kiểm: prompt subagent không chứa lệnh push/publish; `pre-bash-guard.sh` chặn (không `ask`) ở phiên chính. · Nguồn: [`stop-points-and-escalation.md`](.xtemplates/framework/11-autonomous-loop/stop-points-and-escalation.md)

### Agent tự sửa CI/review: giới hạn, cấm, bằng chứng

Nguồn khung: [`11-autonomous-loop/self-healing-ci.md`](.xtemplates/framework/11-autonomous-loop/self-healing-ci.md)

- [ ] `LOOP-CI-001` **MUST** Không skip/disable/xoá test, không hạ ngưỡng coverage, không tắt rule lint/type để cổng xanh. → Kiểm: diff không chứa `skip(`, `xfail`, `.only(`, `eslint-disable` mới, thay đổi `coverageThreshold`/`strict`; hook `pre-edit-guard.sh` đánh dấu khi chạm file cấu hình cổng và khi sửa file test đã có mà thêm skip/only/xfail/`@flaky` hoặc bớt assertion (mặc định cho chạy — ADR-0018; `XT_GUARD_POLICY=strict` thì hỏi). · Nguồn: `AGENTS.md` mục Luật bất biến
- [ ] `LOOP-CI-004` **MUST** Không force-push, không rebase/rewrite history nhánh người khác, không empty commit để kích CI. → Kiểm: `.claude/settings.json` deny `git push --force*`; `pre-bash-guard.sh` chặn; `git log` không có commit rỗng (`git log --format=%H --diff-filter=A`… hoặc `git show --stat` rỗng). · Nguồn: [`../10-workflow/git-and-branching.md`](.xtemplates/framework/10-workflow/git-and-branching.md)
- [ ] `LOOP-CI-008` **MUST** Workflow chạy agent chỉ kích hoạt bởi người (kiểm `author_association` hoặc nhãn do người gắn), không chạy với secret trên PR từ fork. → Kiểm: file workflow có điều kiện `if:` kiểm actor; `pull_request_target` không cấp secret cho code fork. · Nguồn: `research/2026-10-13-ai-agent-research.md` §3; stored 21 §9

### Điểm dừng bắt buộc, mức tin cậy T0–T4, leo thang

Nguồn khung: [`11-autonomous-loop/stop-points-and-escalation.md`](.xtemplates/framework/11-autonomous-loop/stop-points-and-escalation.md)

- [ ] `LOOP-STOP-001` **MUST** Lệnh phá huỷ/không đảo ngược bị **deny** ở PreToolUse (không chỉ `ask`), sau khi tách lệnh nối `; && | ||`. Lệnh lồng cũng được quét: `sh -c`/`bash -c`, `eval '…'`, backtick, `{ …; }`, `if …; then …`, heredoc/ống vào shell, `find … -delete`/`-exec rm` (gốc `/`, `~` → deny); xoá đệ quy ra ngoài gốc dự án (trừ thư mục tạm) → deny (`XT_GUARD_POLICY=strict`: ask). → Kiểm: `xt.py harness-check` exit 0 (lệnh tự viết `python3 -c` bị guard chặn); hook trả `permissionDecision: deny` cho `ls; rm -rf /`, `git push --force`, `eval 'rm -rf ~'`, `` echo `rm -rf ~` ``, `{ rm -rf ~; }`, `find / -exec rm -rf {} +`; deny cho `rm -rf ~/x` (strict: ask); test hook xanh (`tests/test_hooks.py` `GuardStoredScanTest`). · Nguồn: stored 12 §4 quy tắc 6
- [ ] `LOOP-STOP-002` **MUST** Hành động đối ngoại (merge, release, publish, deploy, gửi thông báo) đi qua guard: bộ luật đánh dấu mọi lệnh đối ngoại; không đảo ngược (huỷ repo/bí mật/hạ tầng, push nhánh chính) và merge PR ngoại lệ cứng (`merge_hard_exceptions: human`) hoặc PR chưa có review hợp lệ ở head (`eligible`/`auto_merge_ok` false, `LOOP-STOP-022`) → **deny**; bật auto-merge của GitHub (`gh pr merge --auto`, GraphQL `enablePullRequestAutoMerge`, MCP `enable_pr_auto_merge`) → **deny** phẳng ở mọi mức, mọi PR, mọi chính sách (không ghim head — mã `AUTO_MERGE_ENABLE`, ADR-0036); còn lại mặc định cho chạy, lớp đỡ là CI, ruleset nhánh, review (ADR-0018, ADR-0019); `XT_GUARD_POLICY=strict` → `ask`. Việc chạm tiền/dữ liệu người dùng thật → `loop defer` (D-023). Merge PR: máy merge ghim head khi `xt.py merge-check` trả `merge` ở đúng head — làn nhanh ở mức tự chủ ≥ L2; ở L3 mọi làn, làn nhanh khi CI xanh, làn chuẩn khi CI xanh + review sạch ở đúng head (`xt.py pr next`, `LOOP-STOP-009`, ADR-0024/0025/0036) — trừ ngoại lệ cứng (`LOOP-STOP-022`, ADR-0015, ADR-0016; `merge_hard_exceptions: auto` gồm cả ngoại lệ cứng — ADR-0020). → Kiểm: `xt.py harness-check` exit 0 (lệnh tự viết `python3 -c` bị guard chặn); `.claude/settings.json` `permissions.ask` rỗng; mặc định guard trả `deny` cho `gh repo delete`, `git push origin main`, merge PR `hard` (`GuardPolicyTest`, `MergeGuardTest`); ở `strict` guard trả `ask` cho `gh pr merge` không ghim `--match-head-commit`, có `--admin`/`--repo`, hoặc `merge-check` ≠ `merge` — cùng luật cho `gh api -X PUT …/pulls/N/merge` (ghim `sha`) và tool MCP `merge_pull_request` (ghim `expectedHeadSha`), mọi `gh api` ghi khác (cả `--input`) luôn `ask`; mọi lệnh bật auto-merge → `deny` ở cả mặc định lẫn `strict` (`AUTO_MERGE_ENABLE`); log phiên không có lệnh đối ngoại nào khác chạy tự động.
- [ ] `LOOP-STOP-003` **MUST** Sửa cấu hình cổng (lint/type/coverage/workflows/ruleset/hook) và migration đã tồn tại được guard đánh dấu — mặc định cho chạy (ADR-0018), `XT_GUARD_POLICY=strict` → `ask` — và **lý do ghi ở commit/PR**; PR đó không vào làn nhanh; tắt/bỏ qua hook → deny. → Kiểm: `pre-edit-guard.sh` trả `ask` ở `strict` cho `.github/workflows/x.yml` và file trong `migrations/` đã có; PR mô tả lý do. · Nguồn: stored 23 §4.3
- [ ] `LOOP-STOP-005` **MUST** Việc chạm tiền thật, dữ liệu người dùng thật, xác thực/phân quyền, mật mã luôn có người duyệt trước merge (T4/làn kiến trúc), ở mọi mức `merge_autonomy` kể cả L3 (ADR-0016) — trừ khi chủ dự án đặt `merge_hard_exceptions: auto` trong `xt.yaml` và ghi việc chấp nhận rủi ro (ADR/D-NNN của dự án; ADR-0020). → Kiểm: PR có nhãn `risk:` tương ứng và (khi `human`) required review của người; CI chặn merge khi thiếu; `xt.py merge-check` trả `hard` + `human` và guard chặn merge PR đó; push thêm không tự merge vì mọi đường merge của máy ghim head sau `merge-check` ở đúng head và máy không bật auto-merge (ADR-0036) — sau mỗi push chạy lại `merge-check` (làn `chuẩn` thì rà lại H..head), có `hard` (commit sau chạm auth/tiền, thêm nhãn `risk:`) thì `loop defer` (AUD-SEC-036); auto-merge do người bật trên PR `hard` → `pr next`/steward trả `disable-auto-merge`.

### Bảo mật AI: prompt injection, tool allowlist, OWASP LLM/ASI/MCP

Nguồn khung: [`12-security/ai-security.md`](.xtemplates/framework/12-security/ai-security.md)

- [ ] `SEC-AI-001` **MUST** Mọi nội dung ngoài (tài liệu, web, email, output tool, kết quả RAG, bộ nhớ) đi vào context trong trường/thẻ dữ liệu riêng có nhãn nguồn; không nối thẳng vào system prompt hay kênh lệnh. → Kiểm: code dựng prompt có hàm `wrap_untrusted(source, text)`; test snapshot prompt; review grep nối chuỗi prompt. · Nguồn: OWASP LLM01; ASI01; OWASP LLM Prompt Injection CS
- [ ] `SEC-AI-002` **MUST** Tool cấp theo allowlist tường minh cho từng agent/vai/bước; tool không có trong allowlist không gọi được (deny-by-default enforce bằng code, không bằng prompt). → Kiểm: registry tool có `allowed_tools` theo vai; test gọi tool ngoài allowlist → từ chối + log; grep không có đường "gọi tool theo tên model trả về" mà không qua registry. · Nguồn: ASI02; LLM03; khung cũ spec C5-FR-02; catalog stored 12 §4 quy tắc 1
- [ ] `SEC-AI-005` **MUST** Hành động không đảo ngược hoặc đối ngoại (gửi/đăng/xoá/thanh toán/deploy/đổi quyền) cần phê duyệt người qua middleware HITL; màn hình duyệt hiện lời gọi tool nguyên văn + nguồn dữ liệu dẫn tới nó. → Kiểm: enum `risk_tier` trên tool; test hành động tier cao không có approval → bị chặn; UI/log duyệt lưu payload thật. · Nguồn: ASI09; khung cũ spec C5-FR-08; OWASP LLM Prompt Injection CS (HITL)
- [ ] `SEC-AI-007` **MUST** Agent dùng identity theo người dùng/phiên với token TTL ngắn và scope hẹp; không dùng service account admin chung; test cross-user/cross-tenant. → Kiểm: test "agent của user A gọi tool với id của B" → 403; token có `exp` ≤ 1 giờ (đội tự chọn, ghi ADR). · Nguồn: ASI03; MCP02; MCP07; [`../08-backend/authn-authz.md`](.xtemplates/framework/08-backend/authn-authz.md)

### AppSec web/API: injection, XSS, CSRF, SSRF, IDOR, header, CSP

Nguồn khung: [`12-security/appsec-web.md`](.xtemplates/framework/12-security/appsec-web.md)

- [ ] `SEC-WEB-001` **MUST** Mọi truy vấn CSDL/lệnh hệ thống dùng tham số hoá hoặc API mảng; không nối chuỗi từ đầu vào. → Kiểm: SAST (CodeQL `js/sql-injection`, `py/sql-injection`, Semgrep `sqli`/`subprocess-shell-true`) = 0 finding; grep `shell=True`, `exec(`, `${` trong câu SQL = 0 ngoài allowlist. · Nguồn: OWASP Top 10:2025 A05; ASVS 5.0 V1
- [ ] `SEC-WEB-004` **MUST** Output người dùng vào HTML qua escape mặc định; mọi điểm tắt escape có sanitizer allowlist và comment lý do. → Kiểm: grep `dangerouslySetInnerHTML|innerHTML|v-html|\|safe|mark_safe|raw\(` — mỗi điểm nằm trong allowlist file có review; DAST XSS = 0. · Nguồn: ASVS 5.0 V1, V3; Top 10:2025 A05
- [ ] `SEC-WEB-007` **MUST** Request đổi trạng thái xác thực bằng cookie có chống CSRF: cookie phiên `SameSite=Lax|Strict` **và** một lớp chống CSRF — token (synchronizer / signed double-submit) **hoặc** kiểm `Origin`/`Sec-Fetch-Site` từ chối cross-site — cho mọi request đổi trạng thái; không dùng GET để đổi trạng thái. Đây là nhà của CSRF (`BE-AUTH-019`, `FE-SEC-016` trỏ về đây). → Kiểm: test POST/PUT/PATCH/DELETE giả cross-site (thiếu token, hoặc `Origin` lạ / `Sec-Fetch-Site: cross-site`) → 403; grep route GET có side-effect = 0; test đọc `Set-Cookie` có `SameSite`. · Nguồn: OWASP CSRF Prevention CS; ASVS 5.0 V3
- [ ] `SEC-WEB-008` **MUST** Mọi URL do người dùng cung cấp mà server sẽ gọi (webhook, import, avatar URL, preview) đi qua bộ kiểm SSRF: scheme allowlist, resolve DNS → kiểm IP không thuộc dải nội bộ/metadata, tắt redirect, timeout. → Kiểm: unit test với `http://169.254.169.254/`, `http://127.0.0.1:…`, `http://[::1]`, hostname trỏ IP nội bộ, redirect 302 sang nội bộ → bị chặn. · Nguồn: OWASP SSRF CS; API Top 10 2023 API7

### Hạ tầng & mạng: least privilege, egress, TLS, sandbox, container

Nguồn khung: [`12-security/infrastructure-and-network.md`](.xtemplates/framework/12-security/infrastructure-and-network.md)

- [ ] `SEC-INFRA-001` **MUST** Mỗi service/job có identity riêng với IAM policy tối thiểu; không policy `Action: "*"`/`Resource: "*"` ngoài break-glass có ghi lý do. → Kiểm: checkov/`iam-policy` lint = 0 wildcard; danh sách role ↔ service trong IaC. · Nguồn: NIST SP 800-207; CIS Benchmark cloud (IAM)
- [ ] `SEC-INFRA-002` **MUST** CSDL, cache, queue, kho bí mật không có địa chỉ public; chỉ reachable từ subnet/SG của ứng dụng. → Kiểm: IaC không `publicly_accessible = true`; `nmap`/cloud config scan từ ngoài → cổng đóng; checkov `CKV_AWS_17`/tương đương = 0. · Nguồn: CIS Benchmark cloud; catalog stored 07 (không publish cổng DB)
- [ ] `SEC-INFRA-003` **MUST** Ingress mở đúng cổng cần (443, và 80 chỉ để redirect); không mở SSH/RDP/DB ra `0.0.0.0/0`. → Kiểm: security group/firewall trong IaC; checkov rule cổng mở toàn cầu = 0. · Nguồn: CIS Benchmark cloud (networking)
- [ ] `SEC-INFRA-010` **MUST** Không tài khoản/mật khẩu mặc định (admin/admin, `postgres` không mật khẩu, dashboard không auth); dịch vụ quản trị (Grafana, pgAdmin, queue UI, `/metrics`) đứng sau xác thực và không public. → Kiểm: scan cấu hình: mọi dịch vụ quản trị có auth; test đăng nhập mặc định thất bại; `/metrics` trả 401/403 từ ngoài. · Nguồn: OWASP Top 10:2025 A02; catalog stored 23 §8.1

### Log bảo mật, audit trail, phát hiện, ứng phó

Nguồn khung: [`12-security/logging-audit-and-incident.md`](.xtemplates/framework/12-security/logging-audit-and-incident.md)

- [ ] `SEC-LOG-001` **MUST** Ghi sự kiện bảo mật tối thiểu: đăng nhập thành công/thất bại, đăng xuất, đổi mật khẩu/MFA, cấp/thu hồi token, từ chối quyền (403), đổi vai/quyền, hành động admin, truy cập/xuất dữ liệu nhạy cảm, upload, đổi cấu hình, lỗi validate đầu vào, lỗi deserialize, lỗi TLS/chứng chỉ backend. → Kiểm: bảng `docs/security/security-events.md` liệt kê sự kiện ↔ tên `event` trong code; test tích hợp mỗi sự kiện tạo 1 dòng log có cấu trúc. · Nguồn: OWASP Logging CS; ASVS 5.0 V16; Top 10:2025 A09
- [ ] `SEC-LOG-002` **MUST** Mỗi sự kiện bảo mật có: `timestamp` UTC ISO-8601, `event`, `actor` (user id/service id, không tên thật nếu không cần), `target` (loại + id), `outcome` (success/denied/error), `source_ip`, `user_agent`, `trace_id`/`request_id`. → Kiểm: schema log (JSON Schema) + test validate mẫu; linter log tự viết. · Nguồn: OWASP Logging CS (what to log); OTel Logs Data Model
- [ ] `SEC-LOG-006` **MUST** Log bảo mật tập trung ngoài máy ứng dụng (không chỉ file local), đồng hồ đồng bộ NTP, timestamp sinh tại nguồn. → Kiểm: cấu hình shipper (OTel Collector/agent) → kho trung tâm; `timedatectl`/NTP trên host hoặc image; lệch < 1 s. · Nguồn: OWASP Logging CS; ASVS 5.0 V16
- [ ] `SEC-LOG-007` **MUST** Audit trail cho hành động nhạy cảm (admin, quyền, export, tiền, dữ liệu cá nhân, tool call của agent) là **append-only**: app chỉ `INSERT`, không `UPDATE/DELETE`; xoá theo retention qua job riêng có ghi nhận. → Kiểm: quyền CSDL của app user trên bảng audit = INSERT/SELECT; test `UPDATE` → bị từ chối. · Nguồn: ASVS 5.0 V16; OWASP Secrets Mgmt CS (log bất biến)

### Quản lý bí mật: lưu, xoay, quét, phạm vi

Nguồn khung: [`12-security/secrets-management.md`](.xtemplates/framework/12-security/secrets-management.md)

- [ ] `SEC-SECRET-001` **MUST** Không có bí mật trong repo, kể cả lịch sử: quét toàn bộ lịch sử git bằng gitleaks ở CI; phát hiện = đỏ. → Kiểm: job `gitleaks detect --source . --log-opts="--all" --redact --exit-code 1` với `fetch-depth: 0`; báo cáo = 0 finding (false positive ghi `.gitleaksignore` có lý do). · Nguồn: OWASP Secrets Mgmt CS §Detection; Top 10:2025 A02
- [ ] `SEC-SECRET-005` **MUST** Production lấy bí mật từ kho tập trung (managed secrets/vault) lúc chạy, không từ file trong image hay biến hard-code trong IaC. → Kiểm: `docker history`/`dive` image không có bí mật; IaC không có giá trị thật (checkov `CKV_SECRET_*` = 0); cấu hình runtime trỏ ARN/đường dẫn vault. · Nguồn: OWASP Secrets Mgmt CS §Centralization; NIST SSDF PS.1
- [ ] `SEC-SECRET-007` **MUST** Bí mật không xuất hiện trong log, trace, thông báo lỗi, URL, prompt/transcript của AI. → Kiểm: logger có bộ che (redact) theo tên trường + regex khoá; test ghi log object chứa `password`/`token` → output `[REDACTED]`; gitleaks quét artifact log CI. · Nguồn: OWASP Logging CS (dữ liệu không được log); [`logging-audit-and-incident.md`](.xtemplates/framework/12-security/logging-audit-and-incident.md)
- [ ] `SEC-SECRET-011` **MUST** Khi phát hiện rò rỉ: thu hồi ngay, xoay, rà log dùng khoá trong khoảng lộ, ghi incident theo [`../15-operations/incident-response.md`](.xtemplates/framework/15-operations/incident-response.md); không chỉ xoá commit. → Kiểm: RUNBOOK có mục "Lộ bí mật" với lệnh thu hồi cho từng loại khoá; post-mortem cho mọi vụ lộ. · Nguồn: OWASP Secrets Mgmt CS §Incident response

### Chuỗi cung ứng: ghim, SBOM, chữ ký, SLSA, Scorecard, Dependabot

Nguồn khung: [`12-security/supply-chain.md`](.xtemplates/framework/12-security/supply-chain.md)

- [ ] `SEC-SUPPLY-001` **MUST** Mọi `uses:` trong workflow CI ghim **SHA commit 40 ký tự** kèm comment phiên bản; không dùng tag/branch. → Kiểm: `zizmor .github/workflows` (rule `unpinned-uses`) = 0; Scorecard Pinned-Dependencies = 10; `rg "uses: .*@(v|main|master)" .github` = 0. · Nguồn: GitHub Actions hardening; OpenSSF Scorecard; catalog stored 23 §8.1
- [ ] `SEC-SUPPLY-003` **MUST** Cài dependency ở chế độ khoá đúng lockfile (`npm ci`/`pnpm --frozen-lockfile`/`uv sync --locked`/`go mod verify`/`cargo --locked`); lockfile commit và CI đỏ nếu lockfile đổi sau cài. → Kiểm: lệnh cài trong CI; bước `git diff --exit-code <lockfile>` sau cài. · Nguồn: NIST SSDF PW.4; SLSA (build nhất quán)
- [ ] `SEC-SUPPLY-006` **MUST** Quét lỗ hổng dependency (OSV-Scanner hoặc tool hệ sinh thái) trên mỗi PR **và theo lịch tuần**; critical/high chưa có ngoại lệ có hạn = đỏ. → Kiểm: workflow `osv-scanner` chạy `pull_request` + `schedule`; file ngoại lệ `osv-scanner.toml` có `reason` + ngày hết hạn. · Nguồn: OWASP Top 10:2025 A03; catalog stored 12 (pip-audit tuần)
- [ ] `SEC-SUPPLY-009` **MUST** Workflow chạy trên `issue_comment`/`pull_request_target`/`workflow_run` có quyền ghi phải kiểm `author_association` (OWNER/MEMBER/COLLABORATOR) và **không checkout code của fork**. → Kiểm: `zizmor` rule `dangerous-triggers`/`template-injection` = 0; Scorecard Dangerous-Workflow = 10; grep workflow có `pull_request_target` + `ref: …head.sha` = 0. · Nguồn: GitHub Actions hardening; catalog stored 23 §8.1 (lỗi kế thừa từ upstream của một fork skill red-team)

### Threat model (STRIDE), tài sản, ranh giới tin cậy, biện pháp

Nguồn khung: [`12-security/threat-modeling.md`](.xtemplates/framework/12-security/threat-modeling.md)

- [ ] `SEC-TM-001` **MUST** Có file `docs/THREAT-MODEL.md` theo mẫu khung, được tạo ở G4 và cập nhật khi thêm ranh giới tin cậy mới. → Kiểm: file tồn tại; CI kiểm `updated` trong frontmatter không cũ hơn ADR kiến trúc mới nhất (script so ngày). · Nguồn: OWASP Threat Modeling CS; NIST SSDF PW.1
- [ ] `SEC-TM-003` **MUST** Có sơ đồ luồng dữ liệu (DFD) đánh dấu mọi ranh giới tin cậy: client↔server, server↔CSDL, server↔bên thứ ba, nội dung ngoài↔LLM, agent↔tool. → Kiểm: sơ đồ (Mermaid/Threat Dragon JSON) trong repo; mỗi tích hợp bên ngoài trong `docs/` hoặc cấu hình env xuất hiện trên sơ đồ. · Nguồn: OWASP Threat Modeling CS §"What are we working on"
- [ ] `SEC-TM-005` **MUST** Mỗi mối đe doạ có mức rủi ro (khả năng × tác động, 3 bậc) và quyết định: mitigate / eliminate / transfer / accept. → Kiểm: không còn hàng thiếu mức hoặc thiếu quyết định (grep bảng). · Nguồn: OWASP Threat Modeling CS §"What are we going to do"
- [ ] `SEC-TM-006` **MUST** Mọi mối đe doạ mức **Cao** có biện pháp trỏ tới ID checklist khung, test hoặc cấu hình cụ thể — không có hàng Cao ở trạng thái "accept" khi lên production. → Kiểm: `blueprint-status` của các ID được trỏ = đạt; cổng G4 chặn nếu còn Cao chưa có biện pháp. · Nguồn: NIST SSDF PW.1.1

### Coverage ratchet, mutation test, chất lượng test

Nguồn khung: [`14-testing-quality/coverage-and-mutation.md`](.xtemplates/framework/14-testing-quality/coverage-and-mutation.md)

- [ ] `QA-COV-001` **MUST** Đo coverage **nhánh** (branch) cho unit + integration, báo cáo lưu artifact CI. → Kiểm: cấu hình `--cov-branch`/`coverage.reporter` có `branches`; artifact `coverage/` tồn tại.
- [ ] `QA-COV-002` **MUST** Ratchet: CI đỏ khi coverage (lines và branches) thấp hơn baseline đã commit; baseline chỉ tăng. → Kiểm: Vitest `coverage.thresholds` (`lines`, `branches`) có giá trị số trong repo; hoặc `--cov-fail-under=<baseline>`; PR hạ baseline bị hook hỏi lý do. · Nguồn: catalog 23 §3.3 (coverage ratchet), Vitest docs `coverage.thresholds`
- [ ] `QA-COV-004` **MUST** Không test nào không có assertion; snapshot không là assertion duy nhất cho logic nghiệp vụ. → Kiểm: lint `expect-expect` (eslint-plugin-vitest/jest), `pytest` plugin/grep `assert` mỗi test; review.
- [ ] `QA-COV-008` **MUST** Không sửa cấu hình coverage/mutation để "cho xanh" (hạ ngưỡng, thêm exclude, tắt break) mà không có lý do và duyệt. → Kiểm: hook PreToolUse hỏi khi sửa `vitest.config`/`.coveragerc`/`stryker.config`/`pyproject [tool.coverage]`; PR diff cấu hình cổng cần reviewer.

### E2E & a11y: Playwright/axe, mobile, flaky, trace

Nguồn khung: [`14-testing-quality/e2e-and-accessibility.md`](.xtemplates/framework/14-testing-quality/e2e-and-accessibility.md)

- [ ] `QA-E2E-001` **MUST** Có E2E cho luồng chính (ít nhất: đăng nhập/đăng ký, thao tác lõi tạo giá trị, thanh toán nếu có) chạy trong CI trên mọi PR. → Kiểm: test tag `@smoke` ≥ 3; job `e2e` required.
- [ ] `QA-E2E-003` **MUST** Mỗi E2E (hoặc mỗi trang chính) kèm quét axe với tag đến `wcag22aa`, 0 vi phạm `critical`/`serious`. → Kiểm: helper `expectNoA11yViolations(page)` được gọi trong mọi spec `@smoke`; CI đỏ khi có vi phạm. · Nguồn: WCAG 2.2 AA
- [ ] `QA-E2E-005` **MUST** `forbidOnly` bật ở CI; `retries` ≤ 2; `trace: 'on-first-retry'`; `workers` cố định ở CI (mặc định 4 theo đo catalog 23). → Kiểm: `playwright.config` có `forbidOnly: !!process.env.CI`, `retries: process.env.CI ? 2 : 0`, `trace: 'on-first-retry'`. · Nguồn: Playwright docs test-configuration
- [ ] `QA-E2E-006` **MUST** Test tự tạo dữ liệu qua API/seed và dọn sau; không dùng tài khoản/dữ liệu thật; chạy trên môi trường staging/preview. → Kiểm: `baseURL` không phải production; fixture tạo user với email `+e2e-<uuid>`; cleanup trong `afterEach`/global teardown.

### Integration & contract test: DB thật, API contract, Pact, testcontainers

Nguồn khung: [`14-testing-quality/integration-and-contract.md`](.xtemplates/framework/14-testing-quality/integration-and-contract.md)

- [ ] `QA-INT-001` **MUST** Integration test chạy trên CSDL thật cùng engine và major version với production (container/service), không SQLite thay thế. → Kiểm: cấu hình testcontainers/`services:` ghi image `postgres:<major>` trùng `PROJECT.md`; test kết nối thật.
- [ ] `QA-INT-002` **MUST** DB test được dựng bằng chính chuỗi migration từ rỗng, không bằng dump schema. → Kiểm: bước setup gọi lệnh migrate (`prisma migrate deploy`/`alembic upgrade head`/`goose up`); không file `schema.sql` tải tay.
- [ ] `QA-INT-006` **MUST** Test phân quyền ở tầng HTTP: cho mỗi endpoint có dữ liệu theo người dùng, test người dùng A không đọc/sửa được tài nguyên của B (BOLA) và vai trò thấp không gọi được thao tác admin (BFLA). → Kiểm: test tag `api1-bola`, `api5-bfla` phủ mọi operationId chạm dữ liệu cá nhân (script `check_authz_tests` theo catalog 23 §3.3). · Nguồn: OWASP API Security Top 10 2023 API1, API5
- [ ] `QA-INT-007` **MUST** Thay đổi phá vỡ hợp đồng bị chặn ở PR (oasdiff / Pact can-i-deploy / `buf breaking` / schema registry compatibility). → Kiểm: job CI tương ứng exit 0.

### Hiệu năng & tải: k6/Locust, ngưỡng p95, Lighthouse, ngân sách

Nguồn khung: [`14-testing-quality/performance-and-load.md`](.xtemplates/framework/14-testing-quality/performance-and-load.md)

- [ ] `QA-PERF-002` **MUST** Backend có load test tự động (k6/Locust) với `thresholds` p95 và tỷ lệ lỗi; chạy ít nhất nightly trên staging, fail khi vượt. → Kiểm: script k6 có `thresholds: { http_req_duration: ['p(95)<…'], http_req_failed: ['rate<0.01'] }`; job nightly exit ≠ 0 khi vượt. · Nguồn: k6 docs thresholds
- [ ] `QA-PERF-006` **MUST** Mọi số đo hiệu năng trong báo cáo GO/NO-GO kèm: commit, môi trường, thiết bị/mạng mô phỏng, VU/thời lượng, ngày. → Kiểm: `GO-NO-GO.md` mục hiệu năng có 5 trường; thiếu → NO-GO.
- [ ] `QA-PERF-007` **MUST** Load test không chạy vào production trừ game day có lịch và cảnh báo; cấu hình CI cấm target production. → Kiểm: script k6 lấy `BASE_URL` từ env; CI deny giá trị domain production (grep).
- [ ] `QA-PERF-008` **MUST** Thư viện/CLI: benchmark trong CI so với baseline đã commit; chậm hơn > 10% → đỏ (ngưỡng đổi được). → Kiểm: `benchstat`/`pytest-benchmark --benchmark-compare-fail=mean:10%`/Vitest `bench` với so sánh; file baseline trong repo.

### Phân tích tĩnh: lint, type, complexity, dead code, trùng lặp, kiến trúc

Nguồn khung: [`14-testing-quality/static-analysis-and-code-quality.md`](.xtemplates/framework/14-testing-quality/static-analysis-and-code-quality.md)

- [ ] `QA-STATIC-001` **MUST** Lint 0 lỗi, 0 cảnh báo (hoặc baseline đã ghi) chạy ở hook và CI với cùng cấu hình. → Kiểm: `scripts/dev-task.sh lint` exit 0; job CI dùng cùng lệnh.
- [ ] `QA-STATIC-003` **MUST** Kiểm kiểu chế độ nghiêm: TS `strict: true` + `noUncheckedIndexedAccess`; Python pyright `strict` hoặc mypy `--strict` cho mã mới. → Kiểm: `tsconfig.json`/`pyrightconfig.json` có khoá tương ứng; `tsc --noEmit`/`pyright` exit 0.
- [ ] `QA-STATIC-004` **MUST** Không `any`/`@ts-ignore`/`# type: ignore`/`eslint-disable` không kèm lý do. → Kiểm: lint `no-explicit-any`, `ban-ts-comment` (`allow-with-description`), ruff `PGH003`; grep disable không có comment = 0.
- [ ] `QA-STATIC-005` **MUST** Không bí mật, `console.log`/`print` debug, code comment-out "để phòng" trong nhánh chính. → Kiểm: gitleaks 0 finding; lint `no-console` (trừ logger), ruff `T201`; review diff.

### Dữ liệu test, fixture, seed, ẩn danh hoá, factory

Nguồn khung: [`14-testing-quality/test-data-and-fixtures.md`](.xtemplates/framework/14-testing-quality/test-data-and-fixtures.md)

- [ ] `QA-DATA-001` **MUST** Không có dump/export dữ liệu production trong repo, CI, staging hay máy dev; chính sách ghi trong `PROJECT.md`. → Kiểm: gitleaks + script quét file `.sql/.csv/.json` > 1 MB hoặc có cột PII; `PROJECT.md` mục "Dữ liệu test" có câu cấm. · Nguồn: Luật 91/2025/QH15; GDPR Art. 5(1)(c)
- [ ] `QA-DATA-002` **MUST** Fixture/seed không chứa dữ liệu cá nhân thật (tên, email, SĐT, CCCD, địa chỉ); email test dùng domain dành riêng (`example.com`/`example.test`) hoặc `+tag`. → Kiểm: CI quét fixture bằng regex/Presidio: 0 email ngoài domain cho phép, 0 SĐT VN dạng thật trừ số mẫu ghi trong `docs/compliance/test-data-policy.md`.
- [ ] `QA-DATA-007` **MUST** Bản sao ẩn danh hoá (nếu dùng) được tạo bằng script có phiên bản, kỹ thuật không đảo ngược (xoá/băm có muối/tổng quát hoá), có DPIA hoặc phê duyệt ghi trong repo; không giữ bảng ánh xạ. → Kiểm: `scripts/anonymize/` + `docs/compliance/anonymization.md` có `approved_by`; test mẫu: không tìm được bản ghi gốc từ bản sao. · Nguồn: [`../04-standards/data-privacy-standards.md`](.xtemplates/framework/04-standards/data-privacy-standards.md) STD-PRIV-003
- [ ] `QA-DATA-008` **MUST** Cassette record/replay được lọc header `Authorization`/`Cookie`/`Set-Cookie`, API key và PII trước khi ghi. → Kiểm: cấu hình filter (`filter_headers`, `before_record`) + gitleaks trên thư mục cassette = 0.

### Chiến lược kiểm thử: tháp, mức bao phủ, cổng, trách nhiệm

Nguồn khung: [`14-testing-quality/test-strategy.md`](.xtemplates/framework/14-testing-quality/test-strategy.md)

- [ ] `QA-STRAT-001` **MUST** Một lệnh chạy toàn bộ test khai trong `xt.yaml` (hoặc `package.json`/`Makefile`) và CI gọi đúng lệnh đó. → Kiểm: `scripts/dev-task.sh test` exit 0; job CI dùng cùng lệnh (grep trong workflow). · Nguồn: P9
- [ ] `QA-STRAT-002` **MUST** CI chạy test trên mọi PR và là required check; merge bị chặn khi đỏ. → Kiểm: ruleset/branch protection liệt kê job test; không `continue-on-error`. · Nguồn: catalog 23 §2.5
- [ ] `QA-STRAT-005` **MUST** Bug production sửa kèm test tái hiện (đỏ trước khi sửa). → Kiểm: PR `fix:` có file test thay đổi; CI job kiểm `fix:` thiếu test → cảnh báo/đỏ.
- [ ] `QA-STRAT-008` **MUST** Không `test.only`/`.skip`/`xit`/`@pytest.mark.skip` không lý do lọt vào nhánh chính. → Kiểm: Playwright `forbidOnly: !!process.env.CI`; lint rule `no-focused-tests`/`no-disabled-tests`; grep skip phải kèm ticket.

### Unit test & chống lỗi logic: ca biên, null/0, race, thời gian, tiền

Nguồn khung: [`14-testing-quality/unit-and-logic-edge-cases.md`](.xtemplates/framework/14-testing-quality/unit-and-logic-edge-cases.md)

- [ ] `QA-UNIT-004` **MUST** Tiền và số lượng không dùng float: test `0.1 + 0.2` tương đương trả đúng bằng kiểu số nguyên nhỏ nhất/decimal; làm tròn theo quy tắc ghi rõ (half-even/half-up). → Kiểm: test tổng 3 × 0.1 = 0.3 bằng decimal; lint cấm `number` cho field tiền (schema `string`/`bigint`). · Nguồn: [`../18-cross-cutting/units-time-and-money.md`](.xtemplates/framework/18-cross-cutting/units-time-and-money.md)
- [ ] `QA-UNIT-007` **MUST** Thao tác ghi có idempotency: gửi lại cùng yêu cầu (cùng key) không tạo bản ghi/tính tiền hai lần. → Kiểm: test gọi 2 lần cùng `idempotency_key`, đếm bản ghi = 1.
- [ ] `QA-UNIT-008` **MUST** Race: hai thao tác đồng thời trên cùng tài nguyên (hai click, hai request) giữ bất biến (số dư không âm, tồn kho không âm). → Kiểm: test `Promise.all([op, op])`/`go test -race`/thread pool, assert bất biến; xem [`../09-database/transactions-and-consistency.md`](.xtemplates/framework/09-database/transactions-and-consistency.md).
- [ ] `QA-UNIT-010` **MUST** Thao tác nhiều bước là all-or-nothing: lỗi ở bước giữa → không còn trạng thái nửa vời. → Kiểm: test ném lỗi ở bước 2, assert bước 1 đã rollback.

### Sao lưu & DR: RPO/RTO, diễn tập khôi phục, multi-region

Nguồn khung: [`15-operations/backup-and-disaster-recovery.md`](.xtemplates/framework/15-operations/backup-and-disaster-recovery.md)

- [ ] `OPS-DR-003` **MUST** Áp 3-2-1: ≥ 2 bản sao lưu, 2 hệ thống khác nhau, ≥ 1 bản ở vùng/tài khoản/nhà cung cấp khác production. → Kiểm: cấu hình replication/export sang bucket ở account id khác (IaC); liệt kê trong BACKUP-SCOPE. · Nguồn: CISA/CERT "Data Backup Options" (3-2-1)
- [ ] `OPS-DR-004` **MUST** Backup mã hoá at-rest và in-transit; khoá mã hoá backup được sao lưu riêng (KMS multi-region/escrow) — mất khoá = mất backup. → Kiểm: cấu hình mã hoá bucket/backup; khoá KMS có bản sao/escrow ghi trong runbook; test giải mã từ tài khoản DR. · Nguồn: NIST SP 800-34r1; [`../12-security/secrets-management.md`](.xtemplates/framework/12-security/secrets-management.md)
- [ ] `OPS-DR-007` **MUST** Quyền xoá backup tách khỏi quyền ghi của ứng dụng và admin thường; identity production không xoá được bản offsite. → Kiểm: IAM policy: app/CI chỉ `PutObject`; xoá cần vai trò riêng có MFA; test xoá bằng identity app → bị từ chối. · Nguồn: CIS Benchmark cloud; NIST SP 800-207
- [ ] `OPS-DR-008` **MUST** Runbook khôi phục có lệnh cụ thể cho từng kho (restore DB tới thời điểm T, khôi phục bucket, dựng lại hạ tầng từ IaC, xoay bí mật), kèm thứ tự phụ thuộc và cách xác minh; người không phải tác giả chạy được trong diễn tập. → Kiểm: `docs/ops/runbooks/restore-*.md`; diễn tập do người khác tác giả thực hiện (ghi tên). · Nguồn: NIST SP 800-34r1; [`../templates/RUNBOOK.md`](.xtemplates/framework/templates/RUNBOOK.md)

### Chi phí: ngân sách, cảnh báo, FinOps, chi phí AI/token

Nguồn khung: [`15-operations/cost-management.md`](.xtemplates/framework/15-operations/cost-management.md)

- [ ] `OPS-COST-001` **MUST** Có ngân sách tháng cho mỗi môi trường/dự án cloud và cho dịch vụ AI, với cảnh báo ở 80%, 90%, 100% cả chi phí thực và dự báo, gửi tới kênh có người đọc. → Kiểm: cấu hình budget trong IaC (`aws_budgets_budget`/`google_billing_budget`); alert đã thử kích hoạt 1 lần (ghi ngày). · Nguồn: AWS Budgets docs (alert actual/forecasted); catalog stored 21 §8 (80/90/100)
- [ ] `OPS-COST-003` **MUST** Chi phí AI/LLM đo ở phía mình: token in/out, model, cache hit/miss, số lần gọi, chi phí ước tính theo bảng giá có ngày — gắn `tenant`, `feature`, `user`/`run_id`; dashboard chi phí theo tenant. → Kiểm: metric `llm_tokens_total{tenant,feature,model,direction}`; bảng giá `model-rates.json` có `verified_at`; dashboard tồn tại. · Nguồn: OTel GenAI `gen_ai.usage.*`; [`../13-ai-engineering/observability-and-cost.md`](.xtemplates/framework/13-ai-engineering/observability-and-cost.md)
- [ ] `OPS-COST-004` **MUST** Circuit breaker chi phí cho mọi workload có thể chạy hoang (agent loop, job nền, autoscale, gọi API trả phí): ngân sách theo run và theo ngày/tenant; 80% cảnh báo, 90% bóp, 100% dừng — enforce bằng code, không bằng prompt. → Kiểm: test mô phỏng vượt 100% → dừng + alert; cấu hình ngưỡng trong code/config có review. · Nguồn: catalog stored 21 §8 (spend circuit breaker; ví dụ runaway 400 lần/5 phút); OWASP LLM 2026 LLM06
- [ ] `OPS-COST-005` **MUST** Giới hạn trần autoscale/concurrency (max instances, max workers, max tokens/phút) để sự cố hoặc tấn công không tạo hoá đơn không giới hạn. → Kiểm: `max_size`/`maxReplicas`/quota trong IaC; không có autoscale không trần. · Nguồn: OWASP API Top 10 2023 API4; LLM06

### Triển khai: canary, blue/green, feature flag, rollback, migration online

Nguồn khung: [`15-operations/deployment-strategies.md`](.xtemplates/framework/15-operations/deployment-strategies.md)

- [ ] `OPS-DEPLOY-001` **MUST** Build một lần, một artifact bất biến (image digest/tarball checksum) đi qua staging → production; production không rebuild. → Kiểm: pipeline promote cùng digest (`image@sha256:…` giống nhau ở hai môi trường); log deploy ghi digest. · Nguồn: SLSA (artifact nhất quán); [`../12-security/supply-chain.md`](.xtemplates/framework/12-security/supply-chain.md)
- [ ] `OPS-DEPLOY-002` **MUST** Rollback một bước (lệnh/nút) về artifact trước trong < 15 phút, **đã diễn tập** trên production (hoặc staging giống production) với thời gian ghi lại. → Kiểm: `docs/ops/rollback-drills.md` có ngày + thời gian đo < 15 phút; runbook rollback trỏ lệnh cụ thể. · Nguồn: P8; khung cũ GĐ 6 "rollback sẵn sàng"; DORA recovery time
- [ ] `OPS-DEPLOY-003` **MUST** Mọi migration schema tương thích với phiên bản code đang chạy và phiên bản trước (expand → migrate → contract); không drop/rename cột/bảng cùng deploy dùng nó; contract ở release sau khi code cũ không còn. → Kiểm: CI lint migration (cấm `DROP COLUMN`/`RENAME` không kèm flag `contract` và ghi release trước); test chạy test suite bản N−1 trên schema N. · Nguồn: [`../09-database/migrations.md`](.xtemplates/framework/09-database/migrations.md); P8
- [ ] `OPS-DEPLOY-004` **MUST** Smoke test tự động sau mỗi deploy (health, login/luồng chính, header bảo mật, phiên bản đúng) trên URL thật; thất bại → rollback tự động hoặc chặn promote. → Kiểm: bước `post-deploy-smoke` trong pipeline; log có kết quả; thất bại thử nghiệm → pipeline lùi. · Nguồn: khung cũ GĐ 6 cổng; [`../14-testing-quality/e2e-and-accessibility.md`](.xtemplates/framework/14-testing-quality/e2e-and-accessibility.md)

### Ứng phó sự cố: SEV, runbook, liên lạc, post-mortem không đổ lỗi

Nguồn khung: [`15-operations/incident-response.md`](.xtemplates/framework/15-operations/incident-response.md)

- [ ] `OPS-IR-001` **MUST** Có `docs/ops/INCIDENT-RESPONSE.md` (hoặc mục trong RUNBOOK) định nghĩa SEV1–4 với ví dụ cụ thể của dự án, thời gian phản ứng, và ai được tuyên bố sự cố. → Kiểm: file tồn tại; mỗi SEV có ≥ 2 ví dụ; được nhắc trong onboarding. · Nguồn: NIST SP 800-61r3; PagerDuty Incident Response
- [ ] `OPS-IR-004` **MUST** Thứ tự xử lý cố định: phát hiện → phân mức → **giảm thiệt hại** (rollback/flag/khôi phục/kill switch) → liên lạc → khắc phục triệt để qua cổng thường → đóng → post-mortem. → Kiểm: runbook liệt kê thứ tự; timeline sự cố gần nhất có mốc "giảm thiệt hại" trước mốc "root cause". · Nguồn: khung cũ `docs/ops/incident-response.md` (1b80fe4); NIST SP 800-61r3
- [ ] `OPS-IR-006` **MUST** Thao tác lên dữ liệu thật lúc sự cố có snapshot/backup ngay trước đó và lệnh hoàn tác đã viết sẵn; thao tác không thể hoàn tác cần hai người xác nhận. → Kiểm: runbook mục "Trước khi chạy lệnh lên dữ liệu"; timeline ghi snapshot id. · Nguồn: AGENTS.md mục Điểm dừng bắt buộc về hành động; P3
- [ ] `OPS-IR-010` **MUST** Sự cố bảo mật (lộ dữ liệu/secret, xâm nhập) = SEV1, kích hoạt thêm: bảo toàn chứng cứ, thu hồi/xoay bí mật, đánh giá nghĩa vụ thông báo (xem [`../16-compliance-privacy/vietnam-data-law.md`](.xtemplates/framework/16-compliance-privacy/vietnam-data-law.md), [`../16-compliance-privacy/international-privacy.md`](.xtemplates/framework/16-compliance-privacy/international-privacy.md)). → Kiểm: runbook có nhánh "sự cố bảo mật" với checklist 3 mục trên và đầu mối pháp lý. · Nguồn: NIST SP 800-61r3; [`../12-security/logging-audit-and-incident.md`](.xtemplates/framework/12-security/logging-audit-and-incident.md)

### IaC: Terraform/Pulumi/compose, drift, review, policy-as-code

Nguồn khung: [`15-operations/infrastructure-as-code.md`](.xtemplates/framework/15-operations/infrastructure-as-code.md)

- [ ] `OPS-IAC-001` **MUST** Mọi tài nguyên cloud/hạ tầng production khai báo trong IaC trong repo; không tạo tay. → Kiểm: drift job `plan -detailed-exitcode` = 0 (không lệch); inventory cloud (CLI) đối chiếu với state: tài nguyên ngoài state = 0 (ngoại lệ có file ghi lý do). · Nguồn: NIST SSDF PO.3 (toolchain); P5
- [ ] `OPS-IAC-003` **MUST** State ở backend từ xa có **khoá** (locking), **versioning**, **mã hoá at-rest**, quyền đọc/ghi hẹp (chỉ identity CI + admin); `.tfstate*` trong `.gitignore`. → Kiểm: cấu hình backend trong code; `git ls-files | grep tfstate` = 0; bucket có versioning + encryption (checkov). · Nguồn: Terraform docs — state locking; [`../12-security/secrets-management.md`](.xtemplates/framework/12-security/secrets-management.md)
- [ ] `OPS-IAC-004` **MUST** Không bí mật trong IaC/compose: giá trị nhạy cảm lấy từ kho bí mật (data source) hoặc biến CI; output nhạy cảm đánh dấu `sensitive = true`. → Kiểm: checkov `CKV_SECRET_*` = 0; gitleaks quét thư mục `infra/`; grep `password = "` = 0. · Nguồn: OWASP Secrets Mgmt CS
- [ ] `OPS-IAC-006` **MUST** Hành động phá huỷ (plan có `destroy`/`replace` tài nguyên có dữ liệu: CSDL, bucket, volume, queue) cần người duyệt riêng và `prevent_destroy`/deletion protection trên tài nguyên dữ liệu. → Kiểm: `lifecycle { prevent_destroy = true }` hoặc `deletion_protection = true` trên CSDL/bucket; CI đọc plan JSON, có `delete` tài nguyên dữ liệu → yêu cầu label `approved-destroy`. · Nguồn: P8; AGENTS.md mục Điểm dừng bắt buộc về hành động

### Bảo trì: cập nhật phụ thuộc, EOL, nâng cấp major, nợ kỹ thuật

Nguồn khung: [`15-operations/maintenance-and-lifecycle.md`](.xtemplates/framework/15-operations/maintenance-and-lifecycle.md)

- [ ] `OPS-MAINT-001` **MUST** Bot cập nhật phụ thuộc bật cho mọi hệ sinh thái trong repo (ngôn ngữ, Docker, GitHub Actions, Terraform…), lịch tuần, gom nhóm minor+patch, giới hạn PR mở. → Kiểm: `dependabot.yml`/`renovate.json` có đủ `package-ecosystem` ứng với manifest tồn tại (script so); `groups` + `open-pull-requests-limit` đặt. · Nguồn: GitHub Dependabot options reference; catalog stored 23 §2.5 (gom nhóm + WIP cap)
- [ ] `OPS-MAINT-003` **MUST** Theo dõi EOL bằng máy cho runtime, framework, CSDL, OS/image nền, tool IaC: job tuần đọc endoflife.date, cảnh báo khi còn < 6 tháng, đỏ khi đã EOL. → Kiểm: `scripts/eol-check` (dự án tự viết) với danh sách sản phẩm ↔ phiên bản đang dùng (đọc từ `package.json`/`pyproject`/Dockerfile/`required_version`); không có phiên bản đã EOL ở production. · Nguồn: endoflife.date (ví dụ xác minh 2026-10-13: Python 3.10 EOL 2026-10-01, Node 20 EOL 2026-04-30, Node 22 EOL 2027-04-30)
- [ ] `OPS-MAINT-004` **MUST** Quét lỗ hổng theo lịch tuần (dependency + image + SBOM) với SLA xử lý theo mức (critical/high/medium) ghi thành chính sách; vi phạm SLA hiện trong review tháng. → Kiểm: workflow `schedule`; `docs/ops/VULN-SLA.md`; báo cáo tháng số finding quá SLA = 0. · Nguồn: [`../12-security/supply-chain.md`](.xtemplates/framework/12-security/supply-chain.md) `SEC-SUPPLY-006`; NIST SSDF RV.1
- [ ] `OPS-MAINT-005` **MUST** Nâng major có kế hoạch: PR riêng, changelog/migration guide đọc và tóm tắt trong PR, codemod chính thức nếu có, toàn bộ test + E2E xanh, deploy qua canary/flag, đường lùi ghi rõ. → Kiểm: template PR `major-upgrade` với các mục bắt buộc; label `major`; không gộp major với tính năng. · Nguồn: P8; [`deployment-strategies.md`](.xtemplates/framework/15-operations/deployment-strategies.md)

### Quan sát: log · metric · trace, OpenTelemetry, dashboard

Nguồn khung: [`15-operations/observability.md`](.xtemplates/framework/15-operations/observability.md)

- [ ] `OPS-OBS-001` **MUST** Pipeline log (agent/Collector) nhận log JSON của ứng dụng (định dạng theo `BASE-ERR-005/006` ở [`../01-baseline/errors-and-logging.md`](.xtemplates/framework/01-baseline/errors-and-logging.md)), parse thành OTel Logs Data Model và gắn `Resource` (`service.name`, `service.version`, `deployment.environment`) ở Collector — không drop dòng không parse được (gắn nhãn `unparsed`). → Kiểm: cấu hình Collector `filelog`/`otlp` receiver + `resource` processor; test gửi dòng rác → vẫn lưu với nhãn; query theo `service.name` trả đúng. · Nguồn: OTel Logs Data Model (Stable); OTel resource semconv
- [ ] `OPS-OBS-003` **MUST** Metric RED cho mọi dịch vụ HTTP/RPC: `http.server.request.duration` (histogram, s) với `http.request.method`, `http.route`, `http.response.status_code`; không label cardinality cao (user id, path đầy đủ). → Kiểm: `/metrics` hoặc OTLP có histogram tên chuẩn; script kiểm số series/label < ngưỡng (vd 10k). · Nguồn: OTel HTTP semconv (`http.server.request.duration` Stable)
- [ ] `OPS-OBS-006` **MUST** Health endpoints: `/healthz` (liveness, không gọi phụ thuộc) và `/readyz` (readiness, kiểm phụ thuộc chính có timeout); không lộ chi tiết nội bộ ra public. → Kiểm: test hai endpoint; readiness trả 503 khi DB down; endpoint sau auth hoặc chỉ nội bộ. · Nguồn: Kubernetes probes docs (chưa fetch lại 2026-10-13)
- [ ] `OPS-OBS-008` **MUST** PII/secret được che ở SDK/Collector trước khi rời tiến trình (processor redact/attributes); nội dung prompt/completion không ghi mặc định. → Kiểm: cấu hình Collector `redaction`/`attributes` processor; test span chứa email → che. · Nguồn: [`../12-security/logging-audit-and-incident.md`](.xtemplates/framework/12-security/logging-audit-and-incident.md); OTel GenAI (content opt-in)

### SLO, error budget, cảnh báo có thể hành động, on-call

Nguồn khung: [`15-operations/slo-and-alerting.md`](.xtemplates/framework/15-operations/slo-and-alerting.md)

- [ ] `OPS-SLO-001` **MUST** Mỗi dịch vụ hướng người dùng có ≥ 1 SLI availability và ≥ 1 SLI latency định nghĩa dạng tỷ lệ tốt/tổng, với query cụ thể, lưu `docs/ops/SLO.md` (hoặc file sloth/OpenSLO) trong repo. → Kiểm: file SLO có query PromQL/SQL chạy được; CI validate cú pháp (sloth/OpenSLO schema). · Nguồn: Google SRE Workbook — Implementing SLOs
- [ ] `OPS-SLO-004` **MUST** Cảnh báo page dựa trên burn rate nhiều cửa sổ (long + short) thay vì ngưỡng tĩnh; ít nhất 2 cặp (nhanh/chậm) + 1 ticket. → Kiểm: rule alert trong repo có biểu thức burn rate với 2 cửa sổ; không có alert page kiểu `cpu > 80%`. · Nguồn: SRE Workbook — Alerting on SLOs (14.4×/1h-5m, 6×/6h-30m, 1×/3d-6h cho 99.9%)
- [ ] `OPS-SLO-005` **MUST** Mỗi alert có: `severity` (page/ticket), `runbook_url` trỏ runbook có thật, chủ sở hữu, mô tả tác động người dùng; alert không có runbook không được bật. → Kiểm: script đọc rule files: 100% alert có `runbook_url` tồn tại (HTTP 200/file) và `severity`. · Nguồn: SRE Book — Monitoring (alert phải hành động được); [`../templates/RUNBOOK.md`](.xtemplates/framework/templates/RUNBOOK.md)
- [ ] `OPS-SLO-006` **MUST** Mọi alert được **thử kích hoạt** trước khi tin cậy (inject lỗi/giả metric) và sau mỗi thay đổi rule; ghi ngày diễn tập. → Kiểm: `docs/ops/alert-drills.md` có ngày + kết quả cho từng alert; lifecycle G8 yêu cầu "cảnh báo đã thử kích hoạt". · Nguồn: lifecycle G8; P1

### Quy định AI: EU AI Act, minh bạch, phân loại rủi ro, Việt Nam

Nguồn khung: [`16-compliance-privacy/ai-regulation.md`](.xtemplates/framework/16-compliance-privacy/ai-regulation.md)

- [ ] `CMP-AI-001` **MUST** Mỗi hệ thống/tính năng AI được phân loại rủi ro (VN cao/trung bình/thấp; EU cấm/cao/minh bạch/tối thiểu/GPAI) với lý do, người ký, ngày; phân loại lại khi thay đổi đáng kể, sự cố nghiêm trọng hoặc danh mục mới. → Kiểm: `docs/ai/<tên>.md` có mục "Phân loại" + `classified_at`; CI yêu cầu file này cho module gắn nhãn `ai`. · Nguồn: Luật AI 134/2025/QH15 Đ.9; NĐ 142/2026/NĐ-CP Chương II; EU AI Act Art. 6, Annex III
- [ ] `CMP-AI-002` **MUST** Không xây hành vi bị cấm: thao túng/lừa dối, khai thác trẻ em/người cao tuổi/khuyết tật, chấm điểm xã hội, nhận diện cảm xúc nơi làm việc/trường học, deepfake gây hại, che giấu giám sát của con người. → Kiểm: threat model có mục "hành vi bị cấm" ký xác nhận không có; test red-team cho prompt yêu cầu các hành vi này bị từ chối. · Nguồn: Luật AI 134/2025/QH15 Đ.7; EU AI Act Art. 5
- [ ] `CMP-AI-003` **MUST** Người dùng được thông báo rõ khi tương tác với AI (chatbot, voice) trước khi tương tác; không giả làm người. → Kiểm: test E2E thông điệp hiển thị ở lượt đầu; snapshot UI. · Nguồn: Luật AI 134/2025/QH15; Luật 71/2025/QH15 (thông báo tương tác AI); EU AI Act Art. 50(1)
- [ ] `CMP-AI-006` **MUST** Quyết định tự động ảnh hưởng đáng kể tới quyền/lợi ích (từ chối dịch vụ, chấm điểm, xếp loại, kỷ luật) có người xem lại trước khi có hiệu lực hoặc kênh khiếu nại có SLA; AI chỉ gợi ý trong y tế/pháp lý/tuyển dụng. → Kiểm: state machine quyết định có bước `human_review`; test không thể bỏ qua; xem [`consent-and-user-rights.md`](.xtemplates/framework/16-compliance-privacy/consent-and-user-rights.md). · Nguồn: Luật 91/2025/QH15 Đ.30; GDPR Art. 22; EU AI Act Art. 14, 26

### Đồng ý, quyền chủ thể dữ liệu (truy cập/xoá/di chuyển), cookie, trẻ em

Nguồn khung: [`16-compliance-privacy/consent-and-user-rights.md`](.xtemplates/framework/16-compliance-privacy/consent-and-user-rights.md)

- [ ] `CMP-RIGHTS-001` **MUST** Bản ghi đồng ý lưu `subject_id, purpose_id, policy_version, granted_at, channel, ui_snapshot_hash, withdrawn_at`; truy vấn được theo người dùng; không sửa tại chỗ (append). → Kiểm: schema bảng; test ghi/rút tạo bản ghi mới; export theo người dùng. · Nguồn: GDPR Art. 7(1); Luật 91/2025/QH15 Đ.9
- [ ] `CMP-RIGHTS-003` **MUST** Script/SDK theo dõi (analytics, ads, session replay, pixel) chỉ nạp **sau** khi đồng ý mục đích tương ứng; từ chối → không có request ra ngoài. → Kiểm: test Playwright chặn mạng: trước khi đồng ý, 0 request tới domain tracker; cookie theo dõi không được đặt. · Nguồn: ePrivacy Directive 2002/58/EC Art. 5(3); Luật 91/2025/QH15 Đ.29
- [ ] `CMP-RIGHTS-004` **MUST** Rút đồng ý có cùng số bước/vị trí như cho; rút → dừng xử lý mục đích đó ≤ thời hạn luật (VN: không quá 72 giờ theo NĐ 356/2025 — chưa xác minh số điều) và lan tới bên thứ ba. → Kiểm: test E2E rút tiếp thị → email tiếp thị không còn gửi; webhook/API tới nhà cung cấp email cập nhật. · Nguồn: Luật 91/2025/QH15 Đ.10; GDPR Art. 7(3)
- [ ] `CMP-RIGHTS-007` **MUST** Quyền xoá: tự phục vụ, xác thực lại trước khi xoá, lan tới mọi kho và bên xử lý; trường hợp từ chối (nghĩa vụ pháp lý lưu) phải nêu căn cứ và chỉ giữ phần bắt buộc. → Kiểm: mục CMP-PRIV-005; test xoá tài khoản có dữ liệu phải giữ (hoá đơn) → PII ngoài hoá đơn bị xoá, hoá đơn giữ với lý do. · Nguồn: GDPR Art. 17; Luật 91/2025/QH15 Đ.14

### Quốc tế: GDPR, UK GDPR, CCPA/CPRA, PDPA (SG/TH), chuyển dữ liệu xuyên biên giới

Nguồn khung: [`16-compliance-privacy/international-privacy.md`](.xtemplates/framework/16-compliance-privacy/international-privacy.md)

- [ ] `CMP-INTL-002` **MUST** Mỗi hoạt động xử lý có cơ sở pháp lý ghi trong data map (`legal_basis` theo GDPR Art. 6/9; `consent`/`contract`/`legal_obligation`/…); không có → không xử lý. → Kiểm: lint data map bắt buộc `legal_basis`; dữ liệu nhạy cảm phải có cơ sở Art. 9. · Nguồn: GDPR Art. 6, 9; Luật 91/2025/QH15 Đ.19
- [ ] `CMP-INTL-005` **MUST** Chuyển dữ liệu từ EU/UK ra ngoài (kể cả về VN) có cơ chế hợp lệ: SCC 2021/914 (EU) hoặc IDTA/Addendum (UK) + Transfer Impact Assessment; không có adequacy cho VN. → Kiểm: `docs/privacy/transfers.md` liệt kê từng luồng với cơ chế + TIA; test cấu hình vùng lưu trữ. · Nguồn: GDPR Art. 44–46; Commission Decision (EU) 2021/914
- [ ] `CMP-INTL-006` **MUST** SLA kỹ thuật thông báo vi phạm = thời hạn ngắn nhất áp dụng (SG 3 ngày lịch sau xác định; EU/VN/TH 72 giờ); runbook có bảng thời hạn theo vùng và mẫu thông báo. → Kiểm: `docs/ops/runbooks/data-breach.md` có bảng vùng; diễn tập hằng năm. · Nguồn: GDPR Art. 33; PDPA SG s.26D; PDPA TH s.37(4); Luật 91/2025/QH15 Đ.23
- [ ] `CMP-INTL-007` **MUST** Thời hạn trả lời DSAR cấu hình theo vùng (EU/UK 1 tháng, CA 45 ngày, SG/TH 30 ngày, VN theo NĐ 356) và theo dõi quá hạn. → Kiểm: cấu hình `dsar_days` theo vùng; metric quá hạn = 0. · Nguồn: GDPR Art. 12(3); CCPA §1798.130; PDPA SG s.21

### License mã nguồn mở, IP, dữ liệu huấn luyện, thương hiệu, điều khoản dịch vụ

Nguồn khung: [`16-compliance-privacy/licensing-and-ip.md`](.xtemplates/framework/16-compliance-privacy/licensing-and-ip.md)

- [ ] `CMP-LIC-001` **MUST** Sản phẩm có file `LICENSE` (mở nguồn: license OSI; nội bộ: ghi "proprietary" + chủ sở hữu) và `NOTICE`/`THIRD_PARTY_NOTICES` sinh tự động từ SBOM cho phụ thuộc yêu cầu ghi công. → Kiểm: file tồn tại; CI sinh NOTICE và diff = 0. · Nguồn: Apache-2.0 §4(d); MIT; BSD-3-Clause; Luật SHTT 50/2005/QH11 (sửa đổi 2022, 2025)
- [ ] `CMP-LIC-002` **MUST** Chính sách license phụ thuộc dạng file (`license-policy.yaml`: allow/deny/review theo SPDX id; ngoại lệ có `package, reason, approved_by, expires`); cổng CI chặn license cấm hoặc không xác định. → Kiểm: job CI chạy license check trên lockfile/SBOM; PR thêm gói AGPL/unknown bị chặn; ngoại lệ hết hạn → fail. · Nguồn: SPDX License List 3.29.0 (16/09/2026); OSI Approved Licenses; `research/…catalog-extraction.md` §2.6
- [ ] `CMP-LIC-003` **MUST** SBOM (CycloneDX hoặc SPDX) sinh mỗi build cho mọi thành phần (code, container, model) với trường license; lưu cùng artifact phát hành. → Kiểm: artifact có `sbom.cdx.json`/`.spdx.json`; license không null ≥ 99%; xem [`../12-security/supply-chain.md`](.xtemplates/framework/12-security/supply-chain.md). · Nguồn: NTIA Minimum Elements for SBOM; CycloneDX 1.7 (ECMA-424); SPDX 3.0 (phiên bản theo nhà [`../12-security/supply-chain.md`](.xtemplates/framework/12-security/supply-chain.md))
- [ ] `CMP-LIC-004` **MUST** Không dùng gói/model/dataset/asset không có license rõ ràng; "source-available" (BSL, SSPL, ELv2, Commons Clause) được phân loại riêng và chỉ dùng với quyết định có ghi. → Kiểm: SBOM không có `NOASSERTION`/`UNKNOWN` ngoài danh sách ngoại lệ; ADR cho mỗi thành phần source-available. · Nguồn: OSI Open Source Definition; Elastic License 2.0; SSPL

### Privacy by design: tối thiểu hoá, mục đích, lưu trữ, xoá, DPIA

Nguồn khung: [`16-compliance-privacy/privacy-by-design.md`](.xtemplates/framework/16-compliance-privacy/privacy-by-design.md)

- [ ] `CMP-PRIV-001` **MUST** Có sổ dữ liệu cá nhân (data map) liệt kê mọi trường PII: hệ thống, bảng/cột, phân loại (thường/nhạy cảm/trẻ em), mục đích, cơ sở pháp lý, thời hạn giữ, nơi sao chép, bên nhận. → Kiểm: file `docs/privacy/data-map.yaml` tồn tại, CI chạy script đối chiếu tên cột trong schema với data map (cột PII không khai báo → fail). · Nguồn: GDPR Art. 30; ISO/IEC 27701:2025
- [ ] `CMP-PRIV-005` **MUST** Xoá tài khoản xoá/ẩn danh hoá dữ liệu ở mọi bản sao trong thời hạn công bố, kể cả bên xử lý thứ ba (gọi API xoá hoặc ticket có hạn). → Kiểm: test E2E "xoá tài khoản" rồi truy vấn từng kho (DB, cache, index, storage, analytics) trả rỗng; danh sách bên thứ ba có bằng chứng xoá. · Nguồn: GDPR Art. 17; Luật 91/2025/QH15 Đ.14
- [ ] `CMP-PRIV-008` **MUST** Không ghi PII vào log ứng dụng/trace/crash report (email, SĐT, số định danh, token, nội dung tin nhắn). → Kiểm: rule Semgrep/ESLint cấm log object người dùng; test đơn vị bộ lọc log che PII; quét log staging bằng bộ phát hiện PII (vd Presidio) = 0 phát hiện. · Nguồn: GDPR Art. 5(1)(f); ISO/IEC 27701:2025
- [ ] `CMP-PRIV-010` **MUST** PII bị che (redact) trước khi gửi tới LLM, dịch vụ phân tích hoặc nhà cung cấp chưa có hợp đồng xử lý dữ liệu. → Kiểm: test đơn vị lớp redaction với bộ mẫu PII tiếng Việt (SĐT, CCCD 12 số, email, địa chỉ); log request ra ngoài không chứa PII. · Nguồn: GDPR Art. 28, 44; Luật 91/2025/QH15 Đ.17, Đ.20

### Hồ sơ tuân thủ, audit trail, bằng chứng, chính sách, đào tạo

Nguồn khung: [`16-compliance-privacy/records-and-audit-readiness.md`](.xtemplates/framework/16-compliance-privacy/records-and-audit-readiness.md)

- [ ] `CMP-AUDIT-002` **MUST** Audit trail cho hành động nhạy cảm (đăng nhập/đổi quyền, truy cập dữ liệu nhạy cảm, thay đổi cấu hình, triển khai, xuất dữ liệu, xử lý DSAR) ghi `who, what, target, when(UTC), where(ip/ua), result, reason`; lưu ở kho chỉ ghi thêm (append-only/WORM) với thời hạn theo luật (≥ 12 tháng NĐ 333; ≥ 6 năm HIPAA; ≥ 10 năm chứng từ kế toán). → Kiểm: schema sự kiện; test mỗi hành động trong danh sách sinh sự kiện; cấu hình immutability/retention; NTP. · Nguồn: NĐ 333/2026/NĐ-CP Đ.22–23; HIPAA §164.316(b)(2); PCI DSS v4.0.1 Req. 10
- [ ] `CMP-AUDIT-003` **MUST** Sổ hoạt động xử lý (ROPA)/sổ dữ liệu, hồ sơ ĐGTĐ, hồ sơ chuyển dữ liệu, bản ghi đồng ý và biên nhận nộp cơ quan được lưu có phiên bản tại `docs/privacy/`; cập nhật theo mốc luật (6 tháng/10 ngày NĐ 356). → Kiểm: thư mục có CHANGELOG với ngày; CI nhắc khi quá hạn cập nhật. · Nguồn: Luật 91/2025/QH15 Đ.21–22; NĐ 356/2025/NĐ-CP (chưa xác minh số điều); GDPR Art. 30
- [ ] `CMP-AUDIT-007` **MUST** Quản lý nhà cung cấp/bên xử lý: sổ nhà cung cấp (dịch vụ, dữ liệu chạm, vị trí, DPA, chứng chỉ, đánh giá rủi ro, ngày rà ≤ 12 tháng); thay đổi sub-processor có thông báo. → Kiểm: `docs/privacy/processors.md` + `docs/compliance/vendors.yaml`; CI chặn phụ thuộc/SDK mới không có dòng. · Nguồn: ISO/IEC 27001:2022 A.5.19–5.22; SOC 2 CC9.2; Luật 91/2025/QH15 Đ.17
- [ ] `CMP-AUDIT-010` **MUST** Sổ sự cố và vi phạm dữ liệu: mọi sự cố có bản ghi (phát hiện, phân loại, thông báo cơ quan/khách hàng với mốc giờ, khắc phục, post-mortem, hành động); diễn tập ứng phó ≥ 1 lần/năm có biên bản. → Kiểm: `docs/ops/incidents/` theo mẫu [`../templates/POST-MORTEM.md`](.xtemplates/framework/templates/POST-MORTEM.md); biên bản diễn tập. · Nguồn: Luật 91/2025/QH15 Đ.23; GDPR Art. 33(5); SOC 2 CC7.4–7.5

### Pháp luật dữ liệu Việt Nam: PDPL 2025, NĐ 356/2025, Luật ANM 2025, Luật Dữ liệu, lưu trữ trong nước

Nguồn khung: [`16-compliance-privacy/vietnam-data-law.md`](.xtemplates/framework/16-compliance-privacy/vietnam-data-law.md)

- [ ] `CMP-VN-001` **MUST** Thu thập sự đồng ý theo từng mục đích, hiển thị rõ loại dữ liệu/mục đích/bên nhận, lưu bằng chứng đồng ý (thời điểm, phiên bản văn bản, kênh) có thể in/sao chép. → Kiểm: bảng `consents` có `purpose_id`, `policy_version`, `granted_at`, `channel`; test từ chối xử lý khi thiếu bản ghi đồng ý. · Nguồn: Luật 91/2025/QH15 Đ.9; NĐ 330/2026 Đ.43
- [ ] `CMP-VN-004` **MUST** Mọi lần chuyển dữ liệu cá nhân ra ngoài Việt Nam (cloud, SaaS, LLM, CDN lưu dữ liệu) có trong hồ sơ đánh giá tác động chuyển dữ liệu nộp trong 60 ngày từ lần chuyển đầu. → Kiểm: data map có cột `region`/`processor_country`; script liệt kê nhà cung cấp ngoài VN và đối chiếu danh mục trong hồ sơ; chênh lệch = 0. · Nguồn: Luật 91/2025/QH15 Đ.20; NĐ 356/2025/NĐ-CP
- [ ] `CMP-VN-006` **MUST** Quy trình thông báo vi phạm: phát hiện → đánh giá → thông báo Bộ Công an (Mẫu 08) và chủ thể trong **72 giờ** khi vi phạm có thể gây hại; runbook có mẫu sẵn. → Kiểm: `docs/ops/runbooks/data-breach.md` tồn tại với mốc giờ, diễn tập tabletop ≥ 1 lần/năm có biên bản. · Nguồn: Luật 91/2025/QH15 Đ.23; NĐ 356/2025/NĐ-CP (Mẫu 08 — chưa xác minh số điều)
- [ ] `CMP-VN-007` **MUST** Thực hiện quyền chủ thể (truy cập, chỉnh sửa, rút đồng ý, xoá, hạn chế, phản đối) trong thời hạn NĐ 356/2025 quy định (thường 72 giờ cho xoá/rút đồng ý trừ trường hợp luật khác). → Kiểm: endpoint/giao diện DSAR có SLA đo được; test E2E rút đồng ý → dừng xử lý mục đích tương ứng. · Nguồn: Luật 91/2025/QH15 Đ.4, Đ.10, Đ.14; NĐ 356/2025/NĐ-CP (thời hạn thực hiện quyền — chưa xác minh số điều)

### Khám phá & yêu cầu: vấn đề, người dùng, chỉ số thành công, phạm vi không làm

Nguồn khung: [`17-product-project/discovery-and-requirements.md`](.xtemplates/framework/17-product-project/discovery-and-requirements.md)

- [ ] `PM-REQ-001` **MUST** `PROJECT.md` có phát biểu vấn đề 1–2 câu nêu rõ ai, trong tình huống nào, đau ở đâu — không chứa tên công nghệ hay tính năng. → Kiểm: `rg -n "^## .*Vấn đề" PROJECT.md` có kết quả; review G0 xác nhận câu không chứa giải pháp.
- [ ] `PM-REQ-007` **MUST** Mỗi yêu cầu có ID ổn định `R-NNN`, không tái sử dụng ID đã bỏ. → Kiểm: `rg -o "R-[0-9]{3}" PROJECT.md | sort | uniq -d` rỗng (không trùng ID).
- [ ] `PM-REQ-009` **MUST** Phân loại dữ liệu dự án sẽ xử lý ngay ở G0: có dữ liệu cá nhân không, có dữ liệu nhạy cảm (sức khoẻ, tài chính, trẻ em, định danh) không. → Kiểm: mục "Dữ liệu & pháp lý" ghi rõ có/không + loại; nếu có → gói ngành/module [`../16-compliance-privacy/privacy-by-design.md`](.xtemplates/framework/16-compliance-privacy/privacy-by-design.md) được ghép vào blueprint.
- [ ] `PM-REQ-019` **MUST** Không còn câu hỏi `[chặn]` chưa trả lời khi qua cổng G0; mỗi câu có câu trả lời của người hoặc quyết định `D-NNN` của phiên chính theo tiêu chí chất lượng cuối — thiếu dữ kiện chỉ người có thì chọn giả định đảo ngược được ([`LOOP-STOP-018`](.xtemplates/framework/11-autonomous-loop/stop-points-and-escalation.md)); không đoán ngầm. → Kiểm: `rg -c "\[chặn\]" PROJECT.md` = 0 tại commit đánh dấu cổng G0; mỗi câu đã đóng trỏ `D-NNN` hoặc tên người + ngày. · Nguồn: ADR-0008

### Bàn giao & các bên: tài liệu bàn giao, đào tạo, hỗ trợ, kết thúc dự án

Nguồn khung: [`17-product-project/handover-and-stakeholders.md`](.xtemplates/framework/17-product-project/handover-and-stakeholders.md)

- [ ] `PM-HANDOVER-002` **MUST** Gói tài liệu bàn giao tồn tại trong repo: `README.md` (chạy local từ clone sạch), `RUNBOOK.md`, `docs/adr/`, `PROGRESS.md`, sổ rủi ro, danh sách tài khoản/dịch vụ (không chứa secret). → Kiểm: `test -f README.md -a -f RUNBOOK.md -a -d docs/adr`; CI job "clean clone build" xanh.
- [ ] `PM-HANDOVER-004` **MUST** Tài khoản/secret chuyển giao bằng cơ chế nền tảng (chuyển ownership tổ chức, kho secret dùng chung, mời thành viên) — không gửi qua chat/email; mọi secret được xoay sau bàn giao. → Kiểm: `docs/handover/accounts.md` liệt kê dịch vụ · chủ mới · ngày chuyển · ngày xoay; `gitleaks detect` sạch; không có secret trong lịch sử chat đính kèm.
- [ ] `PM-HANDOVER-005` **MUST** Quyền truy cập của người rời dự án bị thu hồi trong ngày rời (repo, cloud, CSDL, kho secret, dashboard, store, domain) và có danh sách kiểm. → Kiểm: `docs/handover/offboarding-<tên>.md` tick đủ dịch vụ với ngày; `gh api orgs/<org>/members` không còn tên.
- [ ] `PM-HANDOVER-009` **MUST** Danh sách phụ thuộc có hạn (domain, chứng chỉ, license, gói SaaS, khoá API, thẻ thanh toán) kèm ngày hết hạn, chủ gia hạn, nhắc trước hạn. → Kiểm: `docs/handover/renewals.md`; cảnh báo lịch/CI trước hạn ≥ 30 ngày; chứng chỉ TLS tự động gia hạn có bằng chứng.

### Đo lường sản phẩm: sự kiện, funnel, quyền riêng tư trong analytics

Nguồn khung: [`17-product-project/metrics-and-analytics.md`](.xtemplates/framework/17-product-project/metrics-and-analytics.md)

- [ ] `PM-METRIC-003` **MUST** Có đúng một điểm gửi sự kiện (`track()`/`emit()`), kiểm schema tại đó; không gọi SDK analytics rải rác. → Kiểm: `rg -n "posthog\.capture|plausible\(|gtag\(|analytics\.track" src/ | rg -v "analytics/track"` rỗng.
- [ ] `PM-METRIC-004` **MUST** Không gửi sự kiện, không khởi tạo SDK, không đặt cookie/định danh analytics trước khi có căn cứ hợp pháp (đồng ý khi luật yêu cầu); rút đồng ý thì dừng ngay. → Kiểm: E2E (Playwright/Maestro) tải trang lần đầu không có request tới domain analytics và không có cookie analytics; sau khi từ chối vẫn không có. · Nguồn: xem [`../16-compliance-privacy/consent-and-user-rights.md`](.xtemplates/framework/16-compliance-privacy/consent-and-user-rights.md)
- [ ] `PM-METRIC-005` **MUST** Thuộc tính sự kiện không chứa PII thô (email, số điện thoại, tên, địa chỉ, nội dung nhập tự do, token); định danh người dùng là ID nội bộ hoặc giả danh. → Kiểm: schema cấm tên trường trong danh sách đen; test đơn vị quét payload bằng regex email/số điện thoại; review PR thêm sự kiện.
- [ ] `PM-METRIC-006` **MUST** Thời hạn lưu dữ liệu analytics ghi rõ và được cấu hình (xoá/ẩn danh hoá sau N tháng theo chính sách và luật áp dụng); người dùng xoá tài khoản thì dữ liệu định danh được bị xoá/ngắt liên kết. → Kiểm: cấu hình retention trong công cụ (ảnh chụp/IaC); test luồng xoá tài khoản gọi API xoá của analytics.

### Kế hoạch & ước lượng: chia nhỏ, cổng, WIP, deadline thật

Nguồn khung: [`17-product-project/planning-and-estimation.md`](.xtemplates/framework/17-product-project/planning-and-estimation.md)

- [ ] `PM-PLAN-001` **MUST** `PLAN.md` tồn tại, mỗi task một dòng đúng cú pháp `- [ ] \`T-NNN\` <việc> — Gate: \`<lệnh>\``; ID tăng dần, không trùng. → Kiểm: `python3 -c "import sys;sys.path.insert(0,'scripts');import xt,pathlib;t=xt.parse_plan(pathlib.Path('PLAN.md'));assert t and all(x['gate'] for x in t)"` thoát 0.
- [ ] `PM-PLAN-003` **MUST** Gate của task là lệnh chạy được trong repo, trả exit 0 khi đạt (test, lint, build, script kiểm, smoke). → Kiểm: `xt.py loop record --task T-NNN -- <gate>` tạo `.autopilot/evidence/T-NNN.json` với `exit_code: 0`; Gate dạng "đã review" không được chấp nhận.
- [ ] `PM-PLAN-005` **MUST** `PLAN.md` có mục "Điểm dừng bắt buộc" liệt kê thao tác cần người duyệt (xoá dữ liệu, migration phá vỡ, tiền thật, secret, dữ liệu người dùng thật, publish/deploy); mâu thuẫn spec không thuộc danh sách — phiên chính tự quyết (ADR-0008). → Kiểm: `rg -n "^## Điểm dừng bắt buộc" PLAN.md` và ≥4 dòng dưới mục.
- [ ] `PM-PLAN-006` **MUST** `docs/autopilot/PLAN.md` có mục "Ngân sách (4 con số)" theo [`LOOP-DESIGN-001`](.xtemplates/framework/11-autonomous-loop/loop-design.md): số vòng tối đa, ngân sách token/tiền, timeout mỗi lệnh kiểm, ngày hết hạn. → Kiểm: `rg -n "^## Ngân sách" docs/autopilot/PLAN.md`; `xt.py loop init --plan docs/autopilot/PLAN.md --max-iterations N --hours H` dùng đúng số đó.

### Ưu tiên & lộ trình: MVP, lát dọc, RICE/MoSCoW, không phình phạm vi

Nguồn khung: [`17-product-project/prioritization-and-roadmap.md`](.xtemplates/framework/17-product-project/prioritization-and-roadmap.md)

- [ ] `PM-PRIO-001` **MUST** Danh sách tính năng MVP được phân loại MoSCoW, mỗi mục Must có tiêu chí chấp nhận (spec) và ID `F-NNN`. → Kiểm: bảng MoSCoW trong `PROJECT.md` có cột Mức · ID · Spec; mọi Must trỏ file spec tồn tại.
- [ ] `PM-PRIO-003` **MUST** Lộ trình chia theo lát dọc demo được; lát đầu là walking skeleton có CI + deploy trước khi làm tính năng. → Kiểm: `PLAN.md` nhóm task theo lát; lát 1 có task `Gate:` là lệnh deploy/smoke; CI xanh trên commit skeleton (cổng G5).
- [ ] `PM-PRIO-004` **MUST** Phạm vi MVP đóng băng tại cổng G1; thay đổi sau đó đi qua `SCOPE.md` (điều kiện xét) và được ghi ngày, người quyết, mục bị đẩy ra để bù. → Kiểm: `SCOPE.md` tồn tại; mỗi thay đổi phạm vi là một commit sửa `PROJECT.md` có message `docs(scope): …` nêu mục bị đổi.
- [ ] `PM-PRIO-007` **MUST** Khi trễ hạn thật: cắt Could/Should trước, không hạ cổng chất lượng, không kéo hạn thật mà không có người quyết ghi tên. → Kiểm: `PROGRESS.md` mục Quyết định ghi "cắt X để giữ hạn Y" kèm ngày; CI không có cổng nào bị tắt (`rg -n "continue-on-error: true|--no-verify" .github/`).

### Rủi ro & giả định: sổ rủi ro, spike, kế hoạch B

Nguồn khung: [`17-product-project/risk-and-assumptions.md`](.xtemplates/framework/17-product-project/risk-and-assumptions.md)

- [ ] `PM-RISK-001` **MUST** Có sổ rủi ro (`docs/RISKS.md` hoặc mục trong `PROJECT.md`) với cột: ID `RK-NNN` · mô tả · xác suất · ảnh hưởng · chủ · cách ứng xử · biện pháp · trigger · trạng thái · ngày rà. → Kiểm: `rg -n "^\| RK-[0-9]{3}" docs/RISKS.md PROJECT.md` ≥1; mỗi dòng đủ cột.
- [ ] `PM-RISK-003` **MUST** Rủi ro xếp đầu (xác suất × ảnh hưởng cao nhất) có spike hoặc biện pháp bắt đầu trong lát dọc đầu tiên. → Kiểm: `PLAN.md` có task tham chiếu `RK-NNN` đứng đầu trong nhóm task đầu.
- [ ] `PM-RISK-006` **MUST** Mỗi phụ thuộc bên thứ ba quan trọng (SaaS, API, thư viện lõi, model AI) có dòng thẩm định: license (OSI hay không), ngày EOL/phiên bản hỗ trợ, telemetry mặc định, cách xuất dữ liệu/thoát. → Kiểm: bảng "Phụ thuộc" trong `docs/RISKS.md`; license tự động ở [`../16-compliance-privacy/licensing-and-ip.md`](.xtemplates/framework/16-compliance-privacy/licensing-and-ip.md); EOL tra `https://endoflife.date/api/<product>.json`.
- [ ] `PM-RISK-007` **MUST** Danh sách luật áp dụng (số hiệu đầy đủ + ngày hiệu lực + URL + "kiểm tra văn bản sửa đổi") lập ở G2; dự án có dữ liệu cá nhân có DPIA theo [`../templates/DPIA.md`](.xtemplates/framework/templates/DPIA.md). → Kiểm: mục "Khung pháp lý" trong `PROJECT.md`; `docs/DPIA.md` tồn tại khi `PM-REQ-009` = có.

### Đặc tả: user story, Given/When/Then, ca biên, hợp đồng API, truy vết

Nguồn khung: [`17-product-project/specification.md`](.xtemplates/framework/17-product-project/specification.md)

- [ ] `PM-SPEC-001` **MUST** Mỗi tính năng MVP (`F-NNN` trong `PROJECT.md`) có spec theo mẫu, trạng thái "Approved for implementation" trước khi task đầu tiên bắt đầu. → Kiểm: `ls docs/specs/SPEC-*.md`; mỗi `F-NNN` có file chứa dòng `Trạng thái: Approved`.
- [ ] `PM-SPEC-003` **MUST** Mục "Ca biên" không rỗng và rà đủ nhóm: rỗng/null, cực đại, trùng lặp/idempotency, song song, mất mạng giữa chừng, thời gian/múi giờ, quyền, tiền/đơn vị (cách làm đúng ở [`../18-cross-cutting/units-time-and-money.md`](.xtemplates/framework/18-cross-cutting/units-time-and-money.md)). → Kiểm: bảng ca biên có cột "nhóm" phủ ≥6/8 nhóm hoặc ghi "không áp dụng" có lý do.
- [ ] `PM-SPEC-004` **MUST** Mỗi scenario có ≥1 test tự động trỏ về ID của nó; scenario chưa có test thì tính năng chưa Done. → Kiểm: `rg -l "S-[0-9]{3}" tests/ e2e/ src/` phủ mọi `S-NNN` trong spec (script so khớp hai danh sách).
- [ ] `PM-SPEC-020` **MUST** Spec hở (điểm không nói, nhiều cách hiểu, mâu thuẫn với code/spec khác) → ghi vào "Câu hỏi mở" kèm quyết định: `D-NNN` của phiên chính theo tiêu chí chất lượng cuối ([`LOOP-STOP-018`](.xtemplates/framework/11-autonomous-loop/stop-points-and-escalation.md)) hoặc câu trả lời của người; không lấp ngầm, subagent không tự chọn. → Kiểm: mỗi câu hỏi mở đã đóng có "Đã quyết: D-NNN" hoặc tên người + ngày, `D-NNN` có trong `docs/autopilot/DECISIONS.md`. · Nguồn: catalog 23 §2.3, ADR-0008

### DX: onboarding < 1 giờ, lệnh chuẩn, devcontainer, lỗi dễ hiểu

Nguồn khung: [`18-cross-cutting/developer-experience.md`](.xtemplates/framework/18-cross-cutting/developer-experience.md)

- [ ] `XC-DX-001` **MUST** Từ clone sạch đến test xanh bằng **≤ 3 lệnh** ghi ở đầu README (vd `mise install && npm ci && npm test`), không bước tay nào ngoài lấy bí mật dev từ nơi đã ghi. → Kiểm: job CI `onboarding-smoke` chạy đúng các lệnh đó trên runner mới, exit 0; thời gian đo ghi lại. · Nguồn: 12-factor II ("một lệnh build tất định"); OpenSSF Badge `documentation_basics`
- [ ] `XC-DX-002` **MUST** Bộ lệnh chuẩn (`dev`, `build`, `test`, `lint`, `format`, `typecheck`, `migrate` nếu có) khai báo **một nơi máy đọc** và được hook/CI/agent gọi nguyên văn; thêm bản phẳng `xt.yaml`/`runtime.yaml` (key: value) cho agent. → Kiểm: file tồn tại; grep workflow/hook/`AGENTS.md` dùng đúng tên lệnh; không có lệnh chỉ nằm trong văn xuôi. · Nguồn: catalog 23 §3.3 (`runtime.yaml` sau 11 lần `unverified`)
- [ ] `XC-DX-003` **MUST** Phiên bản runtime và công cụ **ghim trong repo** (`mise.toml`/`.tool-versions`/`.nvmrc`/`.python-version`/`go.mod`/`global.json`) và CI dùng đúng file đó (`setup-node` `node-version-file`, `setup-python` `python-version-file`, `mise-action`). → Kiểm: workflow không hard-code phiên bản khác file; `mise install` thành công từ clone. · Nguồn: [`../01-baseline/dependencies.md`](.xtemplates/framework/01-baseline/dependencies.md) BASE-DEP-003
- [ ] `XC-DX-006` **MUST** Hook cục bộ tự cài sau khi cài phụ thuộc và chạy **< 30 s** cho commit thường (chỉ file thay đổi); cổng đầy đủ để CI. → Kiểm: clone + install → `.git/hooks/pre-commit` tồn tại; `time` hook trên commit 5 file < 30 s. · Nguồn: [`../01-baseline/quality-gates.md`](.xtemplates/framework/01-baseline/quality-gates.md) BASE-GATE-015/016

### Tài liệu cho AI agent: AGENTS.md, CLAUDE.md, llms.txt, runtime.yaml, SCOPE.md

Nguồn khung: [`18-cross-cutting/docs-for-ai-agents.md`](.xtemplates/framework/18-cross-cutting/docs-for-ai-agents.md)

- [ ] `XC-DOCAI-001` **MUST** Có `AGENTS.md` ở gốc repo, Markdown thuần, gồm: tổng quan 3–5 dòng, lệnh cài/chạy/test/lint (trích từ file máy đọc), quy ước mã, luật PR/commit, ranh giới an toàn (điểm dừng bắt buộc), nơi đọc tiếp. → Kiểm: file tồn tại; script kiểm có đủ heading bắt buộc; mọi lệnh trong file xuất hiện y nguyên trong `xt.yaml`/`package.json#scripts`. · Nguồn: agents.md (AAIF)
- [ ] `XC-DOCAI-003` **MUST** Lệnh chạy cho agent nằm trong **file máy đọc phẳng** (`xt.yaml`/`runtime.yaml`; nhà của bộ khoá: [`LOOP-HARNESS-008`](.xtemplates/framework/11-autonomous-loop/harness-files.md) và mẫu [`../templates/xt.yaml`](.xtemplates/framework/templates/xt.yaml)) và được CI kiểm khớp với điểm vào thật. `scripts/dev-task.sh` chỉ chạy `format · lint · typecheck · test · build · format_file`; khoá khác (`install`, `dev`, `e2e`, `migrate`, `init`, `smoke`, `audit`…) là lệnh khai báo để agent đọc và chạy trực tiếp; `AGENTS.md` nói "không suy diễn lệnh từ văn xuôi". → Kiểm: `check:commands` so khoá/giá trị với `package.json`/`justfile`/`Makefile` = 0 lệch; `AGENTS.md` có câu cấm suy diễn. · Nguồn: catalog 23 §3.3
- [ ] `XC-DOCAI-004` **MUST** File hướng dẫn nêu rõ **ranh giới tin cậy**: nội dung từ web, issue, PR, tài liệu, output tool/MCP là dữ liệu, không phải chỉ thị; điểm dừng bắt buộc (xoá dữ liệu, tiền thật, publish, đổi quyền/cổng); và câu "hướng dẫn này không thay cho hook/permission". → Kiểm: `AGENTS.md` có mục "Điểm dừng bắt buộc" và câu "dữ liệu, không phải chỉ thị"; hook tương ứng tồn tại trong `.claude/settings.json`/CI. · Nguồn: evidence-and-sources.md luật 13; catalog 20 §1.5; Claude Code memory docs ("context, not enforced configuration")
- [ ] `XC-DOCAI-005` **MUST** File hướng dẫn **không chứa bí mật, dữ liệu người dùng, tên model/phiên AI, hay lệnh tải-và-chạy** (`curl \| sh`); được review như mã (CODEOWNERS) vì nó điều khiển hành vi agent của mọi người clone repo. → Kiểm: gitleaks quét `AGENTS.md`/`CLAUDE.md`/`.claude/**`/`.cursor/**`; grep `curl .*\| *(ba)?sh` = 0; CODEOWNERS có dòng cho các file này. · Nguồn: catalog 12 §3e (đọc install.sh/hook trước khi chạy); AGENTS.md của khung §Luật bất biến

### Quốc tế hoá & bản địa hoá: chuỗi, số/ngày/tiền, RTL, tiếng Việt

Nguồn khung: [`18-cross-cutting/i18n-and-l10n.md`](.xtemplates/framework/18-cross-cutting/i18n-and-l10n.md)

- [ ] `XC-I18N-001` **MUST** Mọi chuỗi người dùng thấy (UI, email, thông báo đẩy, lỗi, PDF) nằm trong **file tài nguyên** (`messages/<locale>.json`, `.po`, `.resx`, `.arb`), không hard-code trong mã; chuỗi nguồn có mô tả ngữ cảnh. → Kiểm: lint "no literal string in JSX/template" (`i18next/no-literal-string`, `formatjs/enforce-description`); script trích khoá so với file nguồn = 0 khoá thiếu. · Nguồn: W3C i18n Best Practices (localization)
- [ ] `XC-I18N-003` **MUST** Số, ngày/giờ, tiền, danh sách, thời gian tương đối định dạng bằng **CLDR/Intl/ICU** theo locale người dùng; không có chuỗi định dạng cứng. → Kiểm: grep không có `toFixed(`, `toLocaleDateString()` không tham số, `strftime('%d/%m/%Y')` ở lớp UI; test `vi-VN`: `1234567.89 → "1.234.567,89"`, `VND → "1.234.568 ₫"`, ngày `13/10/2026`; `en-US`: `"1,234,567.89"`, `10/13/2026`. · Nguồn: ECMA-402 (Intl.NumberFormat, DateTimeFormat); CLDR 48.2
- [ ] `XC-I18N-005` **MUST** Mã hoá UTF-8 đầu–cuối và chuỗi người nhập **chuẩn hoá NFC** (tiếng Việt gõ Telex/VNI/Unikey có thể ra dạng tổ hợp); tìm kiếm không phân biệt dấu/hoa thường dùng case-fold + bỏ dấu có chủ ý. → Kiểm: test nhập "Việt" NFD và NFC → một bản ghi; tìm "viet" ra "Việt" nếu spec yêu cầu bỏ dấu; chi tiết [`../01-baseline/data-correctness.md`](.xtemplates/framework/01-baseline/data-correctness.md). · Nguồn: UAX #15 rev. 58; W3C i18n (encoding)
- [ ] `XC-I18N-009` **MUST** File dịch được **validate trong CI**: mọi locale có đủ khoá của nguồn (hoặc fallback khai báo), đúng cú pháp ICU, cùng tập tham số với nguồn (`{name}` không bị mất/đổi tên), không có HTML/script lạ chèn vào. → Kiểm: `formatjs compile`/`i18next-parser --fail-on-warnings`/`lingui compile --strict`/`pybabel compile --statistics` + script so khoá = 0 lỗi. · Nguồn: P6 (file dịch cũng là đầu vào)

### Mã nguồn mở & cộng đồng: CONTRIBUTING, CoC, SECURITY.md, phát hành công khai

Nguồn khung: [`18-cross-cutting/open-source-and-community.md`](.xtemplates/framework/18-cross-cutting/open-source-and-community.md)

- [ ] `XC-OSS-001` **MUST** Bộ **file sức khoẻ cộng đồng** ở gốc/`.github/`/`docs/`: `LICENSE` (SPDX, OSI nếu gọi là open source), `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md` (hoặc mục trong README), issue/PR template; GitHub community profile đầy đủ. → Kiểm: `gh api repos/{o}/{r}/community/profile --jq .health_percentage` = 100; file tồn tại theo đường dẫn GitHub chấp nhận. · Nguồn: GitHub community profile; default community health files
- [ ] `XC-OSS-004` **MUST** `SECURITY.md` nêu phiên bản được hỗ trợ, cách báo riêng tư (GitHub private vulnerability reporting bật, hoặc email + khoá PGP), SLA phản hồi ban đầu ≤ 14 ngày, chính sách công bố phối hợp; dịch vụ công khai có `/.well-known/security.txt`. → Kiểm: `gh api repos/{o}/{r}` + settings bật PVR; `curl -f /.well-known/security.txt`; nhật ký báo cáo 6 tháng gần nhất phản hồi ≤ 14 ngày. · Nguồn: OpenSSF Badge `vulnerability_report_process`, `vulnerability_report_private`, `vulnerability_report_response`; RFC 9116; Scorecard Security-Policy
- [ ] `XC-OSS-005` **MUST** Mọi đóng góp qua **PR có review** của maintainer khác tác giả; CI chạy cho PR từ fork **không có bí mật** và với `permissions` chỉ đọc; không workflow `pull_request_target` chạy mã của fork với quyền ghi; workflow `issue_comment` có `contents: write` phải kiểm `author_association`. → Kiểm: ruleset `required_approving_review_count ≥ 1`; `actionlint` + review workflow: không `pull_request_target` checkout head của fork; grep `author_association` trong workflow có quyền ghi. · Nguồn: GitHub Actions security hardening; Scorecard Code-Review, Dangerous-Workflow; catalog 23 §8.1
- [ ] `XC-OSS-007` **MUST** Phát hành công khai có: tag ký, ghi chú phát hành người đọc được (không phải git log) nêu breaking/deprecation/lỗ hổng đã vá (CVE id), artefact kèm checksum và SBOM; publish lên registry qua **trusted publishing/OIDC** với 2FA bắt buộc. → Kiểm: release có `sbom.*.json`, `SHA256SUMS`; workflow publish có `id-token: write`, không token tĩnh; `release_notes_vulns` được ghi khi có CVE. · Nguồn: OpenSSF Badge `release_notes`, `release_notes_vulns`; Scorecard Signed-Releases; [`../12-security/supply-chain.md`](.xtemplates/framework/12-security/supply-chain.md)

### Kỹ thuật hiệu năng chung: đo trước, ngân sách, profiling, regression

Nguồn khung: [`18-cross-cutting/performance-engineering.md`](.xtemplates/framework/18-cross-cutting/performance-engineering.md)

- [ ] `XC-PERF-001` **MUST** Mỗi dự án định nghĩa **chỉ số hiệu năng chính** theo hồ sơ (bảng Quyết định) với mục tiêu số, điều kiện đo (thiết bị/mạng/dữ liệu) và nơi đo (lab/field), ghi trong `PROJECT.md`/SPEC. → Kiểm: `PROJECT.md` có mục "Hiệu năng" với ≥ 1 chỉ số có số + điều kiện; blueprint tick trỏ file. · Nguồn: lifecycle.md G0 (chỉ số đo được); web.dev Performance budgets 101
- [ ] `XC-PERF-003` **MUST** **Ngân sách hiệu năng** sống trong repo dưới dạng cấu hình máy đọc (`lighthouserc.json` `budgets`, `size-limit`, `bundlesize`, k6 `thresholds`, `benchstat` delta) và CI đỏ khi vượt — ngưỡng và cổng cụ thể theo loại ở nhà riêng: web [`FE-PERF-002`/`FE-PERF-004`](.xtemplates/framework/07-frontend/performance-web-vitals.md), backend [`QA-PERF-002`](.xtemplates/framework/14-testing-quality/performance-and-load.md), thư viện/CLI `QA-PERF-008`. → Kiểm: file ngân sách tồn tại; job CI thất bại khi cố ý thêm 200 KB/làm chậm 2× (test cổng). · Nguồn: web.dev Performance budgets 101; k6 thresholds
- [ ] `XC-PERF-004` **MUST** Độ trễ báo cáo bằng **phân vị** (p50/p95/p99) và histogram, kèm số mẫu; không dùng trung bình làm mục tiêu hay cổng. → Kiểm: dashboard/báo cáo benchmark có p95/p99; k6 `http_req_duration: ['p(95)<…']`; không có `avg<` làm threshold duy nhất. · Nguồn: Google SRE Book, "Monitoring Distributed Systems" (tail latency)
- [ ] `XC-PERF-006` **MUST** Mọi thao tác I/O có **timeout và giới hạn** (kích thước, số phần tử, độ sâu, số trang) để một yêu cầu không chiếm tài nguyên vô hạn; phân trang bắt buộc cho danh sách. → Kiểm: API list có `limit` mặc định và tối đa (vd 100/1000); test yêu cầu 10⁶ phần tử bị từ chối hoặc phân trang; chi tiết [`../01-baseline/errors-and-logging.md`](.xtemplates/framework/01-baseline/errors-and-logging.md) BASE-ERR-004. · Nguồn: catalog 23 §4.4 (limit 2000, cap 500)

### Bền vững: tài nguyên, chi phí năng lượng, tối ưu mã nguồn không đổi hành vi

Nguồn khung: [`18-cross-cutting/sustainability-and-efficiency.md`](.xtemplates/framework/18-cross-cutting/sustainability-and-efficiency.md)

- [ ] `XC-GREEN-001` **MUST** Có **baseline tài nguyên** đo được cho sản phẩm: web — trọng lượng trang (KB) và số request các màn chính; backend — CPU/RAM/kWh (hoặc chi phí) theo 1.000 yêu cầu; batch/ML — thời gian × tài nguyên mỗi lần chạy; ghi kèm ngày và commit. → Kiểm: `docs/perf/baseline-*.json` hoặc dashboard có các số trên; blueprint tick trỏ file. · Nguồn: P1; SCI spec (R = đơn vị chức năng)
- [ ] `XC-GREEN-002` **MUST** Mọi tài nguyên có **ngân sách**: trọng lượng trang/bundle, kích thước image container, thời gian và số job CI mỗi PR, chi phí/kWh mỗi đơn vị chức năng; vượt = đỏ hoặc issue tự mở. → Kiểm: `size-limit`/`lighthouserc` `budgets`; script kiểm kích thước image (`docker image inspect --format '{{.Size}}'`) trong CI; alert chi phí (xem [`../15-operations/cost-management.md`](.xtemplates/framework/15-operations/cost-management.md)). · Nguồn: web.dev Performance budgets; W3C WSG (Web Development)
- [ ] `XC-GREEN-005` **MUST** Refactor/tối ưu mã nguồn **không đổi hành vi**: có test phủ vùng sửa trước (characterization test nếu chưa có), bước nhỏ và xanh liên tục, PR `refactor:`/`perf:` riêng không trộn tính năng, đo số liệu trước–sau (dòng, bundle, complexity, dependency). → Kiểm: PR refactor có bảng trước/sau; test suite xanh không đổi số test (trừ test mới thêm); diff không chạm hành vi public (snapshot/contract test xanh). · Nguồn: khung cũ `quality-supplements.md` N2 §9; P8
- [ ] `XC-GREEN-007` **MUST** Dữ liệu lưu trữ có **chính sách retention**: log, backup, artefact CI, bản nháp, bảng sự kiện có TTL/lifecycle rule; không lưu vô hạn "phòng khi". → Kiểm: cấu hình lifecycle (S3/GCS/R2 rule, `logrotate`, retention của log backend, `actions/upload-artifact retention-days`) tồn tại; bảng sự kiện có job dọn; khớp với yêu cầu pháp lý ở [`../16-compliance-privacy/records-and-audit-readiness.md`](.xtemplates/framework/16-compliance-privacy/records-and-audit-readiness.md). · Nguồn: W3C WSG (Hosting/Infrastructure); Green Software Patterns

### Đơn vị, thời gian (UTC, timezone), tiền (số nguyên), ID, so sánh chuỗi

Nguồn khung: [`18-cross-cutting/units-time-and-money.md`](.xtemplates/framework/18-cross-cutting/units-time-and-money.md)

- [ ] `XC-UNITS-001` **MUST** Thời điểm lưu trữ và trao đổi bằng **UTC**, định dạng RFC 3339 có offset (`2026-10-13T07:14:05.123Z`); kiểu dữ liệu "aware" (có múi giờ) ở mọi ngôn ngữ; không có `datetime` naive, không `Date` không offset. → Kiểm: schema không có `timestamp without time zone`; lint cấm `datetime.now()`/`utcnow()` không `tz=`, `new Date().toLocale*` ở lớp lưu; test parse chuỗi không offset bị từ chối ở API. · Nguồn: RFC 3339 §5.6; RFC 9557
- [ ] `XC-UNITS-005` **MUST** Tiền **mặc định** lưu/tính bằng **số nguyên đơn vị nhỏ nhất** (`amount_minor`) **kèm mã ISO 4217**, số chữ số lẻ lấy từ bảng ISO 4217 (VND 0, JPY 0, USD/EUR 2, KWD/BHD 3, CLF 4); `numeric`/`decimal` với scale cố định **chỉ khi** nghiệp vụ cần độ chính xác lớn hơn đơn vị nhỏ nhất (tỷ giá, đơn giá theo gram/kWh) và có ADR; **không bao giờ float/double** ở bất kỳ tầng nào (CSDL, API, UI tính toán). → Kiểm: schema cột tiền là `BIGINT` + `currency`, cột `DECIMAL`/`NUMERIC` chỉ ở nơi ADR liệt kê; API trả `{ "amount_minor": 1500000, "currency": "VND" }` (giá trị decimal truyền dạng chuỗi); lint cấm `float`/`parseFloat`/`Number(` trong module tiền; test `Decimal('0.1') + Decimal('0.2') == Decimal('0.3')`. · Nguồn: ISO 4217 List One (SIX, 2026-09-17); Python `decimal`
- [ ] `XC-UNITS-006` **MUST** Phép tính tiền có **quy tắc làm tròn tường minh** (mode: HALF_UP cho hoá đơn VN thông thường, HALF_EVEN cho kế toán/thống kê — chọn theo nghiệp vụ, ghi trong spec) và `quantize` về đúng số chữ số lẻ sau mỗi phép nhân/chia; không dùng `round()` mặc định của ngôn ngữ mà không chỉ định mode. → Kiểm: spec/ADR ghi mode; test `2.665 → 2.67` (HALF_UP) và `→ 2.66` (HALF_EVEN) theo mode đã chọn; `round(Decimal)` không xuất hiện (Python `round()` bỏ qua context). · Nguồn: Python `decimal` docs (ROUND_HALF_EVEN mặc định, `quantize`)
- [ ] `XC-UNITS-009` **MUST** Mọi trường số có đơn vị mang đơn vị trong **tên** (`_ms`, `_s`, `_bytes`, `_kb`, `_kg`, `_cm`, `_percent`, `_bps`) hoặc trong **kiểu** (`Duration`, `Quantity`); hằng số chuyển đổi tập trung một module; không "số ma thuật" (`* 1000`, `/ 1024`). → Kiểm: lint schema/CSDL cảnh báo cột số không hậu tố đơn vị; grep `\* ?1000|/ ?1024` ngoài module đơn vị = 0. · Nguồn: P5; catalog 23 §4.5

### Ứng dụng web

Nguồn khung: [`02-profiles/web-app.md`](.xtemplates/framework/02-profiles/web-app.md)

- [ ] `PRF-WEB-001` **MUST** Chiến lược render (SSG/ISR/SSR/CSR) được chọn **theo nhóm route** và ghi ADR; route theo người dùng không dùng cache chia sẻ. → Kiểm: `docs/adr/` có ADR render; test E2E đăng nhập 2 user khác nhau không thấy dữ liệu của nhau; header `Cache-Control` của route có auth là `private`/`no-store`.
- [ ] `PRF-WEB-002` **MUST** Build production không giấu lỗi: cấm `ignoreBuildErrors`, `ignoreDuringBuilds`, `skipLibCheck` để qua cổng; CI chạy `build` + `type-check` + `lint` trên mọi PR. → Kiểm: `grep -rE "ignoreBuildErrors|ignoreDuringBuilds" next.config.* vite.config.*` rỗng; job CI có 3 bước. · Nguồn: catalog 09 §1.4
- [ ] `PRF-WEB-003` **MUST** Biến môi trường chia hai lớp: tiền tố công khai (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`) **chỉ** cho giá trị được phép lộ; env được validate khi khởi động, thiếu là fail-closed. → Kiểm: script CI grep tên biến chứa `SECRET|KEY|TOKEN|PASSWORD` có tiền tố công khai → fail; module env parse bằng schema (Zod). · Nguồn: catalog 09 §1.4; chi tiết ở [`../12-security/secrets-management.md`](.xtemplates/framework/12-security/secrets-management.md)
- [ ] `PRF-WEB-004` **MUST** Mọi endpoint ghi (API route, server action, form POST, webhook) kiểm xác thực + phân quyền **ở server** và chống CSRF; server action được coi là endpoint POST công khai. → Kiểm: test tích hợp gọi mỗi endpoint ghi không token → 401/403; test IDOR đổi `id` của user khác → 403. · Nguồn: ASVS 5.0 V4/V8; cơ chế ở [`../08-backend/authn-authz.md`](.xtemplates/framework/08-backend/authn-authz.md)
- [ ] `PRF-WEB-005` **MUST** Core Web Vitals ở p75 trên mobile đạt LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 cho ≥ 5 URL chính; Lighthouse CI chặn merge khi Performance < 0.9. → Kiểm: `lhci autorun` với `assertions` trong `lighthouserc.json`; job là required check. · Nguồn: web.dev/vitals; ngân sách chi tiết ở [`../07-frontend/performance-web-vitals.md`](.xtemplates/framework/07-frontend/performance-web-vitals.md)
- [ ] `PRF-WEB-006` **MUST** E2E luồng chính chạy trên **cả** viewport desktop và mobile, mỗi trang kèm quét axe: 0 vi phạm mức `critical`/`serious`. → Kiểm: `playwright.config` có 2 project; `@axe-core/playwright` assert `violations.filter(v => ['critical','serious'].includes(v.impact)).length === 0`. · Nguồn: WCAG 2.2 AA; cách test ở [`../14-testing-quality/e2e-and-accessibility.md`](.xtemplates/framework/14-testing-quality/e2e-and-accessibility.md)
- [ ] `PRF-WEB-007` **MUST** Security headers bật trên mọi response HTML: CSP (không `unsafe-inline` cho `script-src`, dùng nonce/hash), HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors`. → Kiểm: test E2E đọc header; `curl -sI <url>` trong CI so với danh sách bắt buộc. · Nguồn: OWASP ASVS 5.0 V3; chi tiết ở [`../07-frontend/client-security.md`](.xtemplates/framework/07-frontend/client-security.md)
- [ ] `PRF-WEB-008` **MUST** Error tracking phía client và server có **release + source map** tải lên riêng tư; source map không công khai trên production. → Kiểm: bước CI upload sourcemap; `curl -sI https://<host>/_next/static/.../*.map` trả 404/403; lỗi thử nghiệm hiện stack trace đọc được.
- [ ] `PRF-WEB-009` **MUST** Mỗi PR có **preview deployment** và staging có cùng tập biến môi trường/dịch vụ với production (khác giá trị, không khác hình dạng). → Kiểm: PR có URL preview tự động; script so khoá env giữa `staging` và `production` không lệch. · Nguồn: [`../10-workflow/environments-and-config.md`](.xtemplates/framework/10-workflow/environments-and-config.md)
- [ ] `PRF-WEB-010` **MUST** Phiên bản runtime và package manager ghim trong repo (`.nvmrc`/`.node-version`, `engines`, `packageManager`) và CI dùng đúng phiên bản đó. → Kiểm: file tồn tại; workflow dùng `node-version-file`; `corepack`/`pnpm/action-setup` đọc `packageManager`.

### Thương mại điện tử · bán lẻ · marketplace

Nguồn khung: [`03-industries/ecommerce.md`](.xtemplates/framework/03-industries/ecommerce.md)

- [ ] `IND-ECOM-001` **MUST** Tồn kho không âm: reservation có TTL khi vào checkout, ràng buộc `on_hand - reserved >= 0` ở CSDL, commit/release idempotent. → Kiểm: test song song N người mua 1 đơn vị cuối → đúng 1 thành công; constraint tồn tại trong migration. · Nguồn: [`../09-database/transactions-and-consistency.md`](.xtemplates/framework/09-database/transactions-and-consistency.md)
- [ ] `IND-ECOM-002` **MUST** Đơn hàng là snapshot bất biến (giá, thuế, khuyến mãi, địa chỉ, phiên bản điều khoản); giá chốt lại ở checkout, không tin giá trong giỏ/client. → Kiểm: test đổi giá sau khi thêm giỏ → checkout hiển thị giá mới; API đặt hàng bỏ qua giá client gửi lên. · Nguồn: Luật BVQLNTD 19/2023/QH15 (giao dịch từ xa); OWASP ASVS 5.0 V11
- [ ] `IND-ECOM-003` **MUST** Tiền/giá/thuế dùng số nguyên đơn vị nhỏ nhất, một hàm làm tròn, quy tắc công bố trên hoá đơn; test ca biên dòng/tổng. → Kiểm: lint cấm float trong module giá; test 3×33.333 đ + 8%. · Nguồn: ISO 4217; NĐ 123/2020/NĐ-CP (nội dung hoá đơn)
- [ ] `IND-ECOM-004` **MUST** Khuyến mãi qua rule engine: thứ tự áp dụng, giới hạn chồng, ngân sách, giới hạn/người; tổng giảm ≤ giá trị đơn; snapshot khuyến mãi lưu trong đơn. → Kiểm: bảng test ca chồng mã (%, tiền, freeship); test tổng không âm. · Nguồn: thực hành nội bộ; Luật BVQLNTD Đ.17 (thông tin chính xác)
- [ ] `IND-ECOM-005` **MUST** Trạng thái đơn/trả hàng/hoàn tiền theo state machine; chuyển trạng thái idempotent có lý do; hoàn tiền một phần nhiều lần không vượt số đã trả. → Kiểm: property test chuyển trạng thái; test hoàn 2 lần song song. · Nguồn: thực hành nội bộ; xem [`fintech.md`](.xtemplates/framework/03-industries/fintech.md)
- [ ] `IND-ECOM-006` **MUST** Thanh toán qua PSP có token hoá, idempotency key, webhook xác minh chữ ký và xử lý idempotent; không lưu dữ liệu thẻ. → Kiểm: mục IND-FIN-003/004/007 đạt; quét repo không có PAN. · Nguồn: PCI DSS v4.0.1; [`fintech.md`](.xtemplates/framework/03-industries/fintech.md)
- [ ] `IND-ECOM-007` **MUST** Công khai trên nền tảng thông tin bắt buộc: chủ sở hữu, điều kiện giao dịch chung, chính sách đổi trả/vận chuyển/thanh toán, giá đã gồm thuế, chi phí phát sinh trước khi đặt. → Kiểm: test E2E trang checkout hiển thị tổng cuối gồm thuế + phí trước nút đặt hàng; trang chính sách có phiên bản. · Nguồn: Luật TMĐT 122/2025/QH15 Đ.11; NĐ 248/2026/NĐ-CP; Luật BVQLNTD 19/2023/QH15
- [ ] `IND-ECOM-008` **MUST** Lưu và cho truy cập dữ liệu hàng hoá đã đăng ≥ 1 năm và dữ liệu hợp đồng/đơn hàng ≥ 3 năm kể từ giao kết (kể cả khi tài khoản người bán bị khoá); người bán tải được dữ liệu của mình. → Kiểm: retention trong data map ≥ 3 năm cho đơn; test người bán bị khoá vẫn tải được đơn cũ. · Nguồn: Luật TMĐT 122/2025/QH15 Đ.17 k.1e, k.2đ, k.2i
- [ ] `IND-ECOM-009` **MUST** Hoá đơn điện tử lập đúng thời điểm, đủ nội dung (số định danh người mua khi có), có mã cơ quan thuế khi thuộc diện; có luồng điều chỉnh/thay thế; lưu ≥ 10 năm. → Kiểm: tích hợp nhà cung cấp hoá đơn có test; job lập theo `business_date`; retention. · Nguồn: NĐ 123/2020/NĐ-CP sửa bởi NĐ 70/2025/NĐ-CP; Luật Kế toán 88/2015/QH13 Đ.41
- [ ] `IND-ECOM-010` **MUST** Thu thập/sử dụng dữ liệu khách hàng cho tiếp thị, cá nhân hoá, chia sẻ đối tác chỉ khi có đồng ý theo mục đích; cookie/tracking có tuỳ chọn từ chối. → Kiểm: mục CMP-VN-001/002/010 và [`../16-compliance-privacy/consent-and-user-rights.md`](.xtemplates/framework/16-compliance-privacy/consent-and-user-rights.md) đạt. · Nguồn: Luật 91/2025/QH15 Đ.9, Đ.28, Đ.29
- [ ] `IND-ECOM-011` **MUST** Marketplace: xác thực điện tử danh tính người bán (VNeID/giấy tờ hợp pháp với người bán nước ngoài) trước khi cho đăng bán; kiểm duyệt thông tin hàng hoá trước khi hiển thị; hệ thống khiếu nại trực tuyến có người giám sát quyết định. → Kiểm: test người bán chưa xác thực không đăng được sản phẩm; hàng chờ khiếu nại có người duyệt (không chỉ tự động). · Nguồn: Luật TMĐT 122/2025/QH15 Đ.17 k.1c, k.1đ, k.3, k.4
- [ ] `IND-ECOM-012` **MUST** Marketplace: tạm ngừng/chấm dứt tài khoản người bán có thông báo trước ≥ 5 ngày (trừ khi cơ quan nhà nước yêu cầu); gỡ hàng vi phạm theo quy chế có hệ thống rà soát/cảnh báo tự động (nền tảng lớn). → Kiểm: luồng khoá có bước thông báo + hẹn giờ; log quyết định. · Nguồn: Luật TMĐT 122/2025/QH15 Đ.17 k.2e, k.2g, k.3c
- [ ] `IND-ECOM-013` **MUST** Sàn có chức năng thanh toán khấu trừ, kê khai, nộp thuế thay hộ/cá nhân kinh doanh theo từng giao dịch thành công, có bảng kê và đối chiếu. → Kiểm: module thuế có test theo loại người bán (cư trú/không), báo cáo kỳ; đối chiếu tổng khấu trừ = Σ giao dịch. · Nguồn: Luật Thuế GTGT 48/2024/QH15; NĐ 117/2025/NĐ-CP; NĐ 68/2026/NĐ-CP
- [ ] `IND-ECOM-014` **MUST** Livestream bán hàng/affiliate: định danh người livestream, gắn nhãn nội dung quảng cáo, lưu bản ghi phiên theo quy chế. → Kiểm: tính năng livestream yêu cầu tài khoản đã xác thực; nhãn "quảng cáo" hiển thị (test E2E). · Nguồn: Luật TMĐT 122/2025/QH15 Đ.22–26; Luật Quảng cáo sửa đổi 75/2025/QH15 Đ.15a; NĐ 147/2024/NĐ-CP
- [ ] `IND-ECOM-015` **MUST** Đổi trả/huỷ: luồng tự phục vụ với thời hạn theo chính sách công bố (EU: 14 ngày rút lui), trạng thái minh bạch, hoàn tiền về đúng phương thức. → Kiểm: test E2E tạo yêu cầu trả → hoàn một phần; email/thông báo mỗi bước. · Nguồn: Luật BVQLNTD 19/2023/QH15; Directive 2011/83/EU Art. 9
- [ ] `IND-ECOM-016` **MUST** Checkout tiếp cận được (WCAG 2.2 AA), hoạt động bằng bàn phím, lỗi form rõ ràng, trạng thái tải/lỗi/rỗng đầy đủ; mobile-first. → Kiểm: axe trong E2E = 0 lỗi nghiêm trọng; Lighthouse a11y ≥ 90; xem [`../06-design-ux/accessibility.md`](.xtemplates/framework/06-design-ux/accessibility.md). · Nguồn: WCAG 2.2; EAA 2019/882
