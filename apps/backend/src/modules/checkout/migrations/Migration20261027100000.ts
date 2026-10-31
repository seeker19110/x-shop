import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-153 (hỗ trợ ARC-RES-005): `checkout_quote.shipping` — báo phí của hãng lúc quote (phí, đầu vào định phí, thời
 * điểm/hạn). Submit dùng lại phí đã báo khi quote còn hạn và đầu vào không đổi, thay cho bộ nhớ đệm trong tiến trình
 * (chạy nhiều bản sao thì quote ở bản này, submit ở bản kia không còn 409 SHIPPING_CHANGED/503 giả).
 *
 * Cột nullable, không default: thêm cột tức thì, không ghi lại bảng; quote cũ (null) → submit hỏi lại hãng như trước.
 * `down()` xoá cột — chỉ mất ảnh chụp báo phí của các quote còn sống (hạn 10 phút), submit khi đó hỏi lại hãng.
 */
export class Migration20261027100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table if exists "checkout_quote" add column if not exists "shipping" jsonb null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "checkout_quote" drop column if exists "shipping";`);
  }
}
