import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { addDays, todayIn } from '../../../shared/time';
import { api, newIdempotencyKey } from '../../api/client';
import { useApi, useApiMutation, useCan, useMe, useOnline } from '../../api/hooks';
import { Alert, Badge, Button, Card, EmptyState, ErrorMessage, Modal, SelectField, Spinner, TextAreaField, TextField } from '../../components/ui';
import { fmtDate } from '../../lib/format';
import { type Candidate, PASS_STATUS_LABELS, type PassDto, type PassProduct, PLAN_STATUS_LABELS, type PlanDto, type PlanProduct } from './types';

/** 消化する回数券/プランを明示的に選ぶ(自動選択しない) */
export function CandidatePicker({
  candidates,
  value,
  onChange,
  allowNone = true,
  noneLabel = '今回は消化しない',
  name = 'consume',
}: {
  candidates: Candidate[];
  value: string | null;
  onChange: (v: string | null) => void;
  allowNone?: boolean;
  noneLabel?: string;
  name?: string;
}) {
  return (
    <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="sr-only">消化する回数券・プラン</legend>
      {candidates.map((c) => (
        <label key={`${c.kind}:${c.id}`} className="choice-card">
          <input type="radio" name={name} checked={value === `${c.kind}:${c.id}`} onChange={() => onChange(`${c.kind}:${c.id}`)} />
          <span className="grow">
            <strong>{c.name}</strong> <Badge tone={c.kind === 'pass' ? 'info' : 'accent'}>{c.kind === 'pass' ? '回数券' : '利用プラン'}</Badge>
            <br />
            <span className="small">
              残り {c.remaining}回 → 消化後 {c.remaining - 1}回
              {c.kind === 'pass' ? ` ・ 有効期限 ${c.expiresOn ? fmtDate(c.expiresOn) : 'なし'}` : ` ・ 期間 ${fmtDate(c.periodStart)}〜${fmtDate(c.periodEnd)}`}
            </span>
          </span>
        </label>
      ))}
      {allowNone ? (
        <label className="choice-card">
          <input type="radio" name={name} checked={value === 'none'} onChange={() => onChange('none')} />
          <span className="grow">{noneLabel}</span>
        </label>
      ) : null}
    </fieldset>
  );
}

export function parseChoice(v: string | null): { kind: 'pass' | 'plan'; entitlementId: string } | null {
  if (!v || v === 'none') return null;
  const [kind, id] = v.split(':');
  return { kind: kind as 'pass' | 'plan', entitlementId: id };
}

/** 顧客詳細の「回数券・利用プラン」タブ */
export function CustomerEntitlements({ customerId, customerActive }: { customerId: string; customerActive: boolean }) {
  const can = useCan();
  const online = useOnline();
  const passes = useApi<{ items: PassDto[] }>(['passes', 'customer', customerId], can('pass.read') ? `/api/v1/customers/${customerId}/passes` : null);
  const plans = useApi<{ items: PlanDto[] }>(['plans', 'customer', customerId], can('plan.read') ? `/api/v1/customers/${customerId}/plans` : null);
  const [grant, setGrant] = useState(false);
  const [assign, setAssign] = useState(false);
  return (
    <div className="stack-lg">
      {can('pass.read') ? (
        <Card
          title="回数券"
          actions={
            can('pass.grant') && customerActive ? (
              <Button size="sm" variant="primary" disabled={!online} onClick={() => setGrant(true)}>
                回数券を付与
              </Button>
            ) : null
          }
        >
          <ErrorMessage error={passes.error} />
          {passes.isLoading ? <Spinner /> : null}
          {passes.data?.items.length === 0 ? <EmptyState title="回数券はありません" /> : null}
          {passes.data && passes.data.items.length > 0 ? (
            <ul className="list">
              {passes.data.items.map((p) => (
                <li key={p.id}>
                  <Link className="list-item" to={`/app/passes/${p.id}`}>
                    <span className="grow">
                      <strong>{p.name}</strong> <PassStatus p={p} />
                      <br />
                      <span className="small muted">
                        {fmtDate(p.startsOn)}〜{p.expiresOn ? fmtDate(p.expiresOn) : '期限なし'}
                      </span>
                    </span>
                    <span className="num" style={{ fontSize: '1.3rem', fontWeight: 800 }}>
                      残{p.remaining}
                      <span className="small muted">/{p.initialUses}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}
      {can('plan.read') ? (
        <Card
          title="利用プラン(期間内の利用回数)"
          actions={
            can('plan.assign') && customerActive ? (
              <Button size="sm" variant="primary" disabled={!online} onClick={() => setAssign(true)}>
                プランを登録
              </Button>
            ) : null
          }
        >
          <ErrorMessage error={plans.error} />
          {plans.isLoading ? <Spinner /> : null}
          {plans.data?.items.length === 0 ? <EmptyState title="利用プランはありません" /> : null}
          {plans.data && plans.data.items.length > 0 ? (
            <ul className="list">
              {plans.data.items.map((p) => (
                <li key={p.id}>
                  <Link className="list-item" to={`/app/plans/${p.id}`}>
                    <span className="grow">
                      <strong>{p.name}</strong> <PlanStatus p={p} />
                      <br />
                      <span className="small muted">
                        {fmtDate(p.startsOn)}〜{p.endsOn ? fmtDate(p.endsOn) : '終了日なし'}
                        {p.currentPeriod ? ` ・ 当期 ${fmtDate(p.currentPeriod.start)}〜${fmtDate(p.currentPeriod.end)}` : ''}
                      </span>
                    </span>
                    {p.currentPeriod ? (
                      <span className="num" style={{ fontSize: '1.3rem', fontWeight: 800 }}>
                        残{p.currentPeriod.remaining}
                        <span className="small muted">/{p.currentPeriod.granted}</span>
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="small muted">利用プランは期間ごとの利用回数を管理します。料金の請求・決済は行いません。</p>
        </Card>
      ) : null}
      {grant ? <GrantPassModal customerId={customerId} onClose={() => setGrant(false)} /> : null}
      {assign ? <AssignPlanModal customerId={customerId} onClose={() => setAssign(false)} /> : null}
    </div>
  );
}

export function PassStatus({ p }: { p: Pick<PassDto, 'status' | 'expiredByDate' | 'remaining'> }) {
  if (p.status === 'active' && p.expiredByDate) return <Badge tone="muted" icon="○">期限切れ</Badge>;
  if (p.status === 'active' && p.remaining === 0) return <Badge tone="muted" icon="○">使い切り</Badge>;
  const s = PASS_STATUS_LABELS[p.status];
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

export function PlanStatus({ p }: { p: Pick<PlanDto, 'status'> }) {
  const s = PLAN_STATUS_LABELS[p.status];
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

function GrantPassModal({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const me = useMe();
  const tz = me.data?.organization?.timezone ?? 'Asia/Tokyo';
  const products = useApi<{ items: PassProduct[] }>(['pass-products'], '/api/v1/pass-products');
  const active = (products.data?.items ?? []).filter((p) => p.status === 'active');
  const [productId, setProductId] = useState('');
  const [startsOn, setStartsOn] = useState(todayIn(tz));
  const [memo, setMemo] = useState('');
  const key = useRef(newIdempotencyKey('grant'));
  const product = active.find((p) => p.id === productId);
  const m = useApiMutation(
    () => api.post(`/api/v1/customers/${customerId}/passes`, { passProductId: productId, startsOn, memo: memo || null, idempotencyKey: key.current }),
    { invalidate: [['passes'], ['customer', customerId]], success: '回数券を付与しました', onSuccess: onClose },
  );
  return (
    <Modal
      title="回数券を付与"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>やめる</Button>
          <Button variant="primary" disabled={!productId} busy={m.isPending} onClick={() => m.mutate(undefined)}>
            付与する
          </Button>
        </>
      }
    >
      <div className="stack">
        {products.isLoading ? <Spinner /> : null}
        {!products.isLoading && active.length === 0 ? <Alert tone="info">回数券の種類がありません。設定 → 回数券の種類 で作成してください。</Alert> : null}
        <SelectField
          label="回数券の種類"
          required
          value={productId}
          onChange={(e) => setProductId(e.target.value)}
          placeholder="選択してください"
          options={active.map((p) => ({ value: p.id, label: `${p.name}(${p.totalUses}回${p.validityDays ? `・${p.validityDays}日間` : '・期限なし'})` }))}
        />
        <TextField label="利用開始日" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} required />
        {product ? (
          <Alert tone="info">
            {product.totalUses}回分を付与します。有効期限: {product.validityDays ? fmtDate(addDays(startsOn, product.validityDays - 1)) : 'なし'}
            。付与時点の内容(回数・対象サービス)で保存され、後から種類を変更しても影響しません。
          </Alert>
        ) : null}
        <TextAreaField label="メモ(任意)" value={memo} onChange={(e) => setMemo(e.target.value)} hint="支払い方法などの記録用(決済は行いません)" />
        <ErrorMessage error={m.error} />
      </div>
    </Modal>
  );
}

function AssignPlanModal({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const me = useMe();
  const tz = me.data?.organization?.timezone ?? 'Asia/Tokyo';
  const products = useApi<{ items: PlanProduct[] }>(['plan-products'], '/api/v1/plan-products');
  const active = (products.data?.items ?? []).filter((p) => p.status === 'active');
  const [productId, setProductId] = useState('');
  const [startsOn, setStartsOn] = useState(todayIn(tz));
  const [endsOn, setEndsOn] = useState('');
  const [memo, setMemo] = useState('');
  const key = useRef(newIdempotencyKey('plan'));
  const product = active.find((p) => p.id === productId);
  const m = useApiMutation(
    () => api.post(`/api/v1/customers/${customerId}/plans`, { planProductId: productId, startsOn, endsOn: endsOn || null, memo: memo || null, idempotencyKey: key.current }),
    { invalidate: [['plans'], ['customer', customerId]], success: '利用プランを登録しました', onSuccess: onClose },
  );
  return (
    <Modal
      title="利用プランを登録"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>やめる</Button>
          <Button variant="primary" disabled={!productId} busy={m.isPending} onClick={() => m.mutate(undefined)}>
            登録する
          </Button>
        </>
      }
    >
      <div className="stack">
        {!products.isLoading && active.length === 0 ? <Alert tone="info">利用プランの種類がありません。設定 → 利用プランの種類 で作成してください。</Alert> : null}
        <SelectField
          label="プランの種類"
          required
          value={productId}
          onChange={(e) => setProductId(e.target.value)}
          placeholder="選択してください"
          options={active.map((p) => ({ value: p.id, label: `${p.name}(${p.periodMonths === 1 ? '月' : `${p.periodMonths}か月`}${p.usesPerPeriod}回)` }))}
        />
        <div className="grid-2">
          <TextField label="開始日" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} required />
          <TextField label="終了日(任意)" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} hint="空欄は終了日なし" />
        </div>
        {product ? (
          <Alert tone="info">
            {product.alignment === 'calendar' ? '暦月' : '開始日起点'}で{product.periodMonths === 1 ? '毎月' : `${product.periodMonths}か月ごとに`}
            {product.usesPerPeriod}回。繰越: {product.carryoverEnabled ? `あり(上限${product.carryoverMax ?? '無制限'}回)` : 'なし(期間終了で失効)'}
            {product.alignment === 'calendar' ? '。初回は開始日から月末までで満額です。' : ''}
          </Alert>
        ) : null}
        <TextAreaField label="メモ(任意)" value={memo} onChange={(e) => setMemo(e.target.value)} />
        <p className="small muted">料金の請求・自動引き落としは行いません。</p>
        <ErrorMessage error={m.error} />
      </div>
    </Modal>
  );
}
