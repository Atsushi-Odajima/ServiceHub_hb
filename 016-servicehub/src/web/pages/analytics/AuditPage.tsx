import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AUDIT_CATEGORIES, auditLabel } from '../../../shared/audit-labels';
import { addDays, todayIn } from '../../../shared/time';
import { api, type ApiError, qs } from '../../api/client';
import { useMe } from '../../api/hooks';
import { Button, Card, EmptyState, ErrorMessage, Modal, PageHeader, SelectField, Spinner, TextField } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';

interface AuditItem {
  id: string;
  at: string;
  actorType: string;
  actor: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  locationId: string | null;
  locationName: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
  requestId: string | null;
}

/** 監査ログ(追記専用・変更削除不可)の閲覧 */
export function AuditPage() {
  const me = useMe();
  const tz = me.data?.organization?.timezone ?? 'Asia/Tokyo';
  const today = todayIn(tz);
  const locations = me.data?.locations ?? [];
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const [category, setCategory] = useState('');
  const [locId, setLocId] = useState('');
  const [detail, setDetail] = useState<AuditItem | null>(null);
  const q = useInfiniteQuery<{ items: AuditItem[]; next: string | null }, ApiError>({
    queryKey: ['audit', from, to, category, locId],
    queryFn: ({ pageParam }) => api.get(`/api/v1/audit${qs({ from, to, action: category || undefined, locationId: locId || undefined, before: (pageParam as string | null) ?? undefined, limit: 100 })}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    enabled: Boolean(from && to && to >= from),
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="stack-lg">
      <PageHeader title="監査ログ" sub="重要な操作の記録です(追記のみで、変更・削除はできません)。マネージャーは担当拠点の記録のみ表示されます。" />
      <Card>
        <div className="grid-auto">
          <TextField label="開始日" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <TextField label="終了日" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          <SelectField label="種類" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="すべて" options={AUDIT_CATEGORIES} />
          {locations.length > 1 ? <SelectField label="拠点" value={locId} onChange={(e) => setLocId(e.target.value)} placeholder="すべて" options={locations.map((l) => ({ value: l.id, label: l.name }))} /> : null}
        </div>
      </Card>
      <ErrorMessage error={q.error} retry={() => void q.refetch()} />
      {q.isLoading ? <Spinner /> : null}
      {q.data && items.length === 0 ? <EmptyState title="該当する記録はありません" /> : null}
      {items.length > 0 ? (
        <div className="table-wrap">
          <table className="table table-responsive">
            <thead>
              <tr>
                <th>日時</th>
                <th>操作者</th>
                <th>操作</th>
                <th>拠点</th>
                <th>内容</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id} className="clickable" onClick={() => setDetail(a)}>
                  <td data-label="日時" className="nowrap">
                    {fmtDateTime(a.at, tz)}
                  </td>
                  <td data-label="操作者">{a.actor ?? '—'}</td>
                  <td data-label="操作">
                    <button type="button" className="link-btn" onClick={(e) => { e.stopPropagation(); setDetail(a); }}>
                      {auditLabel(a.action)}
                    </button>
                  </td>
                  <td data-label="拠点">{a.locationName ?? '—'}</td>
                  <td data-label="内容" className="small muted">
                    {summary(a)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {q.hasNextPage ? (
        <div>
          <Button busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            さらに読み込む
          </Button>
        </div>
      ) : null}
      {detail ? (
        <Modal title={auditLabel(detail.action)} wide onClose={() => setDetail(null)}>
          <dl className="kv">
            <dt>日時</dt>
            <dd>{fmtDateTime(detail.at, tz)}</dd>
            <dt>操作者</dt>
            <dd>{detail.actor ?? '—'}</dd>
            <dt>操作コード</dt>
            <dd className="mono">{detail.action}</dd>
            <dt>対象</dt>
            <dd className="mono">
              {detail.targetType} {detail.targetId ?? ''}
            </dd>
            <dt>拠点</dt>
            <dd>{detail.locationName ?? '—'}</dd>
            {detail.requestId ? (
              <>
                <dt>リクエストID</dt>
                <dd className="mono small">{detail.requestId}</dd>
              </>
            ) : null}
          </dl>
          {(['before', 'after', 'metadata'] as const).map((k) =>
            detail[k] ? (
              <div key={k} style={{ marginTop: 12 }}>
                <strong className="small">{k === 'before' ? '変更前' : k === 'after' ? '変更後' : '詳細'}</strong>
                <pre className="small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--c-surface-2)', padding: 8, borderRadius: 6, margin: '4px 0 0' }}>
                  {JSON.stringify(detail[k], null, 2)}
                </pre>
              </div>
            ) : null,
          )}
        </Modal>
      ) : null}
    </div>
  );
}

function summary(a: AuditItem): string {
  const m = (a.metadata ?? {}) as Record<string, unknown>;
  if (typeof m.reason === 'string' && m.reason) return `理由: ${m.reason}`;
  if (a.action.startsWith('csv.') && m.kind) return `種類: ${String(m.kind)}`;
  const after = (a.after ?? {}) as Record<string, unknown>;
  if (typeof after.code === 'string') return `予約番号 ${after.code}`;
  return '';
}
