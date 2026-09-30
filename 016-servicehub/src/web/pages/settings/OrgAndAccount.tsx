import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { OrgSettings } from '../../../shared/constants';
import type { Permission } from '../../../shared/permissions';
import { api, type ApiError } from '../../api/client';
import { useApi, useApiMutation, useCan, useMe } from '../../api/hooks';
import { Alert, Button, Card, Checkbox, ErrorMessage, PageHeader, SelectField, Spinner, TextAreaField, TextField } from '../../components/ui';

const SETTINGS_LINKS: { to: string; title: string; desc: string; perm: Permission[] }[] = [
  { to: '/app/settings/org', title: '組織・運営ルール', desc: '組織名、移動時間、キャンセル時の消化ルール、通知', perm: ['org.manage'] },
  { to: '/app/settings/locations', title: '拠点', desc: '営業時間、定休日、臨時休業、予約ページ', perm: ['location.manage', 'location.schedule.manage'] },
  { to: '/app/settings/services', title: 'サービス', desc: '所要時間、buffer、定員、必要リソース、事前質問', perm: ['service.manage'] },
  { to: '/app/settings/staff', title: 'スタッフ', desc: 'プロフィール、所属拠点、対応サービス、アーカイブ', perm: ['staff.manage'] },
  { to: '/app/settings/resources', title: 'リソース', desc: '部屋・ベッド・スタジオ・機材、メンテナンス停止', perm: ['resource.manage'] },
  { to: '/app/settings/members', title: 'メンバーと権限', desc: 'ログイン招待、ロール、担当拠点、無効化', perm: ['member.manage'] },
  { to: '/app/settings/pass-products', title: '回数券の種類', desc: '回数、有効期間、対象サービス', perm: ['pass.product.manage'] },
  { to: '/app/settings/plan-products', title: '利用プランの種類', desc: '期間内の利用回数、対象サービス、繰越', perm: ['plan.product.manage'] },
  { to: '/app/settings/backup', title: 'バックアップ', desc: '組織データのバックアップ作成・検証', perm: ['backup.manage'] },
];

export function SettingsHome() {
  const can = useCan();
  const links = SETTINGS_LINKS.filter((l) => l.perm.some((p) => can(p)));
  return (
    <>
      <PageHeader title="設定" />
      <div className="grid-auto">
        {links.map((l) => (
          <Link key={l.to} to={l.to} className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
            <h2 style={{ fontSize: '1.05rem' }}>{l.title}</h2>
            <p className="muted small" style={{ margin: 0 }}>
              {l.desc}
            </p>
          </Link>
        ))}
      </div>
    </>
  );
}

interface OrgResponse {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  isSample: boolean;
  publicProfile: { description?: string | null; contact?: string | null };
  settings: OrgSettings;
}

export function OrgSettingsPage() {
  const org = useApi<OrgResponse>(['org'], '/api/v1/org');
  const [form, setForm] = useState<OrgResponse | null>(null);
  useEffect(() => {
    if (org.data) setForm(org.data);
  }, [org.data]);
  const save = useApiMutation((body: unknown) => api.patch('/api/v1/org', body), { invalidate: [['org'], ['me']], success: '保存しました' });
  if (org.isLoading || !form) return <Spinner />;
  const s = form.settings;
  const setS = (patch: Partial<OrgSettings>) => setForm({ ...form, settings: { ...form.settings, ...patch } });
  const setN = (key: keyof OrgSettings['notifications'], v: boolean) =>
    setForm({ ...form, settings: { ...s, notifications: { ...s.notifications, [key]: v } } });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ name: form.name, timezone: form.timezone, publicProfile: form.publicProfile, settings: form.settings });
  };
  const err = save.error as ApiError | null;
  return (
    <form onSubmit={submit} className="stack-lg">
      <PageHeader title="組織・運営ルール" sub={`公開予約URL: /p/${form.slug}`} />
      <ErrorMessage error={org.error} />
      <Card title="基本情報">
        <div className="grid-2">
          <TextField label="組織名" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required error={err?.fields?.name} />
          <TextField label="タイムゾーン(組織の既定)" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} hint="例: Asia/Tokyo" />
        </div>
        <TextAreaField
          label="公開ページの紹介文"
          value={form.publicProfile.description ?? ''}
          onChange={(e) => setForm({ ...form, publicProfile: { ...form.publicProfile, description: e.target.value } })}
        />
        <TextField
          label="お問い合わせ先(公開)"
          value={form.publicProfile.contact ?? ''}
          onChange={(e) => setForm({ ...form, publicProfile: { ...form.publicProfile, contact: e.target.value } })}
        />
      </Card>
      <Card title="予約と拠点間移動">
        <div className="grid-2">
          <SelectField
            label="拠点間の移動時間"
            hint="0分の場合は同時刻の重複のみ防止します。設定すると、スタッフが別拠点の予約の前後この時間内に予約を入れられなくなります。"
            value={String(s.travelBufferMinutes)}
            onChange={(e) => setS({ travelBufferMinutes: Number(e.target.value) })}
            options={[0, 15, 30, 45, 60, 90, 120].map((m) => ({ value: String(m), label: m === 0 ? '設定しない(0分)' : `${m}分` }))}
          />
          <SelectField
            label="リマインダー送信"
            value={String(s.reminderLeadHours)}
            onChange={(e) => setS({ reminderLeadHours: Number(e.target.value) })}
            options={[0, 2, 3, 6, 12, 24, 48, 72].map((h) => ({ value: String(h), label: h === 0 ? '送信しない' : `開始の${h}時間前` }))}
          />
        </div>
        <Checkbox
          label="スタッフが自拠点の全顧客を検索できる(オフの場合は自分の担当顧客のみ)"
          checked={s.staffCanSearchLocationCustomers}
          onChange={(e) => setS({ staffCanSearchLocationCustomers: e.target.checked })}
        />
      </Card>
      <Card title="回数券・利用プランの消化ルール">
        <div className="grid-2">
          <SelectField
            label="完了時の消化"
            value={s.consumptionPrompt}
            onChange={(e) => setS({ consumptionPrompt: e.target.value as OrgSettings['consumptionPrompt'] })}
            options={[
              { value: 'on_complete', label: '完了時に利用可能な券を表示して確認' },
              { value: 'manual', label: '完了時は表示しない(実施記録から後で消化)' },
            ]}
            hint="どちらの場合も「1回消化」の確認なしに自動で消化されることはありません。"
          />
          <SelectField
            label="締切後キャンセル・無断欠席"
            value={s.lateCancelPolicy}
            onChange={(e) => setS({ lateCancelPolicy: e.target.value as OrgSettings['lateCancelPolicy'] })}
            options={[
              { value: 'confirm', label: '運営者が消化するか確認する' },
              { value: 'none', label: '消化しない' },
            ]}
            hint="自動の罰則消化は行いません。"
          />
          <TextField
            label="回数券の期限お知らせ(日前)"
            type="number"
            min={0}
            max={90}
            value={s.passExpiringNoticeDays}
            onChange={(e) => setS({ passExpiringNoticeDays: Number(e.target.value) })}
          />
          <TextField
            label="利用プラン終了のお知らせ(日前)"
            type="number"
            min={0}
            max={90}
            value={s.planExpiringNoticeDays}
            onChange={(e) => setS({ planExpiringNoticeDays: Number(e.target.value) })}
          />
        </div>
      </Card>
      <Card title="顧客へのメール通知">
        <div className="grid-2">
          <Checkbox label="予約確定" checked={s.notifications.bookingConfirmed} onChange={(e) => setN('bookingConfirmed', e.target.checked)} />
          <Checkbox label="予約変更" checked={s.notifications.bookingChanged} onChange={(e) => setN('bookingChanged', e.target.checked)} />
          <Checkbox label="キャンセル" checked={s.notifications.bookingCanceled} onChange={(e) => setN('bookingCanceled', e.target.checked)} />
          <Checkbox label="リマインダー" checked={s.notifications.bookingReminder} onChange={(e) => setN('bookingReminder', e.target.checked)} />
          <Checkbox label="空き枠のお知らせ(待機)" checked={s.notifications.waitlistAvailable} onChange={(e) => setN('waitlistAvailable', e.target.checked)} />
          <Checkbox label="回数券の期限" checked={s.notifications.passExpiring} onChange={(e) => setN('passExpiring', e.target.checked)} />
          <Checkbox label="利用プランの期限" checked={s.notifications.planExpiring} onChange={(e) => setN('planExpiring', e.target.checked)} />
        </div>
        <TextField
          label="返信先メールアドレス(任意)"
          type="email"
          value={s.replyToEmail ?? ''}
          onChange={(e) => setS({ replyToEmail: e.target.value || null })}
          error={err?.fields?.['settings.replyToEmail']}
        />
      </Card>
      {form.isSample ? <Alert tone="warning">サンプル組織ではメールは実際には送信されません。</Alert> : null}
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={save.isPending}>
          保存する
        </Button>
      </div>
    </form>
  );
}

export function AccountPage() {
  const me = useMe();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const change = useApiMutation((body: unknown) => api.post('/api/v1/auth/change-password', body), {
    success: 'パスワードを変更しました(他の端末はログアウトされました)',
    onSuccess: () => {
      setCur('');
      setNext('');
      setNext2('');
    },
  });
  const err = change.error as ApiError | null;
  const mismatch = next2.length > 0 && next !== next2;
  return (
    <div className="stack-lg">
      <PageHeader title="アカウント" />
      <Card title="ログイン情報">
        <dl className="kv">
          <dt>表示名</dt>
          <dd>{me.data?.user.name}</dd>
          <dt>メールアドレス</dt>
          <dd>{me.data?.user.email}</dd>
          <dt>組織</dt>
          <dd>{me.data?.organization?.name}</dd>
        </dl>
      </Card>
      <Card title="パスワード変更">
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (!mismatch) change.mutate({ currentPassword: cur, newPassword: next });
          }}
        >
          <TextField label="現在のパスワード" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} error={err?.fields?.currentPassword} />
          <TextField label="新しいパスワード" hint="10文字以上" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} error={err?.fields?.newPassword} />
          <TextField label="新しいパスワード(確認)" type="password" autoComplete="new-password" value={next2} onChange={(e) => setNext2(e.target.value)} error={mismatch ? '一致しません' : undefined} />
          <div className="form-actions">
            <Button type="submit" variant="primary" busy={change.isPending} disabled={!cur || next.length < 10 || mismatch}>
              変更する
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
