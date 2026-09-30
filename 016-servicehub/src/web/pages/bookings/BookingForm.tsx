import { useEffect, useMemo, useRef, useState } from 'react';
import { todayIn } from '../../../shared/time';
import { api, ApiError, newIdempotencyKey, qs } from '../../api/client';
import { useApi, useCan, useMe } from '../../api/hooks';
import { Alert, Button, Checkbox, ErrorMessage, Modal, SelectField, Spinner, TextAreaField, TextField } from '../../components/ui';
import { fmtTime } from '../../lib/format';
import { localToUtcLenient } from '../../../shared/time';
import { useCatalog } from '../settings/CatalogPages';

export interface BookingFormInitial {
  locationId?: string;
  serviceId?: string;
  staffId?: string | null;
  date?: string;
  customer?: { id: string; name: string };
  previousBookingId?: string;
  waitlistEntryId?: string;
  /** 空き一覧が読み込まれたら、この開始時刻の枠を選択(待機の候補から予約する時など) */
  startsAt?: string;
  title?: string;
}

interface CustomerHit {
  id: string;
  name: string;
  nameKana: string | null;
  phone: string | null;
  email: string | null;
  lastVisitAt: string | null;
}

export function CustomerPicker({ value, onChange }: { value: { id: string; name: string } | null; onChange: (c: { id: string; name: string } | null) => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const hits = useApi<{ items: CustomerHit[] }>(['customer-search', debounced], debounced.trim().length >= 1 ? `/api/v1/customers${qs({ q: debounced, limit: 10 })}` : null);
  if (value) {
    return (
      <div className="row">
        <strong>{value.name}</strong>
        <Button size="sm" onClick={() => onChange(null)}>
          変更
        </Button>
      </div>
    );
  }
  return (
    <div className="stack">
      <TextField label="顧客を検索" hint="氏名・フリガナ・電話番号(下4桁可)・メール" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {hits.isFetching ? <Spinner /> : null}
      {hits.data ? (
        hits.data.items.length === 0 ? (
          <p className="small muted">該当する顧客がいません(下の「新規顧客として登録」を使えます)</p>
        ) : (
          <ul className="list card" style={{ padding: 0 }}>
            {hits.data.items.map((c) => (
              <li key={c.id}>
                <button type="button" className="list-item" onClick={() => onChange({ id: c.id, name: c.name })}>
                  <span className="grow">
                    <strong>{c.name}</strong> {c.nameKana ? <span className="muted small">{c.nameKana}</span> : null}
                    <br />
                    <span className="small muted">
                      {c.phone ?? ''} {c.email ?? ''}
                    </span>
                  </span>
                  <span aria-hidden="true">選択 ›</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

export function BookingFormModal({ initial = {}, onClose, onCreated }: { initial?: BookingFormInitial; onClose: () => void; onCreated?: (b: any) => void }) {
  const me = useMe();
  const can = useCan();
  const cat = useCatalog();
  const locations = me.data?.locations ?? [];
  const ownOnly = !can('booking.create.all');
  const [locationId, setLocationId] = useState(initial.locationId ?? locations[0]?.id ?? '');
  const tz = locations.find((l) => l.id === locationId)?.timezone ?? 'Asia/Tokyo';
  const [serviceId, setServiceId] = useState(initial.serviceId ?? '');
  const [staffId, setStaffId] = useState<string>(ownOnly ? (me.data?.membership?.staffId ?? '') : (initial.staffId ?? ''));
  const [date, setDate] = useState(initial.date ?? todayIn(tz));
  const [partySize, setPartySize] = useState(1);
  const [slot, setSlot] = useState<string | null>(null);
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(initial.customer ?? null);
  const [newCustomer, setNewCustomer] = useState<{ name: string; nameKana: string; phone: string; email: string } | null>(null);
  const [request, setRequest] = useState('');
  const [internalNote, setInternalNote] = useState('');
  const [manualTime, setManualTime] = useState(false);
  const [time, setTime] = useState('10:00');
  const [forceReason, setForceReason] = useState('');
  const [check, setCheck] = useState<{ ok: boolean; requiresForce: boolean; violations: { code: string; hard: boolean; message: string }[] } | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const idem = useRef(newIdempotencyKey('adm'));

  const services = cat.services.filter((s) => s.status === 'active' && s.locationIds.includes(locationId));
  const service = services.find((s) => s.id === serviceId);
  const staffOptions = useMemo(
    () => cat.staff.filter((s) => s.status === 'active' && s.locationIds.includes(locationId) && (!service || service.staffIds.includes(s.id))),
    [cat.staff, locationId, service],
  );
  const avail = useApi<{ slots: { startsAt: string; endsAt: string; seatsAvailable: number; staff: { staffId: string | null; name: string | null }[] }[] }>(
    ['admin-availability', locationId, serviceId, staffId, date, partySize],
    locationId && serviceId && date && !manualTime ? `/api/v1/availability${qs({ locationId, serviceId, date, staffId: staffId || undefined, partySize })}` : null,
  );
  useEffect(() => setSlot(null), [locationId, serviceId, staffId, date, partySize]);
  const wantedStart = useRef(initial.startsAt ?? null);
  useEffect(() => {
    if (!wantedStart.current || !avail.data) return;
    const hit = avail.data.slots.find((x) => new Date(x.startsAt).getTime() === new Date(wantedStart.current!).getTime());
    wantedStart.current = null;
    if (hit) setSlot(hit.startsAt);
  }, [avail.data]);

  const startsAt = manualTime ? localToUtcLenient(date, time, tz).toISOString() : slot;
  useEffect(() => {
    if (!manualTime || !serviceId || !locationId) return;
    let cancelled = false;
    void api
      .post('/api/v1/availability/check', { locationId, serviceId, staffId: staffId || null, startsAt: localToUtcLenient(date, time, tz).toISOString(), partySize })
      .then((r) => !cancelled && setCheck(r))
      .catch(() => !cancelled && setCheck(null));
    return () => {
      cancelled = true;
    };
  }, [manualTime, date, time, serviceId, locationId, staffId, partySize, tz]);

  const needsForce = manualTime && check?.requiresForce;
  const canSubmit = Boolean(startsAt && serviceId && (customer || (newCustomer && newCustomer.name.trim())) && (!manualTime || (check?.ok && (!needsForce || forceReason.trim()))));
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const b = await api.post('/api/v1/bookings', {
        locationId,
        serviceId,
        staffId: staffId || null,
        startsAt,
        partySize,
        customer: customer ? { customerId: customer.id } : { name: newCustomer!.name, nameKana: newCustomer!.nameKana || null, phone: newCustomer!.phone || null, email: newCustomer!.email || null },
        customerRequest: request || null,
        internalNote: internalNote || null,
        channel: can('reception.operate') && !can('booking.force') ? 'reception' : 'staff',
        force: Boolean(needsForce),
        forceReason: needsForce ? forceReason : null,
        idempotencyKey: idem.current,
        previousBookingId: initial.previousBookingId ?? null,
        waitlistEntryId: initial.waitlistEntryId ?? null,
      });
      onCreated?.(b);
      onClose();
    } catch (e) {
      const ae = e as ApiError;
      setErr(ae);
      if (ae.code === 'SLOT_UNAVAILABLE') {
        idem.current = newIdempotencyKey('adm');
        if (!manualTime) void avail.refetch();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={initial.title ?? '予約を作成'}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>閉じる</Button>
          <Button variant="primary" busy={busy} disabled={!canSubmit} onClick={() => void submit()}>
            {needsForce ? '強制予約する' : '予約を確定'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorMessage error={err} />
        {err?.details?.violations ? (
          <ul className="small">
            {err.details.violations.map((v: any) => (
              <li key={v.code}>{v.message}</li>
            ))}
          </ul>
        ) : null}
        <fieldset>
          <legend>顧客</legend>
          {newCustomer ? (
            <div className="grid-2">
              <TextField label="氏名" value={newCustomer.name} onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} required />
              <TextField label="フリガナ" value={newCustomer.nameKana} onChange={(e) => setNewCustomer({ ...newCustomer, nameKana: e.target.value })} />
              <TextField label="電話" type="tel" value={newCustomer.phone} onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })} />
              <TextField label="メール" type="email" value={newCustomer.email} onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })} />
              <Button size="sm" onClick={() => setNewCustomer(null)}>
                既存の顧客から選ぶ
              </Button>
            </div>
          ) : (
            <>
              <CustomerPicker value={customer} onChange={setCustomer} />
              {!customer && can('customer.create') ? (
                <Button size="sm" onClick={() => setNewCustomer({ name: '', nameKana: '', phone: '', email: '' })}>
                  + 新規顧客として登録
                </Button>
              ) : null}
            </>
          )}
        </fieldset>
        <div className="grid-3">
          {locations.length > 1 ? (
            <SelectField label="拠点" value={locationId} onChange={(e) => setLocationId(e.target.value)} options={locations.map((l) => ({ value: l.id, label: l.name }))} />
          ) : null}
          <SelectField label="サービス" value={serviceId} onChange={(e) => setServiceId(e.target.value)} placeholder="選択してください" options={services.map((s) => ({ value: s.id, label: `${s.name}(${s.durationMin}分)` }))} />
          {service?.requiresStaff !== false ? (
            <SelectField
              label="担当"
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
              disabled={ownOnly}
              placeholder={ownOnly ? undefined : 'おまかせ(空いているスタッフ)'}
              options={staffOptions.map((s) => ({ value: s.id, label: s.displayName }))}
            />
          ) : null}
          {service && service.maxPartySize > 1 ? (
            <SelectField
              label="人数"
              value={String(partySize)}
              onChange={(e) => setPartySize(Number(e.target.value))}
              options={Array.from({ length: service.maxPartySize }, (_, i) => ({ value: String(i + 1), label: `${i + 1}名` }))}
            />
          ) : null}
          <TextField label="日付" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        {serviceId ? (
          <>
            {can('booking.force') ? (
              <Checkbox label="時刻を直接指定する(営業時間外・シフト外などを理由付きで強制予約)" checked={manualTime} onChange={(e) => setManualTime(e.target.checked)} />
            ) : null}
            {manualTime ? (
              <div className="stack">
                <TextField label={`開始時刻(${tz})`} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
                {check ? (
                  check.ok && !check.requiresForce ? (
                    <Alert tone="success">この時刻は通常どおり予約できます。</Alert>
                  ) : check.ok ? (
                    <Alert tone="warning">
                      次のルールを上書きして予約します:
                      <ul>
                        {check.violations.map((v) => (
                          <li key={v.code}>{v.message}</li>
                        ))}
                      </ul>
                    </Alert>
                  ) : (
                    <Alert tone="danger">
                      この時刻は予約できません(強制でも不可):
                      <ul>
                        {check.violations.filter((v) => v.hard).map((v) => (
                          <li key={v.code}>{v.message}</li>
                        ))}
                      </ul>
                    </Alert>
                  )
                ) : null}
                {needsForce ? <TextField label="強制予約の理由" value={forceReason} onChange={(e) => setForceReason(e.target.value)} required hint="監査ログに記録されます" /> : null}
              </div>
            ) : avail.isLoading ? (
              <Spinner label="空き枠を確認中" />
            ) : avail.data && avail.data.slots.length === 0 ? (
              <Alert tone="info">この日は空き枠がありません。日付・担当を変えてください。</Alert>
            ) : (
              <div className="slot-grid" role="group" aria-label="開始時刻">
                {avail.data?.slots.map((s) => (
                  <button key={s.startsAt} type="button" className="slot-btn" aria-pressed={slot === s.startsAt} onClick={() => setSlot(s.startsAt)}>
                    {fmtTime(s.startsAt, tz)}
                    <small>{staffId ? (service && service.capacity > 1 ? `残${s.seatsAvailable}` : '') : `${s.staff.length}名可`}</small>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : null}
        <div className="grid-2">
          <TextAreaField label="お客様の要望" value={request} onChange={(e) => setRequest(e.target.value)} />
          {can('booking.internal_note') ? <TextAreaField label="内部メモ(お客様には表示されません)" value={internalNote} onChange={(e) => setInternalNote(e.target.value)} /> : null}
        </div>
      </div>
    </Modal>
  );
}
