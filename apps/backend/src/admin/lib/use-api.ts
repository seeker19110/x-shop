import { useCallback, useEffect, useRef, useState } from "react";
import { AdminApiError } from "./problem";

export interface ApiState<T> {
  data: T | null;
  error: AdminApiError | null;
  loading: boolean;
  reload: () => void;
}

/** Tải dữ liệu khi `key` đổi (key = chuỗi định danh tham số); bỏ kết quả của lần gọi cũ (không ghi đè lần mới). */
export function useApi<T>(load: (() => Promise<T>) | null, key: string): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<AdminApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const fn = loadRef.current;
    if (!fn) return;
    let stale = false;
    setLoading(true);
    fn()
      .then((d) => {
        if (stale) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (stale) return;
        setError(
          e instanceof AdminApiError ? e : new AdminApiError(0, "NETWORK", "Không kết nối được máy chủ"),
        );
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [key, tick]);

  return { data, error, loading, reload };
}
