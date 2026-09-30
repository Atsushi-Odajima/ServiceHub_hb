import { Link } from 'react-router';
import { ROLE_LABELS } from '../../shared/permissions';
import { qs } from '../api/client';
import { useApi, useCan, useCurrentLocation, useMe } from '../api/hooks';
import { Badge, Card, EmptyState, ErrorMessage, PageHeader, SelectField, Spinner, Stat, StatusBadge } from '../components/ui';
import { fmtDate, fmtDateTime, fmtTime, formatDateJa } from '../lib/format';
import type { BookingDto } from './bookings/BookingPages';
import type { EntitlementHint, PassDto } from './entitlements/types';

interface Today {
  date: string;
  timezone: string;
  items: (BookingDto & { entitlements: EntitlementHint[] })[];
  next: BookingDto | null;
}

export function DashboardPage() {
  const me = useMe();
  const can = useCan();
  const role = me.data?.membership?.role;
  const ownOnly = !can('booking.read.all');
  const [locId, setLocId, locations] = useCurrentLocation();
  const canBookings = can('booking.read.all') || can('booking.read.own');
  const today = useApi<Today>(
    ['today', ownOnly ? 'own' : locId],
    !canBookings ? null : ownOnly ? '/api/v1/today' : locId ? `/api/v1/today${qs({ locationId: locId })}` : null,
    { refetchInterval: 60_000 },
  );
  const canReview = can('pass.adjust') || can('plan.adjust');
  const reviews = useApi<{ items: BookingDto[] }>(['dashboard', 'reviews'], canReview ? `/api/v1/bookings${qs({ consumptionReview: 'pending', limit: 50, order: 'desc' })}` : null);
  const expiring = useApi<{ items: PassDto[] }>(['dashboard', 'expiring'], can('pass.read') && !ownOnly ? `/api/v1/passes${qs({ expiringWithinDays: 14, limit: 100 })}` : null);
  const items = today.data?.items ?? [];
  const count = (f: (b: BookingDto) => boolean) => items.filter(f).length;
  const tz = today.data?.timezone ?? me.data?.organization?.timezone ?? 'Asia/Tokyo';
  return (
    <div className="stack-lg">
      <PageHeader
        title={today.data ? `今日 ${formatDateJa(today.data.date)}` : 'ダッシュボード'}
        sub={`${me.data?.user.name ?? ''} ・ ${role ? ROLE_LABELS[role] : ''}${ownOnly ? ' ・ 自分の予約(全拠点)' : ''}`}
        actions={
          can('reception.operate') ? (
            <Link className="btn btn-primary btn-lg" to="/app/reception">
              ◉ 受付モードを開く
            </Link>
          ) : null
        }
      />
      {!ownOnly && (locations?.length ?? 0) > 1 ? (
        <div style={{ maxWidth: 320 }}>
          <SelectField label="拠点" value={locId ?? ''} onChange={(e) => setLocId(e.target.value)} options={(locations ?? []).map((l) => ({ value: l.id, label: l.name }))} />
        </div>
      ) : null}
      {canBookings ? (
        <>
          <ErrorMessage error={today.error} retry={() => void today.refetch()} />
          {today.isLoading ? <Spinner /> : null}
          {today.data ? (
            <div className="grid-auto">
              <Stat label="今日の予約" value={count((b) => b.status !== 'canceled_customer' && b.status !== 'canceled_business')} sub="キャンセルを除く" />
              <Stat label="来店待ち" value={count((b) => b.status === 'confirmed')} />
              <Stat label="来店・対応中" value={count((b) => b.status === 'arrived' || b.status === 'in_service')} />
              <Stat label="完了" value={count((b) => b.status === 'completed')} />
            </div>
          ) : null}
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
      ) : (
        <Card title="ようこそ">
          <p>左のメニュー(スマホは下の「メニュー」)から操作を選んでください。</p>
        </Card>
      )}
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
    </div>
  );
}
