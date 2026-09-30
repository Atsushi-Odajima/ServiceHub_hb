/**
 * Cloudflare Turnstile(公開予約・キャンセル待ちの bot 対策。任意)。
 * サーバーに TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY が設定されているときだけ表示し、
 * 確認が済むまで送信ボタンを押せないようにする。トークンは1回限りなので、送信に失敗したら作り直す。
 */
import { useEffect, useRef, useState } from 'react';
import { useApi } from '../api/hooks';

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SCRIPT_URL;
      s.async = true;
      s.onload = () => (window.turnstile ? resolve() : reject(new Error('turnstile not available')));
      s.onerror = () => reject(new Error('turnstile load failed'));
      document.head.appendChild(s);
    }).catch((e) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}

/** サイトキー(未設定なら null = 表示しない) */
export function useTurnstileSiteKey(): { siteKey: string | null; loading: boolean } {
  const q = useApi<{ turnstileSiteKey: string | null }>(['public-config'], '/api/v1/public/config', { staleTime: Infinity, retry: 1 });
  return { siteKey: q.data?.turnstileSiteKey ?? null, loading: q.isLoading };
}

/** resetKey を変えると確認をやり直す(送信失敗後など) */
export function TurnstileWidget({ siteKey, onToken, resetKey = 0 }: { siteKey: string; onToken: (token: string | null) => void; resetKey?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const cb = useRef(onToken);
  cb.current = onToken;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !box.current || !window.turnstile) return;
        widget.current = window.turnstile.render(box.current, {
          sitekey: siteKey,
          language: 'ja',
          callback: (token: string) => cb.current(token),
          'expired-callback': () => cb.current(null),
          'error-callback': () => cb.current(null),
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetKey === 0) return;
    cb.current(null);
    if (widget.current && window.turnstile) window.turnstile.reset(widget.current);
  }, [resetKey]);

  return (
    <div className="stack" style={{ gap: 4 }}>
      <div ref={box} aria-label="ロボットによる送信を防ぐための確認" />
      {failed ? (
        <p className="small" role="alert" style={{ margin: 0 }}>
          確認のための部品を読み込めませんでした。通信状況を確認して、ページを読み込み直してください。
        </p>
      ) : null}
    </div>
  );
}
