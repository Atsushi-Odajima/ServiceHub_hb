/**
 * 端末内の下書き(実施記録・顧客情報・顧客メモの入力)。
 * - 通信が切れたり画面を閉じたりしても入力が失われないよう、入力のたびにこの端末(localStorage)へ保存する
 * - サーバーへは送らない。送信は通常の操作で、オンラインのときに最新の状態(版番号)で再検証してから行う
 * - キーに組織・ユーザーを含め、別の人・別の組織には表示しない。ログアウト時は全て、ログイン時は他の人の分を消す
 * - 7日より古い下書きは捨てる
 */
import { useEffect, useRef, useState } from 'react';
import { useMe } from '../api/hooks';

const PREFIX = 'sh.draft.';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface Draft<T> {
  savedAt: string;
  data: T;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function keysWithPrefix(prefix: string): string[] {
  const s = storage();
  if (!s) return [];
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k && k.startsWith(prefix)) out.push(k);
  }
  return out;
}

export function draftKey(orgId: string, userId: string, kind: string, id: string): string {
  return `${PREFIX}${orgId}.${userId}.${kind}.${id}`;
}

export function loadDraft<T>(key: string): Draft<T> | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft<T>;
    if (!d?.savedAt || Date.now() - new Date(d.savedAt).getTime() > MAX_AGE_MS) {
      s.removeItem(key);
      return null;
    }
    return d;
  } catch {
    return null;
  }
}

export function saveDraft<T>(key: string, data: T): Draft<T> | null {
  const s = storage();
  if (!s) return null;
  const d: Draft<T> = { savedAt: new Date().toISOString(), data };
  try {
    s.setItem(key, JSON.stringify(d));
    return d;
  } catch {
    return null;
  }
}

export function removeDraft(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** この端末に残っている下書きの件数(userId を指定するとその人の分だけ) */
export function countDrafts(userId?: string): number {
  return keysWithPrefix(PREFIX).filter((k) => !userId || k.split('.')[3] === userId).length;
}

/** 下書きを消す。keepUserId を指定すると、その人の下書きは残す(同じ人が再ログインしたとき用) */
export function clearDrafts(keepUserId?: string): void {
  for (const k of keysWithPrefix(PREFIX)) {
    if (keepUserId && k.split('.')[3] === keepUserId) continue;
    removeDraft(k);
  }
}

/**
 * 入力欄の値を下書きとして保存しながら扱う。値が初期値と同じなら下書きは持たない。
 * kind/id が null のとき(ログイン情報の取得前など)は保存しない。
 */
export function useDraft<T extends Record<string, string>>(kind: string, id: string | null, initial: T) {
  const me = useMe();
  const orgId = me.data?.organization?.id;
  const userId = me.data?.user.id;
  const key = orgId && userId && id ? draftKey(orgId, userId, kind, id) : null;
  const initialRef = useRef(initial);
  const [restored, setRestored] = useState<Draft<T> | null>(() => (key ? loadDraft<T>(key) : null));
  const [value, setValue] = useState<T>(() => (restored ? { ...initial, ...restored.data } : initial));
  const [savedAt, setSavedAt] = useState<string | null>(restored?.savedAt ?? null);
  // 下書きを読み込み済みのキー。読み込む前に保存(=上書き・削除)しないようにする
  const [readyKey, setReadyKey] = useState<string | null>(key);

  // ログイン情報が後から分かった場合に、下書きを読み込む
  useEffect(() => {
    if (!key || readyKey === key) return;
    const d = loadDraft<T>(key);
    if (d) {
      setRestored(d);
      setValue({ ...initialRef.current, ...d.data });
      setSavedAt(d.savedAt);
    }
    setReadyKey(key);
  }, [key, readyKey]);

  useEffect(() => {
    if (!key || readyKey !== key) return;
    const changed = (Object.keys(value) as (keyof T)[]).some((k) => value[k] !== initialRef.current[k]);
    if (!changed) {
      removeDraft(key);
      setSavedAt(null);
      return;
    }
    setSavedAt(saveDraft(key, value)?.savedAt ?? null);
  }, [key, readyKey, value]);

  const set = <K extends keyof T>(k: K, v: T[K]) => setValue((cur) => ({ ...cur, [k]: v }));
  /** 送信に成功したとき: 下書きを消す(画面の値はそのまま) */
  const clear = () => {
    if (key) removeDraft(key);
    setSavedAt(null);
    setRestored(null);
  };
  /** 下書きを破棄して初期値に戻す */
  const discard = () => {
    clear();
    setValue(initialRef.current);
  };
  return { value, set, setAll: setValue, restored, savedAt, clear, discard };
}

/**
 * 保存済みの下書きを読むだけ(フォームを表示しない画面で「未送信の下書きがある」ことを知らせる)。
 * refresh が変わったら読み直す(予約の状態・版など)
 */
export function useStoredDraft<T>(kind: string, id: string | null, refresh = ''): { draft: Draft<T> | null; discard: () => void } {
  const me = useMe();
  const orgId = me.data?.organization?.id;
  const userId = me.data?.user.id;
  const key = orgId && userId && id ? draftKey(orgId, userId, kind, id) : null;
  const [draft, setDraft] = useState<Draft<T> | null>(() => (key ? loadDraft<T>(key) : null));
  useEffect(() => {
    setDraft(key ? loadDraft<T>(key) : null);
  }, [key, refresh]);
  return {
    draft,
    discard: () => {
      if (key) removeDraft(key);
      setDraft(null);
    },
  };
}
