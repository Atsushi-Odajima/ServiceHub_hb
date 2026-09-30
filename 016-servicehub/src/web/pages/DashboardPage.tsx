import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ROLE_LABELS, type Role } from '../../shared/permissions';
import { qs } from '../api/client';
import { useApi, useCan, useCurrentLocation, useMe } from '../api/hooks';
import { Badge, Button, Card, EmptyState, ErrorMessage, PageHeader, SelectField, Spinner, Stat, StatusBadge } from '../components/ui';
import { fmtDate, fmtDateTime, fmtTime, formatDateJa } from '../lib/format';
import type { BookingDto } from './bookings/BookingPages';
import { BookingFormModal } from './bookings/BookingForm';
import type { EntitlementHint, PassDto } from './entitlements/types';

interface Today {
  date: string;
  timezone: string;
  items: (BookingDto & { entitlements: EntitlementHint[] })[];
  next: BookingDto | null;
}

interface Dashboard {
  role: Role;
  locations?: {
    id: string;
    name: string;
    date: string;
    counts: Partial<Record<string, number>>;
    staffOnShiftToday: number;
    staffOnShiftNow: number;
    waitlistActive: number | null;
    waitlistOpenMatches: number | null;
  }[];
  pendingReviews?: number;
  expiringPasses?: number;
  planUsage?: { plans: number; remaining: number; endingSoonWithRemaining: number };
  failedNotifications?: number;
  mine?: { today: number; upcoming7: number; recordsMissing: { bookingId: string; customerName: string; serviceName: string; performedAt: string }[] };
}

const n = (v: number | undefined) => v ?? 0;

export function DashboardPage() {
  const me = useMe();
  const can = useCan();
  const navigate = useNavigate();
  const role = me.data?.membership?.role;
  const ownOnly = !can('booking.read.all');
  const [locId, setLocId, locations] = useCurrentLocation();
  const [walkin, setWalkin] = useState(false);
  const canBookings = can('booking.read.all') || can('booking.read.own');
  const dash = useApi<Dashboard>(['dashboard'], '/api/v1/dashboard', { refetchInterval: 60_000 });
  const today = useApi<Today>(
    ['today', ownOnly ? 'own' : locId],
    !canBookings ? null : ownOnly ? '/api/v1/today' : locId ? `/api/v1/today${qs({ locationId: locId })}` : null,
    { refetchInterval: 60_000 },
  );
  const canReview = can('pass.adjust') || can('plan.adjust');
  const reviews = useApi<{ items: BookingDto[] }>(['dashboard', 'reviews'], canReview ? `/api/v1/bookings${qs({ consumptionReview: 'pending', limit: 50, order: 'desc' })}` : null);
  const expiring = useApi<{ items: PassDto[] }>(['dashboard', 'expiring'], can('pass.read') && !ownOnly ? `/api/v1/passes${qs({ expiringWithinDays: 14, limit: 100 })}` : null);
  const items = today.data?.items ?? [];
  const tz = today.data?.timezone ?? me.data?.organization?.timezone ?? 'Asia/Tokyo';
  const d = dash.data;
  const openLocation = (id: string, to: string) => {
    setLocId(id);
    navigate(to);
  };
  return (
    <div className="stack-lg">
      <PageHeader
        title={today.data ? `今日 ${formatDateJa(today.data.date)}` : 'ダッシュボード'}
        sub={`${me.data?.user.name ?? ''} ・ ${role ? ROLE_LABELS[role] : ''}${ownOnly ? ' ・ 自分の予約(全拠点)' : ''}`}
        actions={
          <>
            {can('reception.operate') && (can('booking.create.all') || can('booking.create.own')) ? <Button onClick={() => setWalkin(true)}>＋ 当日の予約</Button> : null}
            {can('reception.operate') ? (
              <Link className="btn btn-primary btn-lg" to="/app/reception">
                ◉ 受付モードを開く
              </Link>
            ) : null}
          </>
        }
      />
      <ErrorMessage error={dash.error} retry={() => void dash.refetch()} />

      {/* 自分の予定(Staff) */}
      {d?.mine ? (
        <div className="grid-auto">
          <Stat label="今日の担当" value={d.mine.today} sub="キャンセルを除く" />
          <Stat label="今後7日の予約" value={d.mine.upcoming7} />
          <Stat label="記録が未入力" value={d.mine.recordsMissing.length} sub="直近14日の完了" />
        </div>
      ) : null}

      {/* 拠点の状況(Owner / Manager / Reception) */}
      {d?.locations && d.locations.length > 0 ? (
        <section className="stack" aria-labelledby="loc-status">
          <h2 id="loc-status" style={{ margin: 0, fontSize: '1.1rem' }}>
            拠点の状況(今日)
          </h2>
          <div className="grid-2">
            {d.locations.map((l) => {
              const c = l.counts;
              const active = n(c.confirmed) + n(c.arrived) + n(c.in_service) + n(c.completed);
              return (
                <Card
                  key={l.id}
                  title={l.name}
                  actions={
                    <>
                      <Button size="sm" onClick={() => openLocation(l.id, '/app/schedule')}>
                        予定表
                      </Button>
                      {can('reception.operate') ? (
                        <Button size="sm" onClick={() => openLocation(l.id, '/app/reception')}>
                          受付
                        </Button>
                      ) : null}
                    </>
                  }
                >
                  <dl className="kv">
                    <dt>予約</dt>
                    <dd>
                      <strong>{active}件</strong>(来店待ち {n(c.confirmed)} ・ 来店/対応中 {n(c.arrived) + n(c.in_service)} ・ 完了 {n(c.completed)})
                    </dd>
                    <dt>キャンセル・欠席</dt>
                    <dd>
                      キャンセル {n(c.canceled_customer) + n(c.canceled_business)} ・ 無断欠席 {n(c.no_show)}
                    </dd>
                    <dt>出勤スタッフ</dt>
                    <dd>
                      今日 {l.staffOnShiftToday}名 ・ 現在 {l.staffOnShiftNow}名
                    </dd>
                    {l.waitlistActive !== null ? (
                      <>
                        <dt>待機</dt>
                        <dd>
                          <Link to="/app/waitlist" onClick={() => setLocId(l.id)}>
                            {l.waitlistActive}件
                          </Link>
                          {l.waitlistOpenMatches ? (
                            <>
                              {' '}
                              <Badge tone="warning" icon="!">
                                空きの候補 {l.waitlistOpenMatches}件
                              </Badge>
                            </>
                          ) : null}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </Card>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* 要確認 */}
      {d && (d.pendingReviews || d.expiringPasses || d.failedNotifications || d.planUsage?.plans) ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }} aria-label="要確認">
          {d.pendingReviews ? (
            <Badge tone="warning" icon="?">
              消化の確認待ち {d.pendingReviews}件
            </Badge>
          ) : null}
          {d.expiringPasses ? (
            <Link to="/app/passes">
              <Badge tone="warning" icon="▤">
                14日以内に期限の回数券 {d.expiringPasses}件
              </Badge>
            </Link>
          ) : null}
          {d.planUsage?.plans ? (
            <Link to="/app/plans">
              <Badge tone={d.planUsage.endingSoonWithRemaining ? 'warning' : 'neutral'} icon="↻">
                利用プランの今期の残り 合計{d.planUsage.remaining}回({d.planUsage.plans}件)
                {d.planUsage.endingSoonWithRemaining ? ` ・ 7日以内に期間終了で残りあり ${d.planUsage.endingSoonWithRemaining}件` : ''}
              </Badge>
            </Link>
          ) : null}
          {d.failedNotifications ? (
            <Link to="/app/notifications">
              <Badge tone="danger" icon="!">
                送信に失敗した通知 {d.failedNotifications}件(7日間)
              </Badge>
            </Link>
          ) : null}
        </div>
      ) : null}

      {!ownOnly && (locations?.length ?? 0) > 1 && canBookings ? (
        <div style={{ maxWidth: 320 }}>
          <SelectField label="今日の予約を表示する拠点" value={locId ?? ''} onChange={(e) => setLocId(e.target.value)} options={(locations ?? []).map((l) => ({ value: l.id, label: l.name }))} />
        </div>
      ) : null}
      {canBookings ? (
        <>
          <ErrorMessage error={today.error} retry={() => void today.refetch()} />
          {today.isLoading ? <Spinner /> : null}
          {today.data?.next ? (
            <Card title="次の予約">
              <Link to={`/app/bookings/${today.data.next.id}`} className="list-item" style={{ padding: 0 }}>
                <span className="mono" style={{ fontSize: '1.4rem', fontWeight: 800, minWidth: 80 }}>
                  {fmtTime(today.data.next.startsAt, today.data.next.timezone)}
                </span>
                <span className="grow">
                  <strong style={{ fontSize: '1.15rem' }}>{today.data.next.customerName} 様</strong>
                  <br />
                  <span className="small muted">
                    {fmtDateTime(today.data.next.startsAt, today.data.next.timezone)} ・ {today.data.next.serviceName} ・ {today.data.next.staffName ?? '担当なし'} ・{' '}
                    {today.data.next.locationName}
                  </span>
                </span>
                <StatusBadge status={today.data.next.status} />
              </Link>
            </Card>
          ) : null}
          {today.data ? (
            <Card
              title={ownOnly ? '今日の担当' : '今日の予約'}
              actions={
                <Link className="btn btn-sm" to="/app/schedule">
                  予定表を開く
                </Link>
              }
            >
              {items.length === 0 ? (
                <EmptyState title="今日の予約はありません" />
              ) : (
                <ul className="list">
                  {items.map((b) => (
                    <li key={b.id}>
                      <Link className="list-item" to={`/app/bookings/${b.id}`}>
                        <span className="mono" style={{ minWidth: 56, fontWeight: 700 }}>
                          {fmtTime(b.startsAt, tz)}
                        </span>
                        <span className="grow">
                          <strong>{b.customerName}</strong>
                          {b.partySize > 1 ? `(${b.partySize}名)` : ''}
                          <br />
                          <span className="small muted">
                            {b.serviceName} ・ {b.staffName ?? '担当なし'}
                            {ownOnly ? ` ・ ${b.locationName}` : ''}
                          </span>
                          {b.entitlements.length > 0 && !b.consumptionKind ? (
                            <span className="row" style={{ flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                              {b.entitlements.map((h) => (
                                <Badge key={h.id} tone={h.remaining <= 1 || h.expiringSoon ? 'warning' : 'info'}>
                                  {h.name} 残{h.remaining}
                                </Badge>
                              ))}
                            </span>
                          ) : null}
                        </span>
                        <StatusBadge status={b.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}
        </>
      ) : null}

      {d?.mine && d.mine.recordsMissing.length > 0 ? (
        <Card title="記録が未入力の完了予約">
          <ul className="list">
            {d.mine.recordsMissing.map((r) => (
              <li key={r.bookingId}>
                <Link className="list-item" to={`/app/bookings/${r.bookingId}/complete`}>
                  <span className="grow">
                    <strong>{r.customerName}</strong>
                    <br />
                    <span className="small muted">
                      {fmtDateTime(r.performedAt, tz)} ・ {r.serviceName}
                    </span>
                  </span>
                  <span aria-hidden="true">記入 ›</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {canReview || (can('pass.read') && !ownOnly) ? (
        <div className="grid-2">
          {canReview ? (
            <Card title="消化の確認待ち" actions={<Badge tone={reviews.data?.items.length ? 'warning' : 'neutral'}>{reviews.data?.items.length ?? '—'}件</Badge>}>
              <ErrorMessage error={reviews.error} />
              {reviews.data?.items.length === 0 ? <p className="muted small">確認待ちはありません。</p> : null}
              <ul className="list">
                {(reviews.data?.items ?? []).slice(0, 5).map((b) => (
                  <li key={b.id}>
                    <Link className="list-item" to={`/app/bookings/${b.id}/consume`}>
                      <span className="grow">
                        <strong>{b.customerName}</strong>
                        <br />
                        <span className="small muted">
                          {fmtDateTime(b.startsAt, b.timezone)} ・ {b.serviceName}
                        </span>
                      </span>
                      <StatusBadge status={b.status} />
                    </Link>
                  </li>
                ))}
              </ul>
              <p className="small muted">締切後のお客様都合キャンセル・無断欠席は、自動では消化しません。</p>
            </Card>
          ) : null}
          {can('pass.read') && !ownOnly ? (
            <Card title="14日以内に期限の回数券" actions={<Badge tone={expiring.data?.items.length ? 'warning' : 'neutral'}>{expiring.data?.items.length ?? '—'}件</Badge>}>
              <ErrorMessage error={expiring.error} />
              {expiring.data?.items.length === 0 ? <p className="muted small">該当はありません。</p> : null}
              <ul className="list">
                {(expiring.data?.items ?? []).slice(0, 5).map((p) => (
                  <li key={p.id}>
                    <Link className="list-item" to={`/app/passes/${p.id}`}>
                      <span className="grow">
                        <strong>{p.customerName}</strong>
                        <br />
                        <span className="small muted">
                          {p.name} ・ 期限 {p.expiresOn ? fmtDate(p.expiresOn) : ''}
                        </span>
                      </span>
                      <span className="num">残{p.remaining}</span>
                    </Link>
                  </li>
                ))}
              </ul>
              {(expiring.data?.items.length ?? 0) > 5 ? (
                <Link to="/app/passes" className="small">
                  すべて見る
                </Link>
              ) : null}
            </Card>
          ) : null}
        </div>
      ) : null}
      {!canBookings ? (
        <Card title="ようこそ">
          <p>左のメニュー(スマホは下の「メニュー」)から操作を選んでください。</p>
        </Card>
      ) : null}
      {walkin ? <BookingFormModal initial={{ locationId: locId ?? undefined, title: '当日の予約を追加' }} onClose={() => setWalkin(false)} onCreated={(b) => navigate(`/app/bookings/${b.id}`)} /> : null}
    </div>
  );
}
