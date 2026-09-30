import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { addDays, todayIn } from '../../../shared/time';
import { api, qs } from '../../api/client';
import { useApi, useApiMutation, useCan, useCurrentLocation, useMe, useOnline } from '../../api/hooks';
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, ErrorMessage, fieldError, Modal, PageHeader, SelectField, Spinner, Tabs, TextAreaField, TextField } from '../../components/ui';
import { fmtDate, fmtDateTime, localDateOf } from '../../lib/format';
import { BookingFormModal, CustomerPicker } from '../bookings/BookingForm';
import { useCatalog } from '../settings/CatalogPages';

interface Match {
  id: string;
  startsAt: string;
  staffId: string | null;
  status: 'open' | 'notified' | 'booked';
  notifiedAt: string | null;
}

interface Entry {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  hasEmail: boolean;
  locationId: string;
  locationName: string;
  timezone: string;
  serviceId: string;
  serviceName: string;
  staffId: string | null;
  staffName: string | null;
  dateFrom: string;
  dateTo: string;
  timeFrom: string | null;
  timeTo: string | null;
  partySize: number;
  status: 'waiting' | 'notified' | 'booked' | 'expired' | 'canceled';
  source: 'public' | 'staff' | 'restore';
  note: string | null;
  bookedBookingId: string | null;
  matchedAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  matches: Match[];
}

const STATUS: Record<Entry['status'], { label: string; tone: string; icon: string }> = {
  waiting: { label: '待機中', tone: 'info', icon: '⧗' },
  notified: { label: '案内済み', tone: 'accent', icon: '✉' },
  booked: { label: '予約済み', tone: 'success', icon: '✓' },
  expired: { label: '期限切れ', tone: 'muted', icon: '○' },
  canceled: { label: '取消', tone: 'muted', icon: '×' },
};

type Filter = 'active' | 'booked' | 'expired' | 'canceled' | 'all';

export function WaitlistPage() {
  const can = useCan();
  const online = useOnline();
  const navigate = useNavigate();
  const [locId, setLocId, locations] = useCurrentLocation();
  const [filter, setFilter] = useState<Filter>('active');
  // 複数拠点を担当する場合は全拠点をまとめて表示(拠点名は各カードに表示)
  const [allLocations, setAllLocations] = useState(() => (locations?.length ?? 0) > 1);
  const [create, setCreate] = useState(false);
  const [book, setBook] = useState<{ entry: Entry; match: Match } | null>(null);
  const [cancel, setCancel] = useState<Entry | null>(null);
  const list = useApi<{ items: Entry[] }>(['waitlist', filter, allLocations ? 'all' : locId], `/api/v1/waitlist${qs({ status: filter, locationId: allLocations ? undefined : locId })}`, {
    refetchInterval: 60_000,
  });
  const manage = can('waitlist.manage');
  const invalidate = [['waitlist'], ['dashboard']];
  const notify = useApiMutation(({ id, method }: { id: string; method: 'email' | 'manual' }) => api.post(`/api/v1/waitlist/matches/${id}/notify`, { method }), {
    invalidate,
    success: (r: { queued: boolean }) => (r.queued ? '案内メールを送信キューに登録しました' : '案内済みとして記録しました'),
    onError: () => void list.refetch(),
  });
  const dismiss = useApiMutation((id: string) => api.post(`/api/v1/waitlist/matches/${id}/dismiss`, {}), { invalidate, success: '候補を見送りました' });
  const refresh = useApiMutation((id: string) => api.post<{ newMatches: number }>(`/api/v1/waitlist/${id}/refresh`, {}), {
    invalidate,
    success: (r) => (r.newMatches > 0 ? `新しい候補が${r.newMatches}件見つかりました` : '候補を再確認しました'),
  });
  return (
    <>
      <PageHeader
        title="待機リスト"
        sub="空きが出ると候補が表示されます。予約は自動で確定しません(案内・予約は先着順で、その時点の空きで再確認します)。"
        actions={
          manage ? (
            <Button variant="primary" disabled={!online} onClick={() => setCreate(true)}>
              待機を登録
            </Button>
          ) : null
        }
      />
      <Card>
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
          <Tabs
            label="状態"
            value={filter}
            onChange={setFilter}
            tabs={[
              { value: 'active', label: '有効' },
              { value: 'booked', label: '予約済み' },
              { value: 'expired', label: '期限切れ' },
              { value: 'canceled', label: '取消' },
              { value: 'all', label: 'すべて' },
            ]}
          />
          {(locations?.length ?? 0) > 1 ? (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <select className="select" style={{ width: 'auto' }} aria-label="拠点" value={locId ?? ''} disabled={allLocations} onChange={(e) => setLocId(e.target.value)}>
                {(locations ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <Checkbox label="全拠点" checked={allLocations} onChange={(e) => setAllLocations(e.target.checked)} />
            </div>
          ) : null}
        </div>
      </Card>
      <ErrorMessage error={list.error} retry={() => void list.refetch()} />
      {list.isLoading ? <Spinner /> : null}
      {list.data?.items.length === 0 ? <EmptyState title="該当する待機はありません" /> : null}
      <div className="stack" style={{ marginTop: 12 }}>
        {(list.data?.items ?? []).map((e) => {
          const st = STATUS[e.status];
          const active = e.status === 'waiting' || e.status === 'notified';
          return (
            <Card
              key={e.id}
              title={
                <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <h2 style={{ margin: 0, fontSize: '1.05rem' }}>
                    <Link to={`/app/customers/${e.customerId}`}>{e.customerName}</Link>
                  </h2>
                  <Badge tone={st.tone} icon={st.icon}>
                    {st.label}
                  </Badge>
                  {e.source === 'public' ? <Badge tone="neutral">Web登録</Badge> : null}
                </div>
              }
              actions={
                active ? (
                  <>
                    <Button size="sm" disabled={!online} busy={refresh.isPending && refresh.variables === e.id} onClick={() => refresh.mutate(e.id)}>
                      候補を再確認
                    </Button>
                    {manage ? (
                      <Button size="sm" variant="ghost" disabled={!online} onClick={() => setCancel(e)}>
                        取消
                      </Button>
                    ) : null}
                  </>
                ) : null
              }
            >
              <dl className="kv">
                <dt>希望</dt>
                <dd>
                  {e.locationName} ・ {e.serviceName}
                  {e.partySize > 1 ? ` ・ ${e.partySize}名` : ''} ・ 担当 {e.staffName ?? '指定なし'}
                </dd>
                <dt>期間</dt>
                <dd>
                  {fmtDate(e.dateFrom)}〜{fmtDate(e.dateTo)}
                  {e.timeFrom ? ` ・ ${e.timeFrom}〜${e.timeTo} 開始` : ' ・ 時間帯指定なし'}
                </dd>
                <dt>連絡先</dt>
                <dd>
                  {e.customerPhone ? <a href={`tel:${e.customerPhone}`}>{e.customerPhone}</a> : '電話なし'} ・ {e.hasEmail ? 'メールあり' : 'メールなし'}
                </dd>
                {e.note ? (
                  <>
                    <dt>メモ</dt>
                    <dd style={{ whiteSpace: 'pre-wrap' }}>{e.note}</dd>
                  </>
                ) : null}
                {e.bookedBookingId ? (
                  <>
                    <dt>予約</dt>
                    <dd>
                      <Link to={`/app/bookings/${e.bookedBookingId}`}>予約を見る</Link>
                    </dd>
                  </>
                ) : null}
                {e.cancelReason ? (
                  <>
                    <dt>取消理由</dt>
                    <dd>{e.cancelReason}</dd>
                  </>
                ) : null}
              </dl>
              {active ? (
                e.matches.filter((m) => m.status !== 'booked').length === 0 ? (
                  <p className="small muted" style={{ marginBottom: 0 }}>
                    現在、条件に合う空きはありません。キャンセル等で空きが出ると自動で候補に表示されます(予約は自動では確定しません)。
                  </p>
                ) : (
                  <div className="stack" style={{ marginTop: 8 }}>
                    <strong className="small">空きの候補</strong>
                    <ul className="list">
                      {e.matches
                        .filter((m) => m.status !== 'booked')
                        .map((m) => (
                          <li key={m.id} className="list-item" style={{ flexWrap: 'wrap', gap: 8 }}>
                            <span className="grow">
                              <strong>{fmtDateTime(m.startsAt, e.timezone)}</strong>{' '}
                              {m.status === 'notified' ? (
                                <Badge tone="accent" icon="✉">
                                  案内済み{m.notifiedAt ? ` ${fmtDateTime(m.notifiedAt, e.timezone)}` : ''}
                                </Badge>
                              ) : (
                                <Badge tone="info">未案内</Badge>
                              )}
                            </span>
                            {manage ? (
                              <span className="row" style={{ flexWrap: 'wrap' }}>
                                <Button size="sm" variant="primary" disabled={!online || !e.hasEmail} title={e.hasEmail ? undefined : 'メールアドレスが登録されていません'} onClick={() => notify.mutate({ id: m.id, method: 'email' })}>
                                  メールで案内
                                </Button>
                                <Button size="sm" disabled={!online} onClick={() => notify.mutate({ id: m.id, method: 'manual' })}>
                                  連絡済みにする
                                </Button>
                                {can('booking.create.all') ? (
                                  <Button size="sm" disabled={!online} onClick={() => setBook({ entry: e, match: m })}>
                                    この枠で予約
                                  </Button>
                                ) : null}
                                <Button size="sm" variant="ghost" disabled={!online} onClick={() => dismiss.mutate(m.id)}>
                                  見送る
                                </Button>
                              </span>
                            ) : null}
                          </li>
                        ))}
                    </ul>
                  </div>
                )
              ) : null}
            </Card>
          );
        })}
      </div>
      <ErrorMessage error={notify.error} />
      {create ? <CreateWaitlistModal defaultLocationId={locId ?? undefined} onClose={() => setCreate(false)} /> : null}
      {cancel ? <CancelEntryModal entry={cancel} onClose={() => setCancel(null)} /> : null}
      {book ? (
        <BookingFormModal
          initial={{
            title: '待機から予約',
            locationId: book.entry.locationId,
            serviceId: book.entry.serviceId,
            staffId: book.match.staffId ?? book.entry.staffId,
            date: localDateOf(book.match.startsAt, book.entry.timezone),
            customer: { id: book.entry.customerId, name: book.entry.customerName },
            waitlistEntryId: book.entry.id,
            startsAt: book.match.startsAt,
          }}
          onClose={() => {
            setBook(null);
            void list.refetch();
          }}
          onCreated={(b) => navigate(`/app/bookings/${b.id}`)}
        />
      ) : null}
    </>
  );
}

function CancelEntryModal({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const m = useApiMutation(() => api.post(`/api/v1/waitlist/${entry.id}/cancel`, { reason: reason || null }), {
    invalidate: [['waitlist'], ['dashboard']],
    success: '待機を取り消しました',
    onSuccess: onClose,
  });
  return (
    <ConfirmDialog title="待機を取り消しますか?" danger confirmLabel="取り消す" busy={m.isPending} onConfirm={() => m.mutate(undefined)} onCancel={onClose}>
      <p className="small">
        {entry.customerName} 様 / {entry.serviceName}({fmtDate(entry.dateFrom)}〜{fmtDate(entry.dateTo)})
      </p>
      <TextAreaField label="理由(任意)" value={reason} onChange={(e) => setReason(e.target.value)} />
    </ConfirmDialog>
  );
}

function CreateWaitlistModal({ defaultLocationId, onClose }: { defaultLocationId?: string; onClose: () => void }) {
  const me = useMe();
  const cat = useCatalog();
  const locations = me.data?.locations ?? [];
  const [locationId, setLocationId] = useState(defaultLocationId ?? locations[0]?.id ?? '');
  const tz = locations.find((l) => l.id === locationId)?.timezone ?? 'Asia/Tokyo';
  const today = todayIn(tz);
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(null);
  const [serviceId, setServiceId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(addDays(today, 6));
  const [useTime, setUseTime] = useState(false);
  const [timeFrom, setTimeFrom] = useState('10:00');
  const [timeTo, setTimeTo] = useState('18:00');
  const [partySize, setPartySize] = useState(1);
  const [note, setNote] = useState('');
  const services = cat.services.filter((s) => s.status === 'active' && s.locationIds.includes(locationId));
  const service = services.find((s) => s.id === serviceId);
  const staffOptions = useMemo(
    () => cat.staff.filter((s) => s.status === 'active' && s.locationIds.includes(locationId) && (!service || service.staffIds.includes(s.id))),
    [cat.staff, locationId, service],
  );
  const m = useApiMutation(
    () =>
      api.post<{ created: boolean }>('/api/v1/waitlist', {
        customer: { customerId: customer!.id },
        locationId,
        serviceId,
        staffId: staffId || null,
        dateFrom,
        dateTo,
        timeFrom: useTime ? timeFrom : null,
        timeTo: useTime ? timeTo : null,
        partySize,
        note: note || null,
      }),
    { invalidate: [['waitlist'], ['dashboard']], success: (r) => (r.created ? '待機を登録しました' : '同じ条件の待機がすでにあります'), onSuccess: onClose },
  );
  return (
    <Modal
      title="待機を登録"
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>やめる</Button>
          <Button variant="primary" busy={m.isPending} disabled={!customer || !serviceId || dateTo < dateFrom} onClick={() => m.mutate(undefined)}>
            登録する
          </Button>
        </>
      }
    >
      <div className="stack">
        <CustomerPicker value={customer} onChange={setCustomer} />
        <div className="grid-2">
          {locations.length > 1 ? (
            <SelectField label="拠点" value={locationId} onChange={(e) => { setLocationId(e.target.value); setServiceId(''); setStaffId(''); }} options={locations.map((l) => ({ value: l.id, label: l.name }))} />
          ) : null}
          <SelectField label="サービス" value={serviceId} onChange={(e) => { setServiceId(e.target.value); setStaffId(''); }} placeholder="選択してください" options={services.map((s) => ({ value: s.id, label: s.name }))} />
          {service?.requiresStaff ? (
            <SelectField label="担当(任意)" value={staffId} onChange={(e) => setStaffId(e.target.value)} placeholder="指定なし" options={staffOptions.map((s) => ({ value: s.id, label: s.displayName }))} />
          ) : null}
          {service && service.maxPartySize > 1 ? (
            <TextField label="人数" type="number" min={1} max={service.maxPartySize} value={partySize} onChange={(e) => setPartySize(Number(e.target.value) || 1)} error={fieldError(m.error, 'partySize')} />
          ) : null}
        </div>
        <div className="grid-2">
          <TextField label="希望日(から)" type="date" value={dateFrom} min={today} onChange={(e) => setDateFrom(e.target.value)} error={fieldError(m.error, 'dateFrom')} />
          <TextField label="希望日(まで)" type="date" value={dateTo} min={dateFrom} onChange={(e) => setDateTo(e.target.value)} error={fieldError(m.error, 'dateTo')} hint="最長31日間" />
        </div>
        <Checkbox label="希望の時間帯(開始時刻)を指定する" checked={useTime} onChange={(e) => setUseTime(e.target.checked)} />
        {useTime ? (
          <div className="grid-2">
            <TextField label="開始時刻(から)" type="time" value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} />
            <TextField label="開始時刻(まで)" type="time" value={timeTo} onChange={(e) => setTimeTo(e.target.value)} error={fieldError(m.error, 'timeTo')} />
          </div>
        ) : null}
        <TextAreaField label="メモ(任意)" value={note} onChange={(e) => setNote(e.target.value)} />
        <Alert tone="info">登録すると、条件に合う空きが候補として表示されます。お客様への案内・予約は運営者の操作で行い、自動では確定しません。</Alert>
        <ErrorMessage error={m.error} />
      </div>
    </Modal>
  );
}
