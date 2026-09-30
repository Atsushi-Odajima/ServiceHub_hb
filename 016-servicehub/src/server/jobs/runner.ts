import type { Deps } from '../deps.js';

/** 通知ワーカー/スケジューラの起動(Phase 3 で実装を追加)。停止関数を返す。 */
export function startBackgroundJobs(_deps: Deps): () => void {
  return () => undefined;
}
