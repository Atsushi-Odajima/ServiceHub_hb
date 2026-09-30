import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, ApiError, qs } from '../../api/client';
import { useApi, useMe, useOnline } from '../../api/hooks';
import { useToast } from '../../components/Toast';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, ErrorMessage, fieldError, PageHeader, Spinner, TextField } from '../../components/ui';
import { fmtDateTime, fmtNumber } from '../../lib/format';

interface BackupStatus {
  organization: { slug: string; name: string; timezone: string };
  encryption: boolean;
  uploadLimitMb: number;
  recentBackupHours: number;
  hasRecentBackup: boolean;
  excluded: { name: string; reason: string }[];
  history: {
    id: string;
    action: 'backup.created' | 'backup.restored' | 'backup.restore_tested';
    actor: string | null;
    at: string;
    via: string | null;
    bytes: number | null;
    encrypted: boolean | null;
    backupCreatedAt: string | null;
    mode: string | null;
  }[];
}

interface VerifyResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  encrypted: boolean;
  backup: { organization: { id: string; slug: string; name: string; timezone: string; isSample: boolean }; createdAt: string; appVersion: string; schemaVersion: string } | null;
  currentSchemaVersion: string | null;
  sameOrganization: boolean;
  counts: { name: string; label: string; count: number }[];
  sha256: string | null;
}

interface RestoreResult {
  dryRun: boolean;
  organization: { slug: string; name: string };
  backupCreatedAt: string;
  tables: { name: string; label: string; expected: number; restored: number; digest: 'match' | 'skipped'; note?: string }[];
  ledger: { passes: number; passEntries: number; periods: number; planEntries: number };
  users: { created: number; linked: number; membershipsDisabled: number };
  notificationsSkipped: number;
  warnings: string[];
  durationMs: number;
  reloginRequired: boolean;
}

const ACTION_LABEL: Record<BackupStatus['history'][number]['action'], string> = {
  'backup.created': '作成',
  'backup.restored': '復元',
  'backup.restore_tested': '復元テスト',
};

/** 画面・説明書で使う主要な件数 */
const MAIN_COUNTS = ['locations', 'staff', 'memberships', 'services', 'customers', 'bookings', 'service_records', 'customer_passes', 'pass_ledger_entries', 'customer_plans', 'notifications', 'audit_logs'];

function fmtBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function BackupPage() {
  const status = useApi<BackupStatus>(['backup-status'], '/api/v1/backup/status');
  if (status.isLoading) return <Spinner />;
  if (status.error) return <ErrorMessage error={status.error} retry={() => void status.refetch()} />;
  const s = status.data!;
  return (
    <div className="stack-lg">
      <PageHeader
        title="バックアップと復元"
        sub="組織のデータ(拠点・スタッフ・権限・サービス・リソース・シフト・予約・顧客・事前質問の回答・回数券と台帳・利用プラン・実施記録・通知履歴・監査ログ)を1つのファイルに保存し、必要なときに戻せます。"
      />
      <CreateCard status={s} />
      <RestoreCard status={s} />
      <HistoryCard status={s} />
    </div>
  );
}

function CreateCard({ status }: { status: BackupStatus }) {
  const toast = useToast();
  const online = useOnline();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/v1/backup/download', { credentials: 'same-origin' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new ApiError(res.status, body?.error?.code ?? 'HTTP', body?.error?.message ?? `バックアップを作成できませんでした (${res.status})`);
      }
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') ?? '';
      const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
      const name = m ? decodeURIComponent(m[1]) : 'servicehub-backup.shbak';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
      toast.push({ tone: 'success', message: `${name} を保存しました` });
      await qc.invalidateQueries({ queryKey: ['backup-status'] });
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(0, 'NETWORK', 'バックアップを作成できませんでした。通信状態を確認してください。'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="バックアップを作成">
      <div className="stack">
        <p>
          今の時点のデータをファイルに保存します。週1回以上、また大きな設定変更・CSV取込の前に作成してください。
          ホスティング会社のデータベースのバックアップ機能と併用することをおすすめします。
        </p>
        <div className="row">
          {status.encryption ? (
            <Badge tone="success" icon="🔒">
              暗号化: 有効
            </Badge>
          ) : (
            <Badge tone="warning" icon="!">
              暗号化: なし
            </Badge>
          )}
          <span className="muted small">
            {status.encryption
              ? 'サーバーの暗号化キーで暗号化されます。キーを失うと復元できません(キーはバックアップとは別に保管)。'
              : 'サーバーに BACKUP_ENCRYPTION_KEY を設定すると暗号化されます(運用手順書を参照)。'}
          </span>
        </div>
        <Alert tone="warning">
          ファイルには顧客の個人情報とログイン情報(パスワードは元に戻せない形で保存)が含まれます。メールやチャットで送らず、アクセスを制限した場所に保管してください。作成の記録は監査ログに残ります。
        </Alert>
        <details>
          <summary>含まれないもの</summary>
          <ul className="small">
            {status.excluded.map((e) => (
              <li key={e.name}>{e.reason}</li>
            ))}
          </ul>
        </details>
        <ErrorMessage error={err} />
        <div>
          <Button variant="primary" busy={busy} disabled={!online} onClick={() => void create()}>
            バックアップを作成してダウンロード
          </Button>
        </div>
      </div>
    </Card>
  );
}

function RestoreCard({ status }: { status: BackupStatus }) {
  const online = useOnline();
  const me = useMe();
  const qc = useQueryClient();
  const tz = status.organization.timezone;
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [test, setTest] = useState<RestoreResult | null>(null);
  const [done, setDone] = useState<RestoreResult | null>(null);
  const [busy, setBusy] = useState<'verify' | 'test' | 'restore' | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [savedCurrent, setSavedCurrent] = useState(false);
  const [otherOrgOk, setOtherOrgOk] = useState(false);
  const [slugInput, setSlugInput] = useState('');

  const reset = (f: File | null) => {
    setFile(f);
    setVerify(null);
    setTest(null);
    setErr(null);
    setConfirming(false);
    setSavedCurrent(false);
    setOtherOrgOk(false);
    setSlugInput('');
  };

  const run = async <T,>(kind: 'verify' | 'test' | 'restore', fn: () => Promise<T>): Promise<T | null> => {
    setBusy(kind);
    setErr(null);
    try {
      return await fn();
    } catch (e) {
      setErr(e instanceof ApiError ? e : new ApiError(0, 'NETWORK', '通信に失敗しました。操作は完了していない可能性があります。'));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const doVerify = async () => {
    if (!file) return;
    const r = await run('verify', () => api.upload<VerifyResult>('/api/v1/backup/verify', file));
    if (r) setVerify(r);
  };
  const doTest = async () => {
    if (!file) return;
    const r = await run('test', () =>
      api.upload<RestoreResult>(`/api/v1/backup/restore${qs({ confirm: status.organization.slug, dryRun: true, allowOtherOrg: verify?.sameOrganization ? undefined : true })}`, file),
    );
    if (r) {
      setTest(r);
      await qc.invalidateQueries({ queryKey: ['backup-status'] });
    }
  };
  const doRestore = async () => {
    if (!file) return;
    const r = await run('restore', () =>
      api.upload<RestoreResult>(`/api/v1/backup/restore${qs({ confirm: slugInput.trim(), allowOtherOrg: verify?.sameOrganization ? undefined : true })}`, file),
    );
    if (r) {
      setDone(r);
      qc.clear();
    }
  };

  if (done) {
    return (
      <Card title="復元が完了しました">
        <div className="stack">
          <Alert tone="success">
            {done.organization.name} のデータを {fmtDateTime(done.backupCreatedAt, tz)} 時点のバックアップに戻しました。すべての表の件数と内容、回数券・利用プランの残数がバックアップと一致することを確認済みです。
          </Alert>
          {done.warnings.map((w) => (
            <Alert key={w} tone="warning">
              {w}
            </Alert>
          ))}
          <p>安全のため全員がログアウトされました。もう一度ログインしてください。</p>
          <div>
            <Button variant="primary" onClick={() => (window.location.href = '/login')}>
              ログイン画面へ
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  const backupOrg = verify?.backup?.organization;
  const canConfirm = savedCurrent && status.hasRecentBackup && (verify?.sameOrganization || otherOrgOk) && slugInput.trim() === status.organization.slug;
  return (
    <Card title="バックアップの確認と復元">
      <div className="stack">
        <p>
          バックアップファイルを選んで「ファイルを確認」を押すと、壊れていないか・どの組織のいつの時点のデータかを確認できます(データは変わりません)。
          復元すると、この組織の現在のデータはすべてバックアップの内容に置き換わります。
        </p>
        <div className="field">
          <label htmlFor="backup-file">バックアップファイル(.shbak)</label>
          <input
            id="backup-file"
            ref={inputRef}
            type="file"
            accept=".shbak,.gz,application/octet-stream"
            className="input"
            aria-describedby="backup-file-hint"
            onChange={(e) => reset(e.target.files?.[0] ?? null)}
          />
          <span id="backup-file-hint" className="muted small">
            画面から復元できるのは {status.uploadLimitMb}MB までです。これより大きい場合は運用手順書のコマンドで復元してください。
          </span>
        </div>
        <div className="row">
          <Button busy={busy === 'verify'} disabled={!file || !online || busy !== null} onClick={() => void doVerify()}>
            ファイルを確認
          </Button>
        </div>
        <ErrorMessage error={err} />

        {verify ? (
          <div className="stack" aria-live="polite">
            {verify.ok ? (
              <Alert tone="success">ファイルは正常です(改ざん・破損なし)。この環境へ復元できます。</Alert>
            ) : (
              <Alert tone="danger">
                このファイルは復元できません。
                <ul>
                  {verify.errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {verify.backup ? (
              <dl className="kv">
                <dt>組織</dt>
                <dd>
                  {verify.backup.organization.name}(URL名: {verify.backup.organization.slug}){verify.backup.organization.isSample ? ' ・サンプル' : ''}
                </dd>
                <dt>作成日時</dt>
                <dd>{fmtDateTime(verify.backup.createdAt, tz)}</dd>
                <dt>暗号化</dt>
                <dd>{verify.encrypted ? 'あり' : 'なし'}</dd>
                <dt>作成時の版</dt>
                <dd>
                  アプリ {verify.backup.appVersion} / DB構造 {verify.backup.schemaVersion}
                  {verify.currentSchemaVersion ? `(この環境 ${verify.currentSchemaVersion})` : ''}
                </dd>
              </dl>
            ) : null}
            {verify.ok && !verify.sameOrganization && backupOrg ? (
              <Alert tone="warning">
                これは別の組織「{backupOrg.name}」のバックアップです。復元すると、この組織「{status.organization.name}」は「{backupOrg.name}」の内容に置き換わります(新しい環境へ移すときの操作です)。
              </Alert>
            ) : null}
            {verify.warnings.map((w) => (
              <Alert key={w} tone="warning">
                {w}
              </Alert>
            ))}
            {verify.counts.length ? (
              <div className="table-wrap">
                <table className="table">
                  <caption className="sr-only">バックアップに含まれる件数</caption>
                  <thead>
                    <tr>
                      <th scope="col">データ</th>
                      <th scope="col" className="num">
                        件数
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {verify.counts
                      .filter((c) => MAIN_COUNTS.includes(c.name))
                      .map((c) => (
                        <tr key={c.name}>
                          <td>{c.label}</td>
                          <td className="num">{fmtNumber(c.count)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {verify.ok ? (
              <>
                <div className="stack">
                  <h3>復元テスト</h3>
                  <p className="muted small">実際に復元とすべての照合を行い、最後に取り消します。データは変わりません(実行中の数秒間は他の操作が待たされることがあります)。</p>
                  <div>
                    <Button busy={busy === 'test'} disabled={!online || busy !== null} onClick={() => void doTest()}>
                      復元テストを実行
                    </Button>
                  </div>
                  {test ? <RestoreSummary result={test} /> : null}
                </div>

                <div className="stack">
                  <h3>この内容で復元する</h3>
                  {!confirming ? (
                    <div>
                      <Button variant="danger" disabled={!online || busy !== null} onClick={() => setConfirming(true)}>
                        復元の手続きへ進む
                      </Button>
                    </div>
                  ) : (
                    <div className="stack">
                      <Alert tone="danger">
                        <strong>復元すると次のようになります。元に戻すには、復元前に作成したバックアップから再度復元する必要があります。</strong>
                        <ul>
                          <li>
                            この組織の現在のデータはすべて削除され、{verify.backup ? fmtDateTime(verify.backup.createdAt, tz) : ''} 時点の内容に置き換わります。
                          </li>
                          <li>バックアップの作成後に登録・変更した予約・顧客・実施記録・回数券の消化などは失われます。</li>
                          <li>全員がログアウトされます(あなたも再ログインが必要です)。</li>
                          <li>バックアップ時点で未送信だった通知は送信しません。未使用の招待リンクは無効になります。</li>
                        </ul>
                      </Alert>
                      {status.hasRecentBackup ? (
                        <p className="small">
                          <Badge tone="success" icon="✓">
                            済
                          </Badge>{' '}
                          {status.recentBackupHours}時間以内に現在のデータのバックアップが作成されています。
                        </p>
                      ) : (
                        <Alert tone="warning">
                          先に上の「バックアップを作成してダウンロード」で現在のデータを保存してください({status.recentBackupHours}
                          時間以内のバックアップが必要です)。
                        </Alert>
                      )}
                      <Checkbox label="現在のデータのバックアップを保存しました" checked={savedCurrent} onChange={(e) => setSavedCurrent(e.target.checked)} />
                      {!verify.sameOrganization ? (
                        <Checkbox label="別の組織のバックアップで、この組織の内容を置き換えることを理解しました" checked={otherOrgOk} onChange={(e) => setOtherOrgOk(e.target.checked)} />
                      ) : null}
                      <TextField
                        label={`確認のため、この組織のURL名「${status.organization.slug}」を入力`}
                        value={slugInput}
                        autoComplete="off"
                        onChange={(e) => setSlugInput(e.target.value)}
                        error={fieldError(err, 'confirm')}
                      />
                      <div className="row">
                        <Button variant="danger" busy={busy === 'restore'} disabled={!canConfirm || !online || busy !== null} onClick={() => void doRestore()}>
                          復元する
                        </Button>
                        <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirming(false)}>
                          やめる
                        </Button>
                      </div>
                      {me.data?.organization?.isSample ? <p className="muted small">サンプル組織でも同じ手順で試せます。</p> : null}
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function RestoreSummary({ result }: { result: RestoreResult }) {
  const mismatch = result.tables.filter((t) => t.restored !== t.expected);
  const matched = result.tables.filter((t) => t.digest === 'match').length;
  return (
    <div className="stack" aria-live="polite">
      <Alert tone={mismatch.length ? 'danger' : 'success'}>
        {mismatch.length
          ? `件数が一致しない表があります: ${mismatch.map((t) => t.label).join('、')}`
          : `復元テストに成功しました。${result.tables.length}種類のデータの件数が一致し、そのうち${matched}種類は内容も完全に一致しました。回数券 ${result.ledger.passes} 枚・利用プラン期間 ${result.ledger.periods} 件の残数を台帳から再計算し、すべて一致しました(${(result.durationMs / 1000).toFixed(1)}秒)。`}
      </Alert>
      {result.warnings.map((w) => (
        <Alert key={w} tone="info">
          {w}
        </Alert>
      ))}
    </div>
  );
}

function HistoryCard({ status }: { status: BackupStatus }) {
  const tz = status.organization.timezone;
  return (
    <Card title="最近のバックアップと復元">
      {status.history.length === 0 ? (
        <EmptyState title="まだバックアップを作成していません" />
      ) : (
        <div className="table-wrap">
          <table className="table table-responsive">
            <thead>
              <tr>
                <th scope="col">日時</th>
                <th scope="col">操作</th>
                <th scope="col">実行者</th>
                <th scope="col">内容</th>
              </tr>
            </thead>
            <tbody>
              {status.history.map((h) => (
                <tr key={h.id}>
                  <td data-label="日時">{fmtDateTime(h.at, tz)}</td>
                  <td data-label="操作">{ACTION_LABEL[h.action]}</td>
                  <td data-label="実行者">{h.actor ?? '—'}</td>
                  <td data-label="内容" className="small">
                    {h.action === 'backup.created'
                      ? `${fmtBytes(h.bytes)}${h.encrypted ? '・暗号化' : ''}${h.via === 'cli' ? '・コマンド' : ''}`
                      : h.backupCreatedAt
                        ? `${fmtDateTime(h.backupCreatedAt, tz)} 時点のバックアップ`
                        : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
