import { defineRouteConfig } from "@medusajs/admin-sdk";
import { Alert, Badge, Button, Container, Heading, Input, Table, Text, toast } from "@medusajs/ui";
import { useState, type ReactNode } from "react";
import { CsvPicker } from "../../../components/csv-picker";
import { FilterSelect } from "../../../components/filter-select";
import { ProblemAlert, RowErrorTable } from "../../../components/problem-alert";
import { adminFetch } from "../../../lib/api";
import { MAX_CATALOG_CSV_BYTES, MAX_SETTLEMENT_CSV_BYTES } from "../../../lib/csv-file";
import { formatInstant, formatVnd } from "../../../lib/format";
import { AdminApiError, normalizeRowErrors } from "../../../lib/problem";
import { useApi } from "../../../lib/use-api";

interface ImportJob {
  import_id: string;
  status: string;
  file_name: string | null;
  summary: {
    rows_total: number;
    rows_valid: number;
    products_new: number;
    products_existing: number;
    variants_new: number;
    variants_existing: number;
  };
  errors: unknown;
  result: {
    products_created: string[];
    products_updated: string[];
    price_changes: Array<{ sku: string; before: number | null; after: number }>;
    stock_changes: Array<{ sku: string; before: number | null; after: number }>;
  } | null;
  can_commit?: boolean;
  replayed?: boolean;
}

const CatalogImport = (): ReactNode => {
  const [picked, setPicked] = useState<{ name: string; text: string } | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AdminApiError | null>(null);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof AdminApiError ? e : null);
    } finally {
      setBusy(false);
    }
  };

  const preview = () =>
    run(async () => {
      if (!picked) return;
      setJob(await adminFetch<ImportJob>("/admin/x/imports/preview", { method: "POST", csv: picked.text }));
    });

  const commit = () =>
    run(async () => {
      if (!job) return;
      const done = await adminFetch<ImportJob>(
        `/admin/x/imports/${encodeURIComponent(job.import_id)}/commit`,
        {
          method: "POST",
          json: {},
        },
      );
      setJob({ ...job, ...done, can_commit: false });
      toast.success(done.replayed === true ? "Lần nhập này đã được ghi trước đó" : "Đã nhập vào catalog");
    });

  const rowErrors = job ? normalizeRowErrors(job.errors) : [];
  const committed = job?.status === "committed" || job?.result != null;

  return (
    <Container className="flex flex-col gap-y-4">
      <div>
        <Heading level="h2">Nhập catalog từ CSV</Heading>
        <Text size="small" className="text-ui-fg-subtle">
          Bước 1: xem trước (chưa ghi gì). Bước 2: ghi khi không còn lỗi. Nhập giá/tồn cần thêm quyền tương
          ứng.
        </Text>
      </div>
      <CsvPicker
        label="File CSV (≤ 2 MB)"
        maxBytes={MAX_CATALOG_CSV_BYTES}
        disabled={busy}
        onText={(p) => {
          setPicked(p);
          setJob(null);
          setError(null);
        }}
      />
      <div className="flex gap-2">
        <Button onClick={preview} isLoading={busy} disabled={!picked}>
          Xem trước
        </Button>
        {job?.can_commit === true && !committed && (
          <Button variant="primary" onClick={commit} isLoading={busy}>
            Ghi vào catalog
          </Button>
        )}
      </div>
      <ProblemAlert error={error} />
      {job && (
        <div className="flex flex-col gap-y-3">
          <div className="flex flex-wrap gap-2">
            <Badge color="grey">Tổng dòng: {job.summary.rows_total}</Badge>
            <Badge color={job.summary.rows_valid === job.summary.rows_total ? "green" : "orange"}>
              Hợp lệ: {job.summary.rows_valid}
            </Badge>
            <Badge color="grey">
              Sản phẩm mới/cũ: {job.summary.products_new}/{job.summary.products_existing}
            </Badge>
            <Badge color="grey">
              Biến thể mới/cũ: {job.summary.variants_new}/{job.summary.variants_existing}
            </Badge>
            <Badge color="blue">Mã lần nhập: {job.import_id}</Badge>
          </div>
          {rowErrors.length > 0 ? (
            <>
              <Alert variant="error">Còn lỗi — sửa file rồi xem trước lại. Chưa có gì được ghi.</Alert>
              <RowErrorTable errors={rowErrors} />
            </>
          ) : job.summary.rows_total === 0 ? (
            <Alert variant="warning">File không có dòng dữ liệu.</Alert>
          ) : null}
          {job.result && (
            <Alert variant="success">
              Đã tạo {job.result.products_created.length} sản phẩm, cập nhật{" "}
              {job.result.products_updated.length}; đổi giá {job.result.price_changes.length} biến thể; đổi
              tồn {job.result.stock_changes.length} biến thể.
            </Alert>
          )}
        </div>
      )}
    </Container>
  );
};

interface Batch {
  id: string;
  source: string;
  external_ref: string | null;
  row_count: number;
  total_amount: number;
  summary: {
    matched_amount: number;
    discrepancies_opened: number;
    missing_opened: number;
    auto_resolved: number;
  };
  created_at: string;
}

interface BatchImportResult {
  replayed: boolean;
  batch: Batch;
  discrepancies: unknown[];
}

const SOURCES = [
  { value: "ghn_cod", label: "GHN — tiền thu hộ (COD)" },
  { value: "vnpay", label: "VNPAY — sao kê" },
];

const SettlementImport = (): ReactNode => {
  const [source, setSource] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [picked, setPicked] = useState<{ name: string; text: string } | null>(null);
  const [result, setResult] = useState<BatchImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AdminApiError | null>(null);
  const batches = useApi<{ batches: Batch[]; count: number }>(
    () => adminFetch("/admin/x/settlements/batches", { query: { limit: 10 } }),
    "batches",
  );

  const submit = async () => {
    if (!picked || !source || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await adminFetch<BatchImportResult>("/admin/x/settlements/batches", {
        method: "POST",
        query: { source, external_ref: externalRef, period_end: periodEnd },
        csv: picked.text,
      });
      setResult(res);
      toast.success(res.replayed ? "Chứng từ này đã nhập trước đó (không nhập lại)" : "Đã nhập và đối chiếu");
      batches.reload();
    } catch (e) {
      setResult(null);
      setError(e instanceof AdminApiError ? e : null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Container className="flex flex-col gap-y-4">
      <div>
        <Heading level="h2">Nhập chứng từ đối soát</Heading>
        <Text size="small" className="text-ui-fg-subtle">
          CSV bốn cột <code>reference,amount,occurred_at,type</code>. Một dòng sai thì cả file không được
          nhập. Cần xác thực TOTP.
        </Text>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect label="Nguồn (bắt buộc)" value={source} options={SOURCES} onChange={setSource} />
        <div className="w-56">
          <Input
            placeholder="Mã batch của hãng (tuỳ chọn)"
            maxLength={64}
            value={externalRef}
            onChange={(e) => setExternalRef(e.target.value)}
            aria-label="Mã batch của hãng"
          />
        </div>
        <div className="w-72">
          <Input
            placeholder="Chứng từ phủ tới (ISO, vd 2026-10-25T00:00:00+07:00)"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
            aria-label="Chứng từ phủ tới"
          />
        </div>
      </div>
      <CsvPicker
        label="File CSV (≤ 1 MB)"
        maxBytes={MAX_SETTLEMENT_CSV_BYTES}
        disabled={busy}
        onText={(p) => {
          setPicked(p);
          setResult(null);
          setError(null);
        }}
      />
      <div>
        <Button onClick={submit} isLoading={busy} disabled={!picked || !source}>
          Nhập chứng từ
        </Button>
      </div>
      <ProblemAlert error={error} />
      {result && (
        <Alert variant={result.batch.summary.discrepancies_opened > 0 ? "warning" : "success"}>
          {result.replayed ? "Chứng từ đã có từ trước. " : ""}
          {result.batch.row_count} dòng, tổng {formatVnd(result.batch.total_amount)}; khớp{" "}
          {formatVnd(result.batch.summary.matched_amount)}; mở {result.batch.summary.discrepancies_opened}{" "}
          chênh lệch (thiếu {result.batch.summary.missing_opened}), tự đóng{" "}
          {result.batch.summary.auto_resolved}. Xử lý ở trang &quot;Ngoại lệ&quot;.
        </Alert>
      )}
      {batches.data && batches.data.batches.length > 0 && (
        <div className="flex flex-col gap-y-1">
          <Text size="small" weight="plus">
            10 batch gần nhất
          </Text>
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Nhập lúc</Table.HeaderCell>
                <Table.HeaderCell>Nguồn</Table.HeaderCell>
                <Table.HeaderCell>Mã hãng</Table.HeaderCell>
                <Table.HeaderCell>Số dòng</Table.HeaderCell>
                <Table.HeaderCell>Tổng tiền</Table.HeaderCell>
                <Table.HeaderCell>Chênh lệch mở</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {batches.data.batches.map((b) => (
                <Table.Row key={b.id}>
                  <Table.Cell>{formatInstant(b.created_at)}</Table.Cell>
                  <Table.Cell>{SOURCES.find((s) => s.value === b.source)?.label ?? b.source}</Table.Cell>
                  <Table.Cell>{b.external_ref ?? "—"}</Table.Cell>
                  <Table.Cell>{b.row_count}</Table.Cell>
                  <Table.Cell>{formatVnd(b.total_amount)}</Table.Cell>
                  <Table.Cell>{b.summary.discrepancies_opened}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
      <ProblemAlert error={batches.error} />
    </Container>
  );
};

const ImportsPage = (): ReactNode => (
  <div className="flex flex-col gap-y-3">
    <CatalogImport />
    <SettlementImport />
  </div>
);

export const config = defineRouteConfig({ label: "Nhập CSV" });
export default ImportsPage;
