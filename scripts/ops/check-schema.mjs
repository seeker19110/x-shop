/**
 * Kiểm schema các bảng của module tùy biến (T-101 — DB-MODEL-004, DB-MODEL-005) bằng truy vấn catalog PostgreSQL trên
 * một DB ĐÃ MIGRATE. Chỉ bảng do migration của dự án tạo (`apps/backend/src/modules/<module>/migrations/Migration*.ts`,
 * `create table if not exists "…"`); bảng native Medusa và bảng link module không thuộc phạm vi.
 *
 *   node scripts/ops/check-schema.mjs                  # DB riêng dùng một lần: tạo → build domain → medusa db:migrate → kiểm → xoá
 *   node scripts/ops/check-schema.mjs --keep           # như trên nhưng giữ DB (in tên) để soi tay
 *   SCHEMA_DATABASE_URL=postgres://… node scripts/ops/check-schema.mjs   # chỉ đọc catalog của DB đã migrate sẵn
 *
 * Cách dựng DB (mặc định): DB mới `xshop_schema_<hex ngẫu nhiên>` (hai lần chạy song song không đụng nhau; tên — kể cả
 * `SCHEMA_DB_NAME` tự đặt — bắt buộc khớp ^xshop_schema[a-z0-9_]*$, kiểm trước mọi lệnh tới máy chủ) trên máy chủ
 * `SCHEMA_PG_BASE_URL` (mặc định postgres://xshop:xshop@localhost:5432 — dịch vụ cục bộ của scripts/dev-services.sh,
 * trùng job CI; không phải bí mật), rồi `medusa db:migrate --skip-links` với REDIS_URL rỗng (module hạ tầng in-memory —
 * không đụng Redis). Chỉ xoá DB do chính lần chạy này tạo (CREATE thành công), ở cuối kể cả khi lỗi (trừ `--keep`);
 * không bao giờ DROP trước CREATE.
 *
 * Luật (mỗi vi phạm một dòng; ngoại lệ chỉ qua allowlist bên dưới, mỗi mục kèm lý do ≥ 20 ký tự; mục thừa cũng là lỗi):
 *  - FK_ON_DELETE  khóa ngoại phải khai `ON DELETE` tường minh (RESTRICT/CASCADE/SET NULL/SET DEFAULT); `NO ACTION` là
 *                  mặc định ngầm của PostgreSQL nên bị coi là chưa khai.
 *  - FK_INDEX      cột khóa ngoại phải là cột dẫn đầu của một index hợp lệ KHÔNG partial (index partial không phục vụ
 *                  kiểm tra khi xoá/sửa dòng cha — dòng con ngoài điều kiện WHERE vẫn phải quét).
 *  - NOT_NULL      cột nullable phải có lý do: hoặc model DML khai `.nullable()` (snapshot `.snapshot-<module>.json`),
 *                  hoặc nằm trong NULLABLE_ALLOW. Model khai bắt buộc mà DB nullable → luôn là vi phạm.
 *  - CHECK_BOUND   cột số (integer/bigint/numeric/smallint) phải có CHECK cận dưới (`col >= …`/`col > …`) — tiền ≥ 0,
 *                  số lượng ≥ 0 — hoặc nằm trong NUMERIC_ALLOW.
 *  - CHECK_ENUM    cột chữ mang trạng thái/loại (tên state/status/kind/type/channel/method/priority/source/outcome/role/
 *                  action/payer/unit hoặc đuôi _state/_status/_kind/_type/_method) phải có CHECK tập giá trị — hoặc nằm
 *                  trong ENUM_ALLOW.
 *  - MIGRATION_NAME  tên file migration duy nhất giữa các module và đã có trong `mikro_orm_migrations` (bảng chung
 *                  của Medusa, khớp theo tên — trùng tên thì bản sau bị bỏ qua âm thầm).
 *  - MISSING_TABLE migration tạo bảng mà DB không có.
 *
 * Exit: 0 đạt · 1 có vi phạm · 2 lỗi cấu hình/kết nối/migrate.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const backendDir = path.join(root, "apps/backend");
const modulesDir = path.join(backendDir, "src/modules");
const fromRoot = createRequire(path.join(root, "package.json"));
const log = (m) => console.log(`[schema] ${m}`);

/**
 * Cột nullable có chủ đích ở bảng viết SQL tay (không có model DML/snapshot). Khóa `bảng.cột`.
 * Gom theo lý do chung để dễ soát; mỗi lý do nói vì sao "rỗng" là trạng thái hợp lệ của dữ liệu.
 */
const LATER_STEP =
  "chỉ có giá trị khi bước nghiệp vụ tương ứng đã xảy ra (người làm/thời điểm/kết quả của bước sau)";
const OPTIONAL_INPUT = "thông tin tùy chọn do người dùng/nhân viên nhập, bỏ trống là hợp lệ";
const SYSTEM_ACTOR = "hành động do hệ thống (job/webhook) thực hiện thì không có người làm";
const NO_TARGET =
  "dòng chứng từ/chênh lệch không khớp được đối tượng nào (unexpected/missing) thì không có đích";
const ATTR_ABSENT =
  "thuộc tính biến thể/sản phẩm không bắt buộc ở catalog (sản phẩm không có màu/size/chất liệu/ảnh)";
export const NULLABLE_ALLOW = {
  "audit_log.actor_id": SYSTEM_ACTOR,
  "audit_log.resource_id": "hành động không gắn một bản ghi cụ thể (vd đăng nhập, xuất báo cáo)",
  "audit_log.reason": OPTIONAL_INPUT,
  "audit_log.request_id": "ghi từ job/worker không có request HTTP",
  "audit_log.ip_hash": "ghi từ job/worker không có địa chỉ IP khách",
  "audit_log.outcome":
    "dòng ghi trước T-091 không biết kết quả; bảng append-only nên không backfill — dòng mới luôn có (Migration20261027090000)",
  "audit_log.user_agent": "ghi từ job/worker không có request HTTP, hoặc client không gửi User-Agent",
  "inventory_adjustment.actor_id": SYSTEM_ACTOR,
  "inventory_adjustment.note": OPTIONAL_INPUT,
  "user_role.granted_by":
    "vai trò owner đầu tiên cấp bằng lệnh vận hành (rbac:grant-owner), không có người cấp",
  "catalog_index_dirty.next_attempt_at":
    "null = đến hạn ngay (chưa thất bại lần nào) — Migration20261026120000",
  "catalog_variant_index.color": ATTR_ABSENT,
  "catalog_variant_index.color_label": ATTR_ABSENT,
  "catalog_variant_index.color_hex": ATTR_ABSENT,
  "catalog_variant_index.color_rank": ATTR_ABSENT,
  "catalog_variant_index.size": ATTR_ABSENT,
  "catalog_variant_index.size_label": ATTR_ABSENT,
  "catalog_variant_index.size_rank": ATTR_ABSENT,
  "catalog_variant_index.material": ATTR_ABSENT,
  "catalog_variant_index.material_label": ATTR_ABSENT,
  "catalog_variant_index.thumbnail": ATTR_ABSENT,
  "catalog_variant_index.product_thumbnail": ATTR_ABSENT,
  "catalog_variant_index.compare_at": "không có giá gạch (không khuyến mãi); CHECK compare_at > price khi có",
  "catalog_variant_index.price_valid_until":
    "giá không có hạn (giá niêm yết thường, không phải giá khuyến mãi có hạn)",
  "x_return.note": OPTIONAL_INPUT,
  "x_return.requested_by": "yêu cầu do khách gửi (kênh customer) không có tài khoản nhân viên",
  "x_return.decided_by": LATER_STEP,
  "x_return.decided_at": LATER_STEP,
  "x_return.decision_note": LATER_STEP,
  "x_return.received_by": LATER_STEP,
  "x_return.received_at": LATER_STEP,
  "x_return.inspected_by": LATER_STEP,
  "x_return.inspected_at": LATER_STEP,
  "x_return.closed_at": LATER_STEP,
  "x_return.replacement_order_id": "chỉ có khi yêu cầu là đổi hàng và đơn thay thế đã tạo",
  "x_return_line.variant_id": "dòng đơn gốc có thể không còn biến thể (biến thể đã xoá khỏi catalog)",
  "x_return_line.exchange_variant_id": "chỉ có ở yêu cầu đổi hàng (kind = exchange)",
  "x_return_line.size_chart": "sản phẩm không có bảng size (phụ kiện) thì không có ảnh chụp bảng size",
  "x_return_line.received_quantity": LATER_STEP,
  "x_return_line.restock_quantity": LATER_STEP,
  "x_return_line.damaged_quantity": LATER_STEP,
  "x_return_line.rejected_quantity": LATER_STEP,
  "x_return_line.refund_amount": LATER_STEP,
  "x_return_line.inspection_note": LATER_STEP,
  "x_refund.return_id": "hoàn tiền không đến từ yêu cầu trả (hủy đơn, trả thừa, trả muộn)",
  "x_refund.capture_ref":
    "hoàn thủ công (method = manual) không cần giao dịch thu; CHECK bắt buộc khi method = provider",
  "x_refund.approved_by": LATER_STEP,
  "x_refund.approved_at": LATER_STEP,
  "x_refund.rejected_by": LATER_STEP,
  "x_refund.rejected_at": LATER_STEP,
  "x_refund.reject_reason": LATER_STEP,
  "x_refund.executed_by": LATER_STEP,
  "x_refund.provider_ref": LATER_STEP,
  "x_refund.evidence_ref": LATER_STEP,
  "x_refund.last_error": "chỉ có khi lần gọi cổng thanh toán gần nhất lỗi",
  "x_refund.note": OPTIONAL_INPUT,
  "x_refund.succeeded_at": LATER_STEP,
  "x_refund.cancelled_by": LATER_STEP,
  "x_refund.cancelled_at": LATER_STEP,
  "x_refund.cancel_reason": LATER_STEP,
  "x_order_cancel.from_state":
    "lệnh hủy lặp lại trên đơn đã hủy (outcome = already_cancelled) không có trạng thái gốc",
  "x_order_cancel.refund_id": "chỉ có khi đơn đã thu tiền và lệnh hủy tạo yêu cầu hoàn",
  "x_settlement_batch.external_ref":
    "chứng từ của hãng không có mã batch; UNIQUE(source, external_ref) khi có",
  "x_settlement_batch.period_end": "chứng từ không ghi kỳ đối soát",
  "x_settlement_line.target_kind": NO_TARGET,
  "x_settlement_line.target_id": NO_TARGET,
  "x_settlement_line.order_id": NO_TARGET,
  "x_settlement_line.expected_amount": NO_TARGET,
  "x_settlement_line.difference": NO_TARGET,
  "x_settlement_discrepancy.target_kind": NO_TARGET,
  "x_settlement_discrepancy.target_id": NO_TARGET,
  "x_settlement_discrepancy.order_id": NO_TARGET,
  "x_settlement_discrepancy.expected_amount": "chênh lệch loại unexpected: không có số kỳ vọng ở hệ thống",
  "x_settlement_discrepancy.difference": "missing/unexpected: thiếu một vế nên không có hiệu số",
  "x_settlement_discrepancy.line_id": "chênh lệch loại missing không có dòng chứng từ tương ứng",
  "x_settlement_discrepancy.owner": "chưa giao người xử lý",
  "x_settlement_discrepancy.resolved_by": "chưa giải quyết, hoặc hệ thống tự giải quyết (auto_resolved)",
  "x_settlement_discrepancy.resolved_at":
    "chưa giải quyết; CHECK (state = resolved) = (resolved_at is not null)",
  "x_settlement_discrepancy.resolution_note": LATER_STEP,
  "x_settlement_discrepancy.evidence_ref": LATER_STEP,
  "x_settlement_discrepancy_event.actor_id": SYSTEM_ACTOR,
  "x_settlement_discrepancy_event.batch_id": "sự kiện giải quyết tay không gắn batch nhập chứng từ",
  "x_settlement_discrepancy_event.note": OPTIONAL_INPUT,
  "x_settlement_discrepancy_event.data": "sự kiện không kèm dữ liệu chi tiết",
};

/** Cột số không có cận dưới có chủ đích. */
const LATE_AFTER_CANCEL =
  "late_after_cancel ghi phần còn phải thu (phải thu − đã thu, settlement/match.ts) — âm khi đã thu vượt";
const RANK = "thứ tự sắp xếp hiển thị; giá trị âm hợp lệ (đưa lên trước), không phải số lượng hay tiền";
export const NUMERIC_ALLOW = {
  "inventory_adjustment.delta":
    "số điều chỉnh có dấu (nhập +, xuất −); CHECK delta <> 0 và after = before + delta",
  "inventory_adjustment.stocked_before":
    "ảnh chụp stocked_quantity của inventory_level native — Medusa không ràng buộc cận dưới, sổ phải ghi đúng giá trị thấy",
  "x_settlement_line.difference": "hiệu số có dấu (thực nhận − kỳ vọng): âm = thiếu, dương = thừa",
  "x_settlement_line.expected_amount": LATE_AFTER_CANCEL,
  "x_settlement_discrepancy.expected_amount": LATE_AFTER_CANCEL,
  "x_settlement_discrepancy.difference": "hiệu số có dấu (thực nhận − kỳ vọng): âm = thiếu, dương = thừa",
  "fashion_color.rank": RANK,
  "fashion_size.rank": RANK,
  "catalog_variant_index.color_rank": RANK,
  "catalog_variant_index.size_rank": RANK,
  "catalog_variant_index.variant_rank": RANK,
};

/** Cột trạng thái/loại không có CHECK tập giá trị có chủ đích. */
const PROVIDER_VOCAB =
  "giá trị thô của nhà cung cấp (GHN) — tập mở, lưu nguyên để đối chiếu; ánh xạ ở packages/domain";
export const ENUM_ALLOW = {
  "shipment_event.type": PROVIDER_VOCAB,
  "shipment_event.status": PROVIDER_VOCAB,
  "audit_log.actor_type":
    "lấy từ auth_context của Medusa (user/customer/actor tùy biến) + anonymous/system/unknown — audit không được từ chối ghi vì loại lạ",
  "audit_log.action":
    "tên hành động mở rộng theo tính năng (rbac.denied, settlement.batch.imported…); không phải trạng thái",
  "audit_log.resource_type": "tên loại tài nguyên mở rộng theo route admin mới; không phải máy trạng thái",
  "outbox_event.type": "tên sự kiện miền mở rộng theo tính năng (order.placed…); consumer bỏ qua loại lạ",
  "size_chart.garment_type":
    "nhóm hàng do nhân viên catalog đặt (áo, quần, giày…) — danh mục mở, không phải trạng thái",
};

/** Khóa ngoại được miễn luật FK_*. Khóa `bảng.tên_constraint`. Hiện không có. */
export const FK_ALLOW = {};

const ENUM_NAME =
  /^(state|status|kind|type|channel|method|priority|source|outcome|role|action|payer|unit)$|_(state|status|kind|type|method)$/;
const NUMERIC_TYPES = new Set(["integer", "bigint", "numeric", "smallint"]);
const TEXT_TYPES = new Set(["text", "character varying"]);
const NO_ACTION = "a";

/**
 * Quét migration của các module: bảng do dự án tạo (Map bảng → module) và danh sách file migration
 * `[{ module, name }]` (tên lớp = tên file — Medusa ghi chung MỘT bảng `mikro_orm_migrations` cho mọi module, chỉ theo
 * tên: hai module trùng tên thì migration thứ hai bị coi là đã chạy và bỏ qua âm thầm).
 */
export function scanModules(dir = modulesDir) {
  const tables = new Map();
  const migrations = [];
  for (const mod of readdirSync(dir, { withFileTypes: true })) {
    if (!mod.isDirectory()) continue;
    const migDir = path.join(dir, mod.name, "migrations");
    if (!existsSync(migDir)) continue;
    for (const file of readdirSync(migDir).filter((f) => /^Migration\d+\.ts$/.test(f))) {
      migrations.push({ module: mod.name, name: file.replace(/\.ts$/, "") });
      for (const m of readFileSync(path.join(migDir, file), "utf8").matchAll(
        /create table if not exists "([a-z0-9_]+)"/gi,
      )) {
        tables.set(m[1], mod.name);
      }
    }
  }
  return { tables, migrations };
}

export const projectTables = (dir = modulesDir) => scanModules(dir).tables;

/** Cột theo model DML (snapshot MikroORM `.snapshot-<module>.json`): Map bảng → Map cột → { nullable }. */
export function snapshotColumns(dir = modulesDir) {
  const out = new Map();
  for (const mod of readdirSync(dir, { withFileTypes: true })) {
    if (!mod.isDirectory()) continue;
    const migDir = path.join(dir, mod.name, "migrations");
    if (!existsSync(migDir)) continue;
    for (const file of readdirSync(migDir).filter((f) => /^\.snapshot-.*\.json$/.test(f))) {
      const snap = JSON.parse(readFileSync(path.join(migDir, file), "utf8"));
      for (const t of snap.tables ?? []) {
        const cols = new Map();
        for (const [name, c] of Object.entries(t.columns ?? {}))
          cols.set(name, { nullable: c.nullable === true });
        out.set(t.name, cols);
      }
    }
  }
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const colRef = (col) => `(?:^|[^\\w"])"?${esc(col)}"?`;

/** CHECK có cận dưới cho cột: `col >= x` / `col > x` (x là số hoặc cột khác). */
export function hasLowerBound(defs, col) {
  const re = new RegExp(`${colRef(col)}\\)?\\s*(?:>=|>)\\s*`);
  return defs.some((d) => re.test(d));
}

/** CHECK tập giá trị cho cột: `col = ANY (ARRAY[…])` (cách PostgreSQL in `col in (…)`) hoặc `col = '…'::text`. */
export function hasEnumCheck(defs, col) {
  const re = new RegExp(`${colRef(col)}\\s*=\\s*(?:ANY\\s*\\(\\s*\\(?ARRAY\\[|'[^']*'::)`);
  return defs.some((d) => re.test(d));
}

/** FK được phủ bởi index: các cột FK (bất kể thứ tự) là tiền tố cột của một index hợp lệ, không partial. */
export function fkCovered(fkCols, indexes) {
  const want = new Set(fkCols);
  return indexes.some(
    (ix) =>
      ix.valid &&
      !ix.partial &&
      ix.columns.length >= want.size &&
      ix.columns.slice(0, want.size).every((c) => c !== null && want.has(c)),
  );
}

/**
 * Phân tích catalog → danh sách vi phạm `{ rule, table, column?, constraint?, message }`.
 * `catalog`: { columns: [{table, column, type, nullable}], checks: [{table, def}], fks: [{table, name, columns,
 * ref, onDelete}], indexes: [{table, name, columns, partial, valid}] }.
 */
export function analyze(catalog, { tables, migrations = [], snapshot = new Map(), allow = {} }) {
  const nullableAllow = allow.nullable ?? NULLABLE_ALLOW;
  const numericAllow = allow.numeric ?? NUMERIC_ALLOW;
  const enumAllow = allow.enum ?? ENUM_ALLOW;
  const fkAllow = allow.fk ?? FK_ALLOW;
  const used = { nullable: new Set(), numeric: new Set(), enum: new Set(), fk: new Set() };
  const out = [];
  const push = (v) => out.push(v);
  const inScope = (t) => tables.has(t);

  const seen = new Map();
  for (const m of migrations) seen.set(m.name, [...(seen.get(m.name) ?? []), m.module]);
  for (const [name, mods] of seen)
    if (mods.length > 1)
      push({
        rule: "MIGRATION_NAME",
        table: name,
        message: `tên migration trùng giữa module ${mods.join(", ")} — mikro_orm_migrations chỉ theo tên, bản sau bị bỏ qua`,
      });
  if (catalog.applied) {
    const applied = new Set(catalog.applied);
    for (const name of seen.keys())
      if (!applied.has(name))
        push({
          rule: "MIGRATION_NAME",
          table: name,
          message: "migration chưa được áp vào DB (mikro_orm_migrations)",
        });
  }

  const present = new Set(catalog.columns.map((c) => c.table));
  for (const t of tables.keys())
    if (!present.has(t))
      push({ rule: "MISSING_TABLE", table: t, message: "migration tạo bảng nhưng DB không có" });

  const checksBy = new Map();
  for (const c of catalog.checks) {
    if (!checksBy.has(c.table)) checksBy.set(c.table, []);
    checksBy.get(c.table).push(c.def);
  }
  const indexesBy = new Map();
  for (const ix of catalog.indexes) {
    if (!indexesBy.has(ix.table)) indexesBy.set(ix.table, []);
    indexesBy.get(ix.table).push(ix);
  }

  for (const fk of catalog.fks.filter((f) => inScope(f.table))) {
    const key = `${fk.table}.${fk.name}`;
    if (Object.hasOwn(fkAllow, key)) {
      used.fk.add(key);
      continue;
    }
    const cols = fk.columns.join(", ");
    if (fk.onDelete === NO_ACTION)
      push({
        rule: "FK_ON_DELETE",
        table: fk.table,
        constraint: fk.name,
        message: `FK (${cols}) → ${fk.ref} không khai ON DELETE (mặc định NO ACTION)`,
      });
    if (!fkCovered(fk.columns, indexesBy.get(fk.table) ?? []))
      push({
        rule: "FK_INDEX",
        table: fk.table,
        constraint: fk.name,
        message: `FK (${cols}) → ${fk.ref} không có index thường (không partial) dẫn đầu bằng cột FK`,
      });
  }

  for (const c of catalog.columns.filter((x) => inScope(x.table))) {
    const key = `${c.table}.${c.column}`;
    const defs = checksBy.get(c.table) ?? [];
    const model = snapshot.get(c.table)?.get(c.column);
    if (c.nullable) {
      if (model && !model.nullable)
        push({
          rule: "NOT_NULL",
          table: c.table,
          column: c.column,
          message: "model DML khai bắt buộc nhưng DB nullable",
        });
      else if (model?.nullable) {
        // model khai `.nullable()` — lý do nằm ở model
      } else if (Object.hasOwn(nullableAllow, key)) used.nullable.add(key);
      else
        push({
          rule: "NOT_NULL",
          table: c.table,
          column: c.column,
          message: "cột nullable không có lý do (model/allowlist)",
        });
    }
    if (NUMERIC_TYPES.has(c.type) && !hasLowerBound(defs, c.column)) {
      if (Object.hasOwn(numericAllow, key)) used.numeric.add(key);
      else
        push({
          rule: "CHECK_BOUND",
          table: c.table,
          column: c.column,
          message: `cột ${c.type} không có CHECK cận dưới`,
        });
    }
    if (TEXT_TYPES.has(c.type) && ENUM_NAME.test(c.column) && !hasEnumCheck(defs, c.column)) {
      if (Object.hasOwn(enumAllow, key)) used.enum.add(key);
      else
        push({
          rule: "CHECK_ENUM",
          table: c.table,
          column: c.column,
          message: "cột trạng thái/loại không có CHECK tập giá trị",
        });
    }
  }

  for (const [kind, list] of [
    ["nullable", nullableAllow],
    ["numeric", numericAllow],
    ["enum", enumAllow],
    ["fk", fkAllow],
  ]) {
    for (const [key, why] of Object.entries(list)) {
      if (typeof why !== "string" || why.trim().length < 20)
        push({ rule: "ALLOWLIST", table: key, message: `lý do allowlist ${kind} quá ngắn (< 20 ký tự)` });
      if (!used[kind].has(key))
        push({
          rule: "ALLOWLIST",
          table: key,
          message: `mục allowlist ${kind} thừa (không còn vi phạm tương ứng) — xoá`,
        });
    }
  }
  return out;
}

const CATALOG_SQL = {
  columns: `SELECT table_name AS "table", column_name AS "column", data_type AS type, is_nullable = 'YES' AS nullable
              FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1)`,
  checks: `SELECT t.relname AS "table", pg_get_constraintdef(k.oid) AS def
             FROM pg_constraint k JOIN pg_class t ON t.oid = k.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public' AND k.contype = 'c' AND t.relname = ANY($1)`,
  fks: `SELECT t.relname AS "table", k.conname AS name, r.relname AS ref, k.confdeltype AS "onDelete",
               ARRAY(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY AS u(attnum, ord)
                       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum ORDER BY u.ord)::text[] AS columns
          FROM pg_constraint k JOIN pg_class t ON t.oid = k.conrelid JOIN pg_class r ON r.oid = k.confrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = 'public' AND k.contype = 'f' AND t.relname = ANY($1)`,
  indexes: `SELECT t.relname AS "table", c.relname AS name, i.indpred IS NOT NULL AS partial, i.indisvalid AS valid,
                   ARRAY(SELECT a.attname FROM unnest(i.indkey[0:i.indnkeyatts - 1]) WITH ORDINALITY AS u(attnum, ord)
                           LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = u.attnum ORDER BY u.ord)::text[] AS columns
              FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_class c ON c.oid = i.indexrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
             WHERE n.nspname = 'public' AND t.relname = ANY($1)`,
};

/** Đọc catalog của các bảng `names` qua client `pg` đã kết nối. */
export async function readCatalog(db, names) {
  const out = {};
  for (const [k, sql] of Object.entries(CATALOG_SQL)) out[k] = (await db.query(sql, [names])).rows;
  out.applied = (await db.query(`SELECT name FROM mikro_orm_migrations`)).rows.map((r) => r.name);
  return out;
}

const PG_BASE = process.env.SCHEMA_PG_BASE_URL ?? "postgres://xshop:xshop@localhost:5432";
const SAFE_DB_NAME = /^xshop_schema[a-z0-9_]*$/;

export function assertSafeDbName(name) {
  if (typeof name !== "string" || !SAFE_DB_NAME.test(name))
    throw new Error(`SCHEMA_DB_NAME phải khớp ^xshop_schema[a-z0-9_]*$ (nhận "${name}")`);
}

/**
 * Tên DB dùng một lần: `SCHEMA_DB_NAME` nếu đặt, không thì `xshop_schema_<hex ngẫu nhiên>` (crypto — hai lần chạy song
 * song, kể cả khác máy/container cùng pid, không trùng tên → không cần DROP trước CREATE).
 */
export function schemaDbName(env = process.env) {
  return env.SCHEMA_DB_NAME ?? `xshop_schema_${randomBytes(6).toString("hex")}`;
}

async function connect(url) {
  const { Client } = fromRoot("pg");
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd ?? root, env: { ...process.env, ...opts.env } });
    let output = "";
    const sink = (d) => {
      output += d.toString();
    };
    child.stdout.on("data", sink);
    child.stderr.on("data", sink);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${cmd} ${args.join(" ")} thoát mã ${code ?? signal}\n${output.slice(-4000)}`));
    });
  });
}

async function adminQuery(sql) {
  const admin = await connect(`${PG_BASE}/postgres`);
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

/** Migrate DB rỗng vừa tạo bằng Medusa (như production). */
async function migrate(url, runFn) {
  await runFn("pnpm", ["--filter", "@x-shop/domain", "build"]);
  await runFn("pnpm", ["exec", "medusa", "db:migrate", "--skip-links"], {
    cwd: backendDir,
    env: { NODE_ENV: "development", DATABASE_URL: url, REDIS_URL: "", DISABLE_MEDUSA_ADMIN: "true" },
  });
}

/**
 * Luồng chính. `deps` chỉ để test thay I/O (adminQuery/run/connect/env/log).
 * An toàn xoá: tên DB được kiểm TRƯỚC mọi lệnh tới máy chủ; chỉ DROP khi chính lần chạy này đã CREATE thành công, và
 * kiểm tên lần nữa ngay trước DROP. Không bao giờ DROP trước CREATE (DB trùng tên đã có → CREATE lỗi → exit 2).
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const admin = deps.adminQuery ?? adminQuery;
  const runFn = deps.run ?? run;
  const connectFn = deps.connect ?? connect;
  const pgBase = env.SCHEMA_PG_BASE_URL ?? PG_BASE;
  const keep = argv.includes("--keep");
  const external = env.SCHEMA_DATABASE_URL;
  const { tables, migrations } = scanModules();
  if (tables.size === 0) {
    console.error("[schema] không tìm thấy bảng nào trong migration của module — regex/đường dẫn lệch?");
    return 2;
  }
  const dbName = external ? null : schemaDbName(env);
  try {
    if (dbName !== null) assertSafeDbName(dbName);
  } catch (e) {
    console.error(`[schema] LỖI: ${e.message}`);
    return 2;
  }
  let url = external;
  let created = false;
  try {
    if (dbName !== null) {
      await admin(`CREATE DATABASE "${dbName}"`);
      created = true;
      url = `${pgBase}/${dbName}`;
      log(`DB ${dbName}: build domain + medusa db:migrate…`);
      await migrate(url, runFn);
    }
    const db = await connectFn(url);
    let catalog;
    try {
      catalog = await readCatalog(db, [...tables.keys()]);
    } finally {
      await db.end();
    }
    const violations = analyze(catalog, { tables, migrations, snapshot: snapshotColumns() });
    const nullable = catalog.columns.filter((c) => tables.has(c.table) && c.nullable).length;
    log(
      `${tables.size} bảng · ${catalog.columns.filter((c) => tables.has(c.table)).length} cột (${nullable} nullable) · ${catalog.fks.length} FK · ${catalog.checks.length} CHECK`,
    );
    for (const v of violations)
      console.log(
        `[schema] ${v.rule} ${v.table}${v.column ? `.${v.column}` : ""}${v.constraint ? ` (${v.constraint})` : ""}: ${v.message}`,
      );
    if (violations.length) {
      log(`FAIL: ${violations.length} vi phạm`);
      return 1;
    }
    log("đạt");
    return 0;
  } catch (e) {
    console.error(`[schema] LỖI: ${e.message}`);
    return 2;
  } finally {
    if (created && !keep) {
      try {
        assertSafeDbName(dbName);
        await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } catch (e) {
        console.error(`[schema] không xoá được DB ${dbName} (xoá tay): ${e.message}`);
      }
    } else if (created) log(`giữ DB: ${pgBase}/${dbName}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
