import type { Deps } from '../deps.js';
import { runScheduler } from './scheduler.js';
import { processDueNotifications } from './worker.js';
import './register.js';

/**
 * 通知ワーカーとスケジューラを定期実行する。停止関数を返す。
 * 複数インスタンスで同時に動かしても、SKIP LOCKED と冪等キーにより重複送信/重複登録しない。
 */
export function startBackgroundJobs(deps: Deps): () => void {
  let stopped = false;
  let workerBusy = false;
  let schedulerBusy = false;
  const workerTick = async () => {
    if (workerBusy || stopped) return;
    workerBusy = true;
    try {
      // 溜まっている分は続けて処理
      for (let i = 0; i < 10; i++) {
        const r = await processDueNotifications(deps, 20);
        if (r.claimed < 20) break;
      }
    } catch (err) {
      deps.log.error({ err: String((err as Error).message) }, 'notification worker error');
    } finally {
      workerBusy = false;
    }
  };
  const schedulerTick = async () => {
    if (schedulerBusy || stopped) return;
    schedulerBusy = true;
    try {
      await runScheduler(deps);
    } catch (err) {
      deps.log.error({ err: String((err as Error).message) }, 'scheduler error');
    } finally {
      schedulerBusy = false;
    }
  };
  const w = setInterval(() => void workerTick(), deps.config.WORKER_POLL_MS);
  const s = setInterval(() => void schedulerTick(), deps.config.SCHEDULER_INTERVAL_MS);
  setTimeout(() => void schedulerTick(), 3000);
  return () => {
    stopped = true;
    clearInterval(w);
    clearInterval(s);
  };
}
