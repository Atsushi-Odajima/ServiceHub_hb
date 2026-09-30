import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type Tone = 'info' | 'success' | 'error';
interface ToastItem {
  id: number;
  tone: Tone;
  message: string;
}
interface ToastApi {
  push(t: { tone?: Tone; message: string }): void;
}

const Ctx = createContext<ToastApi>({ push: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((t: { tone?: Tone; message: string }) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev.slice(-3), { id, tone: t.tone ?? 'info', message: t.message }]);
    setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== id)), t.tone === 'error' ? 8000 : 4000);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`} role={t.tone === 'error' ? 'alert' : undefined}>
            <span aria-hidden="true">{t.tone === 'success' ? '✓' : t.tone === 'error' ? '!' : 'i'}</span>
            <span className="grow">{t.message}</span>
            <button
              type="button"
              className="btn-ghost"
              style={{ color: 'inherit', background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.1rem' }}
              aria-label="閉じる"
              onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(Ctx);
}
