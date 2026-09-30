import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import type { Permission } from '../../shared/permissions';
import { ROLE_LABELS } from '../../shared/permissions';
import { api, ApiError } from '../api/client';
import { useCan, useMe, useOnline } from '../api/hooks';
import { useRealtime } from '../lib/realtime';
import { Spinner } from './ui';
import { UpdatePrompt } from './UpdatePrompt';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  any?: Permission[];
  end?: boolean;
}

const NAV: { title: string; items: NavItem[] }[] = [
  {
    title: '日々の運営',
    items: [
      { to: '/app', label: 'ダッシュボード', icon: '⌂', end: true },
      { to: '/app/schedule', label: '予定表', icon: '▦', any: ['booking.read.all', 'booking.read.own'] },
      { to: '/app/bookings', label: '予約', icon: '☰', any: ['booking.read.all', 'booking.read.own'] },
      { to: '/app/reception', label: '受付モード', icon: '◉', any: ['reception.operate'] },
      { to: '/app/customers', label: '顧客', icon: '☺', any: ['customer.read'] },
      { to: '/app/waitlist', label: '待機リスト', icon: '⧗', any: ['waitlist.read'] },
    ],
  },
  {
    title: '利用権',
    items: [
      { to: '/app/passes', label: '回数券', icon: '▤', any: ['pass.read'] },
      { to: '/app/plans', label: '利用プラン', icon: '↻', any: ['plan.read'] },
    ],
  },
  {
    title: 'スタッフ',
    items: [{ to: '/app/shifts', label: 'シフト', icon: '◷', any: ['shift.manage', 'shift.read.all', 'shift.read.own'] }],
  },
  {
    title: '分析・管理',
    items: [
      { to: '/app/kpi', label: '運営KPI', icon: '▲', any: ['kpi.read'] },
      { to: '/app/search', label: '検索', icon: '⌕' },
      { to: '/app/notifications', label: '通知履歴', icon: '✉', any: ['notification.read'] },
      { to: '/app/audit', label: '監査ログ', icon: '✎', any: ['audit.read'] },
      {
        to: '/app/csv',
        label: 'CSV入出力',
        icon: '⇅',
        any: ['csv.export.customers', 'csv.export.bookings', 'csv.export.master', 'csv.export.ledger', 'csv.import'],
      },
      {
        to: '/app/settings',
        label: '設定',
        icon: '⚙',
        any: [
          'org.manage',
          'location.manage',
          'location.schedule.manage',
          'service.manage',
          'staff.manage',
          'resource.manage',
          'member.manage',
          'pass.product.manage',
          'plan.product.manage',
          'backup.manage',
        ],
      },
    ],
  },
];

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const can = useCan();
  return (
    <nav aria-label="メインメニュー">
      {NAV.map((sec) => {
        const items = sec.items.filter((i) => !i.any || i.any.some((p) => can(p)));
        if (items.length === 0) return null;
        return (
          <div className="nav-section" key={sec.title}>
            <div className="nav-section-title">{sec.title}</div>
            {items.map((i) => (
              <NavLink key={i.to} to={i.to} end={i.end} className="nav-link" onClick={onNavigate}>
                <span className="nav-icon" aria-hidden="true">
                  {i.icon}
                </span>
                {i.label}
              </NavLink>
            ))}
          </div>
        );
      })}
      <div className="nav-section">
        <NavLink to="/app/account" className="nav-link" onClick={onNavigate}>
          <span className="nav-icon" aria-hidden="true">
            ☻
          </span>
          アカウント
        </NavLink>
      </div>
    </nav>
  );
}

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="banner banner-offline" role="alert">
      <span aria-hidden="true">⚠</span>
      オフラインです。表示は最後に取得した内容です。予約・受付・消化などの操作はできません(未完了のまま)。
    </div>
  );
}

/** ログイン必須領域 */
export function AuthGate({ children }: { children: ReactNode }) {
  const me = useMe();
  const loc = useLocation();
  if (me.isLoading) return <Spinner />;
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401) {
      return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
    }
    return (
      <div className="content">
        <div className="alert alert-danger" role="alert">
          {me.error.message}{' '}
          <button className="link-btn" onClick={() => void me.refetch()}>
            再試行
          </button>
        </div>
      </div>
    );
  }
  if (!me.data?.organization) return <Navigate to="/select-org" replace />;
  return <>{children}</>;
}

export function AppLayout() {
  const me = useMe();
  const can = useCan();
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  useRealtime();
  useEffect(() => setDrawer(false), [loc.pathname]);
  const org = me.data?.organization;
  const role = me.data?.membership?.role;
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        本文へ移動
      </a>
      <aside className="sidebar">
        <a className="brand" href="/app">
          <img src="/pwa-192x192.png" alt="" />
          ServiceHub
        </a>
        <NavList />
      </aside>
      <div className="main">
        <OfflineBanner />
        {org?.isSample ? (
          <div className="banner banner-sample">サンプル組織です(本番データではありません・メールは送信されません)</div>
        ) : null}
        <UpdatePrompt />
        <header className="topbar">
          <div className="grow">
            <div className="title">{org?.name}</div>
            <div className="muted small">
              {me.data?.user.name} ・ {role ? ROLE_LABELS[role] : ''}
            </div>
          </div>
          <UserMenu />
        </header>
        <main id="main" className="content" tabIndex={-1}>
          <Outlet />
        </main>
        <nav className="bottom-nav" aria-label="クイックメニュー">
          <NavLink to="/app" end>
            <span className="bn-icon" aria-hidden="true">
              ⌂
            </span>
            今日
          </NavLink>
          {can('booking.read.all') || can('booking.read.own') ? (
            <NavLink to="/app/schedule">
              <span className="bn-icon" aria-hidden="true">
                ▦
              </span>
              予定
            </NavLink>
          ) : null}
          {can('reception.operate') ? (
            <NavLink to="/app/reception">
              <span className="bn-icon" aria-hidden="true">
                ◉
              </span>
              受付
            </NavLink>
          ) : can('customer.read') ? (
            <NavLink to="/app/customers">
              <span className="bn-icon" aria-hidden="true">
                ☺
              </span>
              顧客
            </NavLink>
          ) : null}
          <NavLink to="/app/search">
            <span className="bn-icon" aria-hidden="true">
              ⌕
            </span>
            検索
          </NavLink>
          <button type="button" onClick={() => setDrawer(true)} aria-haspopup="dialog" aria-expanded={drawer}>
            <span className="bn-icon" aria-hidden="true">
              ≡
            </span>
            メニュー
          </button>
        </nav>
        {drawer ? (
          <div className="drawer" role="dialog" aria-modal="true" aria-label="メニュー" onClick={(e) => e.target === e.currentTarget && setDrawer(false)}>
            <div className="drawer-panel">
              <div className="row-between" style={{ padding: '12px 16px', color: '#fff' }}>
                <strong>メニュー</strong>
                <button type="button" className="btn btn-sm" onClick={() => setDrawer(false)}>
                  閉じる
                </button>
              </div>
              <NavList onNavigate={() => setDrawer(false)} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function UserMenu() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logout = async () => {
    try {
      await api.post('/api/v1/auth/logout');
    } finally {
      await clearOfflineCaches();
      qc.clear();
      navigate('/login');
    }
  };
  const others = (me.data?.memberships ?? []).filter((m) => m.organizationId !== me.data?.organization?.id);
  return (
    <div className="row">
      {others.length > 0 ? (
        <NavLinkButton to="/select-org" label="組織を切替" />
      ) : null}
      <button type="button" className="btn btn-sm" onClick={() => void logout()}>
        ログアウト
      </button>
    </div>
  );
}

function NavLinkButton({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate(to)}>
      {label}
    </button>
  );
}

/** ログアウト時に閲覧キャッシュ(個人情報を含み得る)を消す */
export async function clearOfflineCaches(): Promise<void> {
  try {
    if ('caches' in window) await caches.delete('sh-offline-read');
  } catch {
    /* ignore */
  }
}
