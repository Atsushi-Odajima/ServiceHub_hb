import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { localToUtcLenient } from '../../../shared/time';
import { api, newIdempotencyKey } from '../../api/client';
import { useApi, useApiMutation, useOnline } from '../../api/hooks';
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, ErrorMessage, Modal, PageHeader, Spinner, StatusBadge, TextAreaField, TextField } from '../../components/ui';
import { fmtDate, fmtDateTime, fmtTime, localDateOf, localTimeOf } from '../../lib/format';
import type { BookingDto } from '../bookings/BookingPages';
import { CandidatePicker, parseChoice } from '../entitlements/EntitlementPanels';
import type { Candidate, PassCandidate, PlanCandidate } from '../entitlements/types';

interface RecordDto {
  id: string;
  performedAt: string;
  endedAt: string | null;
  durationMin: number | null;
  internalMemo?: string | null;
  customerMemo?: string | null;
  nextRecommendedOn: string | null;
  nextRecommendedNote?: string | null;
  nextBookingId: string | null;
  status: 'active' | 'voided';
  voidReason: string | null;
  version: number;
}

interface Completion {
  booking: BookingDto & { arrivedAt: string | null; serviceStartedAt: string | null; completedAt: string | null };
  record: RecordDto | null;
  candidates: { date: string | null; passes: PassCandidate[]; plans: PlanCandidate[] };
  consumption: { kind: 'pass' | 'plan'; name: string; balanceAfter: number } | null;
  consumptionPrompt: 'on_complete' | 'manual';
  permissions: { writeRecord: boolean; consumePass: boolean; consumePlan: boolean; reverse: boolean; voidRecord: boolean; review: boolean };
}

function describe(c: Candidate | undefined): string {
  if (!c) return '';
  return `${c.name}から1回消化します(残り ${c.remaining} → ${c.remaining - 1})`;
}

/** 完了・実施記録・回数券/プランの消化(/complete)と、締切後キャンセル/無断欠席の消化確認(/consume) */
export function CompletionPage() {
  const { id = '' } = useParams();
  const q = useApi<Completion>(['booking', id, 'completion'], `/api/v1/bookings/${id}/completion`);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorMessage error={q.error} retry={() => void q.refetch()} />;
  const c = q.data!;
  const b = c.booking;
  const active = ['confirmed', 'arrived', 'in_service'].includes(b.status);
  const review = (b.status === 'canceled_customer' || b.status === 'no_show') && b.consumptionReview === 'pending';
  return (
    <div className="stack-lg">
      <PageHeader
        title={active ? '完了・実施記録' : review ? '回数券・プラン消化の確認' : '実施記録'}
        sub={
          <>
            <Link to={`/app/bookings/${b.id}`}>{b.customerName} 様</Link> ・ {fmtDateTime(b.startsAt, b.timezone)} ・ {b.serviceName}
            {b.staffName ? ` ・ 担当 ${b.staffName}` : ''}
          </>
        }
        actions={<StatusBadge status={b.status} size="lg" />}
      />
      {active ? <CompleteForm c={c} /> : null}
      {b.status === 'completed' ? <CompletedView c={c} /> : null}
      {review ? <ReviewPanel c={c} /> : null}
      {!active && b.status !== 'completed' && !review ? (
        <Alert tone="info">
          この予約は{b.consumptionReview === 'waived' ? '「消化しない」と確認済み' : b.consumptionReview === 'consumed' ? '消化済み' : '完了・消化の対象ではありません'}。
        </Alert>
      ) : null}
      {c.record && c.record.status === 'voided' && b.status !== 'completed' ? (
        <Alert tone="warning">以前の実施記録は取り消されています(理由: {c.record.voidReason})。</Alert>
      ) : null}
    </div>
  );
}

function CompleteForm({ c }: { c: Completion }) {
  const b = c.booking;
  const tz = b.timezone;
  const online = useOnline();
  const navigate = useNavigate();
  const date = localDateOf(b.startsAt, tz);
  const startDefault = b.serviceStartedAt ?? b.arrivedAt ?? b.startsAt;
  const [startTime, setStartTime] = useState(localTimeOf(startDefault, tz));
  const [duration, setDuration] = useState(String(b.durationMin ?? ''));
  const [internalMemo, setInternalMemo] = useState('');
  const [customerMemo, setCustomerMemo] = useState('');
  const [nextOn, setNextOn] = useState('');
  const [nextNote, setNextNote] = useState('');
  const candidates: Candidate[] = [...(c.permissions.consumePass ? c.candidates.passes : []), ...(c.permissions.consumePlan ? c.candidates.plans : [])];
  const [choice, setChoice] = useState<string | null>(c.consumptionPrompt === 'manual' || candidates.length === 0 ? 'none' : null);
  const [confirm, setConfirm] = useState(false);
  const key = useRef(newIdempotencyKey('use'));
  const selected = parseChoice(choice);
  const selectedCandidate = candidates.find((x) => selected && x.kind === selected.kind && x.id === selected.entitlementId);
  const m = useApiMutation(
    () => {
      const started = localToUtcLenient(date, startTime, tz);
      const dur = duration === '' ? null : Number(duration);
      return api.post(`/api/v1/bookings/${b.id}/complete`, {
        expectedVersion: b.version,
        record: {
          startedAt: started.toISOString(),
          endedAt: dur !== null ? new Date(started.getTime() + dur * 60000).toISOString() : null,
          durationMin: dur,
          ...(c.permissions.writeRecord
            ? { internalMemo: internalMemo || null, customerMemo: customerMemo || null, nextRecommendedOn: nextOn || null, nextRecommendedNote: nextNote || null }
            : {}),
        },
        consume: selected ? { ...selected, idempotencyKey: key.current } : null,
      });
    },
    {
      invalidate: [['booking', b.id], ['bookings'], ['today'], ['reception'], ['schedule'], ['passes'], ['plans']],
      success: (r: { consumption: { balanceAfter: number } | null }) => (r.consumption ? `完了しました(残り ${r.consumption.balanceAfter}回)` : '完了しました'),
      onSuccess: () => setConfirm(false),
      onError: () => setConfirm(false),
    },
  );
  const mustChoose = candidates.length > 0 && choice === null;
  return (
    <>
      <Card title="実施内容">
        <div className="stack">
          <div className="grid-2">
            <TextField label="開始時刻" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} hint={fmtDate(date)} />
            <TextField label="所要時間(分)" type="number" inputMode="numeric" min={0} value={duration} onChange={(e) => setDuration(e.target.value)} />
          </div>
          {c.permissions.writeRecord ? (
            <>
              <TextAreaField label="内部メモ(スタッフのみ)" value={internalMemo} onChange={(e) => setInternalMemo(e.target.value)} hint="施術・指導の内容など。医療情報や診断の記録には使わないでください。" />
              <TextAreaField label="お客様向けメモ" value={customerMemo} onChange={(e) => setCustomerMemo(e.target.value)} hint="ご自宅でのストレッチなど、お客様にお伝えした内容" />
              <div className="grid-2">
                <TextField label="次回のおすすめ日(任意)" type="date" value={nextOn} onChange={(e) => setNextOn(e.target.value)} />
                <TextField label="次回のメモ(任意)" value={nextNote} onChange={(e) => setNextNote(e.target.value)} />
              </div>
            </>
          ) : (
            <p className="small muted">メモの記入は担当スタッフ・管理者が行います。</p>
          )}
        </div>
      </Card>
      <Card title="回数券・利用プランの消化">
        {candidates.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            この予約に使える回数券・利用プランはありません。
          </p>
        ) : (
          <div className="stack">
            <p className="small" style={{ margin: 0 }}>
              消化する場合は選んでください。選ばない限り消化されません(完了と同時に1回だけ消化します)。
            </p>
            <CandidatePicker candidates={candidates} value={choice} onChange={setChoice} />
          </div>
        )}
      </Card>
      <ErrorMessage error={m.error} />
      <div className="row">
        <Button variant="primary" size="lg" disabled={!online || mustChoose} onClick={() => setConfirm(true)}>
          {selected ? '✓ 完了して1回消化' : '✓ 完了にする'}
        </Button>
        <Button onClick={() => navigate(`/app/bookings/${b.id}`)}>戻る</Button>
        {mustChoose ? <span className="small muted">消化するか「今回は消化しない」を選んでください</span> : null}
      </div>
      {confirm ? (
        <ConfirmDialog
          title="完了にしますか?"
          confirmLabel={selected ? '完了して1回消化' : '完了にする'}
          busy={m.isPending}
          onConfirm={() => m.mutate(undefined)}
          onCancel={() => setConfirm(false)}
          message={
            <div className="stack">
              <span>
                {b.customerName} 様 / {b.serviceName} を完了にします。
              </span>
              {selectedCandidate ? <strong>{describe(selectedCandidate)}</strong> : <span>回数券・プランは消化しません。</span>}
            </div>
          }
        />
      ) : null}
    </>
  );
}

function CompletedView({ c }: { c: Completion }) {
  const b = c.booking;
  const tz = b.timezone;
  const online = useOnline();
  const rec = c.record && c.record.status === 'active' ? c.record : null;
  const [edit, setEdit] = useState(false);
  const [reverse, setReverse] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [consume, setConsume] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const key = useRef(newIdempotencyKey('use'));
  const candidates: Candidate[] = [...(c.permissions.consumePass ? c.candidates.passes : []), ...(c.permissions.consumePlan ? c.candidates.plans : [])];
  const selected = parseChoice(consume);
  const selectedCandidate = candidates.find((x) => selected && x.kind === selected.kind && x.id === selected.entitlementId);
  const invalidate = [['booking', b.id], ['bookings'], ['today'], ['reception'], ['passes'], ['plans']];
  const consumeM = useApiMutation(() => api.post(`/api/v1/bookings/${b.id}/consume`, { ...selected, idempotencyKey: key.current }), {
    invalidate,
    success: (r: { balanceAfter: number }) => `1回消化しました(残り ${r.balanceAfter}回)`,
    onSuccess: () => {
      setConfirm(false);
      setConsume(null);
      key.current = newIdempotencyKey('use');
    },
    onError: () => setConfirm(false),
  });
  return (
    <>
      <Card
        title="実施記録"
        actions={
          rec && c.permissions.writeRecord ? (
            <Button size="sm" disabled={!online} onClick={() => setEdit(true)}>
              編集
            </Button>
          ) : null
        }
      >
        {rec ? (
          <dl className="kv">
            <dt>実施</dt>
            <dd>
              {fmtDateTime(rec.performedAt, tz)}
              {rec.endedAt ? `〜${fmtTime(rec.endedAt, tz)}` : ''}
              {rec.durationMin !== null ? `(${rec.durationMin}分)` : ''}
            </dd>
            {rec.internalMemo !== undefined ? (
              <>
                <dt>内部メモ</dt>
                <dd style={{ whiteSpace: 'pre-wrap' }}>{rec.internalMemo || <span className="muted">なし</span>}</dd>
                <dt>お客様向けメモ</dt>
                <dd style={{ whiteSpace: 'pre-wrap' }}>{rec.customerMemo || <span className="muted">なし</span>}</dd>
              </>
            ) : null}
            <dt>次回のおすすめ</dt>
            <dd>
              {rec.nextRecommendedOn ? fmtDate(rec.nextRecommendedOn) : '—'}
              {rec.nextRecommendedNote ? ` ・ ${rec.nextRecommendedNote}` : ''}
            </dd>
            <dt>次回予約</dt>
            <dd>{rec.nextBookingId ? <Link to={`/app/bookings/${rec.nextBookingId}`}>予約あり</Link> : 'なし'}</dd>
          </dl>
        ) : (
          <p className="muted">実施記録はありません。</p>
        )}
      </Card>
      <Card title="回数券・利用プラン">
        {c.consumption ? (
          <div className="stack">
            <p style={{ margin: 0 }}>
              <Badge tone="success" icon="✓">
                消化済み
              </Badge>{' '}
              {c.consumption.name}(消化後の残り {c.consumption.balanceAfter}回)
            </p>
            {c.permissions.reverse ? (
              <div>
                <Button disabled={!online} onClick={() => setReverse(true)}>
                  消化を取り消す(+1)
                </Button>
              </div>
            ) : null}
          </div>
        ) : candidates.length > 0 ? (
          <div className="stack">
            <p className="small" style={{ margin: 0 }}>
              この予約ではまだ消化していません。消化する場合は選んで「1回消化する」を押してください。
            </p>
            <CandidatePicker candidates={candidates} value={consume} onChange={setConsume} allowNone={false} name="consume-after" />
            <div>
              <Button variant="primary" disabled={!online || !selected} onClick={() => setConfirm(true)}>
                1回消化する
              </Button>
            </div>
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            消化はありません(使える回数券・プランもありません)。
          </p>
        )}
      </Card>
      <div className="row">
        <Link className="btn btn-primary" to={`/app/bookings/${b.id}/next`}>
          次回予約を取る
        </Link>
        {c.permissions.voidRecord && rec ? (
          <Button variant="danger" disabled={!online} onClick={() => setVoidOpen(true)}>
            実施を取り消す
          </Button>
        ) : null}
      </div>
      {confirm && selectedCandidate ? (
        <ConfirmDialog
          title="1回消化しますか?"
          confirmLabel="1回消化する"
          busy={consumeM.isPending}
          onConfirm={() => consumeM.mutate(undefined)}
          onCancel={() => setConfirm(false)}
          message={<strong>{describe(selectedCandidate)}</strong>}
        />
      ) : null}
      {edit && rec ? <EditRecordModal rec={rec} bookingId={b.id} tz={tz} onClose={() => setEdit(false)} /> : null}
      {reverse ? <ReverseModal bookingId={b.id} name={c.consumption?.name ?? ''} onClose={() => setReverse(false)} /> : null}
      {voidOpen && rec ? <VoidRecordModal rec={rec} bookingId={b.id} consumed={Boolean(c.consumption)} canReverse={c.permissions.reverse} onClose={() => setVoidOpen(false)} /> : null}
    </>
  );
}

function EditRecordModal({ rec, bookingId, tz, onClose }: { rec: RecordDto; bookingId: string; tz: string; onClose: () => void }) {
  const [internalMemo, setInternalMemo] = useState(rec.internalMemo ?? '');
  const [customerMemo, setCustomerMemo] = useState(rec.customerMemo ?? '');
  const [duration, setDuration] = useState(rec.durationMin !== null ? String(rec.durationMin) : '');
  const [nextOn, setNextOn] = useState(rec.nextRecommendedOn ?? '');
  const [nextNote, setNextNote] = useState(rec.nextRecommendedNote ?? '');
  const m = useApiMutation(
    () =>
      api.patch(`/api/v1/records/${rec.id}`, {
        expectedVersion: rec.version,
        internalMemo: internalMemo || null,
        customerMemo: customerMemo || null,
        durationMin: duration === '' ? null : Number(duration),
        nextRecommendedOn: nextOn || null,
        nextRecommendedNote: nextNote || null,
      }),
    { invalidate: [['booking', bookingId]], success: '保存しました', onSuccess: onClose },
  );
  return (
    <Modal
      title="実施記録を編集"
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>やめる</Button>
          <Button variant="primary" busy={m.isPending} onClick={() => m.mutate(undefined)}>
            保存
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">実施: {fmtDateTime(rec.performedAt, tz)}</p>
        <TextField label="所要時間(分)" type="number" inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} />
        <TextAreaField label="内部メモ(スタッフのみ)" value={internalMemo} onChange={(e) => setInternalMemo(e.target.value)} />
        <TextAreaField label="お客様向けメモ" value={customerMemo} onChange={(e) => setCustomerMemo(e.target.value)} />
        <div className="grid-2">
          <TextField label="次回のおすすめ日" type="date" value={nextOn} onChange={(e) => setNextOn(e.target.value)} />
          <TextField label="次回のメモ" value={nextNote} onChange={(e) => setNextNote(e.target.value)} />
        </div>
        <ErrorMessage error={m.error} />
      </div>
    </Modal>
  );
}

function ReverseModal({ bookingId, name, onClose }: { bookingId: string; name: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const m = useApiMutation(() => api.post(`/api/v1/bookings/${bookingId}/consumption/reverse`, { reason }), {
    invalidate: [['booking', bookingId], ['bookings'], ['passes'], ['plans'], ['reception'], ['today']],
    success: (r: { balanceAfter: number }) => `消化を取り消しました(残り ${r.balanceAfter}回)`,
    onSuccess: onClose,
  });
  return (
    <Modal
      title="消化を取り消す"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>やめる</Button>
          <Button variant="primary" disabled={!reason.trim()} busy={m.isPending} onClick={() => m.mutate(undefined)}>
            取り消す(+1)
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>{name} に1回分を戻します。元の消化は削除されず、「取消戻し」として台帳に記録されます。</p>
        <TextAreaField label="理由" required value={reason} onChange={(e) => setReason(e.target.value)} />
        <ErrorMessage error={m.error} />
      </div>
    </Modal>
  );
}

function VoidRecordModal({ rec, bookingId, consumed, canReverse, onClose }: { rec: RecordDto; bookingId: string; consumed: boolean; canReverse: boolean; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [reverse, setReverse] = useState(consumed && canReverse);
  const m = useApiMutation(() => api.post(`/api/v1/records/${rec.id}/void`, { reason, reverseConsumption: reverse }), {
    invalidate: [['booking', bookingId], ['bookings'], ['passes'], ['plans'], ['reception'], ['today']],
    success: '実施を取り消しました(予約は「対応中」に戻りました)',
    onSuccess: onClose,
  });
  return (
    <Modal
      title="実施を取り消す"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>やめる</Button>
          <Button variant="danger" disabled={!reason.trim()} busy={m.isPending} onClick={() => m.mutate(undefined)}>
            取り消す
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>実施記録を取消済みにし、予約を「対応中」に戻します。記録は削除されず履歴に残ります。</p>
        {consumed ? (
          canReverse ? (
            <Checkbox label="回数券・プランの消化も取り消す(+1)" checked={reverse} onChange={(e) => setReverse(e.target.checked)} />
          ) : (
            <Alert tone="info">消化の取消は権限のあるメンバーが行います(消化はそのまま残ります)。</Alert>
          )
        ) : null}
        <TextAreaField label="理由" required value={reason} onChange={(e) => setReason(e.target.value)} />
        <ErrorMessage error={m.error} />
      </div>
    </Modal>
  );
}

function ReviewPanel({ c }: { c: Completion }) {
  const b = c.booking;
  const online = useOnline();
  const [choice, setChoice] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState<'consume' | 'waive' | null>(null);
  const key = useRef(newIdempotencyKey('review'));
  const candidates: Candidate[] = [...c.candidates.passes, ...c.candidates.plans];
  const selected = parseChoice(choice);
  const selectedCandidate = candidates.find((x) => selected && x.kind === selected.kind && x.id === selected.entitlementId);
  const invalidate = [['booking', b.id], ['bookings'], ['passes'], ['plans'], ['dashboard']];
  const consume = useApiMutation(() => api.post(`/api/v1/bookings/${b.id}/consume`, { ...selected, idempotencyKey: key.current, reason: reason || null }), {
    invalidate,
    success: (r: { balanceAfter: number }) => `1回消化しました(残り ${r.balanceAfter}回)`,
    onSuccess: () => setConfirm(null),
    onError: () => setConfirm(null),
  });
  const waive = useApiMutation(() => api.post(`/api/v1/bookings/${b.id}/consumption/waive`, { reason: reason || null }), {
    invalidate,
    success: '「消化しない」で確定しました',
    onSuccess: () => setConfirm(null),
    onError: () => setConfirm(null),
  });
  return (
    <Card title={b.status === 'no_show' ? '無断欠席の消化確認' : '締切後キャンセルの消化確認'}>
      <div className="stack">
        <p style={{ margin: 0 }}>
          運営ルールに従って、回数券・プランを1回消化するか決めてください。<strong>確定するまで消化はされません。</strong>
        </p>
        {b.cancelReason ? <p className="small">キャンセル理由: {b.cancelReason}</p> : null}
        {!c.permissions.review ? (
          <Alert tone="info">この判断はオーナー/マネージャーが行います。</Alert>
        ) : (
          <>
            {candidates.length === 0 ? (
              <Alert tone="info">現在使える回数券・プランがありません(期限切れ・残なし等)。「消化しない」で確定できます。</Alert>
            ) : (
              <CandidatePicker candidates={candidates} value={choice} onChange={setChoice} allowNone={false} name="review" />
            )}
            <TextAreaField label="理由・メモ(任意)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="row">
              <Button variant="primary" disabled={!online || !selected} onClick={() => setConfirm('consume')}>
                1回消化する
              </Button>
              <Button disabled={!online} onClick={() => setConfirm('waive')}>
                消化しない
              </Button>
            </div>
          </>
        )}
        <ErrorMessage error={consume.error ?? waive.error} />
      </div>
      {confirm === 'consume' && selectedCandidate ? (
        <ConfirmDialog
          title="1回消化しますか?"
          confirmLabel="1回消化する"
          busy={consume.isPending}
          onConfirm={() => consume.mutate(undefined)}
          onCancel={() => setConfirm(null)}
          message={<strong>{describe(selectedCandidate)}</strong>}
        />
      ) : null}
      {confirm === 'waive' ? (
        <ConfirmDialog
          title="消化しないで確定しますか?"
          confirmLabel="消化しない"
          busy={waive.isPending}
          onConfirm={() => waive.mutate(undefined)}
          onCancel={() => setConfirm(null)}
          message="この予約について回数券・プランは消化しません。記録は監査ログに残ります。"
        />
      ) : null}
    </Card>
  );
}
