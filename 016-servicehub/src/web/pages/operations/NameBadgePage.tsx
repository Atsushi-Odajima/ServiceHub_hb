/**
 * ServiceHub 名札・受付表(#010 名札・受付チェック表メーカーを統合)。
 * 予約から、回(同じサービス・同じ開始時刻)または1日分の名札(91mm × 55mm、A4に10枚)と
 * 受付チェック表(A4に20人、手書きチェック用)を作り、ブラウザの印刷で紙/PDFにする。
 * 名札と受付表には同じ参加者番号(予約を受けた順の P001…)が載る。
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router';
import {
  type BadgeBooking,
  type BadgeLayout,
  buildDocument,
  buildParticipants,
  LIMITS,
  ORG_FIELD_LABELS,
  type OrgField,
  OUTPUT_MODE_LABELS,
  type OutputMode,
  PARTY_MODE_LABELS,
  type PartyMode,
  type PrintDocument,
  sheetMetaText,
  SORT_LABELS,
  type SortOrder,
} from '../../../shared/namebadge/core';
import { formatDateJa, todayIn } from '../../../shared/time';
import { qs } from '../../api/client';
import { useApi, useCurrentLocation, useMe } from '../../api/hooks';
import { Alert, Button, Card, Checkbox, EmptyState, ErrorMessage, PageHeader, SelectField, Spinner, TextField } from '../../components/ui';

interface Session {
  serviceId: string;
  serviceName: string;
  startsAt: string;
  startTime: string;
  endTime: string;
  capacity: number;
  staffNames: string[];
  bookings: number;
  people: number;
}

interface NameBadgeData {
  location: { id: string; name: string; timezone: string };
  date: string;
  scope: 'session' | 'day';
  sessions: Session[];
  selected: Session | null;
  bookings: BadgeBooking[];
}

const DAY = 'day';
const sessionKey = (s: { serviceId: string; startsAt: string }) => `${s.serviceId}|${s.startsAt}`;

function Badge({ b, eventName }: { b: BadgeLayout; eventName: string }) {
  return (
    <div className="nb-badge" data-no={b.p.number}>
      <div className="nb-badge-top">
        <div className="nb-badge-event" style={{ fontSize: `${b.eventPt}pt` }}>
          {eventName}
        </div>
        <div className="nb-badge-no" style={{ fontSize: `${b.noPt}pt` }}>
          {b.p.number}
        </div>
      </div>
      <div className="nb-badge-main">
        {b.p.kana ? (
          <div className="nb-badge-kana" style={{ fontSize: `${b.kanaPt}pt` }}>
            {b.p.kana}
          </div>
        ) : null}
        <div className={`nb-badge-name${b.p.companion ? ' nb-blank' : ''}`} style={{ fontSize: `${b.namePt}pt` }}>
          {b.p.name}
        </div>
        {b.p.org ? (
          <div className="nb-badge-org" style={{ fontSize: `${b.orgPt}pt` }}>
            {b.p.org}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 印刷用のページ(画面のプレビューと印刷で同じ部品を使う) */
function Sheets({ doc, eventName, eventDate }: { doc: PrintDocument; eventName: string; eventDate: string }) {
  return (
    <>
      {doc.badgePages.map((page, i) => (
        <div key={`b${i}`} className="nb-sheet nb-sheet-badges">
          <div className="nb-badge-grid">
            {page.map((b) => (
              <Badge key={b.p.number} b={b} eventName={eventName} />
            ))}
          </div>
        </div>
      ))}
      {doc.sheetPages.map((page) => (
        <div key={`s${page.pageNo}`} className="nb-sheet nb-sheet-reception">
          <div className="nb-rs-header">
            <div className="nb-rs-head-main">
              <div className="nb-rs-title">受付チェック表</div>
              {eventName ? (
                <div className="nb-rs-event" style={{ fontSize: `${doc.sheetEventPt}pt` }}>
                  {eventName}
                </div>
              ) : null}
              <div className="nb-rs-meta">{sheetMetaText(eventDate, doc.countText)}</div>
            </div>
            <div className="nb-rs-page">
              ページ <strong>{page.pageNo}</strong> / {page.pageTotal}
            </div>
          </div>
          <div className="nb-rs-table">
            <div className="nb-rs-row nb-rs-head">
              <div className="nb-rs-cell nb-rs-check">受付</div>
              <div className="nb-rs-cell">参加者番号</div>
              <div className="nb-rs-cell">氏名・表示名</div>
              <div className="nb-rs-cell">所属</div>
              <div className="nb-rs-cell">メモ</div>
            </div>
            {page.rows.map((r) => (
              <div key={r.p.number} className="nb-rs-row nb-rs-data" data-no={r.p.number}>
                <div className="nb-rs-cell nb-rs-check">
                  <div className="nb-rs-box" />
                </div>
                <div className="nb-rs-cell nb-rs-no">
                  <div className="nb-rs-text" style={{ fontSize: `${r.noPt}pt` }}>
                    {r.p.number}
                  </div>
                </div>
                <div className="nb-rs-cell nb-rs-name">
                  <div className="nb-rs-text" style={{ fontSize: `${r.namePt}pt` }}>
                    {r.nameText}
                  </div>
                </div>
                <div className="nb-rs-cell nb-rs-org">
                  <div className="nb-rs-text" style={{ fontSize: `${r.orgPt}pt` }}>
                    {r.p.org}
                  </div>
                </div>
                <div className="nb-rs-cell nb-rs-memo" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

export function NameBadgePage() {
  const me = useMe();
  const tz = me.data?.organization?.timezone ?? 'Asia/Tokyo';
  const [params, setParams] = useSearchParams();
  const [currentLoc, setCurrentLoc, locations] = useCurrentLocation();
  const paramLoc = params.get('locationId');
  const locationId = paramLoc && locations?.some((l) => l.id === paramLoc) ? paramLoc : currentLoc;
  const date = params.get('date') ?? todayIn(tz);
  const target = params.get('serviceId') && params.get('startsAt') ? `${params.get('serviceId')}|${params.get('startsAt')}` : DAY;
  const update = (next: { locationId?: string; date?: string; target?: string }) => {
    const loc = next.locationId ?? locationId ?? '';
    const t = next.target ?? (next.date || next.locationId ? DAY : target);
    const [serviceId, startsAt] = t === DAY ? [null, null] : t.split('|');
    const p: Record<string, string> = { locationId: loc, date: next.date ?? date };
    if (serviceId && startsAt) Object.assign(p, { serviceId, startsAt });
    if (next.locationId) setCurrentLoc(next.locationId);
    setParams(p, { replace: true });
  };

  // 一覧(回の候補)は1日分、選んだ回の予約は回を指定して取得する
  const [svcId, startsAt] = target === DAY ? [undefined, undefined] : target.split('|');
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const data = useApi<NameBadgeData>(
    ['name-badges', locationId, date, target],
    locationId && valid ? `/api/v1/name-badges${qs({ locationId, date, serviceId: svcId, startsAt })}` : null,
  );

  const [partyMode, setPartyMode] = useState<PartyMode>('person');
  const [sort, setSort] = useState<SortOrder>('number');
  const [orgField, setOrgField] = useState<OrgField>('none');
  const [showKana, setShowKana] = useState(true);
  const [mode, setMode] = useState<OutputMode>('both');
  const [eventName, setEventName] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  // 対象(拠点・日付・回)が変わったら、イベント名・開催日の既定値と除外を作り直す
  const d0 = data.data;
  const scopeKey = d0 ? `${d0.location.id}|${d0.date}|${d0.selected ? sessionKey(d0.selected) : DAY}` : '';
  useEffect(() => {
    const d = data.data;
    if (!d) return;
    const s = d.selected;
    setEventName((s ? s.serviceName : d.location.name).slice(0, LIMITS.eventName));
    setEventDate(s ? `${formatDateJa(d.date)} ${s.startTime}〜${s.endTime}` : formatDateJa(d.date));
    setExcluded(new Set());
    setSort(s ? 'number' : 'time');
    setOrgField(s ? 'none' : 'service');
  }, [scopeKey]);

  const participants = useMemo(
    () => (data.data ? buildParticipants(data.data.bookings, { partyMode, sort, orgField, showKana }) : []),
    [data.data, partyMode, sort, orgField, showKana],
  );
  const doc = useMemo(() => buildDocument({ participants, excluded, eventName, eventDate, mode, partyMode }), [participants, excluded, eventName, eventDate, mode, partyMode]);
  const blocked = doc.problems.length > 0;

  // 印刷中だけ A4・余白なしにする(他の画面の印刷には影響させない)
  useEffect(() => {
    const style = document.createElement('style');
    style.setAttribute('data-nb-print', '');
    style.textContent = '@page { size: A4 portrait; margin: 0; }';
    document.head.appendChild(style);
    document.body.classList.add('nb-printing');
    return () => {
      style.remove();
      document.body.classList.remove('nb-printing');
    };
  }, []);

  const sessions = data.data?.sessions ?? [];
  const sessionOptions = [
    { value: DAY, label: 'この日の全予約(1日分)' },
    ...sessions.map((s) => ({
      value: sessionKey(s),
      label: `${s.startTime}〜${s.endTime} ${s.serviceName}(${s.people}名${s.capacity > 1 ? `/定員${s.capacity}` : ''}${s.staffNames.length ? `・${s.staffNames.join('、')}` : ''})`,
    })),
  ];
  if (target !== DAY && !sessionOptions.some((o) => o.value === target)) sessionOptions.push({ value: target, label: '指定の回' });

  return (
    <>
      <PageHeader
        title="ServiceHub 名札・受付表"
        sub="予約から名札(91mm × 55mm・A4に10枚)と受付チェック表(A4に20人)を作ります。どちらにも同じ参加者番号が入ります。"
        actions={
          <Button variant="primary" onClick={() => window.print()} disabled={blocked || data.isLoading}>
            印刷 / PDF保存
          </Button>
        }
      />
      <Card title="対象">
        <div className="grid-auto">
          {(locations?.length ?? 0) > 1 ? (
            <SelectField label="拠点" value={locationId ?? ''} onChange={(e) => update({ locationId: e.target.value })} options={(locations ?? []).map((l) => ({ value: l.id, label: l.name }))} />
          ) : null}
          <TextField label="日付" type="date" value={date} onChange={(e) => e.target.value && update({ date: e.target.value })} />
          <SelectField label="回(サービスと開始時刻)" value={target} onChange={(e) => update({ target: e.target.value })} options={sessionOptions} />
        </div>
        <p className="small muted">キャンセル・無断欠席の予約は載りません(番号は欠番のまま残り、他の人の番号は変わりません)。</p>
      </Card>
      <Card title="印刷の設定">
        <div className="grid-auto">
          <TextField label="イベント名(名札の上部・受付表)" value={eventName} maxLength={LIMITS.eventName * 2} onChange={(e) => setEventName(e.target.value)} hint={`${LIMITS.eventName}文字まで`} />
          <TextField label="開催日(受付表)" value={eventDate} maxLength={LIMITS.eventDate * 2} onChange={(e) => setEventDate(e.target.value)} hint={`${LIMITS.eventDate}文字まで・入力したとおりに印刷`} />
          <SelectField label="出力対象" value={mode} onChange={(e) => setMode(e.target.value as OutputMode)} options={Object.entries(OUTPUT_MODE_LABELS).map(([value, label]) => ({ value, label }))} />
          <SelectField label="複数名の予約" value={partyMode} onChange={(e) => setPartyMode(e.target.value as PartyMode)} options={Object.entries(PARTY_MODE_LABELS).map(([value, label]) => ({ value, label }))} />
          <SelectField label="並び順" value={sort} onChange={(e) => setSort(e.target.value as SortOrder)} options={Object.entries(SORT_LABELS).map(([value, label]) => ({ value, label }))} />
          <SelectField label="所属欄に出す内容" value={orgField} onChange={(e) => setOrgField(e.target.value as OrgField)} options={Object.entries(ORG_FIELD_LABELS).map(([value, label]) => ({ value, label }))} />
        </div>
        <Checkbox label="名札にふりがなを入れる" checked={showKana} onChange={(e) => setShowKana(e.target.checked)} />
      </Card>
      <ErrorMessage error={data.error} retry={() => void data.refetch()} />
      {data.isLoading ? <Spinner /> : null}
      {data.data ? (
        participants.length === 0 ? (
          <EmptyState title="印刷できる予約がありません">日付や回を変えてください。</EmptyState>
        ) : (
          <>
            <Card title={`参加者(${participants.length - doc.targets.length > 0 ? `${doc.targets.length} / ${participants.length}` : participants.length}件)`}>
              <p className="small muted">チェックを外すと、名札と受付表の両方から外れます(欠席が分かっている人など)。番号は変わりません。</p>
              <ul className="list nb-participants">
                {participants.map((p) => (
                  <li key={p.number} className="list-item">
                    <Checkbox
                      label={
                        <>
                          <strong className="mono">{p.number}</strong> {p.companion ? '(同行者)' : p.name}
                          {p.kana ? <span className="small muted"> {p.kana}</span> : null}
                          {data.data.scope === 'day' ? <span className="small muted"> {p.startTime}</span> : null}
                        </>
                      }
                      checked={!excluded.has(p.number)}
                      onChange={(e) =>
                        setExcluded((prev) => {
                          const n = new Set(prev);
                          if (e.target.checked) n.delete(p.number);
                          else n.add(p.number);
                          return n;
                        })
                      }
                    />
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="印刷プレビュー">
              <p data-testid="nb-pages">
                名札 {doc.pages.badges}ページ・受付表 {doc.pages.sheet}ページ(合計 {doc.pages.total}ページ)
              </p>
              {blocked ? (
                <Alert tone="warning">
                  <strong>確認事項(直すまで印刷できません)</strong>
                  <ul data-testid="nb-problems">
                    {doc.problems.slice(0, 30).map((p, i) => (
                      <li key={i}>{p.text}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
              <details className="small">
                <summary>印刷のしかた</summary>
                <p>印刷画面で 用紙サイズ A4(縦)・倍率 100%(「ページに合わせる」はオフ)・ヘッダーとフッター オフ・余白「なし」にしてください。PDF にする場合は送信先で「PDFに保存」を選びます。初めてのプリンターでは1ページだけ印刷し、名札が 91mm × 55mm になっているか定規で確かめてください。</p>
              </details>
              <div className="nb-preview" role="region" aria-label="印刷プレビュー" tabIndex={0}>
                <Sheets doc={doc} eventName={eventName} eventDate={eventDate} />
              </div>
            </Card>
          </>
        )
      ) : null}
      {data.data && !blocked ? createPortal(<div className="nb-print-root">{<Sheets doc={doc} eventName={eventName} eventDate={eventDate} />}</div>, document.body) : null}
    </>
  );
}
