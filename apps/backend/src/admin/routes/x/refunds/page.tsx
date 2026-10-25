import { defineRouteConfig } from "@medusajs/admin-sdk";
import { Alert, Badge, Button, Container, Heading, Input, Table, Text, Textarea, toast } from "@medusajs/ui";
import { useState, type ReactNode } from "react";
import { ProblemAlert } from "../../../components/problem-alert";
import { adminFetch } from "../../../lib/api";
import { formatInstant, formatVnd } from "../../../lib/format";
import { refundMethodLabel, refundReasonLabel, refundStateLabel } from "../../../lib/labels";
import { AdminApiError } from "../../../lib/problem";
import { useApi } from "../../../lib/use-api";

interface Refund {
  id: string;
  order_id: string;
  return_id: string | null;
  reason: string;
  amount: number;
  method: string;
  state: string;
  approval_required: boolean;
  requested_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  reject_reason: string | null;
  executed_by: string | null;
  evidence_ref: string | null;
  attempts: number;
  last_error: string | null;
  note: string | null;
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

type Pending = { kind: "reject"; refund: Refund } | { kind: "execute"; refund: Refund } | null;

const EXECUTABLE = new Set(["approved", "failed", "unknown"]);

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

const RefundsPage = (): ReactNode => {
  const [input, setInput] = useState("");
  const [orderId, setOrderId] = useState("");
  const list = useApi<RefundSummary>(
    orderId ? () => adminFetch("/admin/x/refunds", { query: { order_id: orderId } }) : null,
    orderId,
  );
  // Best-effort: biết mình là ai để báo sớm "không tự duyệt" (server vẫn chặn — SELF_APPROVAL).
  const me = useApi<{ user: { id: string } }>(() => adminFetch("/admin/users/me"), "me");
  const myId = me.data?.user?.id ?? null;

  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<AdminApiError | null>(null);

  const finish = () => {
    setPending(null);
    setReason("");
    setEvidence("");
    list.reload();
  };

  const act = async (refund: Refund, action: "approve" | "reject" | "execute") => {
    if (busy) return;
    setBusy(refund.id);
    setError(null);
    try {
      const json =
        action === "reject"
          ? { reason: reason.trim() }
          : action === "execute" && evidence.trim()
            ? { evidence_ref: evidence.trim() }
            : {};
      const res = await adminFetch<{ outcome?: string }>(
        `/admin/x/refunds/${encodeURIComponent(refund.id)}/${action}`,
        { method: "POST", json },
      );
      if (action === "execute" && res.outcome === "unknown") {
        toast.warning("Cổng chưa trả lời rõ — gọi lại sau để hỏi lại cổng (không hoàn trùng)");
      } else {
        toast.success(
          action === "approve" ? "Đã duyệt" : action === "reject" ? "Đã từ chối" : "Đã thực hiện hoàn tiền",
        );
      }
      finish();
    } catch (e) {
      if (e instanceof AdminApiError && e.body.outcome === "failed") {
        // 502 từ execute: cổng báo lỗi; yêu cầu giữ nguyên để thử lại cùng mã.
        toast.error("Cổng báo lỗi khi hoàn — có thể thử lại (cùng mã yêu cầu)");
        list.reload();
      }
      setError(e instanceof AdminApiError ? e : null);
    } finally {
      setBusy(null);
    }
  };

  const data = list.data;
  const reasonOk = reason.trim().length >= 3;
  const evidenceOk = evidence.trim() === "" || evidence.trim().length >= 3;

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="flex flex-col gap-y-4">
        <div>
          <Heading level="h1">Duyệt hoàn tiền</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Khoản hoàn lớn cần người thứ hai (khác người tạo) duyệt và xác thực lại TOTP. Tra theo mã đơn.
          </Text>
        </div>
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
          <Button type="submit" disabled={input.trim() === ""} isLoading={list.loading}>
            Tra cứu
          </Button>
        </form>
        <ProblemAlert error={list.error} />
        {data && (
          <div className="flex flex-wrap gap-2">
            <Badge color="grey">Đã thu: {formatVnd(data.captured)}</Badge>
            <Badge color="grey">Đã hoàn: {formatVnd(data.refunded)}</Badge>
            <Badge color="grey">Đang giữ: {formatVnd(data.held)}</Badge>
            <Badge color="blue">Còn hoàn được: {formatVnd(data.refundable)}</Badge>
          </div>
        )}
      </Container>

      <ProblemAlert error={error} />

      {pending && (
        <Container className="flex flex-col gap-y-3">
          {pending.kind === "reject" ? (
            <>
              <Heading level="h2">Từ chối yêu cầu hoàn {formatVnd(pending.refund.amount)}</Heading>
              <Textarea
                placeholder="Lý do từ chối (bắt buộc, ≥ 3 ký tự)"
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                aria-label="Lý do từ chối"
              />
            </>
          ) : (
            <>
              <Heading level="h2">Thực hiện hoàn {formatVnd(pending.refund.amount)}</Heading>
              {pending.refund.method === "manual" ? (
                <Input
                  placeholder="Mã chứng từ hoàn ngoài hệ thống (bắt buộc, ≥ 3 ký tự)"
                  maxLength={128}
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                  aria-label="Mã chứng từ"
                />
              ) : (
                <Text size="small">
                  Hoàn qua cổng thanh toán; thử lại dùng cùng mã yêu cầu nên không hoàn trùng.
                </Text>
              )}
            </>
          )}
          <div className="flex gap-2">
            <Button
              variant={pending.kind === "reject" ? "danger" : "primary"}
              isLoading={busy === pending.refund.id}
              disabled={
                pending.kind === "reject"
                  ? !reasonOk
                  : pending.refund.method === "manual"
                    ? evidence.trim().length < 3
                    : !evidenceOk
              }
              onClick={() => act(pending.refund, pending.kind)}
            >
              {pending.kind === "reject" ? "Từ chối" : "Thực hiện hoàn tiền"}
            </Button>
            <Button variant="secondary" onClick={() => setPending(null)}>
              Hủy
            </Button>
          </div>
        </Container>
      )}

      {data && (
        <Container className="p-0">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Tạo lúc</Table.HeaderCell>
                <Table.HeaderCell>Lý do</Table.HeaderCell>
                <Table.HeaderCell>Số tiền</Table.HeaderCell>
                <Table.HeaderCell>Phương thức</Table.HeaderCell>
                <Table.HeaderCell>Trạng thái</Table.HeaderCell>
                <Table.HeaderCell>Người tạo / duyệt</Table.HeaderCell>
                <Table.HeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {data.refunds.map((r) => {
                const selfCreated = myId !== null && r.requested_by === myId;
                return (
                  <Table.Row key={r.id}>
                    <Table.Cell>{formatInstant(r.created_at)}</Table.Cell>
                    <Table.Cell>
                      {refundReasonLabel(r.reason)}
                      {r.note && (
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
                      {r.reject_reason && <Text size="xsmall">{r.reject_reason}</Text>}
                      {r.last_error && (
                        <Text size="xsmall" className="text-ui-fg-error">
                          {r.last_error}
                        </Text>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="xsmall">Tạo: {r.requested_by ?? "hệ thống"}</Text>
                      <Text size="xsmall">Duyệt: {r.approved_by ?? "—"}</Text>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-col gap-1">
                        {r.state === "requested" && (
                          <>
                            <Button
                              size="small"
                              isLoading={busy === r.id}
                              disabled={selfCreated}
                              onClick={() => act(r, "approve")}
                            >
                              Duyệt
                            </Button>
                            {selfCreated && (
                              <Text size="xsmall" className="text-ui-fg-error">
                                Bạn là người tạo — cần người khác duyệt.
                              </Text>
                            )}
                            <Button
                              size="small"
                              variant="secondary"
                              onClick={() => {
                                setPending({ kind: "reject", refund: r });
                                setReason("");
                              }}
                            >
                              Từ chối
                            </Button>
                          </>
                        )}
                        {EXECUTABLE.has(r.state) && (
                          <Button
                            size="small"
                            variant="secondary"
                            onClick={() => {
                              setPending({ kind: "execute", refund: r });
                              setEvidence("");
                            }}
                          >
                            {r.state === "approved" ? "Thực hiện" : "Thử lại / hỏi lại cổng"}
                          </Button>
                        )}
                      </div>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
          {data.refunds.length === 0 && (
            <Text className="p-6 text-ui-fg-subtle">Đơn này chưa có yêu cầu hoàn tiền.</Text>
          )}
        </Container>
      )}
      {!orderId && (
        <Alert variant="info">
          Danh sách yêu cầu hoàn hiện tra theo mã đơn (API chưa có danh sách toàn bộ yêu cầu chờ duyệt).
        </Alert>
      )}
    </div>
  );
};

export const config = defineRouteConfig({ label: "Hoàn tiền" });
export default RefundsPage;
