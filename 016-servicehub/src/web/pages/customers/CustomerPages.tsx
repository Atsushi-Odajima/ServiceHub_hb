import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { PASS_ENTRY_LABELS } from '../../../shared/constants';
import { api, qs, type ApiError } from '../../api/client';
import { useApi, useApiMutation, useCan, useMe, useOnline } from '../../api/hooks';
import { DraftNotice, DraftStatus } from '../../components/DraftNotice';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorMessage,
  Modal,
  PageHeader,
  SelectField,
  Spinner,
  Stat,
  StatusBadge,
  Tabs,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { useDraft } from '../../lib/drafts';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { BookingFormModal } from '../bookings/BookingForm';
import type { BookingDto } from '../bookings/BookingPages';
import { CustomerEntitlements } from '../entitlements/EntitlementPanels';

interface CustomerListItem {
  id: string;
  name: string;
  nameKana: string | null;
  email: string | null;
  phone: string | null;
  tags: string[];
  status: string;
  lastVisitAt: string | null;
  createdAt: string;
}

export function CustomersPage() {
  const me = useMe();
  const can = useCan();
  const navigate = useNavigate();
  const tz = me.data?.organization?.timezone ?? 'Asia/Tokyo';
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState('active');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = useApi<{ items: CustomerListItem[] }>(['customers', debounced, status], `/api/v1/customers${qs({ q: debounced || undefined, status, limit: 100 })}`);
  return (
    <>
      <PageHeader title="顧客" actions={can('customer.create') ? <Button variant="primary" onClick={() => setCreating(true)}>顧客を登録</Button> : null} />
      <div className="grid-2">
        <TextField label="検索" hint="氏名・フリガナ・電話番号(下4桁も可)・メール" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        <SelectField
          label="状態"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[
            { value: 'active', label: '有効' },
            { value: 'archived', label: 'アーカイブ' },
            { value: 'merged', label: '統合済み' },
            { value: 'anonymized', label: '匿名化済み' },
            { value: 'all', label: 'すべて' },
          ]}
        />
      </div>
      <ErrorMessage error={list.error} />
      {list.isLoading ? <Spinner /> : null}
      {list.data?.items.length === 0 ? <EmptyState title="該当する顧客はいません" /> : null}
      {list.data && list.data.items.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="table table-responsive">
            <thead>
              <tr>
                <th>氏名</th>
                <th>電話</th>
                <th>メール</th>
                <th>タグ</th>
                <th>最終来店</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/app/customers/${c.id}`)}>
                  <td data-label="氏名">
                    <Link to={`/app/customers/${c.id}`} onClick={(e) => e.stopPropagation()}>
                      {c.name}
                    </Link>
                    {c.nameKana ? <div className="muted small">{c.nameKana}</div> : null}
                  </td>
                  <td data-label="電話">{c.phone ?? '—'}</td>
                  <td data-label="メール">{c.email ?? '—'}</td>
                  <td data-label="タグ">{c.tags.map((t) => <Badge key={t}>{t}</Badge>)}</td>
                  <td data-label="最終来店">{c.lastVisitAt ? fmtDateTime(c.lastVisitAt, tz) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {creating ? <CustomerEditModal onClose={() => setCreating(false)} onSaved={(id) => navigate(`/app/customers/${id}`)} /> : null}
    </>
  );
}

interface CustomerDetail extends CustomerListItem {
  memo?: string | null;
  version: number;
  preferredLocationId: string | null;
  mergedIntoId: string | null;
  stats: { total: number; completed: number; canceled_customer: number; canceled_business: number; no_show: number; upcoming: number };
  nextBooking: { id: string; startsAt: string; serviceName: string; locationName: string; timezone: string } | null;
  favoriteLocationId: string | null;
  duplicateCandidates: { id: string; name: string; email: string | null; phone: string | null; createdAt: string; reasons: string[] }[];
  firstVisitAt: string | null;
}

function CustomerEditModal({ customer, onClose, onSaved }: { customer?: CustomerDetail; onClose: () => void; onSaved?: (id: string) => void }) {
  const me = useMe();
  const online = useOnline();
  // 入力はこの端末に下書きとして保存する(通信が切れても失われない。顧客情報が更新されたら古い下書きは使わない)
  const draft = useDraft('customer', customer ? `${customer.id}.v${customer.version}` : 'new', {
    name: customer?.name ?? '',
    nameKana: customer?.nameKana ?? '',
    phone: customer?.phone ?? '',
    email: customer?.email ?? '',
    tags: (customer?.tags ?? []).join(' '),
    memo: customer?.memo ?? '',
    preferredLocationId: customer?.preferredLocationId ?? '',
  });
  const f = draft.value;
  const setF = draft.setAll;
  const save = useApiMutation(
    async () => {
      const body = {
        name: f.name,
        nameKana: f.nameKana || null,
        phone: f.phone || null,
        email: f.email || null,
        tags: f.tags.split(/[\s,、]+/).filter(Boolean),
        memo: f.memo || null,
        preferredLocationId: f.preferredLocationId || null,
      };
      const res = await (customer ? api.patch(`/api/v1/customers/${customer.id}`, { ...body, expectedVersion: customer.version }) : api.post('/api/v1/customers', body));
      draft.clear();
      return res;
    },
    {
      invalidate: [['customers'], ['customer', customer?.id]],
      success: (r: any) => (r.duplicateCandidates ? `登録しました(重複候補 ${r.duplicateCandidates}件あり)` : '保存しました'),
      onSuccess: (r: any) => {
        onSaved?.(r.id);
        onClose();
      },
    },
  );
  const err = save.error as ApiError | null;
  return (
    <Modal
      title={customer ? '顧客情報を編集' : '顧客を登録'}
      onClose={onClose}
      footer={
        <>
          <DraftStatus savedAt={draft.savedAt} />
          <Button onClick={onClose}>閉じる</Button>
          <Button variant="primary" busy={save.isPending} disabled={!f.name || !online} onClick={() => save.mutate(undefined)}>
            保存する
          </Button>
        </>
      }
    >
      <div className="stack">
        <DraftNotice restoredAt={draft.restored?.savedAt ?? null} online={online} submitLabel="保存する" onDiscard={draft.discard} />
        <ErrorMessage error={err} />
        <div className="grid-2">
          <TextField label="氏名" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required error={err?.fields?.name} />
          <TextField label="フリガナ" value={f.nameKana} onChange={(e) => setF({ ...f, nameKana: e.target.value })} />
          <TextField label="電話" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} error={err?.fields?.phone} />
          <TextField label="メール" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} error={err?.fields?.email} />
          <TextField label="タグ(空白区切り)" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} />
          <SelectField
            label="よく利用する拠点(任意)"
            value={f.preferredLocationId}
            onChange={(e) => setF({ ...f, preferredLocationId: e.target.value })}
            placeholder="指定なし"
            options={(me.data?.locations ?? []).map((l) => ({ value: l.id, label: l.name }))}
          />
        </div>
        {customer?.memo !== undefined || !customer ? <TextAreaField label="顧客メモ(スタッフ間の共有事項)" value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} /> : null}
        <p className="small muted">医療情報(病歴・症状など)は記録しないでください。</p>
      </div>
    </Modal>
  );
}

type CustTab = 'timeline' | 'bookings' | 'entitlements' | 'notes';

export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const me = useMe();
  const can = useCan();
  const navigate = useNavigate();
  const tz = me.data?.organization?.timezone ?? 'Asia/Tokyo';
  const c = useApi<CustomerDetail>(['customer', id], `/api/v1/customers/${id}`);
  const [tab, setTab] = useState<CustTab>('timeline');
  const [edit, setEdit] = useState(false);
  const [book, setBook] = useState(false);
  const [merge, setMerge] = useState<CustomerDetail['duplicateCandidates'][number] | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [anon, setAnon] = useState(false);
  const [anonName, setAnonName] = useState('');
  const mergeM = useApiMutation((fromId: string) => api.post(`/api/v1/customers/${id}/merge`, { mergeFromId: fromId, confirm: true }), {
    invalidate: [['customer', id], ['customers']],
    success: (r: any) => `統合しました(予約 ${r.moved.bookings}件・回数券 ${r.moved.passes}件を移動)`,
    onSuccess: () => setMerge(null),
  });
  const archive = useApiMutation((archived: boolean) => api.post(`/api/v1/customers/${id}/archive`, { archived }), {
    invalidate: [['customer', id], ['customers']],
    success: '変更しました',
    onSuccess: () => setArchiveOpen(false),
  });
  const anonymize = useApiMutation(() => api.post(`/api/v1/customers/${id}/anonymize`, { confirmName: anonName }), {
    invalidate: [['customer', id], ['customers']],
    success: '匿名化しました',
    onSuccess: () => setAnon(false),
  });
  if (c.isLoading) return <Spinner />;
  if (c.error) return <ErrorMessage error={c.error} />;
  const d = c.data!;
  const active = d.status === 'active';
  return (
    <div className="stack-lg">
      <PageHeader
        title={`${d.name} 様`}
        sub={
          <>
            {d.nameKana}
            {d.status !== 'active' ? (
              <Badge tone="muted">{{ archived: 'アーカイブ', merged: '統合済み', anonymized: '匿名化済み' }[d.status] ?? d.status}</Badge>
            ) : null}
          </>
        }
        actions={
          active ? (
            <>
              {can('booking.create.all') || can('booking.create.own') ? (
                <Button variant="primary" onClick={() => setBook(true)}>
                  予約を作成
                </Button>
              ) : null}
              {can('customer.update') ? <Button onClick={() => setEdit(true)}>編集</Button> : null}
            </>
          ) : null
        }
      />
      {d.status === 'merged' && d.mergedIntoId ? (
        <Alert tone="info">
          この顧客は統合されています。<Link to={`/app/customers/${d.mergedIntoId}`}>統合先の顧客を表示</Link>
        </Alert>
      ) : null}
      {active && d.duplicateCandidates.length > 0 ? (
        <Alert tone="warning">
          <strong>重複の可能性がある顧客が{d.duplicateCandidates.length}件あります。</strong>自動では統合しません。同一人物の場合のみ統合してください。
          <ul>
            {d.duplicateCandidates.map((x) => (
              <li key={x.id}>
                <Link to={`/app/customers/${x.id}`}>{x.name}</Link> ({x.reasons.join('・')}) {x.phone ?? ''} {x.email ?? ''}{' '}
                {can('customer.merge') ? (
                  <button type="button" className="link-btn" onClick={() => setMerge(x)}>
                    この顧客に統合する
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <div className="grid-auto">
        <Stat label="予約" value={d.stats.total} sub={`今後 ${d.stats.upcoming}件`} />
        <Stat label="実施(完了)" value={d.stats.completed} />
        <Stat label="キャンセル" value={d.stats.canceled_customer + d.stats.canceled_business} sub={`顧客 ${d.stats.canceled_customer} / 事業者 ${d.stats.canceled_business}`} />
        <Stat label="無断欠席" value={d.stats.no_show} />
      </div>
      <div className="grid-2">
        <Card title="連絡先">
          <dl className="kv">
            <dt>電話</dt>
            <dd>{d.phone ? <a href={`tel:${d.phone}`}>{d.phone}</a> : '—'}</dd>
            <dt>メール</dt>
            <dd>{d.email ?? '—'}</dd>
            <dt>タグ</dt>
            <dd>{d.tags.length ? d.tags.map((t) => <Badge key={t}>{t}</Badge>) : '—'}</dd>
            <dt>初回来店</dt>
            <dd>{d.firstVisitAt ? fmtDateTime(d.firstVisitAt, tz) : '—'}</dd>
            <dt>最終来店</dt>
            <dd>{d.lastVisitAt ? fmtDateTime(d.lastVisitAt, tz) : '—'}</dd>
            <dt>よく利用する拠点</dt>
            <dd>{me.data?.locations?.find((l) => l.id === (d.preferredLocationId ?? d.favoriteLocationId))?.name ?? '—'}</dd>
          </dl>
        </Card>
        <Card title="次回予約">
          {d.nextBooking ? (
            <p>
              <Link to={`/app/bookings/${d.nextBooking.id}`}>{fmtDateTime(d.nextBooking.startsAt, d.nextBooking.timezone)}</Link>
              <br />
              {d.nextBooking.serviceName} ・ {d.nextBooking.locationName}
            </p>
          ) : (
            <p className="muted">予定されている予約はありません</p>
          )}
          {d.memo ? (
            <>
              <h3>顧客メモ</h3>
              <p style={{ whiteSpace: 'pre-wrap' }}>{d.memo}</p>
            </>
          ) : null}
        </Card>
      </div>
      <Tabs
        label="顧客情報"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'timeline', label: 'タイムライン' },
          { value: 'bookings', label: '予約' },
          ...(can('pass.read') || can('plan.read') ? [{ value: 'entitlements' as const, label: '回数券・プラン' }] : []),
          { value: 'notes', label: '対応メモ' },
        ]}
      />
      {tab === 'timeline' ? <Timeline customerId={id} tz={tz} /> : null}
      {tab === 'bookings' ? <CustomerBookings customerId={id} /> : null}
      {tab === 'entitlements' ? <CustomerEntitlements customerId={id} customerActive={active} /> : null}
      {tab === 'notes' ? <Notes customerId={id} tz={tz} disabled={d.status === 'anonymized'} /> : null}
      <div className="row">
        {can('customer.export') ? (
          <a className="btn" href={`/api/v1/customers/${id}/export`} download>
            個人データをエクスポート(JSON)
          </a>
        ) : null}
        {can('customer.archive') && (d.status === 'active' || d.status === 'archived') ? (
          <Button onClick={() => setArchiveOpen(true)}>{d.status === 'archived' ? 'アーカイブを解除' : 'アーカイブ'}</Button>
        ) : null}
        {can('customer.anonymize') && d.status !== 'anonymized' ? (
          <Button variant="danger" onClick={() => setAnon(true)}>
            匿名化(削除)
          </Button>
        ) : null}
      </div>
      {edit ? <CustomerEditModal customer={d} onClose={() => setEdit(false)} /> : null}
      {book ? <BookingFormModal initial={{ customer: { id: d.id, name: d.name } }} onClose={() => setBook(false)} onCreated={(b) => navigate(`/app/bookings/${b.id}`)} /> : null}
      {merge ? (
        <ConfirmDialog
          title="顧客を統合しますか?"
          message={
            <>
              「{merge.name}」の予約・回数券・利用プラン・メモ・実施記録をすべて「{d.name}」に移し、「{merge.name}」は統合済みになります。この操作は取り消せません。同一人物であることを確認してください。
            </>
          }
          confirmLabel="統合する"
          danger
          busy={mergeM.isPending}
          onConfirm={() => mergeM.mutate(merge.id)}
          onCancel={() => setMerge(null)}
        />
      ) : null}
      {archiveOpen ? (
        <ConfirmDialog
          title={d.status === 'archived' ? 'アーカイブを解除しますか?' : '顧客をアーカイブしますか?'}
          message="アーカイブした顧客は一覧に表示されず、新しい予約に使えなくなります。履歴は保持されます。"
          busy={archive.isPending}
          onConfirm={() => archive.mutate(d.status !== 'archived')}
          onCancel={() => setArchiveOpen(false)}
        />
      ) : null}
      {anon ? (
        <ConfirmDialog title="顧客を匿名化しますか?" danger confirmLabel="匿名化する" busy={anonymize.isPending} onConfirm={() => anonymize.mutate(undefined)} onCancel={() => setAnon(false)}>
          <p>
            氏名・連絡先・メモ・事前質問の回答など個人を特定できる情報を消去します。予約・回数券台帳・実施記録の件数と関係は集計のため残ります。<strong>元に戻せません。</strong>
          </p>
          <TextField label={`確認のため顧客名「${d.name}」を入力`} value={anonName} onChange={(e) => setAnonName(e.target.value)} error={anonymize.error ? (anonymize.error as ApiError).message : undefined} />
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

const TL_BOOKING: Record<string, string> = {
  created: '予約',
  rescheduled: '予約変更',
  canceled: 'キャンセル',
  arrived: '来店',
  in_service: '対応開始',
  completed: '完了',
  no_show: '無断欠席',
  status_reverted: '状態取消',
  restored: '予約復元',
  next_booking_created: '次回予約',
};

function Timeline({ customerId, tz }: { customerId: string; tz: string }) {
  const q = useApi<{ items: { kind: string; at: string; refId: string | null; title: string; detail: any; actor: string | null }[] }>(
    ['customer-timeline', customerId],
    `/api/v1/customers/${customerId}/timeline`,
  );
  if (q.isLoading) return <Spinner />;
  if (!q.data || q.data.items.length === 0) return <EmptyState title="履歴はまだありません" />;
  return (
    <Card>
      <ul className="timeline">
        {q.data.items.map((e, i) => {
          let title = '';
          let body: React.ReactNode = null;
          if (e.kind === 'booking') {
            title = TL_BOOKING[e.title] ?? e.title;
            body = (
              <>
                <Link to={`/app/bookings/${e.refId}`}>{e.detail?.service}</Link> ・ {e.detail?.location} ・ {e.detail?.startsAt ? fmtDateTime(e.detail.startsAt, e.detail.timezone ?? tz) : ''}
                {e.title === 'canceled' ? ` ・ ${e.detail?.data?.by === 'customer' ? '顧客' : '事業者'}${e.detail?.data?.late ? '(締切後)' : ''}` : ''}
              </>
            );
          } else if (e.kind === 'pass' || e.kind === 'plan') {
            title = `${e.kind === 'pass' ? '回数券' : '利用プラン'} ${PASS_ENTRY_LABELS[e.title] ?? e.title}`;
            body = (
              <>
                {e.detail?.pass ?? e.detail?.plan} {e.detail?.delta > 0 ? `+${e.detail.delta}` : e.detail?.delta}回(残 {e.detail?.balance}){e.detail?.reason ? ` ・ ${e.detail.reason}` : ''}
              </>
            );
          } else if (e.kind === 'note') {
            title = e.title === 'confidential' ? '対応メモ(機密)' : '対応メモ';
            body = <span style={{ whiteSpace: 'pre-wrap' }}>{e.detail?.body}</span>;
          } else if (e.kind === 'record') {
            title = e.title === 'voided' ? '実施記録(取消)' : '実施記録';
            body = (
              <>
                {e.detail?.service}
                {e.detail?.internalMemo ? <div className="small">内部メモ: {e.detail.internalMemo}</div> : null}
                {e.detail?.customerMemo ? <div className="small">お客様向け: {e.detail.customerMemo}</div> : null}
                {e.detail?.nextRecommendedOn ? <div className="small">次回推奨: {fmtDate(e.detail.nextRecommendedOn)}</div> : null}
              </>
            );
          } else if (e.kind === 'merge') {
            title = '顧客統合';
            body = <>別の顧客レコードを統合しました(予約 {e.detail?.moved?.bookings ?? 0}件ほか)</>;
          }
          return (
            <li key={i}>
              <strong>{title}</strong> <span className="muted small">{fmtDateTime(e.at, tz)}</span>
              {e.actor ? <span className="muted small"> ・ {e.actor}</span> : null}
              <div className="small">{body}</div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function CustomerBookings({ customerId }: { customerId: string }) {
  const q = useApi<{ items: BookingDto[] }>(['bookings', 'customer', customerId], `/api/v1/bookings${qs({ customerId, order: 'desc', limit: 200 })}`);
  if (q.isLoading) return <Spinner />;
  if (!q.data || q.data.items.length === 0) return <EmptyState title="予約はありません(権限のある拠点の予約のみ表示されます)" />;
  return (
    <div className="table-wrap">
      <table className="table table-responsive">
        <thead>
          <tr>
            <th>日時</th>
            <th>サービス</th>
            <th>拠点</th>
            <th>担当</th>
            <th>状態</th>
          </tr>
        </thead>
        <tbody>
          {q.data.items.map((b) => (
            <tr key={b.id}>
              <td data-label="日時">
                <Link to={`/app/bookings/${b.id}`}>{fmtDateTime(b.startsAt, b.timezone)}</Link>
              </td>
              <td data-label="サービス">{b.serviceName}</td>
              <td data-label="拠点">{b.locationName}</td>
              <td data-label="担当">{b.staffName ?? '—'}</td>
              <td data-label="状態">
                <StatusBadge status={b.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Notes({ customerId, tz, disabled }: { customerId: string; tz: string; disabled: boolean }) {
  const can = useCan();
  const online = useOnline();
  // 書きかけのメモはこの端末に下書きとして保存する
  const draft = useDraft('customer-note', customerId, { body: '', visibility: 'general' });
  const body = draft.value.body;
  const visibility = draft.value.visibility as 'general' | 'confidential';
  const tl = useApi<{ items: { kind: string; at: string; refId: string; title: string; detail: any; actor: string | null }[] }>(
    ['customer-timeline', customerId],
    `/api/v1/customers/${customerId}/timeline`,
  );
  const add = useApiMutation(
    async () => {
      const res = await api.post(`/api/v1/customers/${customerId}/notes`, { body, visibility });
      draft.discard();
      return res;
    },
    {
      invalidate: [['customer-timeline', customerId]],
      success: 'メモを追加しました',
    },
  );
  const del = useApiMutation((noteId: string) => api.del(`/api/v1/customers/${customerId}/notes/${noteId}`), {
    invalidate: [['customer-timeline', customerId]],
    success: '削除しました',
  });
  const notes = (tl.data?.items ?? []).filter((x) => x.kind === 'note');
  return (
    <div className="stack">
      {!disabled && (can('customer.note.general') || can('customer.note.confidential')) ? (
        <Card title="メモを追加" actions={<DraftStatus savedAt={draft.savedAt} />}>
          <DraftNotice restoredAt={draft.restored?.savedAt ?? null} online={online} submitLabel="追加" onDiscard={draft.discard} />
          <TextAreaField label="内容" value={body} onChange={(e) => draft.set('body', e.target.value)} maxLength={4000} hint="医療情報(病歴・症状など)は記録しないでください" />
          <SelectField
            label="公開範囲"
            value={visibility}
            onChange={(e) => draft.set('visibility', e.target.value)}
            options={[
              ...(can('customer.note.general') ? [{ value: 'general', label: '一般(受付を含むスタッフ全員)' }] : []),
              ...(can('customer.note.confidential') ? [{ value: 'confidential', label: '機密(受付には表示しない)' }] : []),
            ]}
          />
          <div className="form-actions">
            <Button variant="primary" disabled={!body.trim() || !online} busy={add.isPending} onClick={() => add.mutate(undefined)}>
              追加
            </Button>
          </div>
        </Card>
      ) : null}
      {notes.length === 0 ? <EmptyState title="メモはありません" /> : null}
      {notes.map((n) => (
        <Card key={n.refId}>
          <div className="row-between">
            <span className="small muted">
              {fmtDateTime(n.at, tz)} ・ {n.actor} {n.title === 'confidential' ? <Badge tone="danger" icon="🔒">機密</Badge> : null}
            </span>
            {!n.detail?.deleted ? (
              <Button size="sm" onClick={() => del.mutate(n.refId)}>
                削除
              </Button>
            ) : null}
          </div>
          <p style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{n.detail?.body}</p>
        </Card>
      ))}
    </div>
  );
}
