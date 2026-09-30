import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { QUESTION_TYPE_LABELS, QUESTION_TYPES, type QuestionType } from '../../../shared/constants';
import { ROLE_LABELS, type Role } from '../../../shared/permissions';
import { weekdayLabel } from '../../../shared/time';
import { api, qs, type ApiError } from '../../api/client';
import { useApi, useApiMutation, useCan, useMe } from '../../api/hooks';
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
import { fmtDateTime } from '../../lib/format';
import type { LocationDto } from './LocationsPages';

export interface StaffDto {
  id: string;
  displayName: string;
  internalName?: string | null;
  email?: string | null;
  phone?: string | null;
  publicProfile: string | null;
  acceptsBookings: boolean;
  status: string;
  color: string | null;
  sortOrder: number;
  locationIds: string[];
  serviceIds: string[];
  login: { membershipId: string; role: string; status: string } | null;
}

export interface ServiceDto {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  priceLabel: string | null;
  capacity: number;
  maxPartySize: number;
  requiresStaff: boolean;
  isBookable: boolean;
  isPublic: boolean;
  passEligible: boolean;
  planEligible: boolean;
  notice: string | null;
  scheduleMode: 'flexible' | 'fixed';
  slotIntervalMin: number | null;
  minNoticeMin: number | null;
  maxAdvanceDays: number | null;
  color: string | null;
  sortOrder: number;
  status: string;
  locationIds: string[];
  staffIds: string[];
  requirements?: { id?: string; label: string; quantity: number; resourceIds: string[] }[];
  fixedTimes?: { locationId: string; weekday: number; time: string }[];
  questions?: QuestionDto[];
}

export interface QuestionDto {
  id?: string;
  type: QuestionType;
  label: string;
  helpText: string | null;
  options: { id: string; label: string }[];
  required: boolean;
}

export interface ResourceDto {
  id: string;
  locationId: string;
  name: string;
  category: string;
  capacity: number;
  status: string;
  note: string | null;
  sortOrder: number;
}

export function useCatalog() {
  const locations = useApi<{ items: LocationDto[] }>(['locations', false], '/api/v1/locations');
  const staff = useApi<{ items: StaffDto[] }>(['staff-list'], '/api/v1/staff');
  const services = useApi<{ items: ServiceDto[] }>(['services'], '/api/v1/services');
  const resources = useApi<{ items: ResourceDto[] }>(['resources'], '/api/v1/resources');
  return {
    locations: locations.data?.items ?? [],
    staff: staff.data?.items ?? [],
    services: services.data?.items ?? [],
    resources: resources.data?.items ?? [],
    loading: locations.isLoading || staff.isLoading || services.isLoading || resources.isLoading,
  };
}

export function MultiCheck({ legend, items, value, onChange }: { legend: string; items: { id: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      {items.length === 0 ? <p className="muted small">選択肢がありません</p> : null}
      <div className="grid-3">
        {items.map((i) => (
          <Checkbox key={i.id} label={i.label} checked={value.includes(i.id)} onChange={(e) => onChange(e.target.checked ? [...value, i.id] : value.filter((x) => x !== i.id))} />
        ))}
      </div>
    </fieldset>
  );
}

// ======================= サービス =======================
export function ServicesPage() {
  const cat = useCatalog();
  const navigate = useNavigate();
  const [archived, setArchived] = useState(false);
  const list = useApi<{ items: ServiceDto[] }>(['services', archived], `/api/v1/services${qs({ includeArchived: archived })}`);
  return (
    <>
      <PageHeader title="サービス" actions={<Button variant="primary" onClick={() => navigate('/app/settings/services/new')}>サービスを追加</Button>} />
      <Checkbox label="アーカイブ済みも表示" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
      {list.isLoading ? <Spinner /> : null}
      {list.data?.items.length === 0 ? <EmptyState title="サービスがありません" /> : null}
      <div className="table-wrap">
        <table className="table table-responsive">
          <thead>
            <tr>
              <th>名称</th>
              <th>所要時間</th>
              <th>定員</th>
              <th>提供拠点</th>
              <th>公開</th>
              <th>回数券/プラン</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.items.map((s) => (
              <tr key={s.id}>
                <td data-label="名称">
                  <Link to={`/app/settings/services/${s.id}`}>{s.name}</Link>
                  {s.status === 'archived' ? <Badge tone="muted">アーカイブ</Badge> : null}
                </td>
                <td data-label="所要時間">
                  {s.durationMin}分{s.bufferBeforeMin || s.bufferAfterMin ? <span className="muted small">(前{s.bufferBeforeMin}/後{s.bufferAfterMin})</span> : null}
                </td>
                <td data-label="定員">{s.capacity > 1 ? `${s.capacity}名` : '1名'}</td>
                <td data-label="提供拠点">{s.locationIds.map((id) => cat.locations.find((l) => l.id === id)?.name).filter(Boolean).join('、') || '—'}</td>
                <td data-label="公開">{s.isPublic && s.isBookable ? <Badge tone="success" icon="●">公開</Badge> : <Badge tone="warning" icon="○">非公開</Badge>}</td>
                <td data-label="回数券/プラン">
                  {s.passEligible ? '回数券可' : '回数券不可'} / {s.planEligible ? 'プラン可' : 'プラン不可'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const EMPTY_SERVICE: ServiceDto = {
  id: '',
  name: '',
  description: null,
  category: null,
  durationMin: 60,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  priceLabel: null,
  capacity: 1,
  maxPartySize: 1,
  requiresStaff: true,
  isBookable: true,
  isPublic: true,
  passEligible: true,
  planEligible: true,
  notice: null,
  scheduleMode: 'flexible',
  slotIntervalMin: null,
  minNoticeMin: null,
  maxAdvanceDays: null,
  color: null,
  sortOrder: 0,
  status: 'active',
  locationIds: [],
  staffIds: [],
  requirements: [],
  fixedTimes: [],
  questions: [],
};

export function ServiceEditPage() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const cat = useCatalog();
  const detail = useApi<ServiceDto>(['service', id], isNew ? null : `/api/v1/services/${id}`);
  const [f, setF] = useState<ServiceDto>(EMPTY_SERVICE);
  const [tab, setTab] = useState<'basic' | 'relations' | 'questions'>('basic');
  const [archiveOpen, setArchiveOpen] = useState(false);
  useEffect(() => {
    if (detail.data) setF(detail.data);
  }, [detail.data]);
  const save = useApiMutation(
    (b: ServiceDto) => {
      const { id: _id, status: _s, questions: _q, ...body } = b;
      return isNew ? api.post<ServiceDto>('/api/v1/services', body) : api.patch<ServiceDto>(`/api/v1/services/${id}`, body);
    },
    {
      invalidate: [['services'], ['service', id]],
      success: '保存しました',
      onSuccess: (r) => {
        if (isNew) navigate(`/app/settings/services/${r.id}`, { replace: true });
      },
    },
  );
  const saveQuestions = useApiMutation((questions: QuestionDto[]) => api.put(`/api/v1/services/${id}/questions`, { questions }), {
    invalidate: [['service', id]],
    success: '事前質問を保存しました',
  });
  const archive = useApiMutation((archived: boolean) => api.post<{ warning: string | null }>(`/api/v1/services/${id}/archive`, { archived }), {
    invalidate: [['services'], ['service', id]],
    success: (r) => r.warning ?? '変更しました',
    onSuccess: () => setArchiveOpen(false),
  });
  if (!isNew && detail.isLoading) return <Spinner />;
  const err = save.error as ApiError | null;
  const set = (patch: Partial<ServiceDto>) => setF({ ...f, ...patch });
  return (
    <>
      <PageHeader title={isNew ? 'サービスを追加' : f.name} sub={<Link to="/app/settings/services">← サービス一覧</Link>} />
      <Tabs
        label="サービス設定"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'basic', label: '基本・予約ルール' },
          { value: 'relations', label: '拠点・スタッフ・リソース' },
          ...(isNew ? [] : [{ value: 'questions' as const, label: '事前質問' }]),
        ]}
      />
      <ErrorMessage error={err} />
      {tab === 'basic' ? (
        <div className="stack-lg">
          <Card title="基本情報">
            <div className="grid-2">
              <TextField label="名称" value={f.name} onChange={(e) => set({ name: e.target.value })} required error={err?.fields?.name} />
              <TextField label="カテゴリ" value={f.category ?? ''} onChange={(e) => set({ category: e.target.value || null })} />
              <TextField label="価格表示(任意・表示のみ)" value={f.priceLabel ?? ''} onChange={(e) => set({ priceLabel: e.target.value || null })} hint="例: 8,800円(税込)。決済は行いません" />
              <TextField label="表示順" type="number" value={f.sortOrder} onChange={(e) => set({ sortOrder: Number(e.target.value) })} />
            </div>
            <TextAreaField label="説明" value={f.description ?? ''} onChange={(e) => set({ description: e.target.value || null })} />
            <TextAreaField label="注意事項(予約時に表示)" value={f.notice ?? ''} onChange={(e) => set({ notice: e.target.value || null })} />
          </Card>
          <Card title="時間と定員">
            <div className="grid-3">
              <TextField label="所要時間(分)" type="number" min={5} value={f.durationMin} onChange={(e) => set({ durationMin: Number(e.target.value) })} error={err?.fields?.durationMin} />
              <TextField label="準備時間 before(分)" type="number" min={0} value={f.bufferBeforeMin} onChange={(e) => set({ bufferBeforeMin: Number(e.target.value) })} />
              <TextField label="片付け時間 after(分)" type="number" min={0} value={f.bufferAfterMin} onChange={(e) => set({ bufferAfterMin: Number(e.target.value) })} />
              <TextField label="定員(同時に受ける人数)" type="number" min={1} value={f.capacity} onChange={(e) => set({ capacity: Number(e.target.value) })} />
              <TextField label="1予約あたりの最大人数" type="number" min={1} value={f.maxPartySize} onChange={(e) => set({ maxPartySize: Number(e.target.value) })} error={err?.fields?.maxPartySize} />
              <SelectField
                label="開催時刻"
                value={f.scheduleMode}
                onChange={(e) => set({ scheduleMode: e.target.value as ServiceDto['scheduleMode'] })}
                options={[
                  { value: 'flexible', label: '営業時間内の空き時間(刻み)' },
                  { value: 'fixed', label: '曜日ごとの固定開始時刻(クラス)' },
                ]}
              />
            </div>
            <p className="small muted">スタッフ・部屋は「準備〜所要〜片付け」の間確保されます。お客様に表示される時間は所要時間のみです。</p>
          </Card>
          <Card title="予約の受付">
            <div className="grid-3">
              <SelectField
                label="時間刻み(拠点設定を上書き)"
                value={f.slotIntervalMin ? String(f.slotIntervalMin) : ''}
                onChange={(e) => set({ slotIntervalMin: e.target.value ? Number(e.target.value) : null })}
                placeholder="拠点の設定に従う"
                options={[5, 10, 15, 20, 30, 60].map((m) => ({ value: String(m), label: `${m}分` }))}
              />
              <TextField
                label="最短予約時間(分前・空欄=拠点設定)"
                type="number"
                value={f.minNoticeMin ?? ''}
                onChange={(e) => set({ minNoticeMin: e.target.value ? Number(e.target.value) : null })}
              />
              <TextField
                label="受付期間(日先・空欄=拠点設定)"
                type="number"
                value={f.maxAdvanceDays ?? ''}
                onChange={(e) => set({ maxAdvanceDays: e.target.value ? Number(e.target.value) : null })}
              />
            </div>
            <div className="grid-2">
              <Checkbox label="予約を受け付ける" checked={f.isBookable} onChange={(e) => set({ isBookable: e.target.checked })} />
              <Checkbox label="公開予約ページに表示する" checked={f.isPublic} onChange={(e) => set({ isPublic: e.target.checked })} />
              <Checkbox label="スタッフの担当が必要(オフ=部屋の貸出など)" checked={f.requiresStaff} onChange={(e) => set({ requiresStaff: e.target.checked })} />
              <Checkbox label="回数券を利用できる" checked={f.passEligible} onChange={(e) => set({ passEligible: e.target.checked })} />
              <Checkbox label="利用プランの対象" checked={f.planEligible} onChange={(e) => set({ planEligible: e.target.checked })} />
            </div>
          </Card>
        </div>
      ) : null}
      {tab === 'relations' ? <ServiceRelations f={f} set={set} cat={cat} /> : null}
      {tab === 'questions' ? <QuestionsEditor initial={detail.data?.questions ?? []} busy={saveQuestions.isPending} onSave={(qs2) => saveQuestions.mutate(qs2)} error={saveQuestions.error as ApiError | null} /> : null}
      {tab !== 'questions' ? (
        <div className="row-between" style={{ marginTop: 16 }}>
          {!isNew ? (
            <Button variant={f.status === 'archived' ? 'default' : 'danger'} onClick={() => setArchiveOpen(true)}>
              {f.status === 'archived' ? 'アーカイブを解除' : 'アーカイブ'}
            </Button>
          ) : (
            <span />
          )}
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate(f)} disabled={!f.name}>
            保存する
          </Button>
        </div>
      ) : null}
      {archiveOpen ? (
        <ConfirmDialog
          title={f.status === 'archived' ? 'アーカイブを解除しますか?' : 'サービスをアーカイブしますか?'}
          message="アーカイブすると新しい予約を受け付けなくなります。既存の予約と履歴はそのまま残ります。"
          danger={f.status !== 'archived'}
          busy={archive.isPending}
          onConfirm={() => archive.mutate(f.status !== 'archived')}
          onCancel={() => setArchiveOpen(false)}
        />
      ) : null}
    </>
  );
}

function ServiceRelations({ f, set, cat }: { f: ServiceDto; set: (p: Partial<ServiceDto>) => void; cat: ReturnType<typeof useCatalog> }) {
  const reqs = f.requirements ?? [];
  const fixed = f.fixedTimes ?? [];
  const locResources = cat.resources.filter((r) => f.locationIds.includes(r.locationId) && r.status !== 'archived');
  const [ft, setFt] = useState({ locationId: f.locationIds[0] ?? '', weekday: 1, time: '10:00' });
  return (
    <div className="stack-lg">
      <MultiCheck legend="提供する拠点" items={cat.locations.map((l) => ({ id: l.id, label: l.name }))} value={f.locationIds} onChange={(v) => set({ locationIds: v })} />
      {f.requiresStaff ? (
        <MultiCheck
          legend="担当できるスタッフ"
          items={cat.staff.filter((s) => s.status === 'active').map((s) => ({ id: s.id, label: s.displayName }))}
          value={f.staffIds}
          onChange={(v) => set({ staffIds: v })}
        />
      ) : null}
      <Card title="必要なリソース(部屋・ベッド・機材など)">
        <p className="small muted">予約時に、候補のうち空いているものを自動で確保します。拠点ごとに候補を選んでください。</p>
        {reqs.map((r, i) => (
          <fieldset key={i} style={{ marginBottom: 10 }}>
            <legend>必要条件 {i + 1}</legend>
            <div className="grid-2">
              <TextField label="名称" value={r.label} onChange={(e) => set({ requirements: reqs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <TextField
                label="必要数"
                type="number"
                min={1}
                value={r.quantity}
                onChange={(e) => set({ requirements: reqs.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)) })}
              />
            </div>
            <MultiCheck
              legend="候補リソース"
              items={locResources.map((res) => ({ id: res.id, label: `${res.name}(${cat.locations.find((l) => l.id === res.locationId)?.name ?? ''})` }))}
              value={r.resourceIds}
              onChange={(v) => set({ requirements: reqs.map((x, j) => (j === i ? { ...x, resourceIds: v } : x)) })}
            />
            <Button size="sm" onClick={() => set({ requirements: reqs.filter((_, j) => j !== i) })}>
              この条件を削除
            </Button>
          </fieldset>
        ))}
        <Button size="sm" onClick={() => set({ requirements: [...reqs, { label: '部屋', quantity: 1, resourceIds: [] }] })}>
          + 必要なリソースを追加
        </Button>
      </Card>
      {f.scheduleMode === 'fixed' ? (
        <Card title="固定開始時刻(クラスの時間割)">
          <div className="row">
            <select className="select" style={{ width: 'auto' }} aria-label="拠点" value={ft.locationId} onChange={(e) => setFt({ ...ft, locationId: e.target.value })}>
              {cat.locations.filter((l) => f.locationIds.includes(l.id)).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <select className="select" style={{ width: 'auto' }} aria-label="曜日" value={ft.weekday} onChange={(e) => setFt({ ...ft, weekday: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5, 6, 7].map((w) => (
                <option key={w} value={w}>
                  {weekdayLabel(w)}曜
                </option>
              ))}
            </select>
            <input className="input" type="time" aria-label="開始時刻" style={{ width: 130 }} value={ft.time} onChange={(e) => setFt({ ...ft, time: e.target.value })} />
            <Button size="sm" disabled={!ft.locationId} onClick={() => set({ fixedTimes: [...fixed, ft] })}>
              追加
            </Button>
          </div>
          <ul className="list">
            {fixed.map((x, i) => (
              <li className="list-item" key={i}>
                <span className="grow">
                  {cat.locations.find((l) => l.id === x.locationId)?.name} {weekdayLabel(x.weekday)}曜 {x.time}
                </span>
                <Button size="sm" onClick={() => set({ fixedTimes: fixed.filter((_, j) => j !== i) })}>
                  削除
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function QuestionsEditor({ initial, onSave, busy, error }: { initial: QuestionDto[]; onSave: (q: QuestionDto[]) => void; busy: boolean; error: ApiError | null }) {
  const [list, setList] = useState<QuestionDto[]>(initial);
  useEffect(() => setList(initial), [initial]);
  const upd = (i: number, p: Partial<QuestionDto>) => setList(list.map((q, j) => (j === i ? { ...q, ...p } : q)));
  return (
    <div className="stack">
      <Alert tone="warning">事前質問は予約の準備のための簡単な確認用です。病歴・症状など医療問診の用途には使用しないでください。</Alert>
      <ErrorMessage error={error} />
      {list.map((q, i) => (
        <fieldset key={q.id ?? `new-${i}`}>
          <legend>質問 {i + 1}</legend>
          <div className="grid-2">
            <TextField label="質問文" value={q.label} onChange={(e) => upd(i, { label: e.target.value })} />
            <SelectField
              label="回答形式"
              value={q.type}
              onChange={(e) => upd(i, { type: e.target.value as QuestionType })}
              options={QUESTION_TYPES.map((t) => ({ value: t, label: QUESTION_TYPE_LABELS[t] }))}
            />
            <TextField label="補足説明" value={q.helpText ?? ''} onChange={(e) => upd(i, { helpText: e.target.value || null })} />
            <Checkbox label="必須" checked={q.required} onChange={(e) => upd(i, { required: e.target.checked })} />
          </div>
          {q.type === 'single_choice' || q.type === 'multi_choice' ? (
            <div className="stack" style={{ marginTop: 8 }}>
              {q.options.map((o, k) => (
                <div className="row" key={o.id}>
                  <input
                    className="input grow"
                    aria-label={`選択肢${k + 1}`}
                    value={o.label}
                    onChange={(e) => upd(i, { options: q.options.map((x, m) => (m === k ? { ...x, label: e.target.value } : x)) })}
                  />
                  <Button size="sm" onClick={() => upd(i, { options: q.options.filter((_, m) => m !== k) })}>
                    削除
                  </Button>
                </div>
              ))}
              <Button size="sm" onClick={() => upd(i, { options: [...q.options, { id: `o${Date.now().toString(36)}`, label: '' }] })}>
                + 選択肢を追加
              </Button>
            </div>
          ) : null}
          <div className="row" style={{ marginTop: 8 }}>
            <Button size="sm" disabled={i === 0} onClick={() => setList(swap(list, i, i - 1))}>
              ↑ 上へ
            </Button>
            <Button size="sm" disabled={i === list.length - 1} onClick={() => setList(swap(list, i, i + 1))}>
              ↓ 下へ
            </Button>
            <Button size="sm" onClick={() => setList(list.filter((_, j) => j !== i))}>
              質問を削除
            </Button>
          </div>
        </fieldset>
      ))}
      <div className="row-between">
        <Button onClick={() => setList([...list, { type: 'short_text', label: '', helpText: null, options: [], required: false }])}>+ 質問を追加</Button>
        <Button variant="primary" busy={busy} onClick={() => onSave(list)}>
          事前質問を保存
        </Button>
      </div>
      <p className="small muted">変更しても、すでに受け付けた予約の質問と回答は予約時点の内容のまま保存されています。</p>
    </div>
  );
}

function swap<T>(arr: T[], a: number, b: number): T[] {
  const c = [...arr];
  [c[a], c[b]] = [c[b], c[a]];
  return c;
}

// ======================= スタッフ =======================
export function StaffPage() {
  const cat = useCatalog();
  const [archived, setArchived] = useState(false);
  const list = useApi<{ items: StaffDto[] }>(['staff-list', archived], `/api/v1/staff${qs({ includeArchived: archived })}`);
  const [edit, setEdit] = useState<StaffDto | 'new' | null>(null);
  return (
    <>
      <PageHeader title="スタッフ" actions={<Button variant="primary" onClick={() => setEdit('new')}>スタッフを追加</Button>} />
      <Checkbox label="アーカイブ済みも表示" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
      {list.isLoading ? <Spinner /> : null}
      <div className="table-wrap">
        <table className="table table-responsive">
          <thead>
            <tr>
              <th>表示名</th>
              <th>所属拠点</th>
              <th>対応サービス</th>
              <th>受付</th>
              <th>ログイン</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.items.map((s) => (
              <tr key={s.id}>
                <td data-label="表示名">
                  <strong>{s.displayName}</strong>
                  {s.internalName ? <span className="muted small">({s.internalName})</span> : null}
                  {s.status === 'archived' ? <Badge tone="muted">アーカイブ</Badge> : null}
                </td>
                <td data-label="所属拠点">{s.locationIds.map((id) => cat.locations.find((l) => l.id === id)?.name).filter(Boolean).join('、') || '—'}</td>
                <td data-label="対応サービス">{s.serviceIds.length}件</td>
                <td data-label="受付">{s.acceptsBookings ? '受付可' : <Badge tone="warning">受付停止</Badge>}</td>
                <td data-label="ログイン">{s.login ? `${ROLE_LABELS[s.login.role as Role] ?? s.login.role}${s.login.status !== 'active' ? '(無効)' : ''}` : '—'}</td>
                <td data-label="操作">
                  <Button size="sm" onClick={() => setEdit(s)}>
                    編集
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit ? <StaffEditModal staff={edit === 'new' ? null : edit} cat={cat} onClose={() => setEdit(null)} /> : null}
    </>
  );
}

function StaffEditModal({ staff, cat, onClose }: { staff: StaffDto | null; cat: ReturnType<typeof useCatalog>; onClose: () => void }) {
  const [f, setF] = useState({
    displayName: staff?.displayName ?? '',
    internalName: staff?.internalName ?? '',
    email: staff?.email ?? '',
    phone: staff?.phone ?? '',
    publicProfile: staff?.publicProfile ?? '',
    acceptsBookings: staff?.acceptsBookings ?? true,
    sortOrder: staff?.sortOrder ?? 0,
    locationIds: staff?.locationIds ?? [],
    serviceIds: staff?.serviceIds ?? [],
  });
  const [archiveResult, setArchiveResult] = useState<string | null>(null);
  const save = useApiMutation((b: typeof f) => (staff ? api.patch(`/api/v1/staff/${staff.id}`, b) : api.post('/api/v1/staff', b)), {
    invalidate: [['staff-list'], ['services']],
    success: '保存しました',
    onSuccess: onClose,
  });
  const archive = useApiMutation((archived: boolean) => api.post<{ warning: string | null; membershipDisabled: boolean }>(`/api/v1/staff/${staff!.id}/archive`, { archived }), {
    invalidate: [['staff-list'], ['members']],
    onSuccess: (r) => setArchiveResult([r.warning, r.membershipDisabled ? 'ログインアカウントを無効化し、ログイン中の端末をログアウトしました。' : null].filter(Boolean).join(' ') || '変更しました'),
  });
  const err = save.error as ApiError | null;
  return (
    <Modal
      title={staff ? `${staff.displayName} を編集` : 'スタッフを追加'}
      wide
      onClose={onClose}
      footer={
        <>
          {staff ? (
            <Button variant={staff.status === 'archived' ? 'default' : 'danger'} onClick={() => archive.mutate(staff.status !== 'archived')} busy={archive.isPending}>
              {staff.status === 'archived' ? 'アーカイブを解除' : 'アーカイブ'}
            </Button>
          ) : null}
          <Button onClick={onClose}>閉じる</Button>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate(f)} disabled={!f.displayName}>
            保存する
          </Button>
        </>
      }
    >
      <div className="stack">
        {archiveResult ? <Alert tone="info">{archiveResult}</Alert> : null}
        <ErrorMessage error={err} />
        <div className="grid-2">
          <TextField label="表示名(お客様に表示)" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} required error={err?.fields?.displayName} />
          <TextField label="内部名(スタッフ間のみ)" value={f.internalName} onChange={(e) => setF({ ...f, internalName: e.target.value })} />
          <TextField label="メール" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} error={err?.fields?.email} />
          <TextField label="電話" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          <TextField label="表示順" type="number" value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: Number(e.target.value) })} />
          <Checkbox label="予約を受け付ける" checked={f.acceptsBookings} onChange={(e) => setF({ ...f, acceptsBookings: e.target.checked })} />
        </div>
        <TextAreaField label="公開プロフィール" value={f.publicProfile} onChange={(e) => setF({ ...f, publicProfile: e.target.value })} />
        <MultiCheck legend="所属拠点(複数可)" items={cat.locations.map((l) => ({ id: l.id, label: l.name }))} value={f.locationIds} onChange={(v) => setF({ ...f, locationIds: v })} />
        <MultiCheck
          legend="対応サービス"
          items={cat.services.filter((s) => s.requiresStaff).map((s) => ({ id: s.id, label: s.name }))}
          value={f.serviceIds}
          onChange={(v) => setF({ ...f, serviceIds: v })}
        />
        <p className="small muted">ログインアカウントとロールは「メンバーと権限」で招待・紐付けします。アーカイブすると新しい予約に割り当てられなくなり、紐付くログインは無効化されます(既存予約は自動変更されません)。</p>
      </div>
    </Modal>
  );
}

// ======================= リソース =======================
export function ResourcesPage() {
  const cat = useCatalog();
  const can = useCan();
  const me = useMe();
  const tz = me.data?.organization?.timezone ?? 'Asia/Tokyo';
  const [edit, setEdit] = useState<ResourceDto | 'new' | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = useApi<ResourceDto & { blocks: { id: string; startsAt: string; endsAt: string; kind: string; note: string | null }[] }>(
    ['resource', detailId],
    detailId ? `/api/v1/resources/${detailId}` : null,
  );
  const [blk, setBlk] = useState({ startsAt: '', endsAt: '', kind: 'maintenance', note: '' });
  const addBlock = useApiMutation((b: typeof blk) => api.post<{ warning: string | null }>(`/api/v1/resources/${detailId}/blocks`, { ...b, startsAt: new Date(b.startsAt).toISOString(), endsAt: new Date(b.endsAt).toISOString() }), {
    invalidate: [['resource', detailId]],
    success: (r) => r.warning ?? '停止期間を登録しました',
  });
  const delBlock = useApiMutation((bid: string) => api.del(`/api/v1/resources/${detailId}/blocks/${bid}`), { invalidate: [['resource', detailId]], success: '削除しました' });
  return (
    <>
      <PageHeader title="リソース" actions={can('resource.manage') ? <Button variant="primary" onClick={() => setEdit('new')}>リソースを追加</Button> : null} />
      {cat.loading ? <Spinner /> : null}
      {cat.locations.map((l) => {
        const items = cat.resources.filter((r) => r.locationId === l.id);
        return (
          <Card key={l.id} title={l.name} className="stack">
            {items.length === 0 ? <EmptyState title="リソースがありません" /> : null}
            <ul className="list">
              {items.map((r) => (
                <li key={r.id} className="list-item">
                  <span className="grow">
                    <strong>{r.name}</strong> <span className="muted small">{r.category} ・ 同時利用 {r.capacity}</span>{' '}
                    {r.status === 'stopped' ? <Badge tone="danger" icon="■">停止中</Badge> : null}
                  </span>
                  <Button size="sm" onClick={() => setDetailId(r.id)}>
                    停止期間
                  </Button>
                  <Button size="sm" onClick={() => setEdit(r)}>
                    編集
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
      {edit ? <ResourceEditModal res={edit === 'new' ? null : edit} locations={cat.locations} onClose={() => setEdit(null)} /> : null}
      {detailId && detail.data ? (
        <Modal title={`${detail.data.name} のメンテナンス・停止`} onClose={() => setDetailId(null)} wide>
          <div className="grid-3">
            <TextField label="開始" type="datetime-local" value={blk.startsAt} onChange={(e) => setBlk({ ...blk, startsAt: e.target.value })} />
            <TextField label="終了" type="datetime-local" value={blk.endsAt} onChange={(e) => setBlk({ ...blk, endsAt: e.target.value })} />
            <SelectField
              label="種類"
              value={blk.kind}
              onChange={(e) => setBlk({ ...blk, kind: e.target.value })}
              options={[
                { value: 'maintenance', label: 'メンテナンス' },
                { value: 'stopped', label: '停止' },
                { value: 'other', label: 'その他' },
              ]}
            />
          </div>
          <p className="small muted">日時は端末の時刻で入力します(拠点と同じタイムゾーンで操作してください)。</p>
          <TextField label="メモ" value={blk.note} onChange={(e) => setBlk({ ...blk, note: e.target.value })} />
          <div className="form-actions">
            <Button variant="primary" disabled={!blk.startsAt || !blk.endsAt} busy={addBlock.isPending} onClick={() => addBlock.mutate(blk)}>
              登録
            </Button>
          </div>
          <ul className="list">
            {detail.data.blocks.map((b) => (
              <li key={b.id} className="list-item">
                <span className="grow">
                  {fmtDateTime(b.startsAt, tz)} 〜 {fmtDateTime(b.endsAt, tz)} {b.note}
                </span>
                <Button size="sm" onClick={() => delBlock.mutate(b.id)}>
                  削除
                </Button>
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}
    </>
  );
}

function ResourceEditModal({ res, locations, onClose }: { res: ResourceDto | null; locations: LocationDto[]; onClose: () => void }) {
  const [f, setF] = useState({
    locationId: res?.locationId ?? locations[0]?.id ?? '',
    name: res?.name ?? '',
    category: res?.category ?? 'room',
    capacity: res?.capacity ?? 1,
    note: res?.note ?? '',
    sortOrder: res?.sortOrder ?? 0,
    status: res?.status ?? 'active',
  });
  const save = useApiMutation(
    (b: typeof f) => {
      const { locationId, status, ...rest } = b;
      return res ? api.patch(`/api/v1/resources/${res.id}`, { ...rest, status }) : api.post('/api/v1/resources', { locationId, ...rest });
    },
    { invalidate: [['resources']], success: '保存しました', onSuccess: onClose },
  );
  const archive = useApiMutation(() => api.post(`/api/v1/resources/${res!.id}/archive`), { invalidate: [['resources']], success: 'アーカイブしました', onSuccess: onClose });
  const [confirmArchive, setConfirmArchive] = useState(false);
  if (confirmArchive && res) {
    return (
      <ConfirmDialog
        title={`${res.name} をアーカイブしますか?`}
        danger
        message="アーカイブすると一覧に表示されず、新しい予約に使われなくなります。画面から元に戻すことはできません(一時的に使わない場合は「停止中」や停止期間を使ってください)。既存の予約は自動では変更されません。"
        confirmLabel="アーカイブする"
        busy={archive.isPending}
        onConfirm={() => archive.mutate(undefined)}
        onCancel={() => setConfirmArchive(false)}
      />
    );
  }
  return (
    <Modal
      title={res ? `${res.name} を編集` : 'リソースを追加'}
      onClose={onClose}
      footer={
        <>
          {res ? (
            <Button variant="danger" onClick={() => setConfirmArchive(true)}>
              アーカイブ
            </Button>
          ) : null}
          <Button onClick={onClose}>閉じる</Button>
          <Button variant="primary" busy={save.isPending} disabled={!f.name || !f.locationId} onClick={() => save.mutate(f)}>
            保存する
          </Button>
        </>
      }
    >
      <div className="stack">
        <ErrorMessage error={save.error} />
        {!res ? <SelectField label="拠点" value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })} options={locations.map((l) => ({ value: l.id, label: l.name }))} /> : null}
        <TextField label="名称" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        <SelectField
          label="種類"
          value={f.category}
          onChange={(e) => setF({ ...f, category: e.target.value })}
          options={[
            { value: 'room', label: '部屋・施術室' },
            { value: 'bed', label: 'ベッド' },
            { value: 'studio', label: 'スタジオ' },
            { value: 'equipment', label: '機材' },
            { value: 'vehicle', label: '車両' },
            { value: 'other', label: 'その他' },
          ]}
        />
        <TextField label="同時利用数" type="number" min={1} value={f.capacity} onChange={(e) => setF({ ...f, capacity: Number(e.target.value) })} hint="同じ時間に同時に使える数(通常は1)" />
        {res ? (
          <SelectField
            label="状態"
            value={f.status}
            onChange={(e) => setF({ ...f, status: e.target.value })}
            options={[
              { value: 'active', label: '利用可' },
              { value: 'stopped', label: '停止中(予約に使わない)' },
            ]}
          />
        ) : null}
        <TextAreaField label="メモ" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </div>
    </Modal>
  );
}
