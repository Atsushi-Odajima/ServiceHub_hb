import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router';
import { ROLE_LABELS } from '../../../shared/permissions';
import { api, ApiError, setCsrfToken } from '../../api/client';
import { useApi, useMe } from '../../api/hooks';
import { clearOfflineCaches } from '../../components/Layout';
import { Alert, Button, Checkbox, ErrorMessage, Spinner, TextField } from '../../components/ui';

function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="auth-page">
      <main className="auth-card">
        <div className="brand">
          <img src="/pwa-192x192.png" alt="" />
          ServiceHub
        </div>
        <h1 style={{ fontSize: '1.25rem' }}>{title}</h1>
        {children}
      </main>
    </div>
  );
}

function safeNext(next: string | null): string {
  // オープンリダイレクト防止: アプリ内パスのみ
  if (next && next.startsWith('/') && !next.startsWith('//')) return next;
  return '/app';
}

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ csrfToken: string }>('/api/v1/auth/login', { email, password, remember });
      setCsrfToken(r.csrfToken);
      // 共有端末で前の利用者の閲覧キャッシュ(個人情報)が見えないように、ログインのたびに消す
      await clearOfflineCaches();
      qc.clear();
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (e2) {
      setErr(e2 as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard title="ログイン">
      <form className="stack" onSubmit={submit} noValidate>
        <ErrorMessage error={err} />
        <TextField label="メールアドレス" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <TextField
          label="パスワード"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <Checkbox label="ログイン状態を保持する(受付用タブレット等)" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <Button type="submit" variant="primary" block busy={busy} disabled={!email || !password}>
          ログイン
        </Button>
        <p className="small muted" style={{ textAlign: 'center', margin: 0 }}>
          <Link to="/forgot-password">パスワードを忘れた場合</Link>
        </p>
      </form>
    </AuthCard>
  );
}

export function SelectOrgPage() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [err, setErr] = useState<ApiError | null>(null);
  if (me.isLoading) return <Spinner />;
  if (me.error) return <Navigate to="/login" replace />;
  const choose = async (organizationId: string) => {
    try {
      const r = await api.post<{ csrfToken: string }>('/api/v1/auth/switch-org', { organizationId });
      setCsrfToken(r.csrfToken);
      await clearOfflineCaches();
      qc.clear();
      navigate('/app', { replace: true });
    } catch (e) {
      setErr(e as ApiError);
    }
  };
  const list = me.data?.memberships ?? [];
  return (
    <AuthCard title="組織を選択">
      <ErrorMessage error={err} />
      {list.length === 0 ? (
        <Alert tone="warning">利用できる組織がありません。管理者に招待を依頼してください。</Alert>
      ) : (
        <ul className="list">
          {list.map((m) => (
            <li key={m.organizationId}>
              <button type="button" className="list-item" onClick={() => void choose(m.organizationId)}>
                <span className="grow">
                  <strong>{m.name}</strong>
                  <br />
                  <span className="muted small">{ROLE_LABELS[m.role]}</span>
                </span>
                <span aria-hidden="true">›</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </AuthCard>
  );
}

export function AcceptInvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const info = useApi<{ email: string; role: keyof typeof ROLE_LABELS; organizationName: string; userExists: boolean }>(
    ['invite', token],
    `/api/v1/auth/invitations/${encodeURIComponent(token)}`,
    { retry: false },
  );
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  if (info.isLoading) return <Spinner />;
  if (info.error) {
    return (
      <AuthCard title="招待">
        <ErrorMessage error={info.error} />
        <Link to="/login">ログイン画面へ</Link>
      </AuthCard>
    );
  }
  const d = info.data!;
  const mismatch = !d.userExists && password2.length > 0 && password !== password2;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<{ csrfToken: string }>(`/api/v1/auth/invitations/${encodeURIComponent(token)}/accept`, {
        displayName: d.userExists ? undefined : name,
        password,
      });
      setCsrfToken(r.csrfToken);
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate('/app', { replace: true });
    } catch (e2) {
      setErr(e2 as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard title={`${d.organizationName} への招待`}>
      <p>
        <strong>{d.email}</strong> を {ROLE_LABELS[d.role]} として招待しています。
      </p>
      <form className="stack" onSubmit={submit} noValidate>
        <ErrorMessage error={err} />
        {d.userExists ? (
          <TextField label="既存アカウントのパスワード" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        ) : (
          <>
            <TextField label="表示名" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
            <TextField
              label="パスワード"
              hint="10文字以上"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              error={err?.fields?.password}
            />
            <TextField
              label="パスワード(確認)"
              type="password"
              autoComplete="new-password"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              required
              error={mismatch ? 'パスワードが一致しません' : undefined}
            />
          </>
        )}
        <Button type="submit" variant="primary" block busy={busy} disabled={!password || mismatch || (!d.userExists && !name)}>
          参加する
        </Button>
      </form>
    </AuthCard>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.post<{ message: string }>('/api/v1/auth/password-reset/request', { email });
      setDone(r.message);
    } catch (e2) {
      setErr(e2 as ApiError);
    }
  };
  return (
    <AuthCard title="パスワード再設定">
      {done ? (
        <Alert tone="success">{done}</Alert>
      ) : (
        <form className="stack" onSubmit={submit}>
          <ErrorMessage error={err} />
          <p className="small muted">登録メールアドレスに再設定用のリンクを送信します。メールが使えない場合は管理者に再設定リンクの発行を依頼してください。</p>
          <TextField label="メールアドレス" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          <Button type="submit" variant="primary" block disabled={!email}>
            送信する
          </Button>
        </form>
      )}
      <p className="small" style={{ marginTop: 12 }}>
        <Link to="/login">ログイン画面へ戻る</Link>
      </p>
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const mismatch = password2.length > 0 && password !== password2;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    try {
      await api.post('/api/v1/auth/password-reset/confirm', { token, password });
      setDone(true);
    } catch (e2) {
      setErr(e2 as ApiError);
    }
  };
  return (
    <AuthCard title="新しいパスワードの設定">
      {done ? (
        <>
          <Alert tone="success">パスワードを変更しました。新しいパスワードでログインしてください。</Alert>
          <p style={{ marginTop: 12 }}>
            <Link to="/login">ログイン画面へ</Link>
          </p>
        </>
      ) : (
        <form className="stack" onSubmit={submit}>
          <ErrorMessage error={err} />
          <TextField label="新しいパスワード" hint="10文字以上" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} error={err?.fields?.password} />
          <TextField label="新しいパスワード(確認)" type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} error={mismatch ? 'パスワードが一致しません' : undefined} />
          <Button type="submit" variant="primary" block disabled={!token || password.length < 10 || mismatch}>
            設定する
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
