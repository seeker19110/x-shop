import { defineRouteConfig } from "@medusajs/admin-sdk";
import {
  Alert,
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Select,
  Table,
  Text,
  Textarea,
  toast,
} from "@medusajs/ui";
import { useState, type ReactNode } from "react";
import { ProblemAlert } from "../../../components/problem-alert";
import { adminFetch, newIdempotencyKey } from "../../../lib/api";
import { formatInstant, formatVnd } from "../../../lib/format";
import {
  REFUND_METHOD_LABELS,
  REFUND_STATE_LABELS,
  refundMethodLabel,
  refundReasonLabel,
  refundStateLabel,
} from "../../../lib/labels";
import { PAGE_SIZE, pageInfo } from "../../../lib/pagination";
import { AdminApiError } from "../../../lib/problem";
import {
  recreateRefundBody,
  REFUND_MAX_ATTEMPTS,
  refundActions,
  type RefundMethodChoice,
} from "../../../lib/refund-actions";
import { useApi } from "../../../lib/use-api";
import { isNonEmpty } from "../../../lib/presence";

interface Refund {
  id: string;
  order_id: string;
  order_display_ref?: string | null;
  return_id: string | null;
  reason: string;
  amount: number;
  method: string;
  state: string;
  approval_required: boolean;
  requested_by: string | null;
  approved_by: string | null;
  reject_reason: string | null;
  attempts: number;
  last_error: string | null;
  note: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
}

interface RefundSummary {
  order_id: string;
  captured: number;
  refunded: number;
  held: number;
  refundable: number;
  refunds: Refund[];
}

interface RefundQueue {
  state: string;
  refunds: Refund[];
  count: number;
  limit: number;
  offset: number;
}

type PendingKind = "reject" | "execute" | "cancel" | "recreate";
type Pending = { kind: PendingKind; refund: Refund; idempotencyKey?: string } | null;

const stateColor = (s: string): "green" | "red" | "orange" | "blue" | "grey" =>
  s === "succeeded"
    ? "green"
    : s === "rejected" || s === "failed"
      ? "red"
      : s === "unknown"
        ? "orange"
        : s === "requested"
          ? "blue"
          : "grey";

const PENDING_TITLE: Record<PendingKind, string> = {
  reject: "Từ chối yêu cầu hoàn",
  execute: "Thực hiện hoàn",
  cancel: "Hủy yêu cầu hoàn thất bại",
  recreate: "Tạo lại hoàn theo trả hàng",
};

const RefundsPage = (): ReactNode => {
  const [mode, setMode] = useState<"queue" | "order">("queue");
  const [queueState, setQueueState] = useState("requested");
  const [offset, setOffset] = useState(0);
  const [input, setInput] = useState("");
  const [orderId, setOrderId] = useState("");

  const queueQuery = { state: queueState, limit: PAGE_SIZE, offset };
  const queue = useApi<RefundQueue>(
    mode === "queue" ? () => adminFetch("/admin/x/refunds", { query: queueQuery }) : null,
    `queue:${JSON.stringify(queueQuery)}:${mode}`,
  );
  const byOrder = useApi<RefundSummary>(
    mode === "order" && orderId
      ? () => adminFetch("/admin/x/refunds", { query: { order_id: orderId } })
      : null,
    `order:${orderId}:${mode}`,
  );
  // Best-effort: biết mình là ai để báo sớm "không tự duyệt" (server vẫn chặn — SELF_APPROVAL).
  const me = useApi<{ user: { id: string } }>(() => adminFetch("/admin/users/me"), "me");
  const myId = me.data?.user?.id ?? null;

  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [method, setMethod] = useState<RefundMethodChoice>("manual");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<AdminApiError | null>(null);
  const [exhaustedIds, setExhaustedIds] = useState<ReadonlySet<string>>(new Set());

  const reload = () => {
    queue.reload();
    byOrder.reload();
  };
  const open = (kind: PendingKind, refund: Refund) => {
    setError(null);
    setReason("");
    setEvidence("");
    setMethod("manual");
    // Tạo lại: một khoá idempotency cho cả lần mở form — bấm lặp/gửi lại không tạo hai yêu cầu.
    setPending({ kind, refund, ...(kind === "recreate" && { idempotencyKey: newIdempotencyKey() }) });
  };

  const act = async (refund: Refund, action: "approve" | PendingKind) => {
    if (isNonEmpty(busy)) return;
    setBusy(refund.id);
    setError(null);
    try {
      if (action === "recreate") {
        await adminFetch("/admin/x/refunds", {
          method: "POST",
          json: recreateRefundBody(refund, method, reason),
          idempotencyKey: pending?.idempotencyKey ?? newIdempotencyKey(),
        });
        toast.success("Đã tạo lại yêu cầu hoàn theo kết quả kiểm định");
      } else {
        const json =
          action === "reject" || action === "cancel"
            ? { reason: reason.trim() }
            : action === "execute" && evidence.trim()
              ? { evidence_ref: evidence.trim() }
              : {};
        const res = await adminFetch<{ outcome?: string; changed?: boolean }>(
          `/admin/x/refunds/${encodeURIComponent(refund.id)}/${action}`,
          { method: "POST", json },
        );
        if (action === "execute" && res.outcome === "unknown") {
          toast.warning("Cổng chưa trả lời rõ — gọi lại sau để hỏi lại cổng (không hoàn trùng)");
        } else {
          toast.success(
            action === "approve"
              ? "Đã duyệt"
              : action === "reject"
                ? "Đã từ chối"
                : action === "cancel"
                  ? res.changed === false
                    ? "Yêu cầu đã được hủy trước đó"
                    : "Đã hủy — số tiền giữ đã được nhả"
                  : "Đã thực hiện hoàn tiền",
          );
        }
      }
      setPending(null);
      reload();
    } catch (e) {
      if (e instanceof AdminApiError && e.code === "REFUND_RETRY_EXHAUSTED") {
        setExhaustedIds((s) => new Set([...s, refund.id]));
        setPending(null);
      }
      if (e instanceof AdminApiError && e.body.outcome === "failed") {
        // 502 từ execute: cổng báo lỗi; yêu cầu giữ nguyên để thử lại cùng mã (nếu còn lượt).
        toast.error("Cổng báo lỗi khi hoàn — có thể thử lại (cùng mã yêu cầu) nếu còn lượt");
      }
      setError(e instanceof AdminApiError ? e : null);
      reload();
    } finally {
      setBusy(null);
    }
  };

  const reasonOk = reason.trim().length >= 3;
  const evidenceOk = evidence.trim() === "" || evidence.trim().length >= 3;
  const rows = mode === "queue" ? (queue.data?.refunds ?? null) : (byOrder.data?.refunds ?? null);
  const page =
    mode === "queue" && queue.data ? pageInfo(queue.data.count, queue.data.limit, queue.data.offset) : null;
  const summary = mode === "order" ? byOrder.data : null;

  const confirmDisabled = (p: NonNullable<Pending>): boolean => {
    if (p.kind === "reject" || p.kind === "cancel") return !reasonOk;
    if (p.kind === "execute") return p.refund.method === "manual" ? evidence.trim().length < 3 : !evidenceOk;
    return false;
  };

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="flex flex-col gap-y-4">
        <div>
          <Heading level="h1">Hoàn tiền</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Khoản hoàn lớn cần người thứ hai (khác người tạo) duyệt và xác thực lại TOTP. Mỗi yêu cầu được gửi
            tối đa {REFUND_MAX_ATTEMPTS} lần; hết lượt thì hủy (ghi lý do) rồi tạo yêu cầu mới.
          </Text>
        </div>
        <div className="flex gap-2">
          <Button
            size="small"
            variant={mode === "queue" ? "primary" : "secondary"}
            onClick={() => {
              setMode("queue");
              setPending(null);
            }}
          >
            Hàng đợi theo trạng thái
          </Button>
          <Button
            size="small"
            variant={mode === "order" ? "primary" : "secondary"}
            onClick={() => {
              setMode("order");
              setPending(null);
            }}
          >
            Tra theo đơn
          </Button>
        </div>
        {mode === "queue" ? (
          <div className="flex w-56 flex-col gap-y-1">
            <span className="txt-compact-small text-ui-fg-subtle">Trạng thái</span>
            <Select
              size="small"
              value={queueState}
              onValueChange={(v) => {
                setQueueState(v);
                setOffset(0);
                setPending(null);
              }}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {Object.entries(REFUND_STATE_LABELS).map(([value, label]) => (
                  <Select.Item key={value} value={value}>
                    {label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>
        ) : (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              setPending(null);
              setOrderId(input.trim());
            }}
          >
            <div className="w-80">
              <Input
                placeholder="Mã đơn (order id)"
                maxLength={128}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                aria-label="Mã đơn"
              />
            </div>
            <Button type="submit" disabled={input.trim() === ""} isLoading={byOrder.loading}>
              Tra cứu
            </Button>
          </form>
        )}
        <ProblemAlert error={mode === "queue" ? queue.error : byOrder.error} />
        {summary && (
          <div className="flex flex-wrap gap-2">
            <Badge color="grey">Đã thu: {formatVnd(summary.captured)}</Badge>
            <Badge color="grey">Đã hoàn: {formatVnd(summary.refunded)}</Badge>
            <Badge color="grey">Đang giữ: {formatVnd(summary.held)}</Badge>
            <Badge color="blue">Còn hoàn được: {formatVnd(summary.refundable)}</Badge>
          </div>
        )}
      </Container>

      <ProblemAlert error={error} />

      {pending && (
        <Container className="flex flex-col gap-y-3">
          <Heading level="h2">
            {PENDING_TITLE[pending.kind]} {formatVnd(pending.refund.amount)}
          </Heading>
          {(pending.kind === "reject" || pending.kind === "cancel") && (
            <Textarea
              placeholder={`Lý do ${pending.kind === "reject" ? "từ chối" : "hủy"} (bắt buộc, ≥ 3 ký tự)`}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-label={pending.kind === "reject" ? "Lý do từ chối" : "Lý do hủy"}
            />
          )}
          {pending.kind === "cancel" && (
            <Text size="small" className="text-ui-fg-subtle">
              Hoàn qua cổng sẽ được đối chiếu với cổng trước khi hủy; cổng báo đã hoàn thì không hủy.
            </Text>
          )}
          {pending.kind === "execute" &&
            (pending.refund.method === "manual" ? (
              <Input
                placeholder="Mã chứng từ hoàn ngoài hệ thống (bắt buộc, ≥ 3 ký tự)"
                maxLength={128}
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
                aria-label="Mã chứng từ"
              />
            ) : (
              <Text size="small">
                Hoàn qua cổng thanh toán; thử lại dùng cùng mã yêu cầu nên không hoàn trùng. Đã gửi{" "}
                {pending.refund.attempts}/{REFUND_MAX_ATTEMPTS} lần.
              </Text>
            ))}
          {pending.kind === "recreate" && (
            <>
              <Text size="small">
                Số tiền lấy theo kết quả kiểm định của yêu cầu trả {pending.refund.return_id}; yêu cầu mới
                duyệt lại từ đầu.
              </Text>
              <div className="flex w-56 flex-col gap-y-1">
                <span className="txt-compact-small text-ui-fg-subtle">Phương thức</span>
                <Select size="small" value={method} onValueChange={(v) => setMethod(v as RefundMethodChoice)}>
                  <Select.Trigger>
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="manual">{REFUND_METHOD_LABELS.manual}</Select.Item>
                    <Select.Item value="provider">{REFUND_METHOD_LABELS.provider}</Select.Item>
                    <Select.Item value="auto">Tự chọn</Select.Item>
                  </Select.Content>
                </Select>
              </div>
              <Textarea
                placeholder="Ghi chú (không bắt buộc)"
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                aria-label="Ghi chú tạo lại"
              />
            </>
          )}
          <div className="flex gap-2">
            <Button
              variant={pending.kind === "reject" || pending.kind === "cancel" ? "danger" : "primary"}
              isLoading={busy === pending.refund.id}
              disabled={confirmDisabled(pending)}
              onClick={() => act(pending.refund, pending.kind)}
            >
              {pending.kind === "reject"
                ? "Từ chối"
                : pending.kind === "cancel"
                  ? "Hủy yêu cầu"
                  : pending.kind === "recreate"
                    ? "Tạo yêu cầu mới"
                    : "Thực hiện hoàn tiền"}
            </Button>
            <Button variant="secondary" onClick={() => setPending(null)}>
              Đóng
            </Button>
          </div>
        </Container>
      )}

      {rows && (
        <Container className="p-0">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Tạo lúc</Table.HeaderCell>
                {mode === "queue" && <Table.HeaderCell>Đơn</Table.HeaderCell>}
                <Table.HeaderCell>Lý do</Table.HeaderCell>
                <Table.HeaderCell>Số tiền</Table.HeaderCell>
                <Table.HeaderCell>Phương thức</Table.HeaderCell>
                <Table.HeaderCell>Trạng thái</Table.HeaderCell>
                <Table.HeaderCell>Người tạo / duyệt</Table.HeaderCell>
                <Table.HeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((r) => {
                const a = refundActions(r, {
                  myId,
                  exhaustedIds,
                  ...(mode === "order" && { siblings: rows }),
                });
                return (
                  <Table.Row key={r.id}>
                    <Table.Cell>{formatInstant(r.created_at)}</Table.Cell>
                    {mode === "queue" && <Table.Cell>{r.order_display_ref ?? r.order_id}</Table.Cell>}
                    <Table.Cell>
                      {refundReasonLabel(r.reason)}
                      {isNonEmpty(r.return_id) && (
                        <Text size="xsmall" className="text-ui-fg-subtle">
                          Yêu cầu trả {r.return_id}
                        </Text>
                      )}
                      {isNonEmpty(r.note) && (
                        <Text size="xsmall" className="text-ui-fg-subtle">
                          {r.note}
                        </Text>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      {formatVnd(r.amount)}
                      {r.approval_required && (
                        <Text size="xsmall" className="text-ui-fg-subtle">
                          Cần hai người
                        </Text>
                      )}
                    </Table.Cell>
                    <Table.Cell>{refundMethodLabel(r.method)}</Table.Cell>
                    <Table.Cell>
                      <Badge color={stateColor(r.state)}>{refundStateLabel(r.state)}</Badge>
                      {r.attempts > 0 && (
                        <Text size="xsmall" className="text-ui-fg-subtle">
                          Đã gửi {r.attempts}/{REFUND_MAX_ATTEMPTS} lần
                        </Text>
                      )}
                      {isNonEmpty(r.reject_reason) && <Text size="xsmall">{r.reject_reason}</Text>}
                      {isNonEmpty(r.cancel_reason) && <Text size="xsmall">Lý do hủy: {r.cancel_reason}</Text>}
                      {isNonEmpty(r.last_error) && r.state !== "cancelled" && (
                        <Text size="xsmall" className="text-ui-fg-error">
                          {r.last_error}
                        </Text>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="xsmall">Tạo: {r.requested_by ?? "hệ thống"}</Text>
                      <Text size="xsmall">Duyệt: {r.approved_by ?? "—"}</Text>
                      {isNonEmpty(r.cancelled_by) && <Text size="xsmall">Hủy: {r.cancelled_by}</Text>}
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-col gap-1">
                        {a.approve && (
                          <>
                            <Button
                              size="small"
                              isLoading={busy === r.id}
                              disabled={a.selfCreated}
                              onClick={() => act(r, "approve")}
                            >
                              Duyệt
                            </Button>
                            {a.selfCreated && (
                              <Text size="xsmall" className="text-ui-fg-error">
                                Bạn là người tạo — cần người khác duyệt.
                              </Text>
                            )}
                          </>
                        )}
                        {a.reject && (
                          <Button size="small" variant="secondary" onClick={() => open("reject", r)}>
                            Từ chối
                          </Button>
                        )}
                        {a.execute && (
                          <Button size="small" variant="secondary" onClick={() => open("execute", r)}>
                            {a.executeLabel}
                          </Button>
                        )}
                        {a.exhausted && (
                          <Text size="xsmall" className="text-ui-fg-error">
                            Hết lượt thử — hủy rồi tạo yêu cầu mới.
                          </Text>
                        )}
                        {a.cancel && (
                          <Button size="small" variant="danger" onClick={() => open("cancel", r)}>
                            Hủy yêu cầu
                          </Button>
                        )}
                        {a.recreate && (
                          <Button size="small" variant="secondary" onClick={() => open("recreate", r)}>
                            Tạo lại theo trả hàng
                          </Button>
                        )}
                      </div>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
          {rows.length === 0 && (
            <Text className="p-6 text-ui-fg-subtle">
              {mode === "queue"
                ? "Không có yêu cầu nào ở trạng thái này."
                : "Đơn này chưa có yêu cầu hoàn tiền."}
            </Text>
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
      {mode === "queue" && queueState === "cancelled" && (
        <Alert variant="info">
          Yêu cầu đã hủy chỉ còn là lịch sử. Hoàn theo trả hàng mở lại được bằng &quot;Tạo lại theo trả
          hàng&quot; (máy chủ từ chối nếu yêu cầu trả đã có hoàn tiền còn hiệu lực).
        </Alert>
      )}
    </div>
  );
};

export const config = defineRouteConfig({ label: "Hoàn tiền" });
export default RefundsPage;
