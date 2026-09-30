import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { BOOKING_STATUS_LABELS, type BookingStatus } from '../../../shared/constants';
import { normalizeName } from '../../../shared/normalize';
import { api, type ApiError } from '../../api/client';
import { useApi, useApiMutation, useCan, useCurrentLocation, useMe, useOnline } from '../../api/hooks';
import { OfflineBanner } from '../../components/Layout';
import { useToast } from '../../components/Toast';
import { UpdatePrompt } from '../../components/UpdatePrompt';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorMessage, Spinner, StatusBadge, Tabs } from '../../components/ui';
import { fmtDate, fmtTime, formatDateJa } from '../../lib/format';
import { useRealtime } from '../../lib/realtime';
import type { BookingDto } from '../bookings/BookingPages';
import { BookingFormModal } from '../bookings/BookingForm';
import type { EntitlementHint } from '../entitlements/types';

type BoardItem = BookingDto & { entitlements: EntitlementHint[] };
interface Board {
  location: { id: string; name: string; timezone: string };
  date: string;
  generatedAt: string;
  counts: Partial<Record<BookingStatus, number>>;
  items: BoardItem[];
}

type Filter = 'open' | 'upcoming' | 'inhouse' | 'done' | 'all';
const FILTERS: Record<Filter, (s: BookingStatus) => boolean> = {
  open: (s) => s === 'confirmed' || s === 'arrived' || s === 'in_service',
  upcoming: (s) => s === 'confirmed',
  inhouse: (s) => s === 'arrived' || s === 'in_service',
  done: (s) => s === 'completed' || s === 'canceled_customer' || s === 'canceled_business' || s === 'no_show',
  all: () => true,
};

function useNow(ms = 15_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** 受付モード(iPad の受付台などで全画面表示。内部メモ・経営情報は表示しない) */
export function ReceptionPage() {
  useRealtime();
  const me = useMe();
  const can = useCan();
  const online = useOnline();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [locId, setLocId, locations] = useCurrentLocation();
  const [filter, setFilter] = useState<Filter>('open');
  const [search, setSearch] = useState('');
  const [walkin, setWalkin] = useState(false);
  const [noShow, setNoShow] = useState<BoardItem | null>(null);
  const now = useNow();
  const board = useApi<Board>(['reception', locId], locId ? `/api/v1/reception/board?locationId=${locId}` : null, { refetchInterval: 20_000 });
  const tz = board.data?.location.timezone ?? locations?.find((l) => l.id === locId)?.timezone ?? 'Asia/Tokyo';
  const status = useApiMutation(({ b, to }: { b: BoardItem; to: string }) => api.post(`/api/v1/bookings/${b.id}/status`, { to, expectedVersion: b.version }), {
    invalidate: [['reception'], ['today'], ['bookings'], ['schedule']],
    silentError: true,
    success: (r: BookingDto) => `${r.customerName} 様: ${BOOKING_STATUS_LABELS[r.status].label}`,
    onSuccess: () => setNoShow(null),
    onError: (e: ApiError) => {
      setNoShow(null);
      toast.push({ tone: 'error', message: e.code === 'VERSION_CONFLICT' ? '他の端末で更新されていました。最新の状態を表示します。' : e.message });
      void qc.invalidateQueries({ queryKey: ['reception'] });
    },
  });

  const items = useMemo(() => {
    const all = board.data?.items ?? [];
    const s = normalizeName(search);
    return all.filter(
      (b) => FILTERS[filter](b.status) && (!s || normalizeName(`${b.customerName}${b.customerKana ?? ''}`).includes(s) || normalizeName(b.code).includes(s)),
    );
  }, [board.data, filter, search]);
  const c = board.data?.counts ?? {};
  const busy = status.isPending;
  const act = (b: BoardItem, to: string) => status.mutate({ b, to });
  const canCreate = can('booking.create.all') || can('booking.create.own');

  return (
    <div className="reception">
      <OfflineBanner />
      <UpdatePrompt />
      <header className="reception-header">
        <div>
          <h1 style={{ fontSize: '1.2rem', fontWeight: 800, margin: 0, color: 'inherit' }}>
            受付モード ・ {board.data?.location.name ?? locations?.find((l) => l.id === locId)?.name}
          </h1>
          <div className="small" style={{ opacity: 0.85 }}>
            {me.data?.organization?.name} ・ {board.data ? formatDateJa(board.data.date) : ''}
          </div>
        </div>
        <div className="clock" aria-label="現在時刻">
          {fmtTime(now, tz)}
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {(locations?.length ?? 0) > 1 ? (
            <label className="row" style={{ color: '#fff' }}>
              <span className="sr-only">拠点</span>
              <select className="select" value={locId ?? ''} onChange={(e) => setLocId(e.target.value)} style={{ minWidth: 140 }}>
                {(locations ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {canCreate ? (
            <Button variant="primary" disabled={!online} onClick={() => setWalkin(true)}>
              ＋ 当日の予約
            </Button>
          ) : null}
          <Link className="btn" to="/app/schedule">
            予定表
          </Link>
          <Link className="btn" to="/app">
            メニュー
          </Link>
        </div>
      </header>
      <div style={{ padding: '12px 16px 0' }} className="stack">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }} aria-label="本日の件数">
          <Badge tone="info">予約 {board.data?.items.length ?? 0}</Badge>
          <Badge tone="neutral">来店待ち {c.confirmed ?? 0}</Badge>
          <Badge tone="accent">来店済み {c.arrived ?? 0}</Badge>
          <Badge tone="warning">対応中 {c.in_service ?? 0}</Badge>
          <Badge tone="success">完了 {c.completed ?? 0}</Badge>
          <Badge tone="muted">キャンセル {(c.canceled_customer ?? 0) + (c.canceled_business ?? 0)}</Badge>
          <Badge tone="danger">無断欠席 {c.no_show ?? 0}</Badge>
        </div>
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <Tabs
            label="表示する予約"
            value={filter}
            onChange={setFilter}
            tabs={[
              { value: 'open', label: `未完了 (${(c.confirmed ?? 0) + (c.arrived ?? 0) + (c.in_service ?? 0)})` },
              { value: 'upcoming', label: `来店待ち (${c.confirmed ?? 0})` },
              { value: 'inhouse', label: `来店中 (${(c.arrived ?? 0) + (c.in_service ?? 0)})` },
              { value: 'done', label: '終了' },
              { value: 'all', label: 'すべて' },
            ]}
          />
          <input
            className="input"
            type="search"
            placeholder="お名前・フリガナ・予約番号で絞り込み"
            aria-label="お名前・フリガナ・予約番号で絞り込み"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 360 }}
          />
        </div>
      </div>
      <ErrorMessage error={board.error} retry={() => void board.refetch()} />
      {board.isLoading ? <Spinner /> : null}
      {board.data && items.length === 0 ? (
        <div style={{ padding: 16 }}>
          <EmptyState title={search ? '該当する予約はありません' : '表示する予約はありません'} />
        </div>
      ) : null}
      <div className="reception-grid" aria-live="polite">
        {items.map((b) => (
          <article key={b.id} className={`rcard status-${b.status}`} aria-label={`${fmtTime(b.startsAt, tz)} ${b.customerName} 様`}>
            <div className="row-between">
              <span className="rtime">
                {fmtTime(b.startsAt, tz)}
                <span className="small muted" style={{ fontSize: '0.9rem' }}>
                  〜{fmtTime(b.endsAt, tz)}
                </span>
              </span>
              <StatusBadge status={b.status} size="lg" />
            </div>
            <div className="rname">
              {b.customerName} 様{b.partySize > 1 ? <span className="rmeta">({b.partySize}名)</span> : null}
            </div>
            <div className="rmeta">
              {b.serviceName} ・ {b.staffName ?? '担当なし'} ・ <span className="mono">{b.code}</span>
            </div>
            {b.customerRequest ? <div className="small">ご要望: {b.customerRequest}</div> : null}
            {b.entitlements.length > 0 || b.consumptionKind || b.consumptionReview === 'pending' ? (
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {b.consumptionKind ? (
                  <Badge tone="success" icon="✓">
                    {b.consumptionKind === 'pass' ? '回数券' : 'プラン'} 消化済み
                  </Badge>
                ) : null}
                {b.consumptionReview === 'pending' ? (
                  <Badge tone="warning" icon="?">
                    消化確認待ち
                  </Badge>
                ) : null}
                {!b.consumptionKind
                  ? b.entitlements.map((h) => (
                      <Badge key={h.id} tone={h.remaining <= 1 || h.expiringSoon ? 'warning' : 'info'} icon={h.kind === 'pass' ? '▤' : '↻'}>
                        {h.name} 残{h.remaining}
                        {h.kind === 'pass' && h.until ? ` ・ 期限${fmtDate(h.until)}` : ''}
                      </Badge>
                    ))
                  : null}
              </div>
            ) : null}
            <div className="ractions">
              {b.status === 'confirmed' ? (
                <>
                  <Button variant="primary" disabled={!online || busy} onClick={() => act(b, 'arrived')}>
                    ● 来店
                  </Button>
                  <Button disabled={!online || busy} onClick={() => act(b, 'in_service')}>
                    ▶ 対応開始
                  </Button>
                  <Button variant="ghost" disabled={!online || busy} onClick={() => setNoShow(b)}>
                    無断欠席
                  </Button>
                </>
              ) : null}
              {b.status === 'arrived' ? (
                <>
                  <Button variant="primary" disabled={!online || busy} onClick={() => act(b, 'in_service')}>
                    ▶ 対応開始
                  </Button>
                  <Button disabled={!online} onClick={() => navigate(`/app/bookings/${b.id}/complete`)}>
                    ✓ 完了へ
                  </Button>
                  <Button variant="ghost" disabled={!online || busy} onClick={() => act(b, 'confirmed')}>
                    来店を取消
                  </Button>
                </>
              ) : null}
              {b.status === 'in_service' ? (
                <>
                  <Button variant="primary" disabled={!online} onClick={() => navigate(`/app/bookings/${b.id}/complete`)}>
                    ✓ 完了へ
                  </Button>
                  <Button variant="ghost" disabled={!online || busy} onClick={() => act(b, 'arrived')}>
                    対応開始を取消
                  </Button>
                </>
              ) : null}
              {b.status === 'completed' ? (
                <Link className="btn" to={`/app/bookings/${b.id}/complete`}>
                  {b.consumptionKind || b.entitlements.length === 0 ? '記録を見る' : '記録・消化'}
                </Link>
              ) : null}
              {b.consumptionReview === 'pending' && (can('pass.adjust') || can('plan.adjust')) ? (
                <Link className="btn" to={`/app/bookings/${b.id}/consume`}>
                  消化の確認
                </Link>
              ) : null}
              <Link className="btn btn-ghost" to={`/app/bookings/${b.id}`}>
                詳細
              </Link>
            </div>
          </article>
        ))}
      </div>
      <p className="small muted" style={{ padding: '0 16px 16px' }}>
        最終更新 {board.data ? fmtTime(board.data.generatedAt, tz) : '—'}。他の端末での変更は自動で反映されます(オフライン時は操作できません)。
      </p>
      {noShow ? (
        <ConfirmDialog
          title="無断欠席にしますか?"
          danger
          confirmLabel="無断欠席にする"
          busy={busy}
          onConfirm={() => act(noShow, 'no_show')}
          onCancel={() => setNoShow(null)}
          message={`${noShow.customerName} 様(${fmtTime(noShow.startsAt, tz)} ${noShow.serviceName})。回数券・プランは自動では消化しません。`}
        />
      ) : null}
      {walkin ? (
        <BookingFormModal
          initial={{ locationId: locId ?? undefined, title: '当日の予約を追加' }}
          onClose={() => setWalkin(false)}
          onCreated={() => void qc.invalidateQueries({ queryKey: ['reception'] })}
        />
      ) : null}
    </div>
  );
}
