"use client";

import type { RefObject } from "react";
import type { ModelMeasurement, SizeChart } from "../../lib/catalog/types";
import { Dialog } from "../ui/Dialog";
import styles from "./Product.module.css";

/** Dòng mô tả người mẫu — chỉ khi có dữ liệu gắn với bộ ảnh thật (PDP04: không tạo thông tin giả). */
export function modelSentence(m: ModelMeasurement): string {
  const parts = [`cao ${m.height_cm} cm`];
  if (m.bust_cm !== null) parts.push(`ngực ${m.bust_cm} cm`);
  return `Người mẫu ${parts.join(", ")}, mặc size ${m.wearing_size.toUpperCase()}.`;
}

/** Bảng size (cm) trong `Dialog`: khóa focus, Esc đóng, trả focus về nút mở. */
export function SizeChartDialog({
  open,
  onClose,
  chart,
  model,
  returnFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  chart: SizeChart;
  model: ModelMeasurement | null;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Bảng size"
      returnFocusRef={returnFocusRef}
      closeLabel="Đóng bảng size"
    >
      <div className={styles.chartScroll}>
        <table className={styles.chart}>
          <caption>{`Số đo tính bằng ${chart.unit}`}</caption>
          <thead>
            <tr>
              {chart.columns.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {chart.rows.map((row) => (
              <tr key={row.join("|")}>
                {row.map((cell, i) =>
                  i === 0 ? (
                    <th key={`${cell}-${i}`} scope="row">
                      {cell}
                    </th>
                  ) : (
                    <td key={`${cell}-${i}`}>{cell}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {model ? <p className={styles.modelNote}>{modelSentence(model)}</p> : null}
      <p className={styles.note}>
        Số đo là kích thước sản phẩm/cơ thể tham khảo theo cm; không dùng cân nặng để suy ra size.
      </p>
    </Dialog>
  );
}
