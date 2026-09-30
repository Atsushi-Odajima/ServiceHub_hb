import type pg from 'pg';
import type { AppConfig } from './config.js';
import type { Mailer } from './email/mailer.js';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** テスト用: 任意の時刻に固定/進められる時計 */
export class FakeClock implements Clock {
  private t: number;
  constructor(start: Date | string = new Date()) {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(d: Date | string): void {
    this.t = new Date(d).getTime();
  }
  advanceMinutes(min: number): void {
    this.t += min * 60000;
  }
}

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface Deps {
  pool: pg.Pool;
  config: AppConfig;
  clock: Clock;
  mailer: Mailer;
  log: Logger;
}
