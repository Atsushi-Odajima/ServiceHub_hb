import { z } from 'zod';
import { AppError } from '../errors.js';

z.config(z.locales.ja());

/** Zod で検証し、失敗時は VALIDATION_ERROR(項目ごとのメッセージ付き) */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const issue of r.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    throw new AppError('VALIDATION_ERROR', '入力内容に誤りがあります', { fields });
  }
  return r.data;
}

export const zUuid = z.string().uuid('IDの形式が正しくありません');
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付は YYYY-MM-DD 形式で入力してください');
export const zTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$|^24:00(:00)?$/, '時刻は HH:MM 形式で入力してください')
  .transform((t) => t.slice(0, 5));
export const zIso = z.string().datetime({ offset: true, message: '日時の形式が正しくありません' });
export const zSlug = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/, '英小文字・数字・ハイフン(先頭末尾は英数字)で入力してください');
export const zOptText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v == null || v.trim() === '' ? null : v.trim()));
export const zText = (min: number, max: number) => z.string().trim().min(min).max(max);
export const zEmail = z.string().trim().email('メールアドレスの形式が正しくありません').max(254);
export const zOptEmail = z
  .string()
  .trim()
  .max(254)
  .nullish()
  .transform((v) => (v == null || v === '' ? null : v))
  .refine((v) => v == null || z.string().email().safeParse(v).success, 'メールアドレスの形式が正しくありません');
export const zPhone = z
  .string()
  .trim()
  .max(30)
  .regex(/^[0-9０-９+()\-‐－ 　]*$/, '電話番号は数字とハイフンで入力してください')
  .nullish()
  .transform((v) => (v == null || v === '' ? null : v));
export const zIdempotencyKey = z.string().min(8).max(100).regex(/^[A-Za-z0-9_\-:.]+$/);
export const zVersion = z.number().int().positive();
