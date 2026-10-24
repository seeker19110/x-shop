/**
 * Khóa idempotency cho `POST /store/x/checkout/submit` (16–128 ký tự [A-Za-z0-9_-]).
 * Quy tắc: MỘT khóa cho mỗi lần xác nhận. Retry do lỗi mạng với CÙNG nội dung dùng lại khóa (server trả lại kết quả cũ,
 * không tạo đơn thứ hai); nội dung đổi (khách sửa thông tin/xác nhận tổng mới) hoặc lần đặt đã chấm dứt → khóa mới.
 * Chỉ giữ trong bộ nhớ của trang (không localStorage): tải lại trang vẫn an toàn nhờ UNIQUE(cart_id, cart_version).
 */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface KeyKeeper {
  /** Khóa cho nội dung `signature`: giữ nguyên nếu cùng nội dung với lần trước, ngược lại sinh mới. */
  keyFor(signature: string): string;
  /** Lần đặt đã chấm dứt (409 đổi giá, hết hàng…): lần sau phải là khóa mới. */
  reset(): void;
}

export function createKeyKeeper(generate: () => string = newIdempotencyKey): KeyKeeper {
  let current: { signature: string; key: string } | null = null;
  return {
    keyFor(signature) {
      if (current === null || current.signature !== signature) current = { signature, key: generate() };
      return current.key;
    },
    reset() {
      current = null;
    },
  };
}
