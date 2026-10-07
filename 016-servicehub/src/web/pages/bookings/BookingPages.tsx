import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { BOOKING_STATUS_LABELS, BOOKING_STATUSES, CHANNEL_LABELS, SOURCE_DETAIL_LABELS, type BookingStatus } from '../../../shared/constants';
import { addDays, localToUtcLenient, todayIn } from '../../../shared/time';
import { api, qs, type ApiError } from '../../api/client';
import { useApi, useApiMutation, useCan, useCurrentLocation, useMe, useOnline } from '../../api/hooks';
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
  StatusBadge,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { fmtDateTime, fmtTime, formatTimeRange } from '../../lib/format';
import { BookingFormModal } from './BookingForm';

export interface BookingDto {
  id: string;
  code: string;
  locationId: string;
  locationName: string;
  timezone: string;
  customerId: string;
  customerName: string;
  customerKana: string | null;
  serviceId: string;
  serviceName: string;
  durationMin: number;
  capacity: number;
  staffId: string | null;
  staffName: string | null;
  startsAt: string;
  endsAt: string;
  partySize: number;
  status: BookingStatus;
  channel: string;
  sourceDetail: string | null;
  customerRequest: string | null;
  internalNote?: string | null;
  forced: boolean;
  forceReason?: string | null;
  cancelReason: string | null;
  cancelLate: boolean | null;
  consumptionKind: 'pass' | 'plan' | null;
  consumptionEntryId: string | null;
  consumptionReview: 'pending' | 'consumed' | 'waived' | null;
  previousBookingId: string | null;
  version: number;
}

export function BookingsPage() {
  const me = useMe();
  const can = useCan();
  const navigate = useNavigate();
  const [locId, setLocId, locations] = useCurrentLocation();
  const tz = locations?.find((l) => l.id === locId)?.timezone ?? me.data?.organization?.timezone ?? 'Asia/Tokyo';
  const [from, setFrom] = useState(todayIn(tz));
  const [to, setTo] = useState(addDays(todayIn(tz), 7));
  const [status, setStatus] = useState('');
  const [review, setReview] = useState(false);
  const [create, setCreate] = useState(false);
  const list = useApi<{ items: BookingDto[] }>(
    ['bookings', locId, from, to, status, review],
    `/api/v1/bookings${qs({
      locationId: locId,
      from: localToUtcLenient(from, '00:00', tz).toISOString(),
      to: localToUtcLenient(addDays(to, 1), '00:00', tz).toISOString(),
      status: status || undefined,
      consumptionReview: review ? 'pending' : undefined,
      limit: 500,
    })}`,
  );
  return (
    <>
      <PageHeader
        title="予約"
        actions={can('booking.create.all') || can('booking.create.own') ? <Button variant="primary" onClick={() => setCreate(true)}>予約を作成</Button> : null}
      />
      <Card>
        <div className="grid-auto">
          {(locations?.length ?? 0) > 1 ? (
            <SelectField label="拠点" value={locId ?? ''} onChange={(e) => setLocId(e.target.value)} options={(locations ?? []).map((l) => ({ value: l.id, label: l.name }))} />
          ) : null}
          <TextField label="開始日" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <TextField label="終了日" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <SelectField
            label="状態"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            placeholder="すべて"
            options={BOOKING_STATUSES.map((s) => ({ value: s, label: BOOKING_STATUS_LABELS[s].label }))}
          />
        </div>
        <label className="check">
          <input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} /> 回数券/プラン消化の確認待ちのみ
        </label>
      </Card>
      <ErrorMessage error={list.error} />
      {list.isLoading ? <Spinner /> : null}
      {list.data?.items.length === 0 ? <EmptyState title="該当する予約はありません" /> : null}
      {list.data && list.data.items.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="table table-responsive">
            <thead>
              <tr>
                <th>日時</th>
                <th>顧客</th>
                <th>サービス</th>
                <th>担当</th>
                <th>状態</th>
                <th>予約番号</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((b) => (
                <tr key={b.id} className="clickable" onClick={() => navigate(`/app/bookings/${b.id}`)}>
                  <td data-label="日時" className="nowrap">
                    <Link to={`/app/bookings/${b.id}`} onClick={(e) => e.stopPropagation()}>
                      {fmtDateTime(b.startsAt, b.timezone)}
                    </Link>
                  </td>
                  <td data-label="顧客">
                    {b.customerName}
                    {b.partySize > 1 ? <span className="muted small">({b.partySize}名)</span> : null}
                  </td>
                  <td data-label="サービス">{b.serviceName}</td>
                  <td data-label="担当">{b.staffName ?? 'なし'}</td>
                  <td data-label="状態">
                    <StatusBadge status={b.status} />
                    {b.consumptionReview === 'pending' ? <Badge tone="warning" icon="?">消化確認待ち</Badge> : null}
                  </td>
                  <td data-label="予約番号" className="mono">
                    {b.code}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {create ? <BookingFormModal initial={{ locationId: locId ?? undefined }} onClose={() => setCreate(false)} onCreated={(b) => navigate(`/app/bookings/${b.id}`)} /> : null}
    </>
  );
}

interface BookingDetail extends BookingDto {
  customer: { id: string; name: string; nameKana: string | null; email: string | null; phone: string | null; status: string };
  answers: { question: { label: string; type: string; options?: { id: string; label: string }[] }; answer: unknown }[];
  events: { type: string; from: string | null; to: string | null; data: any; actorType: string; actorLabel: string | null; at: string }[];
  resources: string[];
  serviceRecordId: string | null;
  manageLink: { available: boolean; active: boolean; expiresAt: string | null };
}

const EVENT_LABELS: Record<string, string> = {
  created: '予約作成',
  rescheduled: '日時・担当の変更',
  canceled: 'キャンセル',
  arrived: '来店',
  in_service: '対応開始',
  completed: '完了',
  no_show: '無断欠席',
  status_reverted: '状態の取消',
  restored: '復元',
  next_booking_created: '次回予約を作成',
  manage_link_reissued: 'お客様用リンクを再発行',
  manage_link_revoked: 'お客様用リンクを無効化',
};

export function formatAnswer(a: { question: { type: string; options?: { id: string; label: string }[] }; answer: unknown }): string {
  const v = a.answer;
  if (a.question.type === 'yes_no') return v === true ? 'はい' : v === false ? 'いいえ' : String(v);
  if (a.question.type === 'confirm') return v === true ? '同意済み' : String(v);
  if (a.question.type === 'single_choice') return a.question.options?.find((o) => o.id === v)?.label ?? String(v);
  if (a.question.type === 'multi_choice' && Array.isArray(v)) return v.map((x) => a.question.options?.find((o) => o.id === x)?.label ?? x).join('、');
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** お客様用の予約管理リンク(確認・変更・キャンセル)の再発行・無効化 */
function ManageLinkCard({ bookingId, active, canReissue, hasEmail }: { bookingId: string; active: boolean; canReissue: boolean; hasEmail: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const m = useApiMutation((body: { action: 'reissue' | 'revoke'; sendEmail: boolean }) => api.post<{ manageUrl: string | null; emailQueued: boolean }>(`/api/v1/bookings/${bookingId}/manage-link`, body), {
    invalidate: [['booking', bookingId]],
    success: '更新しました',
    onSuccess: (r) => setUrl(r.manageUrl),
  });
  return (
    <Card title="お客様用の予約管理リンク">
      <p className="small muted">
        {active ? '現在のリンクは有効です。' : '現在リンクは無効です。'}
        再発行すると以前のリンクは使えなくなります。リンクを紛失した・他人に知られた場合に使います。
      </p>
      <ErrorMessage error={m.error} />
      {url ? (
        <TextField label="新しいリンク(この画面でのみ表示されます)" value={url} readOnly onFocus={(e) => e.currentTarget.select()} />
      ) : null}
      <div className="row">
        {canReissue && hasEmail ? (
          <Button busy={m.isPending} onClick={() => m.mutate({ action: 'reissue', sendEmail: true })}>
            再発行してメールで送る
          </Button>
        ) : null}
        {canReissue ? (
          <Button busy={m.isPending} onClick={() => m.mutate({ action: 'reissue', sendEmail: false })}>
            再発行してURLを表示
          </Button>
        ) : null}
        {active ? (
          <Button variant="danger" busy={m.isPending} onClick={() => m.mutate({ action: 'revoke', sendEmail: false })}>
            無効にする
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

export function BookingDetailPage() {
  const { id = '' } = useParams();
  const can = useCan();
  const online = useOnline();
  const navigate = useNavigate();
  const q = useApi<BookingDetail>(['booking', id], `/api/v1/bookings/${id}`);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reschedule, setReschedule] = useState(false);
  const [restore, setRestore] = useState(false);
  const [noShowConfirm, setNoShowConfirm] = useState(false);
  const [noteEdit, setNoteEdit] = useState<string | null>(null);
  const invalidate = [['booking', id], ['bookings'], ['today'], ['reception'], ['schedule']];
  const status = useApiMutation((to: string) => api.post(`/api/v1/bookings/${id}/status`, { to, expectedVersion: q.data?.version }), {
    invalidate,
    success: '状態を更新しました',
  });
  const saveNote = useApiMutation((note: string) => api.patch(`/api/v1/bookings/${id}`, { internalNote: note, expectedVersion: q.data?.version }), {
    invalidate,
    success: '保存しました',
    onSuccess: () => setNoteEdit(null),
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorMessage error={q.error} />;
  const b = q.data!;
  const tz = b.timezone;
  const canStatus = can('booking.status.all') || can('booking.status.own');
  const active = b.status === 'confirmed' || b.status === 'arrived' || b.status === 'in_service';
  return (
    <div className="stack-lg">
      <PageHeader
        title={`${b.customerName} 様`}
        sub={
          <>
            予約番号 <span className="mono">{b.code}</span> ・ {CHANNEL_LABELS[b.channel] ?? b.channel}
            {b.sourceDetail ? `(${SOURCE_DETAIL_LABELS[b.sourceDetail] ?? b.sourceDetail})` : ''}
          </>
        }
        actions={<StatusBadge status={b.status} size="lg" />}
      />
      {!online ? <Alert tone="warning">オフラインのため操作できません。</Alert> : null}
      {b.forced ? <Alert tone="warning">強制予約(ルールを上書きして作成){b.forceReason ? `: ${b.forceReason}` : ''}</Alert> : null}
      {b.consumptionReview === 'pending' ? (
        <Alert tone="warning">
          締切後のキャンセル/無断欠席です。回数券・プランを消化するかどうか確認してください。{' '}
          <Link to={`/app/bookings/${b.id}/consume`}>消化の確認へ</Link>
        </Alert>
      ) : null}
      {b.consumptionReview === 'consumed' && b.status !== 'completed' ? (
        <Alert tone="info">
          締切後のキャンセル/無断欠席として、回数券・プランを1回消化済みです。{' '}
          <Link to={`/app/bookings/${b.id}/consume`}>消化の内容・取消</Link>
        </Alert>
      ) : null}
      <div className="grid-2">
        <Card title="予約内容">
          <dl className="kv">
            <dt>日時</dt>
            <dd>
              <strong>{fmtDateTime(b.startsAt, tz)}</strong>〜{fmtTime(b.endsAt, tz)}
            </dd>
            <dt>拠点</dt>
            <dd>{b.locationName}</dd>
            <dt>サービス</dt>
            <dd>
              {b.serviceName}({b.durationMin}分){b.partySize > 1 ? ` ・ ${b.partySize}名` : ''}
            </dd>
            <dt>担当</dt>
            <dd>{b.staffName ?? 'なし'}</dd>
            {b.resources.length ? (
              <>
                <dt>部屋・設備</dt>
                <dd>{b.resources.join('、')}</dd>
              </>
            ) : null}
            {b.customerRequest ? (
              <>
                <dt>お客様の要望</dt>
                <dd style={{ whiteSpace: 'pre-wrap' }}>{b.customerRequest}</dd>
              </>
            ) : null}
            {b.cancelReason ? (
              <>
                <dt>キャンセル理由</dt>
                <dd>
                  {b.cancelReason}
                  {b.cancelLate ? <Badge tone="warning">締切後</Badge> : null}
                </dd>
              </>
            ) : null}
            {b.consumptionKind ? (
              <>
                <dt>消化</dt>
                <dd>{b.consumptionKind === 'pass' ? '回数券' : '利用プラン'}から1回消化済み</dd>
              </>
            ) : null}
          </dl>
        </Card>
        <Card title="顧客">
          <dl className="kv">
            <dt>氏名</dt>
            <dd>
              <Link to={`/app/customers/${b.customer.id}`}>{b.customer.name}</Link>
              {b.customer.nameKana ? <span className="muted small"> {b.customer.nameKana}</span> : null}
            </dd>
            <dt>電話</dt>
            <dd>{b.customer.phone ? <a href={`tel:${b.customer.phone}`}>{b.customer.phone}</a> : '—'}</dd>
            <dt>メール</dt>
            <dd>{b.customer.email ?? '—'}</dd>
          </dl>
        </Card>
      </div>
      {canStatus && active ? (
        <Card title="受付・対応">
          <div className="row">
            {b.status === 'confirmed' ? (
              <Button variant="primary" size="lg" disabled={!online} busy={status.isPending} onClick={() => status.mutate('arrived')}>
                ● 来店済みにする
              </Button>
            ) : null}
            {b.status === 'confirmed' || b.status === 'arrived' ? (
              <Button size="lg" disabled={!online} busy={status.isPending} onClick={() => status.mutate('in_service')}>
                ▶ 対応開始
              </Button>
            ) : null}
            <Button variant="primary" size="lg" disabled={!online} onClick={() => navigate(`/app/bookings/${b.id}/complete`)}>
              ✓ 完了・実施記録
            </Button>
            {b.status === 'arrived' ? (
              <Button disabled={!online} onClick={() => status.mutate('confirmed')}>
                来店を取り消す
              </Button>
            ) : null}
            {b.status === 'in_service' ? (
              <Button disabled={!online} onClick={() => status.mutate('arrived')}>
                対応開始を取り消す
              </Button>
            ) : null}
            {b.status === 'confirmed' || b.status === 'arrived' ? (
              <Button variant="danger" disabled={!online} onClick={() => setNoShowConfirm(true)}>
                ! 無断欠席
              </Button>
            ) : null}
          </div>
          <ErrorMessage error={status.error} />
        </Card>
      ) : null}
      <div className="row">
        {b.status === 'confirmed' && (can('booking.update.all') || can('booking.update.own')) ? (
          <Button disabled={!online} onClick={() => setReschedule(true)}>
            日時・担当を変更
          </Button>
        ) : null}
        {(b.status === 'confirmed' || b.status === 'arrived') && (can('booking.cancel.all') || can('booking.cancel.own')) ? (
          <Button variant="danger" disabled={!online} onClick={() => setCancelOpen(true)}>
            キャンセル
          </Button>
        ) : null}
        {['canceled_customer', 'canceled_business', 'no_show'].includes(b.status) && can('booking.restore') ? (
          <Button disabled={!online} onClick={() => setRestore(true)}>
            キャンセル/無断欠席を取り消す
          </Button>
        ) : null}
        {b.status === 'completed' || b.serviceRecordId ? <Link className="btn" to={`/app/bookings/${b.id}/complete`}>実施記録を見る</Link> : null}
        {(can('booking.create.all') || can('booking.create.own')) && b.status === 'completed' ? (
          <Link className="btn btn-primary" to={`/app/bookings/${b.id}/next`}>
            次回予約を取る
          </Link>
        ) : null}
      </div>
      {b.answers.length > 0 ? (
        <Card title="事前質問への回答">
          <dl className="kv">
            {b.answers.map((a, i) => (
              <div key={i} style={{ display: 'contents' }}>
                <dt>{a.question.label}</dt>
                <dd>{formatAnswer(a)}</dd>
              </div>
            ))}
          </dl>
          <p className="small muted">質問は予約時点の内容で保存されています。</p>
        </Card>
      ) : null}
      {b.manageLink.available && (can('booking.update.all') || can('booking.update.own')) ? <ManageLinkCard bookingId={b.id} active={b.manageLink.active} canReissue={b.status === 'confirmed'} hasEmail={Boolean(b.customer.email)} /> : null}
      {b.internalNote !== undefined ? (
        <Card title="内部メモ" actions={<Button size="sm" onClick={() => setNoteEdit(b.internalNote ?? '')}>編集</Button>}>
          <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{b.internalNote || <span className="muted">なし</span>}</p>
        </Card>
      ) : null}
      <Card title="履歴">
        <ul className="timeline">
          {b.events.map((e, i) => (
            <li key={i}>
              <strong>{EVENT_LABELS[e.type] ?? e.type}</strong> <span className="muted small">{fmtDateTime(e.at, tz)}</span>
              <div className="small muted">
                {e.actorType === 'customer' ? 'お客様(Web)' : e.actorType === 'system' ? 'システム' : e.actorLabel}
                {e.type === 'rescheduled' && e.data?.from ? ` ・ ${fmtDateTime(e.data.from.startsAt, tz)} → ${fmtDateTime(e.data.to.startsAt, tz)}` : ''}
                {e.type === 'canceled' ? ` ・ ${e.data?.by === 'customer' ? '顧客' : '事業者'}キャンセル${e.data?.late ? '(締切後)' : ''}` : ''}
              </div>
            </li>
          ))}
        </ul>
      </Card>
      {cancelOpen ? <CancelDialog booking={b} onClose={() => setCancelOpen(false)} /> : null}
      {reschedule ? <RescheduleModal booking={b} onClose={() => setReschedule(false)} /> : null}
      {restore ? <RestoreDialog booking={b} canForce={can('booking.force')} onClose={() => setRestore(false)} /> : null}
      {noShowConfirm ? (
        <ConfirmDialog
          title="無断欠席にしますか?"
          danger
          message={`${b.customerName} 様の予約を無断欠席にします。回数券・プランは自動では消化されません(運営ルールにより確認待ちになることがあります)。`}
          confirmLabel="無断欠席にする"
          busy={status.isPending}
          onConfirm={() => status.mutate('no_show', { onSettled: () => setNoShowConfirm(false) })}
          onCancel={() => setNoShowConfirm(false)}
        />
      ) : null}
      {noteEdit !== null ? (
        <Modal title="内部メモ" onClose={() => setNoteEdit(null)} footer={<Button variant="primary" busy={saveNote.isPending} onClick={() => saveNote.mutate(noteEdit)}>保存</Button>}>
          <TextAreaField label="内部メモ" value={noteEdit} onChange={(e) => setNoteEdit(e.target.value)} />
        </Modal>
      ) : null}
    </div>
  );
}

/**
 * キャンセル/無断欠席の取り消し。同じ日時の枠を再確保できた場合のみ。
 * 過去の日時・営業時間外など上書きできる理由だけで失敗したときは、強制予約の権限があれば理由を入れて復元できる
 */
function RestoreDialog({ booking, canForce, onClose }: { booking: BookingDto; canForce: boolean; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const m = useApiMutation((force: boolean) => api.post(`/api/v1/bookings/${booking.id}/restore`, force ? { force: true, forceReason: reason } : {}), {
    invalidate: [['booking', booking.id], ['bookings'], ['today'], ['reception'], ['schedule']],
    success: '予約を復元しました',
    onSuccess: onClose,
    silentError: true,
  });
  const err = m.error as ApiError | null;
  const violations: { code: string; hard: boolean; message: string }[] = err?.details?.violations ?? [];
  const softOnly = err?.code === 'SLOT_UNAVAILABLE' && violations.length > 0 && violations.every((v) => !v.hard);
  return (
    <Modal
      title="予約を復元しますか?"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>やめる</Button>
          {softOnly && canForce ? (
            <Button variant="primary" busy={m.isPending} disabled={!reason.trim()} onClick={() => m.mutate(true)}>
              理由を記録して復元(強制)
            </Button>
          ) : (
            <Button variant="primary" busy={m.isPending} onClick={() => m.mutate(false)}>
              復元する
            </Button>
          )}
        </>
      }
    >
      <div className="stack">
        <p style={{ margin: 0 }}>
          {booking.status === 'no_show' ? '無断欠席を取り消し、「来店済み」に戻します。' : 'キャンセルを取り消し、「来店待ち」に戻します。'}同じ日時の枠を再確保できた場合のみ復元できます。
        </p>
        {err ? <ErrorMessage error={err} /> : null}
        {violations.length > 0 ? (
          <ul className="small" style={{ margin: 0 }}>
            {violations.map((v) => (
              <li key={v.code}>
                {v.message}
                {v.hard ? '(上書きできません)' : ''}
              </li>
            ))}
          </ul>
        ) : null}
        {softOnly && canForce ? (
          <TextAreaField label="強制する理由(監査ログに記録)" required value={reason} onChange={(e) => setReason(e.target.value)} hint="例: 誤って無断欠席にしたため。過去の日時などのルールを上書きして復元します。" />
        ) : null}
        {softOnly && !canForce ? <p className="small muted">ルールを上書きした復元はオーナー・マネージャーが行えます。</p> : null}
      </div>
    </Modal>
  );
}

function CancelDialog({ booking, onClose }: { booking: BookingDto; onClose: () => void }) {
  const [by, setBy] = useState<'customer' | 'business'>('customer');
  const [reason, setReason] = useState('');
  const m = useApiMutation(() => api.post(`/api/v1/bookings/${booking.id}/cancel`, { by, reason: reason || null, expectedVersion: booking.version }), {
    invalidate: [['booking', booking.id], ['bookings'], ['today'], ['reception'], ['schedule']],
    success: 'キャンセルしました(枠は再び予約可能になりました)',
    onSuccess: onClose,
  });
  return (
    <ConfirmDialog title="予約をキャンセルしますか?" danger confirmLabel="キャンセルする" busy={m.isPending} onConfirm={() => m.mutate(undefined)} onCancel={onClose}>
      <div className="stack">
        <SelectField
          label="キャンセルの区分"
          value={by}
          onChange={(e) => setBy(e.target.value as typeof by)}
          options={[
            { value: 'customer', label: 'お客様都合(顧客キャンセル)' },
            { value: 'business', label: '店舗都合(事業者キャンセル)' },
          ]}
        />
        <TextAreaField label="理由(任意)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <p className="small muted">締切後のお客様都合キャンセルは、回数券/プランの消化を運営者が確認する対象になります(自動では消化しません)。</p>
      </div>
    </ConfirmDialog>
  );
}

function RescheduleModal({ booking, onClose }: { booking: BookingDto; onClose: () => void }) {
  const me = useMe();
  const can = useCan();
  const tz = booking.timezone;
  const [date, setDate] = useState(todayIn(tz) > booking.startsAt.slice(0, 10) ? todayIn(tz) : booking.startsAt.slice(0, 10));
  const [staffId, setStaffId] = useState(booking.staffId ?? '');
  const [slot, setSlot] = useState<string | null>(null);
  const staff = useApi<{ items: { id: string; displayName: string; status: string; serviceIds: string[] }[] }>(['staff-list', booking.locationId], `/api/v1/staff${qs({ locationId: booking.locationId })}`);
  const avail = useApi<{ slots: { startsAt: string }[] }>(
    ['admin-availability', booking.id, date, staffId],
    `/api/v1/availability${qs({ locationId: booking.locationId, serviceId: booking.serviceId, date, staffId: staffId || undefined, partySize: booking.partySize, excludeBookingId: booking.id })}`,
  );
  const m = useApiMutation(() => api.post(`/api/v1/bookings/${booking.id}/reschedule`, { startsAt: slot, staffId: staffId || null, expectedVersion: booking.version }), {
    invalidate: [['booking', booking.id], ['bookings'], ['today'], ['reception'], ['schedule']],
    success: '予約を変更しました',
    onSuccess: onClose,
  });
  const ownOnly = !can('booking.update.all');
  return (
    <Modal title="日時・担当を変更" wide onClose={onClose} footer={<Button variant="primary" disabled={!slot} busy={m.isPending} onClick={() => m.mutate(undefined)}>変更する</Button>}>
      <div className="stack">
        <p className="small">
          現在: {fmtDateTime(booking.startsAt, tz)} / {booking.staffName ?? '担当なし'}。変更に失敗した場合、元の予約はそのまま残ります。
        </p>
        <div className="grid-2">
          <TextField label="日付" type="date" value={date} onChange={(e) => { setDate(e.target.value); setSlot(null); }} />
          <SelectField
            label="担当"
            value={staffId}
            disabled={ownOnly}
            onChange={(e) => { setStaffId(e.target.value); setSlot(null); }}
            placeholder="おまかせ"
            options={(staff.data?.items ?? []).filter((s) => s.status === 'active' && s.serviceIds.includes(booking.serviceId)).map((s) => ({ value: s.id, label: s.displayName }))}
          />
        </div>
        <ErrorMessage error={m.error as ApiError | null} />
        {avail.isLoading ? <Spinner /> : null}
        {avail.data?.slots.length === 0 ? <Alert tone="info">空き枠がありません</Alert> : null}
        <div className="slot-grid">
          {avail.data?.slots.map((s) => (
            <button key={s.startsAt} type="button" className="slot-btn" aria-pressed={slot === s.startsAt} onClick={() => setSlot(s.startsAt)}>
              {fmtTime(s.startsAt, tz)}
            </button>
          ))}
        </div>
        <span className="small muted">{me.data?.organization?.name}</span>
      </div>
    </Modal>
  );
}

export { formatTimeRange };
