import { defineRouteConfig } from "@medusajs/admin-sdk";
import { Badge, Button, Container, Heading, Input, Table, Text, Textarea, toast } from "@medusajs/ui";
import { useState, type ReactNode } from "react";
import { FilterSelect } from "../../../components/filter-select";
import { ProblemAlert } from "../../../components/problem-alert";
import { adminFetch } from "../../../lib/api";
import { formatAge, formatInstant, formatVnd } from "../../../lib/format";
import {
  DISCREPANCY_KIND_LABELS,
  EXCEPTION_SOURCE_LABELS,
  EXCEPTION_STATE_LABELS,
  PRIORITY_LABELS,
  exceptionStateLabel,
  kindLabel,
  priorityColor,
  priorityLabel,
  sourceLabel,
} from "../../../lib/labels";
import { AdminApiError } from "../../../lib/problem";
import { useApi } from "../../../lib/use-api";
import { isNonEmpty } from "../../../lib/presence";

interface ExceptionItem {
  source: "ops" | "settlement" | "cod";
  id: string;
  kind: string;
  order_id: string | null;
  reference: string | null;
  amount: number | null;
  priority: string;
  state: string;
  owner: string | null;
  owner_role: string;
  opened_at: string;
  due_at: string | null;
  age_seconds: number;
}

interface ExceptionsResponse {
  items: ExceptionItem[];
  count: number;
  by_kind: Array<{ source: string; kind: string; count: number; amount: number }>;
  limit: number;
  offset: number;
}

const PAGE = 50;
const toOptions = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));

const ExceptionsPage = (): ReactNode => {
  const [source, setSource] = useState("");
  const [kind, setKind] = useState("");
  const [priority, setPriority] = useState("");
  // API chỉ trả mục còn mở/đang xử lý; lọc trạng thái áp trên trang hiện tại.
  const [state, setState] = useState("");
  const [offset, setOffset] = useState(0);
  const key = JSON.stringify([source, kind, priority, offset]);
  const list = useApi<ExceptionsResponse>(
    () =>
      adminFetch("/admin/x/reports/exceptions", {
        query: { source, kind, priority, limit: PAGE, offset },
      }),
    key,
  );

  const [resolving, setResolving] = useState<ExceptionItem | null>(null);
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<AdminApiError | null>(null);

  const reset = (fn: () => void) => {
    fn();
    setOffset(0);
  };
  const noteOk = note.trim().length >= 3;
  const evidenceOk = evidence.trim() === "" || evidence.trim().length >= 3;

  const resolve = async () => {
    if (!resolving || !noteOk || !evidenceOk || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await adminFetch(`/admin/x/settlements/discrepancies/${encodeURIComponent(resolving.id)}/resolve`, {
        method: "POST",
        json: { note: note.trim(), ...(evidence.trim() && { evidence_ref: evidence.trim() }) },
      });
      toast.success("Đã đóng chênh lệch");
      setResolving(null);
      setNote("");
      setEvidence("");
      list.reload();
    } catch (e) {
      setActionError(e instanceof AdminApiError ? e : null);
    } finally {
      setBusy(false);
    }
  };

  const data = list.data;
  const items = (data?.items ?? []).filter((i) => state === "" || i.state === state);
  const kindOptions = toOptions({
    ...DISCREPANCY_KIND_LABELS,
    ...Object.fromEntries((data?.by_kind ?? []).map((g) => [g.kind, kindLabel(g.kind)])),
    ...(kind && { [kind]: kindLabel(kind) }),
  });

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="flex flex-col gap-y-4">
        <div>
          <Heading level="h1">Ngoại lệ cần xử lý</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Ngoại lệ vận hành, chênh lệch đối soát và COD chưa đối soát đủ — ưu tiên cao và cũ trước.
          </Text>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <FilterSelect
            label="Loại nguồn"
            value={source}
            options={toOptions(EXCEPTION_SOURCE_LABELS)}
            onChange={(v) => reset(() => setSource(v))}
          />
          <FilterSelect
            label="Loại ngoại lệ"
            value={kind}
            options={kindOptions}
            onChange={(v) => reset(() => setKind(v))}
          />
          <FilterSelect
            label="Ưu tiên"
            value={priority}
            options={toOptions(PRIORITY_LABELS)}
            onChange={(v) => reset(() => setPriority(v))}
          />
          <FilterSelect
            label="Trạng thái (trang này)"
            value={state}
            options={toOptions(EXCEPTION_STATE_LABELS)}
            onChange={setState}
          />
          <Button size="small" variant="secondary" onClick={list.reload} isLoading={list.loading}>
            Tải lại
          </Button>
        </div>
        <ProblemAlert error={list.error} />
        {data && data.by_kind.length > 0 && (
          <div className="flex flex-wrap gap-2" aria-label="Tổng hợp theo loại">
            {data.by_kind.map((g) => (
              <Badge key={`${g.source}-${g.kind}`} color="grey">
                {sourceLabel(g.source)} · {kindLabel(g.kind)}: {g.count} mục, {formatVnd(g.amount)}
              </Badge>
            ))}
          </div>
        )}
      </Container>

      {resolving && (
        <Container className="flex flex-col gap-y-3">
          <Heading level="h2">Đóng chênh lệch {resolving.reference ?? resolving.id}</Heading>
          <Text size="small">
            {kindLabel(resolving.kind)} · {formatVnd(resolving.amount)}. Đóng chỉ ghi nhận đã xử lý — không
            động tới tiền; hoàn/thu hồi đi qua luồng hoàn tiền.
          </Text>
          <Textarea
            placeholder="Lý do đóng (bắt buộc, ≥ 3 ký tự)"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Lý do đóng"
          />
          <Input
            placeholder="Mã chứng từ (tuỳ chọn, ≥ 3 ký tự)"
            maxLength={128}
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            aria-label="Mã chứng từ"
          />
          <ProblemAlert error={actionError} />
          <div className="flex gap-2">
            <Button onClick={resolve} isLoading={busy} disabled={!noteOk || !evidenceOk}>
              Đóng chênh lệch
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setResolving(null);
                setActionError(null);
              }}
            >
              Hủy
            </Button>
          </div>
        </Container>
      )}

      <Container className="p-0">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Ưu tiên</Table.HeaderCell>
              <Table.HeaderCell>Loại</Table.HeaderCell>
              <Table.HeaderCell>Đơn / tham chiếu</Table.HeaderCell>
              <Table.HeaderCell>Số tiền</Table.HeaderCell>
              <Table.HeaderCell>Trạng thái</Table.HeaderCell>
              <Table.HeaderCell>Phụ trách</Table.HeaderCell>
              <Table.HeaderCell>Mở lúc</Table.HeaderCell>
              <Table.HeaderCell>Tuổi</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {items.map((i) => (
              <Table.Row key={`${i.source}-${i.id}`}>
                <Table.Cell>
                  <Badge color={priorityColor(i.priority)}>{priorityLabel(i.priority)}</Badge>
                </Table.Cell>
                <Table.Cell>
                  {kindLabel(i.kind)}
                  <Text size="xsmall" className="text-ui-fg-subtle">
                    {sourceLabel(i.source)}
                  </Text>
                </Table.Cell>
                <Table.Cell>
                  {i.order_id ?? "—"}
                  {isNonEmpty(i.reference) && (
                    <Text size="xsmall" className="text-ui-fg-subtle">
                      {i.reference}
                    </Text>
                  )}
                </Table.Cell>
                <Table.Cell>{formatVnd(i.amount)}</Table.Cell>
                <Table.Cell>{exceptionStateLabel(i.state)}</Table.Cell>
                <Table.Cell>{i.owner ?? i.owner_role}</Table.Cell>
                <Table.Cell>{formatInstant(i.opened_at)}</Table.Cell>
                <Table.Cell>{formatAge(i.age_seconds)}</Table.Cell>
                <Table.Cell>
                  {i.source === "settlement" && (
                    <Button
                      size="small"
                      variant="secondary"
                      onClick={() => {
                        setResolving(i);
                        setActionError(null);
                      }}
                    >
                      Đóng chênh lệch
                    </Button>
                  )}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
        {data && items.length === 0 && (
          <Text className="p-6 text-ui-fg-subtle">Không có ngoại lệ nào khớp bộ lọc.</Text>
        )}
        <div className="flex items-center justify-between p-3">
          <Text size="small">
            {data
              ? `${Math.min(offset + 1, data.count)}–${Math.min(offset + PAGE, data.count)} / ${data.count}`
              : ""}
          </Text>
          <div className="flex gap-2">
            <Button
              size="small"
              variant="secondary"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              Trước
            </Button>
            <Button
              size="small"
              variant="secondary"
              disabled={!data || offset + PAGE >= data.count}
              onClick={() => setOffset(offset + PAGE)}
            >
              Sau
            </Button>
          </div>
        </div>
      </Container>
    </div>
  );
};

export const config = defineRouteConfig({ label: "Ngoại lệ" });
export default ExceptionsPage;
