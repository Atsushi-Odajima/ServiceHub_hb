import { useMutation, useQuery, useQueryClient, type QueryKey, type UseQueryOptions } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import type { Permission, Role } from '../../shared/permissions';
import { useToast } from '../components/Toast';
import { api, ApiError, setCsrfToken } from './client';

export interface Me {
  user: { id: string; name: string; email: string };
  csrfToken: string;
  organization: { id: string; name: string; slug: string; timezone: string; isSample: boolean } | null;
  membership?: { id: string; role: Role; staffId: string | null; allLocations: boolean; permissions: Permission[] };
  locations?: { id: string; name: string; slug: string; timezone: string }[];
  memberships: { organizationId: string; name: string; role: Role }[];
}

export function useMe() {
  const q = useQuery<Me, ApiError>({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/api/v1/auth/me'),
    retry: false,
    staleTime: 60_000,
  });
  useEffect(() => {
    if (q.data?.csrfToken) setCsrfToken(q.data.csrfToken);
  }, [q.data?.csrfToken]);
  return q;
}

export function useCan(): (p: Permission) => boolean {
  const { data } = useMe();
  const perms = data?.membership?.permissions ?? [];
  return useCallback((p: Permission) => perms.includes(p), [perms]);
}

export function useApi<T = any>(key: QueryKey, url: string | null, opts: Partial<UseQueryOptions<T, ApiError>> = {}) {
  return useQuery<T, ApiError>({
    queryKey: key,
    // 無効化中(url=null)の refetch() でも誤ったURLへ要求しない
    queryFn: () => (url === null ? Promise.reject(new ApiError(0, 'DISABLED', '読み込み対象がありません')) : api.get<T>(url)),
    enabled: url !== null && (opts.enabled ?? true),
    ...opts,
  });
}

interface MutationOpts<TRes> {
  invalidate?: QueryKey[];
  success?: string | ((res: TRes) => string | null);
  onSuccess?: (res: TRes) => void;
  onError?: (err: ApiError) => void;
  silentError?: boolean;
}

/** 更新系。楽観的更新はしない(サーバー応答後に反映)。 */
export function useApiMutation<TBody = any, TRes = any>(fn: (body: TBody) => Promise<TRes>, opts: MutationOpts<TRes> = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<TRes, ApiError, TBody>({
    mutationFn: fn,
    onSuccess: async (res) => {
      for (const k of opts.invalidate ?? []) await qc.invalidateQueries({ queryKey: k });
      const msg = typeof opts.success === 'function' ? opts.success(res) : opts.success;
      if (msg) toast.push({ tone: 'success', message: msg });
      opts.onSuccess?.(res);
    },
    onError: (err) => {
      if (!opts.silentError) toast.push({ tone: 'error', message: err.message });
      opts.onError?.(err);
    },
  });
}

/** 通信状態(navigator.onLine + 実際の通信失敗) */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

const LOC_KEY = 'sh.currentLocation';
/** 画面上で選択中の拠点(予定表・受付など)。権限のある拠点のみ */
export function useCurrentLocation(): [string | null, (id: string) => void, Me['locations']] {
  const { data } = useMe();
  const locations = data?.locations ?? [];
  const [sel, setSel] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LOC_KEY);
    } catch {
      return null;
    }
  });
  const valid = locations.find((l) => l.id === sel)?.id ?? locations[0]?.id ?? null;
  const set = useCallback((id: string) => {
    setSel(id);
    try {
      localStorage.setItem(LOC_KEY, id);
    } catch {
      /* ignore */
    }
  }, []);
  return [valid, set, locations];
}
