export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SLOT_UNAVAILABLE'
  | 'VERSION_CONFLICT'
  | 'INVALID_STATE'
  | 'RATE_LIMITED'
  | 'CSRF_FAILED'
  | 'PAYLOAD_TOO_LARGE'
  | 'INSUFFICIENT_BALANCE'
  | 'DUPLICATE_IMPORT'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SLOT_UNAVAILABLE: 409,
  VERSION_CONFLICT: 409,
  INVALID_STATE: 409,
  RATE_LIMITED: 429,
  CSRF_FAILED: 403,
  PAYLOAD_TOO_LARGE: 413,
  INSUFFICIENT_BALANCE: 409,
  DUPLICATE_IMPORT: 409,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export const notFound = (what = '対象'): AppError => new AppError('NOT_FOUND', `${what}が見つかりません`);
export const forbidden = (message = 'この操作を行う権限がありません'): AppError =>
  new AppError('FORBIDDEN', message);
export const invalidState = (message: string, details?: unknown): AppError =>
  new AppError('INVALID_STATE', message, details);
export const versionConflict = (): AppError =>
  new AppError('VERSION_CONFLICT', '他の操作で内容が更新されています。最新の状態を読み込み直してください。');

/** PostgreSQL error → AppError (unknown errors are re-thrown as-is) */
export function mapPgError(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (!e || typeof e !== 'object' || typeof e.code !== 'string') return err;
  switch (e.code) {
    case '23P01': // exclusion_violation
      if (e.constraint === 'occupancies_no_staff_overlap') {
        return new AppError('SLOT_UNAVAILABLE', 'この時間は担当スタッフが他の予約で埋まっています');
      }
      if (e.constraint === 'staff_shifts_no_work_overlap') {
        return new AppError('CONFLICT', '同じスタッフの勤務時間が他の勤務(別拠点を含む)と重なっています');
      }
      return new AppError('CONFLICT', '他のデータと時間が重なっています');
    case '40001':
    case '40P01':
      return new AppError('CONFLICT', '同時に操作が行われました。もう一度お試しください。');
    case '55P03':
      return new AppError('SERVICE_UNAVAILABLE', '処理が混み合っています。少し待ってからもう一度お試しください。');
    case '57014':
      return new AppError('SERVICE_UNAVAILABLE', '処理に時間がかかりすぎたため中断しました。条件を絞って再度お試しください。');
    default:
      return err;
  }
}
