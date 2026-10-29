import { Prompt } from "@medusajs/ui";
import { useRef, useState } from "react";
import type { ConfirmSpec } from "../lib/confirm-dialog";

interface Props {
  /** `null` = đóng. */
  spec: ConfirmSpec | null;
  /** Gọi đúng một lần cho mỗi lượt bấm, dù bấm nhiều lần khi chưa xong. Có thể trả Promise. */
  onConfirm: () => void | Promise<void>;
  /** Esc, nút Hủy bỏ hoặc bấm ra ngoài — không làm gì ngoài việc đóng. */
  onCancel: () => void;
}

/**
 * Hộp thoại xác nhận dùng chung (UX-STATE-008). Dựa trên Prompt (Radix AlertDialog): Esc đóng, tiêu điểm mặc định ở
 * nút Hủy bỏ (nút an toàn). Chặn bấm đúp bằng ref đồng bộ (state cập nhật chậm hơn click thứ hai).
 */
export function ConfirmDialog({ spec, onConfirm, onCancel }: Props) {
  const fired = useRef(false);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (fired.current) return;
    fired.current = true;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      fired.current = false;
    }
  };

  return (
    <Prompt
      open={spec !== null}
      onOpenChange={(open) => {
        if (!open && !fired.current) onCancel();
      }}
    >
      {spec && (
        <Prompt.Content>
          <Prompt.Header>
            <Prompt.Title>{spec.title}</Prompt.Title>
            <Prompt.Description>
              {spec.object} {spec.consequence}
            </Prompt.Description>
          </Prompt.Header>
          <Prompt.Footer>
            <Prompt.Cancel onClick={onCancel}>{spec.cancelLabel}</Prompt.Cancel>
            <Prompt.Action
              disabled={busy}
              className={spec.destructive ? "bg-ui-button-danger hover:bg-ui-button-danger-hover" : undefined}
              onClick={(e) => {
                // Radix AlertDialog.Action tự đóng; để trang quyết định đóng sau khi action xong.
                e.preventDefault();
                void confirm();
              }}
            >
              {spec.confirmLabel}
            </Prompt.Action>
          </Prompt.Footer>
        </Prompt.Content>
      )}
    </Prompt>
  );
}
