import { defineRouteConfig } from "@medusajs/admin-sdk";
import { Button, Container, Heading, Input, Table, Text } from "@medusajs/ui";
import { useState, type ReactNode } from "react";
import { ProblemAlert } from "../../../components/problem-alert";
import { adminFetch } from "../../../lib/api";
import { formatInstant, formatVnd } from "../../../lib/format";
import { periodFromDays } from "../../../lib/period";
import { useApi } from "../../../lib/use-api";
import { isNonEmpty } from "../../../lib/presence";

interface Summary {
  period: { from: string | null; to: string | null };
  orders: { by_state: Array<{ state: string; count: number; value: number }>; count: number };
  order_value: number;
  awaiting_payment_value: number;
  collected: { total: number; online: number; cod_delivered: number };
  cash_received: { total: number; cod: number; vnpay: number };
  refunded: { total: number; provider: number; manual: number; statement_refunds: number };
  cod_receivable: { shipments: number; amount: number };
  discrepancies_open: { count: number; amount: number };
}

const STATE_LABELS: Record<string, string> = {
  awaiting_payment: "Chờ thanh toán",
  placed: "Đã đặt",
  confirmed: "Đã xác nhận",
  completed: "Hoàn tất",
  cancelled: "Đã hủy",
  expired: "Hết hạn",
};

/** Một chỉ số tiền: nhãn + giá trị + định nghĩa ngắn (các khái niệm tiền KHÔNG được gộp — D-026). */
function Stat(props: { label: string; value: number; hint: string; sub?: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col gap-y-1 rounded-md border border-ui-border-base p-4">
      <Text size="small" className="text-ui-fg-subtle">
        {props.label}
      </Text>
      <Heading level="h2">{formatVnd(props.value)}</Heading>
      <Text size="xsmall" className="text-ui-fg-muted">
        {props.hint}
      </Text>
      {props.sub}
    </div>
  );
}

const ReportsPage = (): ReactNode => {
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");
  const [applied, setApplied] = useState<{ from: string | null; to: string | null }>({
    from: null,
    to: null,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const report = useApi<Summary>(
    () => adminFetch("/admin/x/reports/summary", { query: { from: applied.from, to: applied.to } }),
    JSON.stringify(applied),
  );
  const s = report.data;

  return (
    <div className="flex flex-col gap-y-3">
      <Container className="flex flex-col gap-y-4">
        <div>
          <Heading level="h1">Báo cáo tiền</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Giá trị đơn, tiền đã thu, tiền thực nhận và tiền đã hoàn là các khái niệm khác nhau — hiển thị
            tách riêng, không cộng gộp. Mỗi chỉ số lọc theo thời điểm phát sinh của chính nó (giờ Việt Nam).
          </Text>
        </div>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const p = periodFromDays(fromDay, toDay);
            if (!p.ok) return setFormError(p.error);
            setFormError(null);
            setApplied({ from: p.from, to: p.to });
          }}
        >
          <label className="txt-compact-small text-ui-fg-subtle">
            Từ ngày
            <Input type="date" value={fromDay} onChange={(e) => setFromDay(e.target.value)} />
          </label>
          <label className="txt-compact-small text-ui-fg-subtle">
            Đến ngày (gồm cả ngày này)
            <Input type="date" value={toDay} onChange={(e) => setToDay(e.target.value)} />
          </label>
          <Button type="submit" isLoading={report.loading}>
            Xem báo cáo
          </Button>
        </form>
        {isNonEmpty(formError) && <Text className="text-ui-fg-error">{formError}</Text>}
        <ProblemAlert error={report.error} />
        {s && (
          <Text size="xsmall" className="text-ui-fg-muted">
            Kỳ: {isNonEmpty(s.period.from) ? formatInstant(s.period.from) : "từ đầu"} →{" "}
            {isNonEmpty(s.period.to) ? formatInstant(s.period.to) : "hiện tại"} (không gồm mốc cuối). COD phải
            nhận và chênh lệch mở là ảnh chụp hiện tại, không lọc kỳ.
          </Text>
        )}
      </Container>

      {s && (
        <Container className="flex flex-col gap-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Stat
              label="Giá trị đơn"
              value={s.order_value}
              hint="Σ tổng đơn đã cam kết (đã đặt/xác nhận/hoàn tất). Không phải tiền đã nhận."
            />
            <Stat
              label="Đơn chờ thanh toán"
              value={s.awaiting_payment_value}
              hint="Đơn online chưa trả — chưa tính vào giá trị đơn, có thể không thành."
            />
            <Stat
              label="Đã thu theo hệ thống"
              value={s.collected.total}
              hint="Thu qua cổng đã xác minh + COD hãng đã thu khi giao (chưa chắc đã chuyển về)."
              sub={
                <Text size="xsmall">
                  Online {formatVnd(s.collected.online)} · COD đã giao {formatVnd(s.collected.cod_delivered)}
                </Text>
              }
            />
            <Stat
              label="Tiền thực nhận (theo chứng từ)"
              value={s.cash_received.total}
              hint="Theo chứng từ đối soát đã nhập."
              sub={
                <Text size="xsmall">
                  COD {formatVnd(s.cash_received.cod)} · VNPAY {formatVnd(s.cash_received.vnpay)}
                </Text>
              }
            />
            <Stat
              label="Đã hoàn"
              value={s.refunded.total}
              hint="Hoàn thành công qua cổng + hoàn ngoài hệ thống có chứng từ."
              sub={
                <Text size="xsmall">
                  Qua cổng {formatVnd(s.refunded.provider)} · Ngoài hệ thống {formatVnd(s.refunded.manual)} ·
                  Theo sao kê {formatVnd(s.refunded.statement_refunds)}
                </Text>
              }
            />
            <Stat
              label="COD phải nhận"
              value={s.cod_receivable.amount}
              hint="COD hãng đã thu khi giao nhưng chưa đối soát đủ."
              sub={<Text size="xsmall">{s.cod_receivable.shipments} vận đơn</Text>}
            />
            <Stat
              label="Chênh lệch đối soát còn mở"
              value={s.discrepancies_open.amount}
              hint="Xử lý ở trang Ngoại lệ."
              sub={<Text size="xsmall">{s.discrepancies_open.count} mục</Text>}
            />
          </div>
          <div className="flex flex-col gap-y-1">
            <Text size="small" weight="plus">
              Đơn theo trạng thái ({s.orders.count} đơn)
            </Text>
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Trạng thái</Table.HeaderCell>
                  <Table.HeaderCell>Số đơn</Table.HeaderCell>
                  <Table.HeaderCell>Tổng giá trị</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {s.orders.by_state.map((r) => (
                  <Table.Row key={r.state}>
                    <Table.Cell>{STATE_LABELS[r.state] ?? r.state}</Table.Cell>
                    <Table.Cell>{r.count}</Table.Cell>
                    <Table.Cell>{formatVnd(r.value)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        </Container>
      )}
    </div>
  );
};

export const config = defineRouteConfig({ label: "Báo cáo tiền" });
export default ReportsPage;
