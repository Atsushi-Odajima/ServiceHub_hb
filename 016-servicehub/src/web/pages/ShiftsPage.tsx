import { useMemo, useState } from 'react';
import { SHIFT_TYPE_LABELS, SHIFT_TYPES, type ShiftType } from '../../shared/constants';
import { addDays, isoWeekday, localDateOf, localTimeOf, localToUtcLenient, todayIn, weekdayLabel } from '../../shared/time';
import { api, ApiError, qs } from '../api/client';
import { useApi, useApiMutation, useCan, useCurrentLocation, useMe } from '../api/hooks';
import { Alert, Badge, Button, EmptyState, ErrorMessage, Modal, PageHeader, SelectField, Spinner, TextField } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import type { StaffDto } from './settings/CatalogPages';

interface ShiftDto {
  id: string;
  staffId: string;
  locationId: string | null;
  type: ShiftType;
  startsAt: string;
  endsAt: string;
  source: string;
  note: string | null;
}

const TONE: Record<ShiftType, string> = {
  work: 'success',
  break: 'neutral',
  vacation: 'accent',
  training: 'info',
  other_work: 'info',
  block: 'danger',
};

function mondayOf(date: string): string {
  return addDays(date, -(isoWeekday(date) - 1));
}

export function ShiftsPage() {
  const me = useMe();
  const can = useCan();
  const [locId, setLocId, locations] = useCurrentLocation();
  const loc = locations?.find((l) => l.id === locId);
  const tz = loc?.timezone ?? me.data?.organization?.timezone ?? 'Asia/Tokyo';
  const [week, setWeek] = useState(() => mondayOf(todayIn(tz)));
  const from = localToUtcLenient(week, '00:00', tz).toISOString();
  const to = localToUtcLenient(addDays(week, 7), '00:00', tz).toISOString();
  const manage = can('shift.manage');
  const ownOnly = !manage && !can('shift.read.all');
  const staff = useApi<{ items: StaffDto[] }>(['staff-list', locId], locId ? `/api/v1/staff${qs({ locationId: locId })}` : null, { enabled: !ownOnly });
  const shifts = useApi<{ items: ShiftDto[] }>(
    ['shifts', locId, week, ownOnly],
    locId || ownOnly ? `/api/v1/shifts${qs({ from, to, locationId: ownOnly ? undefined : locId, staffId: ownOnly ? me.data?.membership?.staffId : undefined })}` : null,
  );
  const [edit, setEdit] = useState<{ shift: ShiftDto | null; staffId: string; date: string } | null>(null);
  const [template, setTemplate] = useState<StaffDto | null>(null);
  const [generate, setGenerate] = useState(false);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(week, i)), [week]);
  const rows: { id: string; displayName: string }[] = ownOnly
    ? me.data?.membership?.staffId
      ? [{ id: me.data.membership.staffId, displayName: '自分' }]
      : []
    : (staff.data?.items ?? []).filter((s) => s.status === 'active');
  const cell = (staffId: string, date: string) =>
    (shifts.data?.items ?? []).filter((s) => s.staffId === staffId && localDateOf(s.startsAt, tz) === date).sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  return (
    <>
      <PageHeader
        title={ownOnly ? '自分のシフト' : 'シフト'}
        sub={`${week} 〜 ${addDays(week, 6)}(${tz})`}
        actions={
          <>
            {!ownOnly && (locations?.length ?? 0) > 1 ? (
              <select className="select" style={{ width: 'auto' }} aria-label="拠点" value={locId ?? ''} onChange={(e) => setLocId(e.target.value)}>
                {locations!.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            ) : null}
            <Button onClick={() => setWeek(addDays(week, -7))} aria-label="前の週">
              ‹ 前週
            </Button>
            <Button onClick={() => setWeek(mondayOf(todayIn(tz)))}>今週</Button>
            <Button onClick={() => setWeek(addDays(week, 7))} aria-label="次の週">
              次週 ›
            </Button>
            {manage ? (
              <Button variant="primary" onClick={() => setGenerate(true)}>
                テンプレートから生成
              </Button>
            ) : null}
          </>
        }
      />
      <ErrorMessage error={shifts.error} />
      {shifts.isLoading || staff.isLoading ? <Spinner /> : null}
      {rows.length === 0 && !shifts.isLoading ? <EmptyState title="表示するスタッフがいません" /> : null}
      {rows.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">スタッフ</th>
                {days.map((d) => (
                  <th key={d} scope="col">
                    {d.slice(5).replace('-', '/')}({weekdayLabel(isoWeekday(d))})
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <th scope="row" style={{ minWidth: 110 }}>
                    <div>{s.displayName}</div>
                    {manage ? (
                      <button type="button" className="link-btn small" onClick={() => setTemplate(staff.data?.items.find((x) => x.id === s.id) ?? null)}>
                        週テンプレート
                      </button>
                    ) : null}
                  </th>
                  {days.map((d) => (
                    <td key={d} style={{ minWidth: 118 }}>
                      <div className="stack" style={{ gap: 4 }}>
                        {cell(s.id, d).map((sh) => (
                          <button
                            key={sh.id}
                            type="button"
                            className={`badge tone-${TONE[sh.type]}`}
                            style={{ cursor: manage ? 'pointer' : 'default', border: '1px solid', justifyContent: 'flex-start' }}
                            onClick={() => manage && setEdit({ shift: sh, staffId: s.id, date: d })}
                            disabled={!manage}
                            title={sh.note ?? undefined}
                          >
                            {SHIFT_TYPE_LABELS[sh.type]} {localTimeOf(sh.startsAt, tz)}-{localTimeOf(sh.endsAt, tz)}
                            {sh.locationId && sh.locationId !== locId && !ownOnly ? <span aria-label="他拠点">*</span> : null}
                          </button>
                        ))}
                        {manage ? (
                          <button type="button" className="link-btn small" onClick={() => setEdit({ shift: null, staffId: s.id, date: d })} aria-label={`${s.displayName} ${d} にシフトを追加`}>
                            + 追加
                          </button>
                        ) : null}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="small muted" style={{ marginTop: 8 }}>
        * は他拠点での勤務です。同じスタッフが同じ時間に2つの拠点で勤務することはできません。
      </p>
      {edit && locId ? <ShiftModal edit={edit} tz={tz} locationId={locId} locations={locations ?? []} onClose={() => setEdit(null)} /> : null}
      {template ? <TemplateModal staff={template} locations={(locations ?? []).filter((l) => template.locationIds.includes(l.id))} onClose={() => setTemplate(null)} /> : null}
      {generate && locId ? <GenerateModal staff={rows} week={week} onClose={() => setGenerate(false)} /> : null}
    </>
  );
}

function ShiftModal({
  edit,
  tz,
  locationId,
  locations,
  onClose,
}: {
  edit: { shift: ShiftDto | null; staffId: string; date: string };
  tz: string;
  locationId: string;
  locations: { id: string; name: string }[];
  onClose: () => void;
}) {
  const s = edit.shift;
  const [type, setType] = useState<ShiftType>(s?.type ?? 'work');
  const [loc, setLoc] = useState(s?.locationId ?? locationId);
  const [start, setStart] = useState(s ? localTimeOf(s.startsAt, tz) : '10:00');
  const [end, setEnd] = useState(s ? localTimeOf(s.endsAt, tz) : '19:00');
  const [note, setNote] = useState(s?.note ?? '');
  const [conflicts, setConflicts] = useState<{ bookingId: string; startsAt: string; reason: string }[] | null>(null);
  const body = (ack: boolean) => ({
    staffId: edit.staffId,
    locationId: type === 'vacation' ? null : loc,
    type,
    startsAt: localToUtcLenient(edit.date, start, tz).toISOString(),
    endsAt: localToUtcLenient(edit.date, end, tz).toISOString(),
    note: note || null,
    acknowledgeConflicts: ack,
  });
  const onErr = (e: ApiError) => {
    if (e.code === 'CONFLICT' && e.details?.requiresAcknowledgement) setConflicts(e.details.conflicts);
  };
  const save = useApiMutation(
    (ack: boolean) => {
      const b = body(ack);
      if (s) {
        const { staffId: _s, ...rest } = b;
        return api.patch(`/api/v1/shifts/${s.id}`, rest);
      }
      return api.post('/api/v1/shifts', b);
    },
    { invalidate: [['shifts']], success: '保存しました', onSuccess: onClose, onError: onErr },
  );
  const del = useApiMutation((ack: boolean) => api.del(`/api/v1/shifts/${s!.id}${qs({ acknowledgeConflicts: ack ? 'true' : undefined })}`), {
    invalidate: [['shifts']],
    success: '削除しました',
    onSuccess: onClose,
    onError: onErr,
  });
  return (
    <Modal
      title={`${edit.date} のシフト${s ? 'を編集' : 'を追加'}`}
      onClose={onClose}
      footer={
        <>
          {s ? (
            <Button variant="danger" busy={del.isPending} onClick={() => del.mutate(Boolean(conflicts))}>
              削除
            </Button>
          ) : null}
          <Button onClick={onClose}>閉じる</Button>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate(Boolean(conflicts))}>
            {conflicts ? '競合を承知で保存' : '保存する'}
          </Button>
        </>
      }
    >
      <div className="stack">
        {conflicts ? (
          <Alert tone="warning">
            <strong>既存の予約{conflicts.length}件と競合します。</strong>予約は自動で削除・移動されません。必要に応じて予約の担当変更やお客様への連絡を行ってください。
            <ul>
              {conflicts.map((c) => (
                <li key={c.bookingId}>
                  {fmtDateTime(c.startsAt, tz)} — {c.reason}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}
        <SelectField label="種類" value={type} onChange={(e) => setType(e.target.value as ShiftType)} options={SHIFT_TYPES.map((t) => ({ value: t, label: SHIFT_TYPE_LABELS[t] }))} />
        {type !== 'vacation' ? <SelectField label="拠点" value={loc} onChange={(e) => setLoc(e.target.value)} options={locations.map((l) => ({ value: l.id, label: l.name }))} /> : null}
        <div className="grid-2">
          <TextField label="開始" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          <TextField label="終了" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <TextField label="メモ" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

function TemplateModal({ staff, locations, onClose }: { staff: StaffDto; locations: { id: string; name: string }[]; onClose: () => void }) {
  const tpl = useApi<{ items: { locationId: string; weekday: number; type: 'work' | 'break'; startTime: string; endTime: string }[] }>(
    ['shift-template', staff.id],
    `/api/v1/shift-templates${qs({ staffId: staff.id })}`,
  );
  const [items, setItems] = useState<{ locationId: string; weekday: number; type: 'work' | 'break'; startTime: string; endTime: string }[] | null>(null);
  const list = items ?? tpl.data?.items ?? [];
  const save = useApiMutation(() => api.put(`/api/v1/shift-templates/${staff.id}`, { items: list }), { success: 'テンプレートを保存しました', onSuccess: onClose });
  const upd = (i: number, p: Partial<(typeof list)[number]>) => setItems(list.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <Modal
      title={`${staff.displayName} の週テンプレート`}
      wide
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>閉じる</Button>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate(undefined)}>
            保存する
          </Button>
        </>
      }
    >
      <ErrorMessage error={save.error} />
      {tpl.isLoading ? <Spinner /> : null}
      <div className="stack">
        {list.map((x, i) => (
          <div className="row" key={i}>
            <select className="select" style={{ width: 'auto' }} aria-label="曜日" value={x.weekday} onChange={(e) => upd(i, { weekday: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6, 7].map((w) => (
                <option key={w} value={w}>
                  {weekdayLabel(w)}
                </option>
              ))}
            </select>
            <select className="select" style={{ width: 'auto' }} aria-label="種類" value={x.type} onChange={(e) => upd(i, { type: e.target.value as 'work' | 'break' })}>
              <option value="work">勤務</option>
              <option value="break">休憩</option>
            </select>
            <select className="select" style={{ width: 'auto' }} aria-label="拠点" value={x.locationId} onChange={(e) => upd(i, { locationId: e.target.value })}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <input className="input" type="time" aria-label="開始" style={{ width: 120 }} value={x.startTime} onChange={(e) => upd(i, { startTime: e.target.value })} />
            <span>〜</span>
            <input className="input" type="time" aria-label="終了" style={{ width: 120 }} value={x.endTime} onChange={(e) => upd(i, { endTime: e.target.value })} />
            <Button size="sm" onClick={() => setItems(list.filter((_, j) => j !== i))}>
              削除
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          disabled={locations.length === 0}
          onClick={() => setItems([...list, { locationId: locations[0].id, weekday: 1, type: 'work', startTime: '10:00', endTime: '19:00' }])}
        >
          + 行を追加
        </Button>
      </div>
    </Modal>
  );
}

function GenerateModal({ staff, week, onClose }: { staff: { id: string; displayName: string }[]; week: string; onClose: () => void }) {
  const [from, setFrom] = useState(week);
  const [to, setTo] = useState(addDays(week, 27));
  const [result, setResult] = useState<{ created: number; skippedExisting: number; skippedClosed: number } | null>(null);
  const gen = useApiMutation(() => api.post('/api/v1/shifts/generate', { staffIds: staff.map((s) => s.id), from, to }), {
    invalidate: [['shifts']],
    onSuccess: (r) => setResult(r),
  });
  return (
    <Modal title="テンプレートからシフトを生成" onClose={onClose} footer={<Button variant="primary" busy={gen.isPending} onClick={() => gen.mutate(undefined)}>生成する</Button>}>
      <div className="stack">
        <p className="small">表示中の拠点のスタッフ({staff.length}名)の週テンプレートからシフトを作成します。すでにシフトがある日は上書きせずスキップします。定休日・臨時休業日もスキップします。</p>
        <div className="grid-2">
          <TextField label="開始日" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <TextField label="終了日" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <ErrorMessage error={gen.error} />
        {result ? (
          <Alert tone="success">
            作成 {result.created}件 / 既存のためスキップ {result.skippedExisting}日 / 休業日のためスキップ {result.skippedClosed}件
          </Alert>
        ) : null}
        <Badge tone="info">最大92日</Badge>
      </div>
    </Modal>
  );
}
