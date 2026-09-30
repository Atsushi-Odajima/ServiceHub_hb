import { useState } from 'react';
import { NOTIFICATION_TYPE_LABELS } from '../../shared/constants';
import { api, qs } from '../api/client';
import { useApi, useApiMutation, useCan, useMe } from '../api/hooks';
import { Alert, Badge, Button, EmptyState, ErrorMessage, PageHeader, SelectField, Spinner } from '../components/ui';
import { fmtDateTime } from '../lib/format';

const STATUS: Record<string, { label: string; tone: string; icon: string }> = {
  pending: { label: '送信待ち', tone: 'info', icon: '…' },
  sending: { label: '送信中', tone: 'info', icon: '→' },
  sent: { label: '送信済み', tone: 'success', icon: '✓' },
  failed: { label: '失敗', tone: 'danger', icon: '!' },
  skipped: { label: '未送信', tone: 'muted', icon: '−' },
  canceled: { label: '取消', tone: 'muted', icon: '×' },
};

const SKIP: Record<string, string> = {
  no_recipient: '宛先なし',
  sample_org: 'サンプル組織のため送信しない',
  email_provider_log: 'メール送信が未設定(ログ出力のみ)',
  not_allowlisted: '送信許可リスト外',
  booking_not_active: '予約が有効でない',
  booking_rescheduled: '日時変更済み',
  booking_canceled: 'キャンセル済み',
  restored_from_backup: 'バックアップから復元したため送信しない',
};

export function NotificationsPage() {
  const me = useMe();
  const can = useCan();
  const tz = me.data?.organization?.timezone ?? 'Asia/Tokyo';
  const [status, setStatus] = useState('');
  const q = useApi<{ items: any[]; last30Days: Record<string, number>; provider: string; delivers: boolean }>(
    ['notifications', status],
    `/api/v1/notifications${qs({ status: status || undefined })}`,
  );
  const retry = useApiMutation((id: string) => api.post(`/api/v1/notifications/${id}/retry`), { invalidate: [['notifications']], success: '再送を予約しました' });
  return (
    <>
      <PageHeader title="通知履歴" sub="メール本文(予約確認リンク等)はセキュリティのため表示しません" />
      {q.data && !q.data.delivers ? (
        <Alert tone="warning">現在メール送信は設定されていません(ログ出力のみ)。本番運用では EMAIL_PROVIDER=smtp を設定してください。</Alert>
      ) : null}
      {q.data ? (
        <div className="row" style={{ margin: '12px 0' }}>
          {Object.entries(q.data.last30Days).map(([k, v]) => (
            <Badge key={k} tone={STATUS[k]?.tone} icon={STATUS[k]?.icon}>
              {STATUS[k]?.label ?? k} {v}件(30日)
            </Badge>
          ))}
        </div>
      ) : null}
      <SelectField label="状態" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="すべて" options={Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label }))} />
      <ErrorMessage error={q.error} />
      {q.isLoading ? <Spinner /> : null}
      {q.data?.items.length === 0 ? <EmptyState title="通知はありません" /> : null}
      {q.data && q.data.items.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="table table-responsive">
            <thead>
              <tr>
                <th>作成</th>
                <th>種類</th>
                <th>宛先</th>
                <th>状態</th>
                <th>詳細</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((n) => (
                <tr key={n.id}>
                  <td data-label="作成">{fmtDateTime(n.createdAt, tz)}</td>
                  <td data-label="種類">{NOTIFICATION_TYPE_LABELS[n.type] ?? n.type}</td>
                  <td data-label="宛先">{n.recipient || '—'}</td>
                  <td data-label="状態">
                    <Badge tone={STATUS[n.status]?.tone} icon={STATUS[n.status]?.icon}>
                      {STATUS[n.status]?.label ?? n.status}
                    </Badge>
                  </td>
                  <td data-label="詳細" className="small">
                    {n.subject ? <div>{n.subject}</div> : null}
                    {n.skipReason ? <div className="muted">{SKIP[n.skipReason] ?? n.skipReason}</div> : null}
                    {n.lastError ? <div style={{ color: 'var(--c-danger)' }}>{n.lastError}</div> : null}
                    <div className="muted">試行 {n.attempts}回</div>
                  </td>
                  <td data-label="操作">
                    {n.status === 'failed' && can('notification.retry') ? (
                      <Button size="sm" onClick={() => retry.mutate(n.id)}>
                        再送
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
