import { defineRouteConfig } from "@medusajs/admin-sdk";
import { Alert, Badge, Button, Container, Heading, Input, Table, Text, toast } from "@medusajs/ui";
import { useEffect, useState, type ReactNode } from "react";
import { FilterSelect } from "../../../components/filter-select";
import { ProblemAlert } from "../../../components/problem-alert";
import { adminFetch } from "../../../lib/api";
import { formatInstant, formatVnd } from "../../../lib/format";
import { checkInspection, type InspectDraft } from "../../../lib/inspect";
import {
  RETURN_SOURCE_LABELS,
  RETURN_STATE_LABELS,
  refundStateLabel,
  returnReasonLabel,
  returnSourceLabel,
  returnStateLabel,
} from "../../../lib/labels";
import { PAGE_SIZE, pageInfo } from "../../../lib/pagination";
import { AdminApiError } from "../../../lib/problem";
import { checkReceive, initialReceiveDrafts } from "../../../lib/receive";
import { useApi } from "../../../lib/use-api";

interface ReturnSummary {
  id: string;
  kind: string;
  state: string;
  reason: string;
  source: string;
  order_id: string;
  order_display_ref: string | null;
  quantity: number;
  received_quantity: number | null;
  created_at: string;
  refund: { id: string; amount: number; state: string } | null;
}

interface ReturnList {
  returns: ReturnSummary[];
  count: number;
  limit: number;
  offset: number;
}

interface ReturnLine {
  line_id: string;
  title: string | null;
  variant_title: string | null;
  quantity: number;
  received_quantity: number | null;
  restock_quantity: number | null;
  damaged_quantity: number | null;
  rejected_quantity: number | null;
  refund_amount: number | null;
  inspection_note: string | null;
}

interface ReturnDetail {
  id: string;
  kind: string;
  state: string;
  reason: string;
  note: string | null;
  source: string;
  order_id: string;
  order_display_ref: string | null;
  created_at: string;
  received_at: string | null;
  inspected_at: string | null;
  lines: ReturnLine[];
  refund: { id?: string; amount: number; state: string } | null;
}

const num = (v: number | null): string => (v === null ? "—" : String(v));
const stateOptions = Object.entries(RETURN_STATE_LABELS).map(([value, label]) => ({ value, label }));
const sourceOptions = Object.entries(RETURN_SOURCE_LABELS).map(([value, label]) => ({ value, label }));
const lineName = (l: ReturnLine) =>
  l.title ? `${l.title}${l.variant_title ? ` — ${l.variant_title}` : ""}` : l.line_id;

const ReturnsPage = (): ReactNode => {
  const [state, setState] = useState("received");
  const [source, setSource] = useState("");
  const [orderInput, setOrderInput] = useState("");
  const [orderId, setOrderId] = useState("");
  const [offset, setOffset] = useState(0);
  const query = { state, source, order_id: orderId, limit: PAGE_SIZE, offset };
  const list = useApi<ReturnList>(() => adminFetch("/admin/x/returns", { query }), JSON.stringify(query));

  const [selected, setSelected] = useState<string | null>(null);
  const detail = useApi<{ return: ReturnDetail }>(
    selected ? () => adminFetch(`/admin/x/returns/${encodeURIComponent(selected)}`) : null,
    selected ?? "",
  );
  const ret = selected && detail.data?.return.id === selected ? detail.data.return : null;

  const [receiveDrafts, setReceiveDrafts] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, InspectDraft>>({});
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AdminApiError | null>(null);

  // Mở yêu cầu khác / trạng thái đổi → bản nháp mới (nhận: mặc định đủ số yêu cầu). Chỉ theo khóa id:trạng thái —
  // tải lại cùng trạng thái không xoá số người dùng đang nhập.
  const draftKey = ret ? `${ret.id}:${ret.state}` : "";
  const retLines = ret?.lines;
  useEffect(() => {
    setReceiveDrafts(retLines ? initialReceiveDrafts(retLines) : {});
    setDrafts({});
    setLineErrors({});
  }, [draftKey]);

  const changeFilter = (apply: () => void) => {
    apply();
    setOffset(0);
  };

  const call = async (action: "receive" | "inspect", json: unknown) => {
    if (busy || !ret) return;
    setBusy(true);
    setError(null);
    try {
      const res = await adminFetch<{ changed: boolean }>(
        `/admin/x/returns/${encodeURIComponent(ret.id)}/${action}`,
        { method: "POST", json },
      );
      toast.success(
        res.changed
          ? action === "receive"
            ? "Đã nhận hàng vào kho cách ly (tồn bán chưa đổi)"
            : "Đã ghi kết quả kiểm định"
          : "Không có thay đổi (đã ghi nhận trước đó)",
      );
      detail.reload();
      list.reload();
    } catch (e) {
      setError(e instanceof AdminApiError ? e : null);
      detail.reload();
    } finally {
      setBusy(false);
    }
  };

  const receivePreview = ret?.state === "approved" ? checkReceive(ret.lines, receiveDrafts) : null;
  const receive = () => {
    if (!ret || !receivePreview) return;
    if (!receivePreview.ok) {
      setLineErrors(receivePreview.errors);
      return;
    }
    setLineErrors({});
    void call("receive", { lines: receivePreview.lines });
  };

  const draftOf = (id: string): InspectDraft => drafts[id] ?? { restock: "", damaged: "", note: "" };
  const setDraft = (id: string, patch: Partial<InspectDraft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...draftOf(id), ...patch } }));
  const inspectable = ret
    ? ret.lines.map((l) => ({ line_id: l.line_id, received_quantity: l.received_quantity }))
    : [];
  const inspectPreview = ret?.state === "received" ? checkInspection(inspectable, drafts) : null;
  const inspect = () => {
    if (!inspectPreview) return;
    if (!inspectPreview.ok) {
      setLineErrors(inspectPreview.errors);
      return;
    }
    setLineErrors({});
    void call("inspect", { lines: inspectPreview.lines });
  };

  const data = list.data;
  const page = data ? pageInfo(data.count, data.limit, data.offset) : null;

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="flex flex-col gap-y-4">
        <div>
          <Heading level="h1">Hàng trả</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Nhận hàng vào kho cách ly (được nhận thiếu từng dòng), rồi kiểm từng dòng: đạt (nhập lại tồn bán)
            · lỗi (ở lại kho cách ly) · không đạt (trả lại khách). Trả hàng đã kiểm định sẽ mở yêu cầu hoàn
            theo giá thực trả. Hàng hãng hoàn về được hệ thống tự mở yêu cầu, đánh dấu &quot;Hãng hoàn
            về&quot;.
          </Text>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <FilterSelect
            label="Trạng thái"
            value={state}
            options={stateOptions}
            onChange={(v) => changeFilter(() => setState(v))}
          />
          <FilterSelect
            label="Nguồn"
            value={source}
            options={sourceOptions}
            onChange={(v) => changeFilter(() => setSource(v))}
          />
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              changeFilter(() => setOrderId(orderInput.trim()));
            }}
          >
            <div className="w-64">
              <Input
                placeholder="Mã đơn (order id) — bỏ trống = mọi đơn"
                maxLength={128}
                value={orderInput}
                onChange={(e) => setOrderInput(e.target.value)}
                aria-label="Lọc theo mã đơn"
              />
            </div>
            <Button type="submit" variant="secondary" isLoading={list.loading}>
              Lọc
            </Button>
          </form>
        </div>
        <ProblemAlert error={list.error} />
      </Container>

      {data && (
        <Container className="p-0">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Tạo lúc</Table.HeaderCell>
                <Table.HeaderCell>Đơn</Table.HeaderCell>
                <Table.HeaderCell>Loại / lý do</Table.HeaderCell>
                <Table.HeaderCell>Nguồn</Table.HeaderCell>
                <Table.HeaderCell>Trạng thái</Table.HeaderCell>
                <Table.HeaderCell>Đã nhận / yêu cầu</Table.HeaderCell>
                <Table.HeaderCell>Hoàn tiền</Table.HeaderCell>
                <Table.HeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.returns.map((r) => (
                <Table.Row key={r.id} className={r.id === selected ? "bg-ui-bg-highlight" : undefined}>
                  <Table.Cell>{formatInstant(r.created_at)}</Table.Cell>
                  <Table.Cell>{r.order_display_ref ?? r.order_id}</Table.Cell>
                  <Table.Cell>
                    {r.kind === "exchange" ? "Đổi size" : "Trả hàng"} · {returnReasonLabel(r.reason)}
                  </Table.Cell>
                  <Table.Cell>
                    <Badge color={r.source === "carrier" ? "purple" : "grey"}>
                      {returnSourceLabel(r.source)}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge color={r.state === "received" || r.state === "approved" ? "orange" : "grey"}>
                      {returnStateLabel(r.state)}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
                    {num(r.received_quantity)} / {r.quantity}
                  </Table.Cell>
                  <Table.Cell>
                    {r.refund ? `${formatVnd(r.refund.amount)} · ${refundStateLabel(r.refund.state)}` : "—"}
                  </Table.Cell>
                  <Table.Cell>
                    <Button
                      size="small"
                      variant="secondary"
                      onClick={() => {
                        setError(null);
                        setSelected(r.id);
                      }}
                    >
                      Mở
                    </Button>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
          {data.returns.length === 0 && (
            <Text className="p-6 text-ui-fg-subtle">Không có yêu cầu nào khớp bộ lọc.</Text>
          )}
          {page && page.count > 0 && (
            <div className="flex items-center justify-between p-4">
              <Text size="small">
                {page.from}–{page.to} / {page.count}
              </Text>
              <div className="flex gap-2">
                <Button
                  size="small"
                  variant="secondary"
                  disabled={page.prevOffset === null}
                  onClick={() => page.prevOffset !== null && setOffset(page.prevOffset)}
                >
                  Trước
                </Button>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={page.nextOffset === null}
                  onClick={() => page.nextOffset !== null && setOffset(page.nextOffset)}
                >
                  Sau
                </Button>
              </div>
            </div>
          )}
        </Container>
      )}

      {selected && <ProblemAlert error={detail.error} />}
      <ProblemAlert error={error} />

      {ret && (
        <Container className="flex flex-col gap-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Heading level="h2">
              {ret.kind === "exchange" ? "Đổi size" : "Trả hàng"} {ret.id}
            </Heading>
            <Badge color={ret.state === "received" || ret.state === "approved" ? "orange" : "grey"}>
              {returnStateLabel(ret.state)}
            </Badge>
            <Badge color={ret.source === "carrier" ? "purple" : "grey"}>
              {returnSourceLabel(ret.source)}
            </Badge>
            <Text size="small">Đơn {ret.order_display_ref ?? ret.order_id}</Text>
            <Text size="small" className="text-ui-fg-subtle">
              Lý do: {returnReasonLabel(ret.reason)}
            </Text>
          </div>
          {ret.note && (
            <Text size="small" className="text-ui-fg-subtle">
              Ghi chú: {ret.note}
            </Text>
          )}
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Sản phẩm</Table.HeaderCell>
                <Table.HeaderCell>Yêu cầu</Table.HeaderCell>
                <Table.HeaderCell>Đã nhận</Table.HeaderCell>
                <Table.HeaderCell>Đạt</Table.HeaderCell>
                <Table.HeaderCell>Lỗi</Table.HeaderCell>
                <Table.HeaderCell>Không đạt</Table.HeaderCell>
                <Table.HeaderCell>{ret.state === "received" ? "Ghi chú" : "Hoàn theo dòng"}</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {ret.lines.map((l) => {
                const d = draftOf(l.line_id);
                const received = l.received_quantity ?? 0;
                const rejected = inspectPreview?.ok ? inspectPreview.rejected[l.line_id] : undefined;
                return (
                  <Table.Row key={l.line_id}>
                    <Table.Cell>
                      {lineName(l)}
                      {l.inspection_note && (
                        <Text size="xsmall" className="text-ui-fg-subtle">
                          Kiểm định: {l.inspection_note}
                        </Text>
                      )}
                      {lineErrors[l.line_id] && (
                        <Text size="xsmall" className="text-ui-fg-error">
                          {lineErrors[l.line_id]}
                        </Text>
                      )}
                    </Table.Cell>
                    <Table.Cell>{l.quantity}</Table.Cell>
                    <Table.Cell>
                      {ret.state === "approved" ? (
                        <Input
                          size="small"
                          inputMode="numeric"
                          className="w-16"
                          value={receiveDrafts[l.line_id] ?? ""}
                          onChange={(e) => setReceiveDrafts((s) => ({ ...s, [l.line_id]: e.target.value }))}
                          aria-label={`Số lượng đã nhận: ${lineName(l)}`}
                        />
                      ) : (
                        num(l.received_quantity)
                      )}
                    </Table.Cell>
                    {ret.state === "received" ? (
                      received > 0 ? (
                        <>
                          <Table.Cell>
                            <Input
                              size="small"
                              inputMode="numeric"
                              className="w-16"
                              value={d.restock}
                              onChange={(e) => setDraft(l.line_id, { restock: e.target.value })}
                              aria-label={`Số lượng đạt: ${lineName(l)}`}
                            />
                          </Table.Cell>
                          <Table.Cell>
                            <Input
                              size="small"
                              inputMode="numeric"
                              className="w-16"
                              value={d.damaged}
                              onChange={(e) => setDraft(l.line_id, { damaged: e.target.value })}
                              aria-label={`Số lượng lỗi: ${lineName(l)}`}
                            />
                          </Table.Cell>
                          <Table.Cell>{rejected ?? "—"}</Table.Cell>
                          <Table.Cell>
                            <Input
                              size="small"
                              maxLength={500}
                              value={d.note}
                              onChange={(e) => setDraft(l.line_id, { note: e.target.value })}
                              aria-label={`Ghi chú kiểm định: ${lineName(l)}`}
                            />
                          </Table.Cell>
                        </>
                      ) : (
                        <>
                          <Table.Cell>Chưa nhận</Table.Cell>
                          <Table.Cell>—</Table.Cell>
                          <Table.Cell>—</Table.Cell>
                          <Table.Cell>—</Table.Cell>
                        </>
                      )
                    ) : (
                      <>
                        <Table.Cell>{num(l.restock_quantity)}</Table.Cell>
                        <Table.Cell>{num(l.damaged_quantity)}</Table.Cell>
                        <Table.Cell>{num(l.rejected_quantity)}</Table.Cell>
                        <Table.Cell>{formatVnd(l.refund_amount)}</Table.Cell>
                      </>
                    )}
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
          {lineErrors["*"] && <Text className="text-ui-fg-error">{lineErrors["*"]}</Text>}
          {ret.state === "approved" && (
            <div className="flex flex-wrap items-center gap-3">
              <Button isLoading={busy} onClick={receive}>
                Ghi nhận hàng đã nhận
              </Button>
              {receivePreview?.ok && !receivePreview.full && (
                <Text size="small" className="text-ui-fg-subtle">
                  Nhận thiếu: {receivePreview.total} sản phẩm. Chỉ ghi nhận được một lần — kiểm kỹ số lượng.
                </Text>
              )}
            </div>
          )}
          {ret.state === "requested" && (
            <Alert variant="info">Yêu cầu chờ CSKH duyệt — kho chưa nhận hàng được.</Alert>
          )}
          {ret.state === "received" && (
            <div>
              <Button isLoading={busy} onClick={inspect}>
                Ghi kết quả kiểm định
              </Button>
            </div>
          )}
          {ret.refund && (
            <Alert variant="info">
              Yêu cầu hoàn {formatVnd(ret.refund.amount)} — {refundStateLabel(ret.refund.state)}. Xử lý ở
              trang &quot;Hoàn tiền&quot;.
            </Alert>
          )}
        </Container>
      )}
    </div>
  );
};

export const config = defineRouteConfig({ label: "Hàng trả" });
export default ReturnsPage;
