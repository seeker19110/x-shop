import { defineRouteConfig } from "@medusajs/admin-sdk";
import { Alert, Badge, Button, Container, Heading, Input, Table, Text, toast } from "@medusajs/ui";
import { useState, type ReactNode } from "react";
import { ProblemAlert } from "../../../components/problem-alert";
import { adminFetch } from "../../../lib/api";
import { formatVnd } from "../../../lib/format";
import { checkInspection, type InspectDraft } from "../../../lib/inspect";
import { refundStateLabel, returnStateLabel } from "../../../lib/labels";
import { AdminApiError } from "../../../lib/problem";

interface ReturnLine {
  line_id: string;
  quantity: number;
  received_quantity: number | null;
  restock_quantity: number | null;
  damaged_quantity: number | null;
  rejected_quantity: number | null;
  refund_amount: number | null;
}

interface ReturnView {
  id: string;
  kind: string;
  state: string;
  status_label: string;
  order_id?: string;
  reason: string;
  lines: ReturnLine[];
  refund: { id?: string; amount: number; state: string } | null;
}

interface ActionResult {
  changed: boolean;
  return: ReturnView;
  refund?: { amount: number; state: string } | null;
}

const num = (v: number | null): string => (v === null ? "—" : String(v));

const ReturnsPage = (): ReactNode => {
  const [input, setInput] = useState("");
  const [ret, setRet] = useState<ReturnView | null>(null);
  const [drafts, setDrafts] = useState<Record<string, InspectDraft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AdminApiError | null>(null);
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});

  const returnId = input.trim();

  const call = async (action: "receive" | "inspect", json: unknown) => {
    if (busy || !returnId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await adminFetch<ActionResult>(
        `/admin/x/returns/${encodeURIComponent(returnId)}/${action}`,
        {
          method: "POST",
          json,
        },
      );
      setRet(res.return);
      toast.success(
        res.changed
          ? action === "receive"
            ? "Đã nhận hàng vào kho cách ly (tồn bán chưa đổi)"
            : "Đã ghi kết quả kiểm định"
          : "Không có thay đổi (đã ghi nhận trước đó)",
      );
    } catch (e) {
      setError(e instanceof AdminApiError ? e : null);
    } finally {
      setBusy(false);
    }
  };

  const draftOf = (id: string): InspectDraft => drafts[id] ?? { restock: "", damaged: "", note: "" };
  const setDraft = (id: string, patch: Partial<InspectDraft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...draftOf(id), ...patch } }));

  const inspect = () => {
    if (!ret) return;
    const check = checkInspection(
      ret.lines.map((l) => ({ line_id: l.line_id, received_quantity: l.received_quantity })),
      drafts,
    );
    if (!check.ok) {
      setLineErrors(check.errors);
      return;
    }
    setLineErrors({});
    void call("inspect", { lines: check.lines });
  };

  const preview = ret
    ? checkInspection(
        ret.lines.map((l) => ({ line_id: l.line_id, received_quantity: l.received_quantity })),
        drafts,
      )
    : null;

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="flex flex-col gap-y-4">
        <div>
          <Heading level="h1">Kiểm định hàng trả</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Nhận hàng vào kho cách ly, rồi kiểm từng dòng: đạt (nhập lại tồn bán) · lỗi (ở lại kho cách ly) ·
            không đạt (trả lại khách). Trả hàng đã kiểm định sẽ mở yêu cầu hoàn theo giá thực trả.
          </Text>
        </div>
        <div className="flex items-end gap-2">
          <div className="w-80">
            <Input
              placeholder="Mã yêu cầu đổi/trả"
              maxLength={128}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setRet(null);
                setError(null);
              }}
              aria-label="Mã yêu cầu đổi/trả"
            />
          </div>
          <Button isLoading={busy} disabled={!returnId} onClick={() => call("receive", {})}>
            Nhận đủ hàng
          </Button>
        </div>
        <Alert variant="info">
          API chưa có tra cứu yêu cầu theo mã. Bấm &quot;Nhận đủ hàng&quot; (gọi lại an toàn — không đổi gì
          nếu đã nhận) để xem dòng hàng rồi kiểm định.
        </Alert>
        <ProblemAlert error={error} />
      </Container>

      {ret && (
        <Container className="flex flex-col gap-y-4">
          <div className="flex items-center gap-3">
            <Heading level="h2">
              {ret.kind === "exchange" ? "Đổi size" : "Trả hàng"} {ret.id}
            </Heading>
            <Badge color={ret.state === "received" ? "orange" : "grey"}>{returnStateLabel(ret.state)}</Badge>
            {ret.order_id && <Text size="small">Đơn {ret.order_id}</Text>}
          </div>
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Dòng</Table.HeaderCell>
                <Table.HeaderCell>Yêu cầu</Table.HeaderCell>
                <Table.HeaderCell>Đã nhận</Table.HeaderCell>
                {ret.state === "received" ? (
                  <>
                    <Table.HeaderCell>Đạt</Table.HeaderCell>
                    <Table.HeaderCell>Lỗi</Table.HeaderCell>
                    <Table.HeaderCell>Không đạt</Table.HeaderCell>
                    <Table.HeaderCell>Ghi chú</Table.HeaderCell>
                  </>
                ) : (
                  <>
                    <Table.HeaderCell>Đạt</Table.HeaderCell>
                    <Table.HeaderCell>Lỗi</Table.HeaderCell>
                    <Table.HeaderCell>Không đạt</Table.HeaderCell>
                    <Table.HeaderCell>Hoàn theo dòng</Table.HeaderCell>
                  </>
                )}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {ret.lines.map((l) => {
                const d = draftOf(l.line_id);
                const received = l.received_quantity ?? 0;
                const rejected = preview?.ok ? preview.rejected[l.line_id] : undefined;
                return (
                  <Table.Row key={l.line_id}>
                    <Table.Cell>
                      {l.line_id}
                      {lineErrors[l.line_id] && (
                        <Text size="xsmall" className="text-ui-fg-error">
                          {lineErrors[l.line_id]}
                        </Text>
                      )}
                    </Table.Cell>
                    <Table.Cell>{l.quantity}</Table.Cell>
                    <Table.Cell>{num(l.received_quantity)}</Table.Cell>
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
                              aria-label={`Số lượng đạt dòng ${l.line_id}`}
                            />
                          </Table.Cell>
                          <Table.Cell>
                            <Input
                              size="small"
                              inputMode="numeric"
                              className="w-16"
                              value={d.damaged}
                              onChange={(e) => setDraft(l.line_id, { damaged: e.target.value })}
                              aria-label={`Số lượng lỗi dòng ${l.line_id}`}
                            />
                          </Table.Cell>
                          <Table.Cell>{rejected ?? "—"}</Table.Cell>
                          <Table.Cell>
                            <Input
                              size="small"
                              maxLength={500}
                              value={d.note}
                              onChange={(e) => setDraft(l.line_id, { note: e.target.value })}
                              aria-label={`Ghi chú dòng ${l.line_id}`}
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
          {ret.state === "received" && (
            <div>
              <Button isLoading={busy} onClick={inspect}>
                Ghi kết quả kiểm định
              </Button>
            </div>
          )}
          {ret.state === "approved" && (
            <Alert variant="warning">
              Chưa nhận được hàng nào — bấm &quot;Nhận đủ hàng&quot; khi kho đã nhận.
            </Alert>
          )}
          {ret.refund && (
            <Alert variant="info">
              Yêu cầu hoàn {formatVnd(ret.refund.amount)} — {refundStateLabel(ret.refund.state)}. Duyệt ở
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
