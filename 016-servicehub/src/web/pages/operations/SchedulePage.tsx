import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { BOOKING_STATUS_LABELS, SHIFT_TYPE_LABELS, type ShiftType } from '../../../shared/constants';
import { addDays, localToUtcLenient, todayIn } from '../../../shared/time';
import { qs } from '../../api/client';
import { useApi, useCan, useCurrentLocation, useMe } from '../../api/hooks';
import { Button, Card, Checkbox, EmptyState, ErrorMessage, Modal, PageHeader, SelectField, Spinner, StatusBadge, Tabs, TextField } from '../../components/ui';
import { fmtRelativeDay, fmtTime, formatDateJa } from '../../lib/format';
import type { BookingDto } from '../bookings/BookingPages';
import { BookingFormModal } from '../bookings/BookingForm';
import type { StaffDto } from '../settings/CatalogPages';

interface ShiftDto {
  id: string;
  staffId: string;
  locationId: string | null;
  type: ShiftType;
  startsAt: string;
  endsAt: string;
}

const PX_PER_MIN = 1.1;
const ACTIVE = new Set(['confirmed', 'arrived', 'in_service', 'completed']);

interface Block {
  key: string;
  start: number;
  end: number;
  bookings: BookingDto[];
  other: boolean;
}

/** 開始が同じ同一サービス(グループレッスン等)はまとめ、重なりはレーンに分ける */
function layout(blocks: Block[]): (Block & { lane: number; lanes: number })[] {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: (Block & { lane: number; lanes: number })[] = [];
  let cluster: (Block & { lane: number; lanes: number })[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1));
    for (const c of cluster) c.lanes = lanes;
    out.push(...cluster);
    cluster = [];
  };
  for (const b of sorted) {
    if (b.start >= clusterEnd && cluster.length) flush();
    const used = new Set(cluster.filter((c) => c.end > b.start).map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    cluster.push({ ...b, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, b.end);
  }
  if (cluster.length) flush();
  return out;
}

export function SchedulePage() {
  const me = useMe();
  const can = useCan();
  const navigate = useNavigate();
  const ownOnly = !can('booking.read.all');
  const [locId, setLocId, locations] = useCurrentLocation();
  const tz = locations?.find((l) => l.id === locId)?.timezone ?? me.data?.organization?.timezone ?? 'Asia/Tokyo';
  const [date, setDate] = useState(() => todayIn(tz));
  const [view, setView] = useState<'columns' | 'list'>(() => (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 720px)').matches ? 'list' : 'columns'));
  const [showCanceled, setShowCanceled] = useState(false);
  const [create, setCreate] = useState(false);
  const [group, setGroup] = useState<BookingDto[] | null>(null);
  const from = localToUtcLenient(date, '00:00', tz);
  const to = localToUtcLenient(addDays(date, 1), '00:00', tz);
  // 全担当拠点の予約を取得(他拠点での予約もスタッフ列に表示するため)
  const bookings = useApi<{ items: BookingDto[] }>(['schedule', 'bookings', date, tz], `/api/v1/bookings${qs({ from: from.toISOString(), to: to.toISOString(), limit: 500 })}`, {
    refetchInterval: 60_000,
  });
  const staff = useApi<{ items: StaffDto[] }>(['staff-list'], '/api/v1/staff');
  const canShifts = can('shift.read.all') || can('shift.read.own') || can('shift.manage');
  const shifts = useApi<{ items: ShiftDto[] }>(['schedule', 'shifts', date, tz], canShifts ? `/api/v1/shifts${qs({ from: from.toISOString(), to: to.toISOString() })}` : null);
  const locName = (id: string | null) => locations?.find((l) => l.id === id)?.name ?? '他拠点';

  const items = (bookings.data?.items ?? []).filter((b) => showCanceled || ACTIVE.has(b.status));
  const here = items.filter((b) => ownOnly || b.locationId === locId);

  const columns = useMemo(() => {
    const all = staff.data?.items ?? [];
    if (ownOnly) {
      const mine = all.find((s) => s.id === me.data?.membership?.staffId);
      return mine ? [{ id: mine.id, name: mine.displayName }] : [];
    }
    const cols: { id: string | null; name: string }[] = all.filter((s) => s.status === 'active' && s.locationIds.includes(locId ?? '')).map((s) => ({ id: s.id, name: s.displayName }));
    if (here.some((b) => b.staffId === null)) cols.push({ id: null, name: '担当なし(部屋・設備のみ)' });
    // 列にいない担当者の予約(所属外の強制予約など)
    for (const b of here) if (b.staffId && !cols.some((c) => c.id === b.staffId)) cols.push({ id: b.staffId, name: b.staffName ?? '担当者' });
    return cols;
  }, [staff.data, ownOnly, locId, here, me.data]);

  // 表示範囲(既定 9:00〜21:00。予約・シフトがあれば広げる)
  const minuteOf = (iso: string) => (new Date(iso).getTime() - from.getTime()) / 60000;
  let startMin = 9 * 60;
  let endMin = 21 * 60;
  for (const b of items) {
    startMin = Math.min(startMin, Math.floor(minuteOf(b.startsAt) / 60) * 60);
    endMin = Math.max(endMin, Math.ceil(minuteOf(b.endsAt) / 60) * 60);
  }
  for (const s of shifts.data?.items ?? []) {
    startMin = Math.min(startMin, Math.max(0, Math.floor(minuteOf(s.startsAt) / 60) * 60));
    endMin = Math.min(24 * 60, Math.max(endMin, Math.ceil(minuteOf(s.endsAt) / 60) * 60));
  }
  startMin = Math.max(0, startMin);
  endMin = Math.min(24 * 60 + 60, endMin);
  const height = (endMin - startMin) * PX_PER_MIN;
  const y = (min: number) => (Math.min(Math.max(min, startMin), endMin) - startMin) * PX_PER_MIN;
  const hours: number[] = [];
  for (let m = startMin; m <= endMin; m += 60) hours.push(m);

  const loading = bookings.isLoading || staff.isLoading;
  return (
    <>
      <PageHeader
        title="予定表"
        sub={ownOnly ? '自分の予約(すべての拠点)' : undefined}
        actions={
          can('booking.create.all') || can('booking.create.own') ? (
            <Button variant="primary" onClick={() => setCreate(true)}>
              予約を作成
            </Button>
          ) : null
        }
      />
      <Card>
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Button onClick={() => setDate(addDays(date, -1))} aria-label="前の日">
              ‹ 前日
            </Button>
            <Button onClick={() => setDate(todayIn(tz))}>今日</Button>
            <Button onClick={() => setDate(addDays(date, 1))} aria-label="次の日">
              翌日 ›
            </Button>
            <strong style={{ fontSize: '1.1rem' }}>
              {formatDateJa(date)}({fmtRelativeDay(date, tz)})
            </strong>
          </div>
          <Tabs
            label="表示形式"
            value={view}
            onChange={setView}
            tabs={[
              { value: 'columns', label: '担当者別' },
              { value: 'list', label: 'リスト' },
            ]}
          />
        </div>
        <div className="grid-auto" style={{ marginTop: 8 }}>
          {!ownOnly && (locations?.length ?? 0) > 1 ? (
            <SelectField label="拠点" value={locId ?? ''} onChange={(e) => setLocId(e.target.value)} options={(locations ?? []).map((l) => ({ value: l.id, label: l.name }))} />
          ) : null}
          <TextField label="日付" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </div>
        <Checkbox label="キャンセル・無断欠席も表示" checked={showCanceled} onChange={(e) => setShowCanceled(e.target.checked)} />
      </Card>
      <ErrorMessage error={bookings.error ?? staff.error} retry={() => void bookings.refetch()} />
      {loading ? <Spinner /> : null}
      {!loading && view === 'list' ? (
        here.length === 0 ? (
          <EmptyState title="この日の予約はありません" />
        ) : (
          <ul className="list card" style={{ padding: 0, marginTop: 12 }}>
            {[...here]
              .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
              .map((b) => (
                <li key={b.id}>
                  <Link className="list-item" to={`/app/bookings/${b.id}`}>
                    <span className="mono" style={{ minWidth: 92, fontWeight: 700 }}>
                      {fmtTime(b.startsAt, b.timezone)}〜{fmtTime(b.endsAt, b.timezone)}
                    </span>
                    <span className="grow">
                      <strong>{b.customerName}</strong>
                      {b.partySize > 1 ? `(${b.partySize}名)` : ''}
                      <br />
                      <span className="small muted">
                        {b.serviceName} ・ {b.staffName ?? '担当なし'}
                        {ownOnly ? ` ・ ${b.locationName}` : ''}
                      </span>
                    </span>
                    <StatusBadge status={b.status} />
                  </Link>
                </li>
              ))}
          </ul>
        )
      ) : null}
      {!loading && view === 'columns' ? (
        columns.length === 0 ? (
          <EmptyState title="この拠点に所属するスタッフがいません">設定 → スタッフ で所属拠点を設定してください。</EmptyState>
        ) : (
          <div className="schedule" style={{ gridTemplateColumns: `56px repeat(${columns.length}, minmax(150px, 1fr))`, marginTop: 12, maxHeight: '75dvh' }} role="region" aria-label="担当者別の予定表">
            <div className="schedule-col-head" aria-hidden="true" />
            {columns.map((c) => (
              <div key={c.id ?? 'none'} className="schedule-col-head">
                {c.name}
              </div>
            ))}
            <div className="schedule-time" style={{ position: 'relative', height }}>
              {hours.map((m) => (
                <div key={m} style={{ position: 'absolute', top: Math.max(2, y(m) - 7), right: 6 }}>
                  {Math.floor(m / 60)}:00
                </div>
              ))}
            </div>
            {columns.map((c) => {
              const colShifts = (shifts.data?.items ?? []).filter((s) => s.staffId === c.id);
              const workHere = colShifts.filter((s) => s.type === 'work' && (ownOnly || s.locationId === locId)).map((s) => [minuteOf(s.startsAt), minuteOf(s.endsAt)] as const);
              // 勤務時間外を斜線で(担当なし列・シフト権限なしの場合は表示しない)
              const off: [number, number][] = [];
              if (c.id && canShifts) {
                let cursor = startMin;
                for (const [s, e] of [...workHere].sort((a, b) => a[0] - b[0])) {
                  if (s > cursor) off.push([cursor, s]);
                  cursor = Math.max(cursor, e);
                }
                if (cursor < endMin) off.push([cursor, endMin]);
              }
              const markers = colShifts.filter((s) => s.type !== 'work' || (!ownOnly && s.locationId !== locId));
              const colBookings = items.filter((b) => b.staffId === c.id && (c.id !== null || b.locationId === locId));
              const groups = new Map<string, Block>();
              for (const b of colBookings) {
                const other = !ownOnly && b.locationId !== locId;
                const k = `${b.serviceId}|${b.startsAt}|${b.locationId}|${b.status === 'canceled_customer' || b.status === 'canceled_business' || b.status === 'no_show' ? b.id : ''}`;
                const g = groups.get(k);
                if (g) g.bookings.push(b);
                else groups.set(k, { key: k, start: minuteOf(b.startsAt), end: minuteOf(b.endsAt), bookings: [b], other });
              }
              return (
                <div key={c.id ?? 'none'} className="schedule-col" style={{ height }}>
                  {hours.map((m) => (
                    <div key={m} className="schedule-slot-line" style={{ top: y(m) }} />
                  ))}
                  {off.map(([s, e], i) => (
                    <div key={`off${i}`} className="schedule-offhours" style={{ top: y(s), height: y(e) - y(s) }} title="勤務時間外" />
                  ))}
                  {markers.map((s) => (
                    <div
                      key={s.id}
                      className={`schedule-event shift tone-${s.type === 'work' ? 'muted' : s.type === 'break' ? 'neutral' : 'accent'}`}
                      style={{ top: y(minuteOf(s.startsAt)), height: Math.max(18, y(minuteOf(s.endsAt)) - y(minuteOf(s.startsAt))) }}
                    >
                      {s.type === 'work' ? `他拠点勤務(${locName(s.locationId)})` : SHIFT_TYPE_LABELS[s.type]}
                    </div>
                  ))}
                  {layout([...groups.values()]).map((g) => {
                    const first = g.bookings[0];
                    const st = BOOKING_STATUS_LABELS[first.status];
                    const top = y(g.start);
                    const h = Math.max(22, y(g.end) - top - 2);
                    const width = `calc(${100 / g.lanes}% - 6px)`;
                    const left = `calc(${(100 / g.lanes) * g.lane}% + 3px)`;
                    const seats = g.bookings.reduce((n, b) => n + b.partySize, 0);
                    return (
                      <button
                        key={g.key}
                        type="button"
                        className={`schedule-event tone-${g.other ? 'muted' : st.tone}`}
                        style={{ top, height: h, left, width, right: 'auto', opacity: g.other ? 0.8 : 1 }}
                        onClick={() => (g.bookings.length === 1 ? navigate(`/app/bookings/${first.id}`) : setGroup(g.bookings))}
                        aria-label={`${fmtTime(first.startsAt, first.timezone)} ${g.bookings.length > 1 ? `${first.serviceName} ${seats}/${first.capacity}名` : first.customerName} ${st.label}${g.other ? ` ${first.locationName}` : ''}`}
                      >
                        <strong>
                          <span aria-hidden="true">{st.icon} </span>
                          {fmtTime(first.startsAt, first.timezone)}
                        </strong>{' '}
                        {g.other ? (
                          <>他拠点の予約({first.locationName})</>
                        ) : g.bookings.length > 1 ? (
                          <>
                            {first.serviceName} {seats}/{first.capacity}名
                            <br />
                            <span className="small">{g.bookings.map((b) => b.customerName).join('、')}</span>
                          </>
                        ) : (
                          <>
                            {first.customerName}
                            <br />
                            <span className="small">{first.serviceName}</span>
                          </>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )
      ) : null}
      <p className="small muted" style={{ marginTop: 8 }}>
        斜線は勤務時間外です。グレーの枠は他拠点での予約・勤務で、この拠点では予約できません。他の端末での変更は自動で反映されます。
      </p>
      {group ? (
        <Modal title={`${fmtTime(group[0].startsAt, group[0].timezone)} ${group[0].serviceName}`} onClose={() => setGroup(null)}>
          <ul className="list">
            {group.map((b) => (
              <li key={b.id}>
                <Link className="list-item" to={`/app/bookings/${b.id}`}>
                  <span className="grow">
                    <strong>{b.customerName}</strong>
                    {b.partySize > 1 ? `(${b.partySize}名)` : ''}
                  </span>
                  <StatusBadge status={b.status} />
                </Link>
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}
      {create ? <BookingFormModal initial={{ locationId: locId ?? undefined, date }} onClose={() => setCreate(false)} onCreated={(b) => navigate(`/app/bookings/${b.id}`)} /> : null}
    </>
  );
}
