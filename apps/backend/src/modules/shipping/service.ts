import type { SqlEntityManager } from "@medusajs/framework/mikro-orm/knex";
import { generateEntityId, MedusaService } from "@medusajs/framework/utils";
import type { SettlementState, ShipmentState } from "@x-shop/domain";
import { Shipment, ShipmentEvent, type ShippingPayer } from "./models/shipping-models";

interface BaseRepositoryLike {
  getFreshManager(): SqlEntityManager;
  transaction<T>(task: (manager: SqlEntityManager) => Promise<T>): Promise<T>;
}

type Row = Record<string, unknown>;

export interface ShipmentRow {
  id: string;
  order_id: string;
  client_order_code: string;
  provider: string;
  provider_order_code: string | null;
  state: ShipmentState;
  cod_amount: number;
  shipping_fee: number | null;
  payer: ShippingPayer;
  created_by: string;
  cod_reported_amount: number | null;
  cod_reported_at: Date | null;
  settlement_state: SettlementState;
  delivered_at: Date | null;
}

const COLUMNS = `id, order_id, client_order_code, provider, provider_order_code, state, cod_amount, shipping_fee, payer,
  created_by, cod_reported_amount, cod_reported_at, settlement_state, delivered_at`;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toShipment(r: Row): ShipmentRow {
  return {
    id: String(r.id),
    order_id: String(r.order_id),
    client_order_code: String(r.client_order_code),
    provider: String(r.provider),
    provider_order_code: (r.provider_order_code as string | null) ?? null,
    state: String(r.state) as ShipmentState,
    cod_amount: Number(r.cod_amount),
    shipping_fee: num(r.shipping_fee),
    payer: String(r.payer) as ShippingPayer,
    created_by: String(r.created_by),
    cod_reported_amount: num(r.cod_reported_amount),
    cod_reported_at: r.cod_reported_at ? new Date(r.cod_reported_at as string) : null,
    settlement_state: String(r.settlement_state) as SettlementState,
    delivered_at: r.delivered_at ? new Date(r.delivered_at as string) : null,
  };
}

/**
 * Service của module `shipping`: CRUD sinh từ DSL + thao tác nguyên tử ở Postgres (INSERT … ON CONFLICT, UPDATE có
 * điều kiện trạng thái) để đua đồng thời có đúng một bên thắng (S-303, ca biên "2 nhân viên cùng tạo vận đơn").
 */
class ShippingModuleService extends MedusaService({ Shipment, ShipmentEvent }) {
  protected readonly repo_: BaseRepositoryLike;

  constructor(container: { baseRepository: BaseRepositoryLike }, ...rest: unknown[]) {
    super(container, ...rest);
    this.repo_ = container.baseRepository;
  }

  private async exec(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.repo_.getFreshManager().execute(sql, params, "all")) as Row[];
  }

  async shipmentOfOrder(orderId: string): Promise<ShipmentRow | null> {
    const rows = await this.exec(
      `SELECT ${COLUMNS} FROM shipment WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
      [orderId],
    );
    return rows[0] ? toShipment(rows[0]) : null;
  }

  async shipmentByProviderCode(provider: string, providerOrderCode: string): Promise<ShipmentRow | null> {
    const rows = await this.exec(
      `SELECT ${COLUMNS} FROM shipment WHERE provider = ? AND provider_order_code = ? AND deleted_at IS NULL`,
      [provider, providerOrderCode],
    );
    return rows[0] ? toShipment(rows[0]) : null;
  }

  async shipmentByClientCode(clientOrderCode: string): Promise<ShipmentRow | null> {
    const rows = await this.exec(`SELECT ${COLUMNS} FROM shipment WHERE client_order_code = ?`, [
      clientOrderCode,
    ]);
    return rows[0] ? toShipment(rows[0]) : null;
  }

  /**
   * Giữ chỗ vận đơn TRƯỚC khi gọi hãng (provider_order_code NULL). Va UNIQUE(client_order_code) → trả dòng đã có
   * (`inserted: false`) — người đến sau không gửi hãng lần nữa mà đi đường "tra trước khi gửi lại".
   */
  async reserveShipment(input: {
    order_id: string;
    client_order_code: string;
    provider: string;
    cod_amount: number;
    payer: ShippingPayer;
    created_by: string;
  }): Promise<{ shipment: ShipmentRow; inserted: boolean }> {
    const rows = await this.exec(
      `INSERT INTO shipment (id, order_id, client_order_code, provider, state, cod_amount, payer, created_by)
       VALUES (?, ?, ?, ?, 'unfulfilled', ?, ?, ?)
       ON CONFLICT (client_order_code) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        generateEntityId(undefined, "shp"),
        input.order_id,
        input.client_order_code,
        input.provider,
        input.cod_amount,
        input.payer,
        input.created_by,
      ],
    );
    if (rows[0]) return { shipment: toShipment(rows[0]), inserted: true };
    const existing = await this.shipmentByClientCode(input.client_order_code);
    if (!existing) throw new Error(`Không đọc lại được vận đơn ${input.client_order_code}`);
    return { shipment: existing, inserted: false };
  }

  /** Ghi mã vận đơn của hãng (chỉ khi còn trống) và đưa vận đơn sang trạng thái hãng báo lúc tạo. */
  async markCreated(
    id: string,
    providerOrderCode: string,
    fee: number | null,
    state: ShipmentState,
  ): Promise<ShipmentRow> {
    await this.exec(
      `UPDATE shipment SET provider_order_code = ?, shipping_fee = COALESCE(?, shipping_fee), state = ?,
         updated_at = now()
       WHERE id = ? AND provider_order_code IS NULL`,
      [providerOrderCode, fee, state, id],
    );
    const rows = await this.exec(`SELECT ${COLUMNS} FROM shipment WHERE id = ?`, [id]);
    return toShipment(rows[0] as Row);
  }

  /** Chuyển trạng thái có điều kiện (`from` còn đúng) — trả true nếu chính lời gọi này đổi. */
  async moveState(id: string, from: ShipmentState, to: ShipmentState, at: Date): Promise<boolean> {
    const rows = await this.exec(
      `UPDATE shipment SET state = ?, delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?)
         ELSE delivered_at END, updated_at = now()
       WHERE id = ? AND state = ? RETURNING id`,
      [to, to, at, id, from],
    );
    return rows.length === 1;
  }

  /**
   * Courier báo đã chuyển COD (AT14): chỉ GHI lời báo để đối soát ở T-028 — settlement_state KHÔNG đổi ở đây.
   */
  async recordCodReport(id: string, amount: number | null, at: Date): Promise<void> {
    await this.exec(
      `UPDATE shipment SET cod_reported_amount = COALESCE(?, cod_reported_amount), cod_reported_at = ?,
         updated_at = now()
       WHERE id = ?`,
      [amount, at, id],
    );
  }

  /**
   * Lưu callback TRƯỚC khi xử lý; trùng event_key → trả bản đã có (kèm `applied`) để xử lý tiếp nếu lần trước dở.
   */
  async recordEvent(input: {
    provider: string;
    event_key: string;
    shipment_id: string | null;
    provider_order_code: string;
    type: string;
    status: string;
    raw: Record<string, unknown>;
  }): Promise<{ id: string; inserted: boolean; applied: boolean; result: Record<string, unknown> | null }> {
    const rows = await this.exec(
      `INSERT INTO shipment_event (id, provider, event_key, shipment_id, provider_order_code, type, status, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb)
       ON CONFLICT (event_key) DO NOTHING RETURNING id`,
      [
        generateEntityId(undefined, "shpev"),
        input.provider,
        input.event_key,
        input.shipment_id,
        input.provider_order_code,
        input.type,
        input.status,
        JSON.stringify(input.raw),
      ],
    );
    if (rows[0]) return { id: String(rows[0].id), inserted: true, applied: false, result: null };
    const found = await this.exec(`SELECT id, applied, result FROM shipment_event WHERE event_key = ?`, [
      input.event_key,
    ]);
    const r = found[0] ?? {};
    return {
      id: String(r.id),
      inserted: false,
      applied: r.applied === true,
      result: (r.result as Record<string, unknown> | null) ?? null,
    };
  }

  async markEventApplied(
    id: string,
    shipmentId: string | null,
    result: Record<string, unknown>,
  ): Promise<void> {
    await this.exec(
      `UPDATE shipment_event SET applied = true, shipment_id = COALESCE(?, shipment_id), result = ?::jsonb,
         updated_at = now()
       WHERE id = ?`,
      [shipmentId, JSON.stringify(result), id],
    );
  }

  /**
   * Số COD phải thu từ hãng (S-304, dashboard): vận đơn đã giao có COD > 0 mà chưa `settled` — kể cả khi courier đã
   * báo chuyển tiền (chưa đối soát thì vẫn là phải thu).
   */
  async codReceivable(): Promise<{ shipments: number; amount: number; reported: number }> {
    const rows = await this.exec(
      `SELECT count(*)::int AS n, COALESCE(sum(cod_amount), 0)::bigint AS amount,
              count(cod_reported_at)::int AS reported
       FROM shipment
       WHERE state = 'delivered' AND cod_amount > 0 AND settlement_state <> 'settled' AND deleted_at IS NULL`,
    );
    const r = rows[0] ?? {};
    return { shipments: Number(r.n ?? 0), amount: Number(r.amount ?? 0), reported: Number(r.reported ?? 0) };
  }
}

export default ShippingModuleService;
