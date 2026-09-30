import type pg from 'pg';
import type { Deps } from '../deps.js';
import type { SampleIds } from './seed.js';

/** 実施履歴・回数券・利用プラン・待機リストのサンプル(Phase 4-7 で追加) */
export async function sampleExtras(_pool: pg.Pool, _deps: Deps, _ids: SampleIds, _now: Date): Promise<void> {
  return;
}
