import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { BookingPage } from '../../../shared/constants';
import { addDays, localToUtcLenient, todayIn, weekdayLabel } from '../../../shared/time';
import { api, qs, type ApiError } from '../../api/client';
import { useApi, useApiMutation, useCan } from '../../api/hooks';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  ErrorMessage,
  Modal,
  PageHeader,
  SelectField,
  Spinner,
  Tabs,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { fmtDate, fmtDateTime } from '../../lib/format';

export interface LocationDto {
  id: string;
  slug: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  timezone: string;
  status: string;
  isPublic: boolean;
  bookingPage: BookingPage;
  slotIntervalMin: number;
  minNoticeMin: number;
  maxAdvanceDays: number;
  maxConcurrentSessions: number | null;
  cancelDeadlineHours: number;
  allowCustomerCancel: boolean;
  allowCustomerReschedule: boolean;
  allowPublicWaitlist: boolean;
  sortOrder: number;
  hours?: { weekday: number; openTime: string; closeTime: string }[];
}

export function LocationsPage() {
  const can = useCan();
  const [includeArchived, setIncludeArchived] = useState(false);
  const list = useApi<{ items: LocationDto[] }>(['locations', includeArchived], `/api/v1/locations${qs({ includeArchived })}`);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title="拠点"
        actions={can('location.manage') ? <Button variant="primary" onClick={() => setCreating(true)}>拠点を追加</Button> : null}
      />
      <Checkbox label="アーカイブ済みも表示" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
      <ErrorMessage error={list.error} />
      {list.isLoading ? (
        <Spinner />
      ) : list.data?.items.length === 0 ? (
        <EmptyState title="拠点がありません" />
      ) : (
        <div className="table-wrap">
          <table className="table table-responsive">
            <thead>
              <tr>
                <th>拠点名</th>
                <th>URL名</th>
                <th>状態</th>
                <th>タイムゾーン</th>
                <th>電話</th>
              </tr>
            </thead>
            <tbody>
              {list.data?.items.map((l) => (
                <tr key={l.id}>
                  <td data-label="拠点名">
                    <Link to={`/app/settings/locations/${l.id}`}>{l.name}</Link>
                  </td>
                  <td data-label="URL名" className="mono">
                    {l.slug}
                  </td>
                  <td data-label="状態">
                    {l.status === 'archived' ? (
                      <Badge tone="muted" icon="■">アーカイブ</Badge>
                    ) : l.isPublic ? (
                      <Badge tone="success" icon="●">公開中</Badge>
                    ) : (
                      <Badge tone="warning" icon="○">非公開</Badge>
                    )}
                  </td>
                  <td data-label="タイムゾーン">{l.timezone}</td>
                  <td data-label="電話">{l.phone ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating ? <CreateLocationModal onClose={() => setCreating(false)} /> : null}
    </>
  );
}

const DEFAULT_HOURS = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, openTime: '10:00', closeTime: '19:00' }));

function CreateLocationModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [timezone, setTimezone] = useState('Asia/Tokyo');
  const create = useApiMutation((body: unknown) => api.post<LocationDto>('/api/v1/locations', body), {
    invalidate: [['locations'], ['me']],
    success: '拠点を追加しました',
    onSuccess: (l) => navigate(`/app/settings/locations/${l.id}`),
  });
  const err = create.error as ApiError | null;
  return (
    <Modal
      title="拠点を追加"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>やめる</Button>
          <Button variant="primary" busy={create.isPending} onClick={() => create.mutate({ name, slug, timezone, hours: DEFAULT_HOURS })} disabled={!name || !slug}>
            追加する
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField label="拠点名" value={name} onChange={(e) => setName(e.target.value)} required error={err?.fields?.name} />
        <TextField
          label="URL名(スラッグ)"
          hint="公開予約ページのURLに使います(英小文字・数字・ハイフン)。例: ikebukuro"
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          required
          error={err?.fields?.slug}
        />
        <TextField label="タイムゾーン" value={timezone} onChange={(e) => setTimezone(e.target.value)} error={err?.fields?.timezone} />
        <p className="small muted">営業時間は初期値(毎日10:00〜19:00)で作成します。作成後に変更してください。</p>
      </div>
    </Modal>
  );
}

type LocTab = 'basic' | 'hours' | 'exceptions' | 'blocks' | 'page';

export function LocationEditPage() {
  const { id = '' } = useParams();
  const can = useCan();
  const loc = useApi<LocationDto>(['location', id], `/api/v1/locations/${id}`);
  const [tab, setTab] = useState<LocTab>(can('location.manage') ? 'basic' : 'exceptions');
  if (loc.isLoading) return <Spinner />;
  if (loc.error) return <ErrorMessage error={loc.error} />;
  const l = loc.data!;
  const tabs: { value: LocTab; label: string }[] = [
    ...(can('location.manage')
      ? [
          { value: 'basic' as const, label: '基本情報・予約ルール' },
          { value: 'hours' as const, label: '営業時間' },
        ]
      : []),
    { value: 'exceptions', label: '臨時休業・特別営業' },
    { value: 'blocks', label: '予約受付停止' },
    ...(can('location.manage') ? [{ value: 'page' as const, label: '予約ページ' }] : []),
  ];
  return (
    <>
      <PageHeader title={l.name} sub={<Link to="/app/settings/locations">← 拠点一覧</Link>} />
      <Tabs label="拠点設定" tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'basic' ? <LocationBasicForm loc={l} /> : null}
      {tab === 'hours' ? <LocationHoursForm loc={l} /> : null}
      {tab === 'exceptions' ? <LocationExceptions loc={l} /> : null}
      {tab === 'blocks' ? <LocationBlocks loc={l} /> : null}
      {tab === 'page' ? <LocationPageForm loc={l} /> : null}
    </>
  );
}

function LocationBasicForm({ loc }: { loc: LocationDto }) {
  const [f, setF] = useState(loc);
  const [archiveOpen, setArchiveOpen] = useState(false);
  useEffect(() => setF(loc), [loc]);
  const save = useApiMutation((body: unknown) => api.patch(`/api/v1/locations/${loc.id}`, body), {
    invalidate: [['location', loc.id], ['locations'], ['me']],
    success: '保存しました',
  });
  const archive = useApiMutation((archived: boolean) => api.post(`/api/v1/locations/${loc.id}/archive`, { archived }), {
    invalidate: [['location', loc.id], ['locations'], ['me']],
    success: '変更しました',
    onSuccess: () => setArchiveOpen(false),
  });
  const err = save.error as ApiError | null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      name: f.name,
      slug: f.slug,
      address: f.address,
      phone: f.phone,
      email: f.email,
      timezone: f.timezone,
      isPublic: f.isPublic,
      slotIntervalMin: f.slotIntervalMin,
      minNoticeMin: f.minNoticeMin,
      maxAdvanceDays: f.maxAdvanceDays,
      maxConcurrentSessions: f.maxConcurrentSessions,
      cancelDeadlineHours: f.cancelDeadlineHours,
      allowCustomerCancel: f.allowCustomerCancel,
      allowCustomerReschedule: f.allowCustomerReschedule,
      allowPublicWaitlist: f.allowPublicWaitlist,
      sortOrder: f.sortOrder,
    });
  };
  return (
    <form className="stack-lg" onSubmit={submit}>
      <Card title="基本情報">
        <div className="grid-2">
          <TextField label="拠点名" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={err?.fields?.name} required />
          <TextField label="URL名" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} error={err?.fields?.slug} required />
          <TextField label="住所" value={f.address ?? ''} onChange={(e) => setF({ ...f, address: e.target.value })} />
          <TextField label="電話" value={f.phone ?? ''} onChange={(e) => setF({ ...f, phone: e.target.value })} error={err?.fields?.phone} />
          <TextField label="メール" type="email" value={f.email ?? ''} onChange={(e) => setF({ ...f, email: e.target.value })} error={err?.fields?.email} />
          <TextField label="タイムゾーン" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} error={err?.fields?.timezone} />
          <TextField label="表示順" type="number" value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: Number(e.target.value) })} />
        </div>
        <Checkbox label="公開予約ページに表示する" checked={f.isPublic} onChange={(e) => setF({ ...f, isPublic: e.target.checked })} />
      </Card>
      <Card title="予約ルール">
        <div className="grid-2">
          <SelectField
            label="予約の時間刻み"
            value={String(f.slotIntervalMin)}
            onChange={(e) => setF({ ...f, slotIntervalMin: Number(e.target.value) })}
            options={[5, 10, 15, 20, 30, 60].map((m) => ({ value: String(m), label: `${m}分` }))}
          />
          <TextField
            label="最短予約時間(分前まで受付)"
            type="number"
            min={0}
            value={f.minNoticeMin}
            onChange={(e) => setF({ ...f, minNoticeMin: Number(e.target.value) })}
            hint="例: 60 = 開始1時間前まで予約可能"
          />
          <TextField label="受付期間(何日先まで)" type="number" min={1} max={366} value={f.maxAdvanceDays} onChange={(e) => setF({ ...f, maxAdvanceDays: Number(e.target.value) })} />
          <TextField
            label="同時受付上限(空欄=制限なし)"
            type="number"
            min={1}
            value={f.maxConcurrentSessions ?? ''}
            onChange={(e) => setF({ ...f, maxConcurrentSessions: e.target.value ? Number(e.target.value) : null })}
            hint="同じ時間帯に受け付ける予約枠数の上限(定員制の相乗りは1枠)"
          />
          <TextField
            label="キャンセル締切(開始の何時間前)"
            type="number"
            min={0}
            value={f.cancelDeadlineHours}
            onChange={(e) => setF({ ...f, cancelDeadlineHours: Number(e.target.value) })}
          />
        </div>
        <Checkbox label="お客様がWebからキャンセルできる(締切前のみ)" checked={f.allowCustomerCancel} onChange={(e) => setF({ ...f, allowCustomerCancel: e.target.checked })} />
        <Checkbox label="お客様がWebから日時変更できる(締切前のみ)" checked={f.allowCustomerReschedule} onChange={(e) => setF({ ...f, allowCustomerReschedule: e.target.checked })} />
        <Checkbox label="満席時にキャンセル待ち登録を受け付ける" checked={f.allowPublicWaitlist} onChange={(e) => setF({ ...f, allowPublicWaitlist: e.target.checked })} />
      </Card>
      <div className="row-between">
        <Button variant={loc.status === 'archived' ? 'default' : 'danger'} onClick={() => setArchiveOpen(true)}>
          {loc.status === 'archived' ? 'アーカイブを解除' : 'この拠点をアーカイブ'}
        </Button>
        <Button type="submit" variant="primary" busy={save.isPending}>
          保存する
        </Button>
      </div>
      {archiveOpen ? (
        <ConfirmDialog
          title={loc.status === 'archived' ? 'アーカイブを解除しますか?' : '拠点をアーカイブしますか?'}
          message={
            loc.status === 'archived'
              ? '拠点を再び利用できるようにします。公開設定は個別に行ってください。'
              : '予約ページから非表示になり、新しい予約を受け付けなくなります。今後の予約がある場合はアーカイブできません。過去の履歴は保持されます。'
          }
          danger={loc.status !== 'archived'}
          busy={archive.isPending}
          onConfirm={() => archive.mutate(loc.status !== 'archived')}
          onCancel={() => setArchiveOpen(false)}
        />
      ) : null}
    </form>
  );
}

function LocationHoursForm({ loc }: { loc: LocationDto }) {
  const [rows, setRows] = useState(loc.hours ?? []);
  useEffect(() => setRows(loc.hours ?? []), [loc.hours]);
  const save = useApiMutation((body: unknown) => api.put(`/api/v1/locations/${loc.id}/hours`, body), {
    invalidate: [['location', loc.id]],
    success: '営業時間を保存しました',
  });
  const update = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Card title="営業時間(曜日ごと・複数区間可)">
      <p className="small muted">行がない曜日は定休日です。昼休みがある場合は同じ曜日に2行登録します。</p>
      <div className="stack">
        {[1, 2, 3, 4, 5, 6, 7].map((wd) => {
          const dayRows = rows.map((r, i) => ({ r, i })).filter((x) => x.r.weekday === wd);
          return (
            <fieldset key={wd}>
              <legend>{weekdayLabel(wd)}曜日</legend>
              {dayRows.length === 0 ? <p className="muted small" style={{ margin: 0 }}>定休日</p> : null}
              {dayRows.map(({ r, i }) => (
                <div className="row" key={i} style={{ marginBottom: 6 }}>
                  <label className="sr-only" htmlFor={`h-open-${i}`}>
                    開始
                  </label>
                  <input id={`h-open-${i}`} className="input" type="time" style={{ width: 130 }} value={r.openTime} onChange={(e) => update(i, { openTime: e.target.value })} />
                  <span>〜</span>
                  <label className="sr-only" htmlFor={`h-close-${i}`}>
                    終了
                  </label>
                  <input id={`h-close-${i}`} className="input" type="time" style={{ width: 130 }} value={r.closeTime} onChange={(e) => update(i, { closeTime: e.target.value })} />
                  <Button size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    削除
                  </Button>
                </div>
              ))}
              <Button size="sm" onClick={() => setRows([...rows, { weekday: wd, openTime: '10:00', closeTime: '19:00' }])}>
                + 時間帯を追加
              </Button>
            </fieldset>
          );
        })}
      </div>
      <ErrorMessage error={save.error} />
      <div className="form-actions">
        <Button variant="primary" busy={save.isPending} onClick={() => save.mutate({ hours: rows })}>
          保存する
        </Button>
      </div>
    </Card>
  );
}

function LocationExceptions({ loc }: { loc: LocationDto }) {
  const today = todayIn(loc.timezone);
  const to = addDays(today, 180);
  const list = useApi<{ items: { id: string; date: string; kind: string; openTime: string | null; closeTime: string | null; note: string | null }[] }>(
    ['location-exceptions', loc.id],
    `/api/v1/locations/${loc.id}/exceptions${qs({ from: today, to })}`,
  );
  const [date, setDate] = useState(today);
  const [kind, setKind] = useState<'closed' | 'special_hours'>('closed');
  const [openTime, setOpen] = useState('10:00');
  const [closeTime, setClose] = useState('15:00');
  const [note, setNote] = useState('');
  const add = useApiMutation((body: unknown) => api.post<{ warning: string | null }>(`/api/v1/locations/${loc.id}/exceptions`, body), {
    invalidate: [['location-exceptions', loc.id]],
    success: (r) => r.warning ?? '登録しました',
  });
  const remove = useApiMutation((exId: string) => api.del(`/api/v1/locations/${loc.id}/exceptions/${exId}`), {
    invalidate: [['location-exceptions', loc.id]],
    success: '削除しました',
  });
  return (
    <div className="stack-lg">
      <Card title="臨時休業・特別営業を登録">
        <div className="grid-3">
          <TextField label="日付" type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} />
          <SelectField
            label="種類"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
            options={[
              { value: 'closed', label: '臨時休業(終日)' },
              { value: 'special_hours', label: '特別営業時間' },
            ]}
          />
          <TextField label="メモ" value={note} onChange={(e) => setNote(e.target.value)} />
          {kind === 'special_hours' ? (
            <>
              <TextField label="開始" type="time" value={openTime} onChange={(e) => setOpen(e.target.value)} />
              <TextField label="終了" type="time" value={closeTime} onChange={(e) => setClose(e.target.value)} />
            </>
          ) : null}
        </div>
        <p className="small muted">既存の予約は自動でキャンセル・移動されません。登録後に表示される件数を確認し、必要に応じて個別に対応してください。</p>
        <ErrorMessage error={add.error} />
        <div className="form-actions">
          <Button
            variant="primary"
            busy={add.isPending}
            onClick={() => add.mutate(kind === 'closed' ? { kind, date, note } : { kind, date, openTime, closeTime, note })}
          >
            登録する
          </Button>
        </div>
      </Card>
      <Card title="今後の登録(180日)">
        {list.isLoading ? <Spinner /> : null}
        {list.data?.items.length === 0 ? <EmptyState title="登録はありません" /> : null}
        <ul className="list">
          {list.data?.items.map((x) => (
            <li className="list-item" key={x.id}>
              <span className="grow">
                <strong>{fmtDate(x.date)}</strong>{' '}
                {x.kind === 'closed' ? <Badge tone="danger" icon="×">臨時休業</Badge> : <Badge tone="info" icon="◷">{`${x.openTime}〜${x.closeTime}`}</Badge>}
                {x.note ? <span className="muted small"> {x.note}</span> : null}
              </span>
              <Button size="sm" onClick={() => remove.mutate(x.id)}>
                削除
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function LocationBlocks({ loc }: { loc: LocationDto }) {
  const today = todayIn(loc.timezone);
  const from = localToUtcLenient(today, '00:00', loc.timezone).toISOString();
  const to = localToUtcLenient(addDays(today, 120), '00:00', loc.timezone).toISOString();
  const list = useApi<{ items: { id: string; startsAt: string; endsAt: string; note: string | null }[] }>(
    ['location-blocks', loc.id],
    `/api/v1/locations/${loc.id}/blocks${qs({ from, to })}`,
  );
  const [date, setDate] = useState(today);
  const [start, setStart] = useState('12:00');
  const [end, setEnd] = useState('13:00');
  const [note, setNote] = useState('');
  const add = useApiMutation((body: unknown) => api.post<{ warning: string | null }>(`/api/v1/locations/${loc.id}/blocks`, body), {
    invalidate: [['location-blocks', loc.id]],
    success: (r) => r.warning ?? '登録しました',
  });
  const remove = useApiMutation((bid: string) => api.del(`/api/v1/locations/${loc.id}/blocks/${bid}`), {
    invalidate: [['location-blocks', loc.id]],
    success: '削除しました',
  });
  return (
    <div className="stack-lg">
      <Card title="予約受付を停止する時間帯">
        <Alert tone="info">営業はするが予約を受け付けない時間(清掃・イベント等)を登録します。拠点の時間({loc.timezone})で入力してください。</Alert>
        <div className="grid-3" style={{ marginTop: 12 }}>
          <TextField label="日付" type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} />
          <TextField label="開始" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          <TextField label="終了" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <TextField label="メモ" value={note} onChange={(e) => setNote(e.target.value)} />
        <ErrorMessage error={add.error} />
        <div className="form-actions">
          <Button
            variant="primary"
            busy={add.isPending}
            onClick={() =>
              add.mutate({
                startsAt: localToUtcLenient(date, start, loc.timezone).toISOString(),
                endsAt: localToUtcLenient(date, end, loc.timezone).toISOString(),
                note,
              })
            }
          >
            登録する
          </Button>
        </div>
      </Card>
      <Card title="今後の予約受付停止">
        {list.data?.items.length === 0 ? <EmptyState title="登録はありません" /> : null}
        <ul className="list">
          {list.data?.items.map((b) => (
            <li className="list-item" key={b.id}>
              <span className="grow">
                {fmtDateTime(b.startsAt, loc.timezone)} 〜 {fmtDateTime(b.endsAt, loc.timezone).slice(-5)}
                {b.note ? <span className="muted small"> {b.note}</span> : null}
              </span>
              <Button size="sm" onClick={() => remove.mutate(b.id)}>
                削除
              </Button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function LocationPageForm({ loc }: { loc: LocationDto }) {
  const [p, setP] = useState(loc.bookingPage);
  useEffect(() => setP(loc.bookingPage), [loc.bookingPage]);
  const save = useApiMutation((body: unknown) => api.patch(`/api/v1/locations/${loc.id}`, body), {
    invalidate: [['location', loc.id]],
    success: '保存しました',
  });
  return (
    <Card title="予約ページの表示">
      <div className="stack">
        <TextAreaField label="ご案内(予約ページ上部に表示)" value={p.message} onChange={(e) => setP({ ...p, message: e.target.value })} />
        <TextAreaField label="注意事項(確認画面に表示)" value={p.notice} onChange={(e) => setP({ ...p, notice: e.target.value })} />
        <TextField label="テーマカラー" type="color" value={p.themeColor} onChange={(e) => setP({ ...p, themeColor: e.target.value })} />
        <Checkbox label="お客様がスタッフを指名できる" checked={p.allowStaffSelection} onChange={(e) => setP({ ...p, allowStaffSelection: e.target.checked })} />
        <Checkbox label="価格表示を出す" checked={p.showPrices} onChange={(e) => setP({ ...p, showPrices: e.target.checked })} />
        <SelectField
          label="電話番号の入力"
          value={p.phoneRequirement}
          onChange={(e) => setP({ ...p, phoneRequirement: e.target.value as BookingPage['phoneRequirement'] })}
          options={[
            { value: 'required', label: '必須' },
            { value: 'optional', label: '任意' },
            { value: 'hidden', label: '聞かない' },
          ]}
        />
        <TextField
          label="Webからの日時変更の締切(開始の何時間前まで。空欄ならキャンセル締切と同じ)"
          type="number"
          min={0}
          max={720}
          value={p.changeDeadlineHours ?? ''}
          onChange={(e) => setP({ ...p, changeDeadlineHours: e.target.value === '' ? null : Number(e.target.value) })}
        />
        <TextAreaField
          label="同意事項(空欄なら「上記の内容と注意事項を確認しました」で同意を取ります)"
          value={p.consentText}
          onChange={(e) => setP({ ...p, consentText: e.target.value })}
        />
        <TextAreaField label="予約完了画面のメッセージ" value={p.completionMessage} onChange={(e) => setP({ ...p, completionMessage: e.target.value })} />
        <TextAreaField
          label="ご案内(持ち物・アクセスなど。確認画面・予約確認メール・リマインダーに表示)"
          value={p.notes}
          onChange={(e) => setP({ ...p, notes: e.target.value })}
        />
        <TextField label="ホームページURL" type="url" value={p.websiteUrl} onChange={(e) => setP({ ...p, websiteUrl: e.target.value })} placeholder="https://" />
        <TextField label="SNSのURL" type="url" value={p.snsUrl} onChange={(e) => setP({ ...p, snsUrl: e.target.value })} placeholder="https://" />
        <ErrorMessage error={save.error} />
        <div className="form-actions">
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate({ bookingPage: p })}>
            保存する
          </Button>
        </div>
      </div>
    </Card>
  );
}
