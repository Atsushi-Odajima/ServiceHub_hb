/**
 * ServiceHub 空き枠お知らせ画像(#005 サロン空き枠お知らせ画像メーカーを統合)。
 * 予約エンジンの実際の空き枠から、SNS 向けの「空き枠のお知らせ」画像(PNG)を作る。
 * 日ごとの休業/満席、枠の非表示・状態・メニュー名は手動で上書きできる(上書きは画像だけに反映され、予約データは変えない)。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type AnnState,
  type AnnouncementOverrides,
  type AvailabilityDay,
  buildAnnouncementState,
  collectIssues,
  DAY_MODE_LABELS,
  type DayMode,
  eligibleSlots,
  emptyOverrides,
  formatJaDate,
  imageFileName,
  LIMITS,
  MAX_SLOTS_PER_DAY,
  type OutputMode,
  PALETTE_LABELS,
  type PaletteId,
  resolveDay,
  SINGLE_TITLE_TEXT,
  type SingleTitle,
  SIZE_LABELS,
  type SizeId,
  slotKey,
  type SlotStatus,
  STATUS_LABELS,
} from '../../../shared/announcement/core';
import { renderAnnouncement } from '../../../shared/announcement/render';
import { todayIn } from '../../../shared/time';
import { qs } from '../../api/client';
import { useApi, useCurrentLocation, useMe } from '../../api/hooks';
import { Alert, Button, Card, EmptyState, ErrorMessage, PageHeader, SelectField, Spinner, TextField } from '../../components/ui';

interface AnnouncementData {
  from: string;
  to: string;
  today: string;
  timezone: string;
  basis: 'public' | 'staff';
  location: { name: string; isPublic: boolean };
  service: { name: string; isPublic: boolean; durationMin: number };
  days: AvailabilityDay[];
}

interface ShopText {
  name: string;
  booking: string;
  note: string;
}

const TEXT_KEY = 'sh.announcement.text';
const DESIGN_KEY = 'sh.announcement.design';

/** 店舗名・案内文・デザインはこの端末に覚えておく(画面の便利機能。共有はしない) */
function loadLocal<T>(key: string, orgId: string | undefined, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${key}:${orgId ?? ''}`);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
}
function saveLocal(key: string, orgId: string | undefined, v: unknown): void {
  try {
    localStorage.setItem(`${key}:${orgId ?? ''}`, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

export function AnnouncementPage() {
  const me = useMe();
  const orgId = me.data?.organization?.id;
  const tz = me.data?.organization?.timezone ?? 'Asia/Tokyo';
  const [locationId, setLocationId, locations] = useCurrentLocation();
  const [serviceId, setServiceId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [from, setFrom] = useState(() => todayIn(tz));
  const [basis, setBasis] = useState<'public' | 'staff'>('public');
  const [shop, setShop] = useState<ShopText>(() => loadLocal(TEXT_KEY, orgId, { name: me.data?.organization?.name ?? '', booking: '', note: '' }));
  const [design, setDesign] = useState<{ palette: PaletteId; size: SizeId }>(() => loadLocal(DESIGN_KEY, orgId, { palette: 'white', size: 'square' }));
  const [output, setOutput] = useState<{ mode: OutputMode; singleKey: string | null; singleTitle: SingleTitle }>({ mode: 'week', singleKey: null, singleTitle: 'vacancy' });
  const [overrides, setOverrides] = useState<AnnouncementOverrides>(emptyOverrides);

  useEffect(() => saveLocal(TEXT_KEY, orgId, shop), [orgId, shop]);
  useEffect(() => saveLocal(DESIGN_KEY, orgId, design), [orgId, design]);

  const services = useApi<{ items: { id: string; name: string; requiresStaff: boolean; isPublic: boolean }[] }>(
    ['services', 'loc', locationId],
    locationId ? `/api/v1/services${qs({ locationId })}` : null,
  );
  const staff = useApi<{ items: { id: string; displayName: string; serviceIds: string[] }[] }>(
    ['staff-list', 'loc', locationId],
    locationId ? `/api/v1/staff${qs({ locationId })}` : null,
  );
  const svcList = services.data?.items ?? [];
  const svc = svcList.find((s) => s.id === serviceId) ?? svcList[0] ?? null;
  const staffOptions = (staff.data?.items ?? []).filter((s) => svc && s.serviceIds.includes(svc.id));

  const data = useApi<AnnouncementData>(
    ['announcement', locationId, svc?.id, staffId, from, basis],
    locationId && svc && /^\d{4}-\d{2}-\d{2}$/.test(from)
      ? `/api/v1/availability/announcement${qs({ locationId, serviceId: svc.id, from, basis, staffId: svc.requiresStaff && staffId ? staffId : undefined })}`
      : null,
  );

  // 対象(拠点・サービス・期間)が変わったら手動の上書きは捨てる(別の枠に誤って効かせない)
  useEffect(() => {
    setOverrides(emptyOverrides());
    setOutput((o) => ({ ...o, singleKey: null }));
  }, [locationId, svc?.id, staffId, from, basis]);

  const state: AnnState | null = useMemo(
    () => (data.data ? buildAnnouncementState({ shop, design, output, startDate: data.data.from, days: data.data.days, overrides }) : null),
    [data.data, shop, design, output, overrides],
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [problems, setProblems] = useState<{ level: string; message: string }[]>([]);
  useEffect(() => {
    if (!state || !canvasRef.current) return;
    try {
      const r = renderAnnouncement(canvasRef.current, state);
      setProblems(r.problems);
    } catch (e) {
      setProblems([{ level: 'error', message: (e as Error).message }]);
    }
  }, [state]);

  const issues = state ? [...collectIssues(state), ...problems] : [];
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');

  const download = () => {
    const canvas = canvasRef.current;
    if (!state || !canvas || errors.length > 0) return;
    if (warnings.length > 0 && !window.confirm(`確認してください:\n${warnings.map((w) => `・${w.message}`).join('\n')}\n\nこのまま画像を保存しますか?`)) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = imageFileName(state);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }, 'image/png');
  };

  const setDay = (date: string, patch: Partial<{ mode: 'auto' | DayMode; times: string[] | null }>) =>
    setOverrides((o) => {
      const cur = o.days[date] ?? { mode: 'auto' as const, times: null };
      return { ...o, days: { ...o.days, [date]: { ...cur, ...patch } } };
    });

  if (!locationId) return <EmptyState title="担当の拠点がありません" />;

  return (
    <div className="stack-lg">
      <PageHeader title="ServiceHub 空き枠お知らせ画像" sub="予約の空き状況から、SNS などに載せる「空き枠のお知らせ」画像(PNG)を作ります。" />

      <Card title="1. 対象">
        <div className="grid-3">
          <SelectField label="拠点" value={locationId} onChange={(e) => setLocationId(e.target.value)} options={(locations ?? []).map((l) => ({ value: l.id, label: l.name }))} />
          <SelectField
            label="サービス"
            value={svc?.id ?? ''}
            onChange={(e) => setServiceId(e.target.value)}
            options={svcList.map((s) => ({ value: s.id, label: s.name }))}
            placeholder={svcList.length === 0 ? 'この拠点のサービスがありません' : undefined}
          />
          {svc?.requiresStaff ? (
            <SelectField
              label="担当スタッフ"
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
              options={staffOptions.map((s) => ({ value: s.id, label: s.displayName }))}
              placeholder="指定なし(誰かが空いていれば空き)"
            />
          ) : null}
          <TextField label="開始日(7日分)" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <SelectField
            label="空きの基準"
            value={basis}
            onChange={(e) => setBasis(e.target.value as 'public' | 'staff')}
            options={[
              { value: 'public', label: '公開予約ページと同じ条件' },
              { value: 'staff', label: 'スタッフが予約を入れられる条件' },
            ]}
            hint="公開予約ページの受付期間・直前締切を使うか、スタッフ側の条件で数えるかを選びます"
          />
        </div>
        {data.data && basis === 'public' && (!data.data.location.isPublic || !data.data.service.isPublic) ? (
          <Alert tone="warning">この拠点またはサービスは公開予約ページに出していないため、「公開予約ページと同じ条件」では空きがありません。「スタッフが予約を入れられる条件」に切り替えてください。</Alert>
        ) : null}
      </Card>

      <Card title="2. 店舗情報(画像に入る文字)">
        <div className="grid-3">
          <TextField label="店舗名" value={shop.name} maxLength={LIMITS.shopName} onChange={(e) => setShop({ ...shop, name: e.target.value })} hint={`${LIMITS.shopName}文字まで`} />
          <TextField label="予約方法の案内文" value={shop.booking} maxLength={LIMITS.booking} placeholder="例: ご予約はWebまたはDMから" onChange={(e) => setShop({ ...shop, booking: e.target.value })} hint={`${LIMITS.booking}文字まで`} />
          <TextField label="補足文" value={shop.note} maxLength={LIMITS.note} onChange={(e) => setShop({ ...shop, note: e.target.value })} hint={`${LIMITS.note}文字まで`} />
        </div>
      </Card>

      <Card title="3. 日ごとの枠">
        {data.isLoading ? <Spinner /> : null}
        <ErrorMessage error={data.error} retry={() => void data.refetch()} />
        {data.data ? (
          <div className="stack">
            <p className="small muted">
              空きのある時刻から1日{MAX_SLOTS_PER_DAY}枠まで自動で選びます(朝〜夜に散らばるように選びます)。時刻を押すと表示する枠を手動で選べます。上書きは画像だけに反映され、予約は変わりません。
            </p>
            {data.data.days.map((day) => (
              <DayEditor key={day.date} day={day} overrides={overrides} setOverrides={setOverrides} setDay={setDay} />
            ))}
          </div>
        ) : null}
      </Card>

      <Card title="4. デザインと保存">
        <div className="grid-3">
          <SelectField
            label="画像の種類"
            value={output.mode}
            onChange={(e) => setOutput({ ...output, mode: e.target.value as OutputMode })}
            options={[
              { value: 'week', label: '週間告知(7日分)' },
              { value: 'single', label: '1枠告知(1つの枠を大きく)' },
            ]}
          />
          <SelectField
            label="配色"
            value={design.palette}
            onChange={(e) => setDesign({ ...design, palette: e.target.value as PaletteId })}
            options={(Object.keys(PALETTE_LABELS) as PaletteId[]).map((p) => ({ value: p, label: PALETTE_LABELS[p] }))}
          />
          <SelectField
            label="画像サイズ"
            value={design.size}
            onChange={(e) => setDesign({ ...design, size: e.target.value as SizeId })}
            options={[
              { value: 'square', label: `${SIZE_LABELS.square}(1080×1080)` },
              { value: 'story', label: `${SIZE_LABELS.story}(1080×1920)` },
            ]}
          />
          {output.mode === 'single' && state ? (
            <>
              <SelectField
                label="告知する枠"
                value={output.singleKey ?? ''}
                onChange={(e) => setOutput({ ...output, singleKey: e.target.value || null })}
                placeholder="選んでください"
                options={eligibleSlots(state).map((s) => ({ value: slotKey(s.date, s.time), label: `${formatJaDate(s.date, false)} ${s.time}${s.label ? ` ${s.label}` : ''}` }))}
              />
              <SelectField
                label="タイトル"
                value={output.singleTitle}
                onChange={(e) => setOutput({ ...output, singleTitle: e.target.value as SingleTitle })}
                options={(Object.keys(SINGLE_TITLE_TEXT) as SingleTitle[]).map((t) => ({ value: t, label: SINGLE_TITLE_TEXT[t] }))}
              />
            </>
          ) : null}
        </div>
      </Card>

      <Card title="プレビュー">
        {state ? (
          <div className="stack">
            <canvas
              ref={canvasRef}
              data-testid="announcement-canvas"
              role="img"
              aria-label="空き枠お知らせ画像のプレビュー"
              style={{ width: '100%', maxWidth: design.size === 'square' ? 480 : 360, height: 'auto', border: '1px solid #ddd', borderRadius: 8 }}
            />
            {errors.length > 0 ? (
              <Alert tone="danger">
                <strong>画像を保存できません</strong>
                <ul>
                  {errors.map((e, i) => (
                    <li key={i}>{e.message}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            {warnings.length > 0 ? (
              <Alert tone="warning">
                <ul>
                  {warnings.map((e, i) => (
                    <li key={i}>{e.message}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            <div>
              <Button variant="primary" onClick={download} disabled={errors.length > 0}>
                画像を保存(PNG)
              </Button>
            </div>
          </div>
        ) : (
          <p className="muted small">対象を選ぶとプレビューが表示されます。</p>
        )}
      </Card>
    </div>
  );
}

function DayEditor({
  day,
  overrides,
  setOverrides,
  setDay,
}: {
  day: AvailabilityDay;
  overrides: AnnouncementOverrides;
  setOverrides: (f: (o: AnnouncementOverrides) => AnnouncementOverrides) => void;
  setDay: (date: string, patch: Partial<{ mode: 'auto' | DayMode; times: string[] | null }>) => void;
}) {
  const ov = overrides.days[day.date];
  const r = resolveDay(day, ov);
  const shown = new Set(r.times);
  const toggle = (time: string) => {
    const next = shown.has(time) ? r.times.filter((t) => t !== time) : [...r.times, time];
    if (next.length > MAX_SLOTS_PER_DAY) return;
    setDay(day.date, { times: next });
  };
  const setStatus = (time: string, v: SlotStatus | '') =>
    setOverrides((o) => ({ ...o, slotStatus: { ...o.slotStatus, [slotKey(day.date, time)]: v || undefined } }));
  const setLabel = (time: string, v: string) => setOverrides((o) => ({ ...o, labels: { ...o.labels, [slotKey(day.date, time)]: v } }));
  return (
    <fieldset className="card" data-testid={`ann-day-${day.date}`}>
      <legend>
        <strong>{formatJaDate(day.date, false)}</strong>{' '}
        <span className="small muted">
          {day.closed ? '営業時間なし' : `空き ${day.slots.filter((s) => s.available).length} / 候補 ${day.slots.length}`}
        </span>
      </legend>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
        <SelectField
          label="この日の表示"
          value={ov?.mode ?? 'auto'}
          onChange={(e) => setDay(day.date, { mode: e.target.value as 'auto' | DayMode })}
          options={[
            { value: 'auto', label: `自動(${DAY_MODE_LABELS[r.autoMode]})` },
            { value: 'slots', label: DAY_MODE_LABELS.slots },
            { value: 'full', label: DAY_MODE_LABELS.full },
            { value: 'closed', label: DAY_MODE_LABELS.closed },
          ]}
        />
        {r.manual ? (
          <Button size="sm" onClick={() => setDay(day.date, { times: null })}>
            枠の選択を自動に戻す
          </Button>
        ) : null}
      </div>
      {r.mode === 'slots' && day.slots.length > 0 ? (
        <>
          <div className="row" style={{ flexWrap: 'wrap', gap: 4, marginTop: 8 }} role="group" aria-label="画像に載せる時刻">
            {day.slots.map((s) => (
              <button
                key={s.time}
                type="button"
                className={`btn btn-sm ${shown.has(s.time) ? 'btn-primary' : ''}`}
                aria-pressed={shown.has(s.time)}
                onClick={() => toggle(s.time)}
                disabled={!shown.has(s.time) && r.times.length >= MAX_SLOTS_PER_DAY}
                title={s.available ? '空きあり' : '空きなし'}
              >
                {s.time}
                {s.available ? '' : '(満)'}
              </button>
            ))}
          </div>
          {r.times.length > 0 ? (
            <div className="stack" style={{ marginTop: 8 }}>
              {r.times.map((time) => {
                const key = slotKey(day.date, time);
                const avail = day.slots.find((s) => s.time === time)?.available ?? false;
                return (
                  <div key={time} className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
                    <strong className="mono">{time}</strong>
                    <SelectField
                      label="状態"
                      value={overrides.slotStatus[key] ?? ''}
                      onChange={(e) => setStatus(time, e.target.value as SlotStatus | '')}
                      options={[
                        { value: '', label: `自動(${avail ? STATUS_LABELS.open : STATUS_LABELS.full})` },
                        { value: 'open', label: STATUS_LABELS.open },
                        { value: 'full', label: STATUS_LABELS.full },
                        { value: 'hidden', label: STATUS_LABELS.hidden },
                      ]}
                    />
                    <TextField label="メニュー名・補足" value={overrides.labels[key] ?? ''} maxLength={LIMITS.label} onChange={(e) => setLabel(time, e.target.value)} />
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="small muted">画像に載せる枠がありません(「情報未設定」と表示されます)。</p>
          )}
        </>
      ) : null}
    </fieldset>
  );
}
