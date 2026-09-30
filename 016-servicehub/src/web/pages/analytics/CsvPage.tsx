import { useState } from 'react';
import type { Permission } from '../../../shared/permissions';
import { startOfMonth, todayIn } from '../../../shared/time';
import { api, ApiError, qs } from '../../api/client';
import { useApi, useApiMutation, useCan, useMe, useOnline } from '../../api/hooks';
import { useToast } from '../../components/Toast';
import { Alert, Badge, Button, Card, EmptyState, ErrorMessage, PageHeader, SelectField, TextField } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';

type ExportKind = 'customers' | 'bookings' | 'cancellations' | 'services' | 'staff' | 'pass-ledger' | 'plan-ledger' | 'records';
const EXPORTS: { kind: ExportKind; label: string; perm: Permission; period: boolean; note: string }[] = [
  { kind: 'customers', label: '顧客', perm: 'csv.export.customers', period: false, note: '氏名・連絡先・タグ・メモ・来店日(統合済み・匿名化は「すべて」で含む)' },
  { kind: 'bookings', label: '予約', perm: 'csv.export.bookings', period: true, note: '開始日で期間を指定。状態・キャンセル区分・消化の有無' },
  { kind: 'cancellations', label: 'キャンセル・無断欠席', perm: 'csv.export.bookings', period: true, note: '予約の開始日で期間を指定。区分・理由・日時・操作者・締切後か・消化の確認' },
  { kind: 'services', label: 'サービス', perm: 'csv.export.master', period: false, note: '所要時間・定員・提供拠点・担当スタッフ' },
  { kind: 'staff', label: 'スタッフ', perm: 'csv.export.master', period: false, note: '所属拠点・対応サービス' },
  { kind: 'pass-ledger', label: '回数券台帳', perm: 'csv.export.ledger', period: true, note: '付与・利用・取消戻し・調整・失効(記録日で期間を指定)' },
  { kind: 'plan-ledger', label: '利用プラン台帳', perm: 'csv.export.ledger', period: true, note: '期間ごとの付与・利用・繰越・失効' },
  { kind: 'records', label: '実施履歴', perm: 'csv.export.ledger', period: true, note: '実施記録(内部メモは閲覧権限がある場合のみ)' },
];

type ImportKind = 'customers' | 'services' | 'staff';

interface Preview {
  id: string;
  kind: ImportKind;
  fileName: string | null;
  rowCount: number;
  errorCount: number;
  duplicateCount: number;
  unknownColumns: string[];
  columns: { key: string; label: string; required: boolean }[];
  rows: {
    line: number;
    values: Record<string, unknown>;
    errors: Record<string, string>;
    duplicate: { kind: 'file'; line: number } | { kind: 'existing'; id: string; name: string } | null;
  }[];
}

/** Excel 由来の Shift_JIS にも対応: UTF-8 として読めなければ Shift_JIS で読む */
async function readText(file: File): Promise<{ text: string; encoding: string }> {
  const buf = await file.arrayBuffer();
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('shift_jis').decode(buf), encoding: 'Shift_JIS' };
  }
}

export function CsvPage() {
  const can = useCan();
  const exports = EXPORTS.filter((e) => can(e.perm));
  return (
    <div className="stack-lg">
      <PageHeader title="CSV入出力" sub="出力は UTF-8(BOM付き)で Excel でも文字化けしません。数式として実行されないよう、= + - @ で始まる文字は先頭に ' を付けて出力します。" />
      {exports.length > 0 ? <ExportCard kinds={exports} /> : null}
      {can('csv.import') ? <ImportCard /> : null}
      {exports.length === 0 && !can('csv.import') ? <EmptyState title="CSVを扱う権限がありません" /> : null}
    </div>
  );
}

function ExportCard({ kinds }: { kinds: typeof EXPORTS }) {
  const me = useMe();
  const toast = useToast();
  const online = useOnline();
  const tz = me.data?.organization?.timezone ?? 'Asia/Tokyo';
  const today = todayIn(tz);
  const [kind, setKind] = useState<ExportKind>(kinds[0].kind);
  const [from, setFrom] = useState(startOfMonth(today));
  const [to, setTo] = useState(today);
  const [locId, setLocId] = useState('');
  const [status, setStatus] = useState<'active' | 'all'>('active');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const def = kinds.find((k) => k.kind === kind) ?? kinds[0];
  const locations = me.data?.locations ?? [];
  const download = async () => {
    setBusy(true);
    setErr(null);
    try {
      const url = `/api/v1/csv/export/${def.kind}${qs({ from: def.period ? from : undefined, to: def.period ? to : undefined, locationId: locId || undefined, status: def.kind === 'customers' ? status : undefined })}`;
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new ApiError(res.status, body?.error?.code ?? 'HTTP', body?.error?.message ?? `出力に失敗しました (${res.status})`);
      }
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') ?? '';
      const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
      const name = m ? decodeURIComponent(m[1]) : `${def.label}.csv`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      toast.push({ tone: 'success', message: `${name} を出力しました` });
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(0, 'NETWORK', '出力に失敗しました'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="CSVを出力">
      <div className="stack">
        <div className="grid-auto">
          <SelectField label="種類" value={kind} onChange={(e) => setKind(e.target.value as ExportKind)} options={kinds.map((k) => ({ value: k.kind, label: k.label }))} hint={def.note} />
          {def.period ? (
            <>
              <TextField label="開始日" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              <TextField label="終了日" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} hint="最長366日" />
            </>
          ) : null}
          {locations.length > 1 && def.kind !== 'customers' ? (
            <SelectField label="拠点" value={locId} onChange={(e) => setLocId(e.target.value)} placeholder="担当のすべての拠点" options={locations.map((l) => ({ value: l.id, label: l.name }))} />
          ) : null}
          {def.kind === 'customers' ? (
            <SelectField
              label="対象"
              value={status}
              onChange={(e) => setStatus(e.target.value as 'active' | 'all')}
              options={[
                { value: 'active', label: '有効・アーカイブ' },
                { value: 'all', label: 'すべて(統合済み・匿名化を含む)' },
              ]}
            />
          ) : null}
        </div>
        <Alert tone="warning">出力したファイルには個人情報が含まれます。保管・共有に注意し、不要になったら削除してください。出力の記録は監査ログに残ります。</Alert>
        <ErrorMessage error={err} />
        <div>
          <Button variant="primary" busy={busy} disabled={!online || (def.period && (!from || !to || to < from))} onClick={() => void download()}>
            CSVを出力
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ImportCard() {
  const online = useOnline();
  const me = useMe();
  const [kind, setKind] = useState<ImportKind>('customers');
  const [file, setFile] = useState<File | null>(null);
  const [encoding, setEncoding] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [duplicates, setDuplicates] = useState<'skip' | 'create'>('skip');
  const history = useApi<{ items: { id: string; kind: string; fileName: string | null; status: string; rowCount: number; errorCount: number; result: { created: number; skipped: number } | null; createdAt: string; committedAt: string | null; createdBy: string | null }[] }>(
    ['csv-imports'],
    '/api/v1/csv/imports',
  );
  const tz = me.data?.organization?.timezone ?? 'Asia/Tokyo';
  const previewM = useApiMutation(
    async () => {
      const r = await readText(file!);
      setEncoding(r.encoding);
      return api.post<Preview>('/api/v1/csv/import/preview', { kind, fileName: file!.name, content: r.text });
    },
    { onSuccess: (p) => setPreview(p), invalidate: [['csv-imports']] },
  );
  const commit = useApiMutation(() => api.post<{ created: number; skipped: number }>(`/api/v1/csv/import/${preview!.id}/commit`, { duplicates }), {
    invalidate: [['csv-imports'], ['customers'], ['services'], ['staff-list']],
    success: (r) => `取り込みました(登録 ${r.created}件 / スキップ ${r.skipped}件)`,
    onSuccess: () => {
      setPreview(null);
      setFile(null);
    },
  });
  const cancel = useApiMutation(() => api.post(`/api/v1/csv/import/${preview!.id}/cancel`, {}), {
    invalidate: [['csv-imports']],
    success: 'プレビューを取り消しました',
    onSuccess: () => setPreview(null),
  });
  const templates: Record<ImportKind, string> = {
    customers: '氏名,フリガナ,メール,電話,タグ,よく利用する拠点,メモ',
    services: '名称,カテゴリ,所要時間(分),準備時間(分),片付け時間(分),定員,最大人数,価格表示,説明,提供拠点,公開,回数券可,プラン可',
    staff: '表示名,内部名,メール,電話,所属拠点,予約受付,公開プロフィール',
  };
  const downloadTemplate = () => {
    const blob = new Blob([`﻿${templates[kind]}\r\n`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `取込ひな形_${kind}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  return (
    <Card title="CSVを取り込む(新規登録のみ)">
      <div className="stack">
        <p className="small" style={{ margin: 0 }}>
          手順: ファイルを選ぶ → <strong>プレビュー</strong>で内容とエラーを確認 → 問題がなければ<strong>反映</strong>。既存データの更新・削除はしません。同じ内容のファイルは二度取り込めません。
        </p>
        <div className="grid-auto">
          <SelectField
            label="取り込む種類"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as ImportKind);
              setPreview(null);
            }}
            options={[
              { value: 'customers', label: '顧客' },
              { value: 'services', label: 'サービス' },
              { value: 'staff', label: 'スタッフ' },
            ]}
          />
          <div className="field">
            <label className="field-label" htmlFor="csv-file">
              CSVファイル(UTF-8 または Shift_JIS、5,000行まで)
            </label>
            <input
              id="csv-file"
              className="input"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
              }}
            />
          </div>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          見出し: {templates[kind]}{' '}
          <button type="button" className="link-btn" onClick={downloadTemplate}>
            ひな形をダウンロード
          </button>
        </p>
        <div className="row">
          <Button variant="primary" disabled={!online || !file} busy={previewM.isPending} onClick={() => previewM.mutate(undefined)}>
            プレビュー
          </Button>
        </div>
        <ErrorMessage error={previewM.error} />
        {preview ? (
          <div className="stack">
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              <Badge tone="info">{preview.rowCount}行</Badge>
              <Badge tone={preview.errorCount ? 'danger' : 'success'} icon={preview.errorCount ? '!' : '✓'}>
                エラー {preview.errorCount}行
              </Badge>
              <Badge tone={preview.duplicateCount ? 'warning' : 'neutral'}>重複の可能性 {preview.duplicateCount}行</Badge>
              {encoding ? <Badge tone="neutral">文字コード {encoding}</Badge> : null}
            </div>
            {preview.unknownColumns.length > 0 ? <Alert tone="info">取り込まない列: {preview.unknownColumns.join('、')}</Alert> : null}
            {preview.errorCount > 0 ? <Alert tone="danger">エラーのある行があるため反映できません。ファイルを修正して、もう一度プレビューしてください。</Alert> : null}
            <div className="table-wrap" style={{ maxHeight: 420, overflow: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>行</th>
                    {preview.columns.map((c) => (
                      <th key={c.key}>{c.label}</th>
                    ))}
                    <th>確認</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 500).map((r) => (
                    <tr key={r.line} style={Object.keys(r.errors).length ? { background: 'var(--c-danger-bg)' } : r.duplicate ? { background: 'var(--c-warning-bg)' } : undefined}>
                      <td className="num">{r.line}</td>
                      {preview.columns.map((c) => {
                        // 拠点は ID ではなく名前で表示
                        const v = c.key === 'location' ? r.values.locationName : c.key === 'locations' ? r.values.locationNames : r.values[c.key];
                        return (
                          <td key={c.key}>
                            {Array.isArray(v) ? v.join(' ') : v === true ? 'はい' : v === false ? 'いいえ' : String(v ?? '')}
                            {r.errors[c.key] ? (
                              <div className="small" style={{ color: 'var(--c-danger)' }} role="note">
                                ! {r.errors[c.key]}
                              </div>
                            ) : null}
                          </td>
                        );
                      })}
                      <td className="small">
                        {r.duplicate?.kind === 'file' ? `ファイル内の${r.duplicate.line}行目と重複` : r.duplicate?.kind === 'existing' ? `既存「${r.duplicate.name}」と重複の可能性` : Object.keys(r.errors).length ? 'エラー' : 'OK'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.rows.length > 500 ? <p className="small muted">先頭500行を表示しています。</p> : null}
            {preview.errorCount === 0 ? (
              <>
                {preview.duplicateCount > 0 ? (
                  <SelectField
                    label="重複の可能性がある行"
                    value={duplicates}
                    onChange={(e) => setDuplicates(e.target.value as 'skip' | 'create')}
                    options={[
                      { value: 'skip', label: '取り込まない(推奨)' },
                      { value: 'create', label: '別人として登録する(ファイル内の重複は常に取り込みません)' },
                    ]}
                    hint="自動で統合はしません。同一人物の統合は顧客画面で確認してから行ってください。"
                  />
                ) : null}
                <div className="row">
                  <Button variant="primary" disabled={!online} busy={commit.isPending} onClick={() => commit.mutate(undefined)}>
                    反映する
                  </Button>
                  <Button disabled={!online} onClick={() => cancel.mutate(undefined)}>
                    やめる
                  </Button>
                </div>
              </>
            ) : null}
            <ErrorMessage error={commit.error} />
          </div>
        ) : null}
        <h3 style={{ fontSize: '1rem', marginBottom: 0 }}>取込の履歴</h3>
        {history.data?.items.length === 0 ? <p className="small muted">まだ取り込みはありません。</p> : null}
        <ul className="list">
          {(history.data?.items ?? []).map((h) => (
            <li key={h.id} className="list-item">
              <span className="grow">
                <strong>{h.fileName ?? '(無題)'}</strong> <span className="small muted">({h.kind})</span>
                <br />
                <span className="small muted">
                  {fmtDateTime(h.committedAt ?? h.createdAt, tz)} ・ {h.createdBy ?? ''} ・ {h.rowCount}行
                  {h.result ? ` ・ 登録${h.result.created} / スキップ${h.result.skipped}` : ''}
                </span>
              </span>
              <Badge tone={h.status === 'committed' ? 'success' : h.status === 'canceled' ? 'muted' : 'info'}>
                {h.status === 'committed' ? '反映済み' : h.status === 'canceled' ? '取消' : 'プレビュー'}
              </Badge>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

