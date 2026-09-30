import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/**
 * サーバー送信イベント(SSE)で他端末の変更を受け取り、関連クエリを再取得する。
 * 接続できない場合もポーリング(各画面の refetchInterval)で追従する。
 */
export function useRealtime(): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const connect = () => {
      es = new EventSource('/api/v1/events', { withCredentials: true });
      es.addEventListener('change', (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as { entity?: string };
          const entity = data.entity ?? 'booking';
          if (entity === 'booking') {
            void qc.invalidateQueries({ queryKey: ['bookings'] });
            void qc.invalidateQueries({ queryKey: ['today'] });
            void qc.invalidateQueries({ queryKey: ['reception'] });
            void qc.invalidateQueries({ queryKey: ['schedule'] });
            void qc.invalidateQueries({ queryKey: ['dashboard'] });
          } else {
            void qc.invalidateQueries({ queryKey: [entity] });
          }
        } catch {
          /* ignore */
        }
      });
      es.onerror = () => {
        es?.close();
        if (!closed) retry = setTimeout(connect, 10_000);
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
      if (retry) clearTimeout(retry);
    };
  }, [qc]);
}
