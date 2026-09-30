import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { PASS_ENTRY_LABELS } from '../../../shared/constants';
import { todayIn } from '../../../shared/time';
import { api, newIdempotencyKey, qs } from '../../api/client';
import { useApi, useApiMutation, useCan, useMe, useOnline } from '../../api/hooks';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, ErrorMessage, fieldError, Modal, PageHeader, SelectField, Spinner, TextAreaField, TextField } from '../../components/ui';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { PassStatus, PlanStatus } from './EntitlementPanels';
import type { LedgerRow, PassDetail, PassDto, PlanDetail, PlanDto } from './types';

function useOrgTz() {
  const me = useMe();
  return me.data?.organization?.timezone ?? 'Asia/Tokyo';
}

// =============================== 回数券 ===============================

export function PassesPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('active');
  const [expiring, setExpiring] = useState('');
  const list = useApi<{ items: PassDto[] }>(
    ['passes', 'list', status, expiring],
    `/api/v1/passes${qs({ status, expiringWithinDays: expiring || undefined, limit: 500 })}`,
  );
  return (
    <>
      <PageHeader title="回数券" sub="付与は顧客詳細の「回数券・利用プラン」から行います" />
      <Card>
        <div className="grid-auto">
          <SelectField
            label="状態"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: 'active', label: '有効' },
              { value: 'expired', label: '期限切れ' },
              { value: 'voided', label: '無効化' },
              { value: 'all', label: 'すべて' },
            ]}
          />
          <SelectField
            label="期限"
            value={expiring}
            onChange={(e) => setExpiring(e.target.value)}
            placeholder="指定しない"
            options={[
              { value: '7', label: '7日以内に期限(残あり)' },
              { value: '14', label: '14日以内に期限(残あり)' },
              { value: '30', label: '30日以内に期限(残あり)' },
            ]}
          />
        </div>
      </Card>
      <ErrorMessage error={list.error} />
      {list.isLoading ? <Spinner /> : null}
      {list.data?.items.length === 0 ? <EmptyState title="該当する回数券はありません" /> : null}
      {list.data && list.data.items.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="table table-responsive">
            <thead>
              <tr>
                <th>顧客</th>
                <th>回数券</th>
                <th className="num">残り</th>
                <th>有効期限</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => navigate(`/app/passes/${p.id}`)}>
                  <td data-label="顧客">
                    <Link to={`/app/passes/${p.id}`} onClick={(e) => e.stopPropagation()}>
                      {p.customerName}
                    </Link>
                  </td>
                  <td data-label="回数券">{p.name}</td>
                  <td data-label="残り" className="num">
                    <strong>{p.remaining}</strong> / {p.initialUses}
                  </td>
                  <td data-label="有効期限">{p.expiresOn ? fmtDate(p.expiresOn) : 'なし'}</td>
                  <td data-label="状態">
                    <PassStatus p={p} />
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

export function LedgerTable({ rows, tz }: { rows: LedgerRow[]; tz: string }) {
  if (rows.length === 0) return <EmptyState title="履歴はありません" />;
  return (
    <div className="table-wrap">
      <table className="table table-responsive">
        <thead>
          <tr>
            <th>日時</th>
            <th>内容</th>
            <th className="num">増減</th>
            <th className="num">残り</th>
            <th>予約</th>
            <th>理由</th>
            <th>操作者</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td data-label="日時" className="nowrap">
                {fmtDateTime(e.at, tz)}
              </td>
              <td data-label="内容">
                <Badge tone={e.delta > 0 ? 'success' : e.type === 'use' ? 'info' : 'warning'}>{PASS_ENTRY_LABELS[e.type] ?? e.type}</Badge>
              </td>
              <td data-label="増減" className="num">
                {e.delta > 0 ? `+${e.delta}` : e.delta}
              </td>
              <td data-label="残り" className="num">
                {e.balanceAfter}
              </td>
              <td data-label="予約">
                {e.bookingId ? (
                  <>
                    <Link to={`/app/bookings/${e.bookingId}`}>{e.bookingCode ?? '予約'}</Link>
                    {e.bookingStartsAt ? <div className="small muted">{fmtDateTime(e.bookingStartsAt, tz)}</div> : null}
                  </>
                ) : (
                  '—'
                )}
              </td>
              <td data-label="理由">{e.reason ?? '—'}</td>
              <td data-label="操作者">{e.actor ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PassDetailPage() {
  const { id = '' } = useParams();
  const can = useCan();
  const online = useOnline();
  const tz = useOrgTz();
  const q = useApi<PassDetail>(['passes', 'detail', id], `/api/v1/passes/${id}`);
  const [adjust, setAdjust] = useState(false);
  const [expiry, setExpiry] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorMessage error={q.error} />;
  const p = q.data!;
  const editable = can('pass.adjust') && p.status !== 'voided';
  return (
    <div className="stack-lg">
      <PageHeader
        title={p.name}
        sub={
          <>
            <Link to={`/app/customers/${p.customerId}`}>{p.customerName} 様</Link> の回数券
          </>
        }
        actions={<PassStatus p={p} />}
      />
      {!p.consistent ? (
        <Alert tone="danger">残数と台帳の合計が一致しません(残 {p.remaining} / 台帳 {p.ledgerSum})。管理者に連絡してください。</Alert>
      ) : null}
      <div className="grid-3">
        <div className="card stat">
          <span className="stat-label">残り回数</span>
          <span className="stat-value">
            {p.remaining}
            <span className="small muted"> / {p.initialUses}回</span>
          </span>
          <span className="stat-sub">台帳の合計と一致{p.consistent ? ' ✓' : ' ×'}</span>
        </div>
        <div className="card stat">
          <span className="stat-label">有効期間</span>
          <span className="stat-value" style={{ fontSize: '1.1rem' }}>
            {fmtDate(p.startsOn)}〜{p.expiresOn ? fmtDate(p.expiresOn) : '期限なし'}
          </span>
          <span className="stat-sub">{p.usable ? '現在利用できます' : '現在は利用できません'}</span>
        </div>
        <div className="card stat">
          <span className="stat-label">対象サービス</span>
          <span className="stat-value" style={{ fontSize: '1rem' }}>
            <ServiceNames ids={p.serviceIds} all={p.allServices} />
          </span>
          <span className="stat-sub">付与時点の内容</span>
        </div>
      </div>
      {p.memo ? (
        <Card title="メモ">
          <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{p.memo}</p>
        </Card>
      ) : null}
      {editable ? (
        <div className="row">
          <Button disabled={!online} onClick={() => setAdjust(true)}>
            回数を調整
          </Button>
          <Button disabled={!online} onClick={() => setExpiry(true)}>
            有効期限を変更
          </Button>
          <Button variant="danger" disabled={!online} onClick={() => setVoidOpen(true)}>
            無効化
          </Button>
        </div>
      ) : null}
      <Card title="台帳(すべての増減の履歴)">
        <LedgerTable rows={p.ledger} tz={tz} />
        <p className="small muted">台帳は追記のみで、削除・書き換えはできません。取消は「取消戻し」、誤りは「訂正」として記録されます。</p>
      </Card>
      {adjust ? <AdjustModal kind="pass" id={p.id} onClose={() => setAdjust(false)} /> : null}
      {expiry ? <ExpiryModal pass={p} onClose={() => setExpiry(false)} /> : null}
      {voidOpen ? <VoidPassModal pass={p} onClose={() => setVoidOpen(false)} /> : null}
    </div>
  );
}

function ServiceNames({ ids, all }: { ids: string[]; all: boolean }) {
  const services = useApi<{ items: { id: string; name: string }[] }>(['services'], '/api/v1/services');
  if (all) return <>すべてのサービス</>;
  const names = ids.map((i) => services.data?.items.find((s) => s.id === i)?.name ?? '(削除済み)');
  return <>{names.join('、') || 'なし'}</>;
}

function AdjustModal({ kind, id, onClose, date }: { kind: 'pass' | 'plan'; id: string; onClose: () => void; date?: string }) {
  const tz = useOrgTz();
  const [type, setType] = useState<'manual_add' | 'manual_subtract' | 'correction'>('manual_add');
  const [delta, setDelta] = useState('1');
  const [reason, setReason] = useState('');
  const [on, setOn] = useState(date ?? todayIn(tz));
  const key = useRef(newIdempotencyKey('adj'));
  const n = Number(delta);
  const valid = Number.isInteger(n) && n !== 0 && (type === 'correction' || n > 0) && reason.trim().length > 0;
  const m = useApiMutation(
    () =>
      api.post(`/api/v1/${kind === 'pass' ? 'passes' : 'plans'}/${id}/adjust`, {
        type,
        delta: n,
        reason,
        idempotencyKey: key.current,
        ...(kind === 'plan' ? { date: on } : {}),
      }),
    { invalidate: [[kind === 'pass' ? 'passes' : 'plans']], success: '調整しました', onSuccess: onClose },
  );
  return (
    <Modal
      title="回数を調整"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>やめる</Button>
          <Button variant="primary" disabled={!valid} busy={m.isPending} onClick={() => m.mutate(undefined)}>
            記録する
          </Button>
        </>
      }
    >
      <div className="stack">
        <SelectField
          label="種類"
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
          options={[
            { value: 'manual_add', label: '手動追加(回数を増やす)' },
            { value: 'manual_subtract', label: '手動減算(回数を減らす)' },
            { value: 'correction', label: '訂正(誤りの修正・±指定)' },
          ]}
        />
        <TextField
          label={type === 'correction' ? '増減(マイナスで減算)' : '回数'}
          type="number"
          inputMode="numeric"
          value={delta}
          onChange={(e) => setDelta(e.target.value)}
          error={fieldError(m.error, 'delta')}
        />
        {kind === 'plan' ? <TextField label="対象日(この日を含む期間に記録)" type="date" value={on} onChange={(e) => setOn(e.target.value)} /> : null}
        <TextAreaField label="理由" required value={reason} onChange={(e) => setReason(e.target.value)} error={fieldError(m.error, 'reason')} />
        <p className="small muted">台帳に追記され、監査ログにも残ります。残りがマイナスになる調整はできません。</p>
        <ErrorMessage error={m.error} />
      </div>
    </Modal>
  );
}

function ExpiryModal({ pass, onClose }: { pass: PassDetail; onClose: () => void }) {
  const [noLimit, setNoLimit] = useState(pass.expiresOn === null);
  const [date, setDate] = useState(pass.expiresOn ?? '');
  const [reactivate, setReactivate] = useState(pass.status === 'expired');
  const m = useApiMutation(() => api.post(`/api/v1/passes/${pass.id}/expiry`, { expiresOn: noLimit ? null : date, reactivate }), {
    invalidate: [['passes']],
    success: '有効期限を変更しました',
    onSuccess: onClose,
  });
  return (
    <Modal
      title="有効期限を変更"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>やめる</Button>
          <Button variant="primary" disabled={!noLimit && !date} busy={m.isPending} onClick={() => m.mutate(undefined)}>
            変更する
          </Button>
        </>
      }
    >
      <div className="stack">
        <Checkbox label="期限なしにする" checked={noLimit} onChange={(e) => setNoLimit(e.target.checked)} />
        {!noLimit ? <TextField label="新しい有効期限" type="date" value={date} onChange={(e) => setDate(e.target.value)} /> : null}
        {pass.status === 'expired' ? (
          <>
            <Checkbox label="期限切れの回数券を再び有効にする" checked={reactivate} onChange={(e) => setReactivate(e.target.checked)} />
            <Alert tone="info">失効時に0になった残り回数は自動では戻りません。戻す場合は「回数を調整 → 訂正」で理由を付けて記録してください。</Alert>
          </>
        ) : null}
        <ErrorMessage error={m.error} />
      </div>
    </Modal>
  );
}

function VoidPassModal({ pass, onClose }: { pass: PassDetail; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const m = useApiMutation(() => api.post(`/api/v1/passes/${pass.id}/void`, { reason }), { invalidate: [['passes']], success: '無効化しました', onSuccess: onClose });
  return (
    <Modal
      title="回数券を無効化"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>やめる</Button>
          <Button variant="danger" disabled={!reason.trim()} busy={m.isPending} onClick={() => m.mutate(undefined)}>
            無効化する
          </Button>
        </>
      }
    >
      <div className="stack">
        <Alert tone="warning">
          残り {pass.remaining}回 を訂正として0にし、以後は利用・調整できなくなります。台帳の履歴は残ります。返金等の精算はこのシステムでは行いません。
        </Alert>
        <TextAreaField label="理由" required value={reason} onChange={(e) => setReason(e.target.value)} />
        <ErrorMessage error={m.error} />
      </div>
    </Modal>
  );
}

// =============================== 利用プラン ===============================

export function PlansPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('active');
  const list = useApi<{ items: PlanDto[] }>(['plans', 'list', status], `/api/v1/plans${qs({ status, limit: 500 })}`);
  return (
    <>
      <PageHeader title="利用プラン" sub="月N回などの期間内の利用回数を管理します(請求・決済は行いません)" />
      <Card>
        <div className="grid-auto">
          <SelectField
            label="状態"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: 'active', label: '契約中' },
              { value: 'ended', label: '終了' },
              { value: 'canceled', label: '解約' },
              { value: 'all', label: 'すべて' },
            ]}
          />
        </div>
      </Card>
      <ErrorMessage error={list.error} />
      {list.isLoading ? <Spinner /> : null}
      {list.data?.items.length === 0 ? <EmptyState title="該当する利用プランはありません" /> : null}
      {list.data && list.data.items.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="table table-responsive">
            <thead>
              <tr>
                <th>顧客</th>
                <th>プラン</th>
                <th>当期</th>
                <th className="num">当期の残り</th>
                <th>契約期間</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => navigate(`/app/plans/${p.id}`)}>
                  <td data-label="顧客">
                    <Link to={`/app/plans/${p.id}`} onClick={(e) => e.stopPropagation()}>
                      {p.customerName}
                    </Link>
                  </td>
                  <td data-label="プラン">{p.name}</td>
                  <td data-label="当期">{p.currentPeriod ? `${fmtDate(p.currentPeriod.start)}〜${fmtDate(p.currentPeriod.end)}` : '—'}</td>
                  <td data-label="当期の残り" className="num">
                    {p.currentPeriod ? (
                      <>
                        <strong>{p.currentPeriod.remaining}</strong> / {p.currentPeriod.granted}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td data-label="契約期間">
                    {fmtDate(p.startsOn)}〜{p.endsOn ? fmtDate(p.endsOn) : ''}
                  </td>
                  <td data-label="状態">
                    <PlanStatus p={p} />
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

export function PlanDetailPage() {
  const { id = '' } = useParams();
  const can = useCan();
  const online = useOnline();
  const tz = useOrgTz();
  const q = useApi<PlanDetail>(['plans', 'detail', id], `/api/v1/plans/${id}`);
  const [adjust, setAdjust] = useState(false);
  const [end, setEnd] = useState(false);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorMessage error={q.error} />;
  const p = q.data!;
  const inconsistent = p.periods.some((x) => !x.consistent);
  return (
    <div className="stack-lg">
      <PageHeader
        title={p.name}
        sub={
          <>
            <Link to={`/app/customers/${p.customerId}`}>{p.customerName} 様</Link> の利用プラン
          </>
        }
        actions={<PlanStatus p={p} />}
      />
      {inconsistent ? <Alert tone="danger">期間の残りと台帳の合計が一致しない期間があります。管理者に連絡してください。</Alert> : null}
      <div className="grid-3">
        <div className="card stat">
          <span className="stat-label">当期の残り</span>
          <span className="stat-value">
            {p.currentPeriod ? p.currentPeriod.remaining : '—'}
            {p.currentPeriod ? <span className="small muted"> / {p.currentPeriod.granted}回</span> : null}
          </span>
          <span className="stat-sub">{p.currentPeriod ? `${fmtDate(p.currentPeriod.start)}〜${fmtDate(p.currentPeriod.end)} ・ 利用 ${p.currentPeriod.used}回` : '当期はありません'}</span>
        </div>
        <div className="card stat">
          <span className="stat-label">契約期間</span>
          <span className="stat-value" style={{ fontSize: '1.1rem' }}>
            {fmtDate(p.startsOn)}〜{p.endsOn ? fmtDate(p.endsOn) : '終了日なし'}
          </span>
          <span className="stat-sub">
            {p.alignment === 'calendar' ? '暦月' : '開始日起点'} ・ {p.periodMonths === 1 ? '毎月' : `${p.periodMonths}か月ごと`} {p.usesPerPeriod}回
          </span>
        </div>
        <div className="card stat">
          <span className="stat-label">繰越</span>
          <span className="stat-value" style={{ fontSize: '1.1rem' }}>
            {p.carryoverEnabled ? 'あり' : 'なし'}
          </span>
          <span className="stat-sub">{p.carryoverEnabled ? '期間終了時に次の期間へ繰越' : '期間終了時に残りは失効'}</span>
        </div>
      </div>
      {can('plan.adjust') ? (
        <div className="row">
          <Button disabled={!online} onClick={() => setAdjust(true)}>
            回数を調整
          </Button>
          {p.status === 'active' ? (
            <Button variant="danger" disabled={!online} onClick={() => setEnd(true)}>
              契約を終了・解約
            </Button>
          ) : null}
        </div>
      ) : null}
      <Card title="期間">
        {p.periods.length === 0 ? (
          <EmptyState title="まだ利用・調整がありません">期間は最初の利用時に作られます(満額付与)。</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table table-responsive">
              <thead>
                <tr>
                  <th>期間</th>
                  <th className="num">残り</th>
                  <th>状態</th>
                  <th>台帳との一致</th>
                </tr>
              </thead>
              <tbody>
                {p.periods.map((x) => (
                  <tr key={x.id}>
                    <td data-label="期間">
                      {fmtDate(x.start)}〜{fmtDate(x.end)}
                    </td>
                    <td data-label="残り" className="num">
                      {x.remaining}
                    </td>
                    <td data-label="状態">{x.status === 'open' ? '利用可能' : '締め済み'}</td>
                    <td data-label="台帳との一致">{x.consistent ? '✓ 一致' : '× 不一致'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="台帳">
        <LedgerTable rows={p.ledger} tz={tz} />
      </Card>
      {adjust ? <AdjustModal kind="plan" id={p.id} onClose={() => setAdjust(false)} /> : null}
      {end ? <EndPlanModal plan={p} onClose={() => setEnd(false)} /> : null}
    </div>
  );
}

function EndPlanModal({ plan, onClose }: { plan: PlanDetail; onClose: () => void }) {
  const tz = useOrgTz();
  const [status, setStatus] = useState<'ended' | 'canceled'>('ended');
  const [endsOn, setEndsOn] = useState(plan.endsOn && plan.endsOn < todayIn(tz) ? plan.endsOn : todayIn(tz));
  const [reason, setReason] = useState('');
  const m = useApiMutation(() => api.post(`/api/v1/plans/${plan.id}/end`, { endsOn, status, reason: reason || null }), {
    invalidate: [['plans']],
    success: (r: { status: string }) => (r.status === 'active' ? '終了日を設定しました(終了日まで利用できます)' : '契約を終了しました'),
    onSuccess: onClose,
  });
  return (
    <Modal
      title="契約を終了・解約"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>やめる</Button>
          <Button variant="danger" busy={m.isPending} onClick={() => m.mutate(undefined)}>
            確定する
          </Button>
        </>
      }
    >
      <div className="stack">
        <SelectField
          label="区分"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          options={[
            { value: 'ended', label: '終了(終了日まで利用可)' },
            { value: 'canceled', label: '解約(今すぐ利用停止)' },
          ]}
        />
        <TextField label="終了日" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} error={fieldError(m.error, 'endsOn')} />
        <TextAreaField label="理由(任意)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <p className="small muted">終了日を延ばすことはできません(延長は新しい契約として登録します)。終了日より後の期間の残りは失効します。</p>
        <ErrorMessage error={m.error} />
      </div>
    </Modal>
  );
}
