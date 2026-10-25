import { Alert, Table, Text } from "@medusajs/ui";
import type { ReactNode } from "react";
import { AdminApiError, describeProblem, rowErrorsOf, type RowError } from "../lib/problem";

/** Hiển thị lỗi API bằng tiếng Việt; lỗi theo dòng/cột (CSV) hiện thành bảng. */
export function ProblemAlert({ error }: { error: AdminApiError | null }): ReactNode {
  if (!error) return null;
  const view = describeProblem(error);
  return (
    <div className="flex flex-col gap-y-2" role="alert" data-code={error.code}>
      <Alert variant="error">
        {view.message}
        {view.action === "reauth" && (
          <Text size="small" className="mt-1">
            Mã lỗi: {error.code}. Sau khi xác thực lại, quay về trang này và bấm lại thao tác.
          </Text>
        )}
      </Alert>
      <RowErrorTable errors={rowErrorsOf(error)} />
    </div>
  );
}

/** Bảng lỗi theo dòng/cột của file CSV (hiện tối đa `max` dòng, còn lại ghi số lượng). */
export function RowErrorTable({ errors, max = 100 }: { errors: RowError[]; max?: number }): ReactNode {
  if (errors.length === 0) return null;
  return (
    <div className="flex flex-col gap-y-1">
      <Text size="small" weight="plus">
        {errors.length} lỗi theo dòng/cột
      </Text>
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Dòng</Table.HeaderCell>
            <Table.HeaderCell>Cột</Table.HeaderCell>
            <Table.HeaderCell>Lỗi</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {errors.slice(0, max).map((e, i) => (
            <Table.Row key={`${e.line}-${e.column}-${i}`}>
              <Table.Cell>{e.line ?? "—"}</Table.Cell>
              <Table.Cell>{e.column === "*" ? "(cả dòng)" : e.column}</Table.Cell>
              <Table.Cell>{e.message}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      {errors.length > max && <Text size="small">… và {errors.length - max} lỗi nữa.</Text>}
    </div>
  );
}
