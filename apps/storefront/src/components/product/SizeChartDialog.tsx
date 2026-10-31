"use client";

import type { RefObject } from "react";
import type { ModelMeasurement, SizeChart } from "../../lib/catalog/types";
import { t } from "../../lib/i18n";
import { Dialog } from "../ui/Dialog";
import styles from "./Product.module.css";

/** Dòng mô tả người mẫu — chỉ khi có dữ liệu gắn với bộ ảnh thật (PDP04: không tạo thông tin giả). */
export function modelSentence(m: ModelMeasurement): string {
  const parts = [t("product.sizeChart.heightPart", { cm: m.height_cm })];
  if (m.bust_cm !== null) parts.push(t("product.sizeChart.bustPart", { cm: m.bust_cm }));
  return t("product.sizeChart.model", { parts: parts.join(", "), size: m.wearing_size.toUpperCase() });
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
      title={t("product.sizeChart.title")}
      returnFocusRef={returnFocusRef}
      closeLabel={t("product.sizeChart.close")}
    >
      <div className={styles.chartScroll}>
        <table className={styles.chart}>
          <caption>{t("product.sizeChart.caption", { unit: chart.unit })}</caption>
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
      <p className={styles.note}>{t("product.sizeChart.note")}</p>
    </Dialog>
  );
}
