/**
 * 本番組織と最初のオーナーの作成(CLI `setup-org` と、環境変数による初回セットアップで共用)。
 * サンプルデータは入れない。
 */
import type pg from 'pg';
import { normalizeEmail } from '../shared/normalize.js';
import { isValidZone } from '../shared/time.js';
import { hashPassword } from './auth/crypto.js';
import { SAMPLE_SLUG, seedSampleOrganization } from './sample/seed.js';
import { lockKey, withSystem } from './db/tx.js';

export interface SetupOrgInput {
  slug: string;
  name: string;
  ownerEmail: string;
  ownerName?: string;
  password: string;
  timezone?: string;
  locationName?: string;
  locationSlug?: string;
  actorLabel: string;
}

export interface SetupOrgResult {
  orgId: string;
  userId: string;
  membershipId: string;
  createdUser: boolean;
}

export function validateSetupInput(i: Pick<SetupOrgInput, 'slug' | 'name' | 'ownerEmail' | 'password' | 'timezone'>): string | null {
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(i.slug)) return '組織のURL名(slug)は英小文字・数字・ハイフン 3〜40文字で指定してください';
  if (!i.name.trim()) return '組織名を指定してください';
  if (!normalizeEmail(i.ownerEmail)?.includes('@')) return 'オーナーのメールアドレスが正しくありません';
  if (i.password.length < 10) return 'パスワードは10文字以上にしてください';
  if (i.timezone && !isValidZone(i.timezone)) return `タイムゾーンが正しくありません: ${i.timezone}`;
  return null;
}

export async function createOrganizationWithOwner(pool: pg.Pool, input: SetupOrgInput): Promise<SetupOrgResult> {
  const problem = validateSetupInput(input);
  if (problem) throw new Error(problem);
  const timezone = input.timezone ?? 'Asia/Tokyo';
  const hash = await hashPassword(input.password);
  return withSystem(pool, async (q) => {
    const exists = await q.maybeOne('SELECT 1 FROM organizations WHERE slug = $1', [input.slug]);
    if (exists) throw new Error(`organization slug "${input.slug}" already exists`);
    const org = await q.one<{ id: string }>('INSERT INTO organizations (slug, name, timezone, is_sample) VALUES ($1,$2,$3,false) RETURNING id', [
      input.slug,
      input.name.trim(),
      timezone,
    ]);
    const emailNorm = normalizeEmail(input.ownerEmail)!;
    let user = await q.maybeOne<{ id: string }>('SELECT id FROM users WHERE email_normalized = $1', [emailNorm]);
    let createdUser = false;
    if (!user) {
      user = await q.one<{ id: string }>(
        `INSERT INTO users (email, email_normalized, password_hash, display_name, password_changed_at)
         VALUES ($1,$2,$3,$4,now()) RETURNING id`,
        [input.ownerEmail.trim(), emailNorm, hash, input.ownerName?.trim() || 'オーナー'],
      );
      createdUser = true;
    }
    const m = await q.one<{ id: string }>(`INSERT INTO memberships (organization_id, user_id, role, all_locations) VALUES ($1,$2,'owner',true) RETURNING id`, [
      org.id,
      user.id,
    ]);
    if (input.locationName?.trim()) {
      await q.exec(`INSERT INTO locations (organization_id, slug, name, timezone) VALUES ($1,$2,$3,$4)`, [org.id, input.locationSlug ?? 'main', input.locationName.trim(), timezone]);
    }
    await q.exec(
      `INSERT INTO audit_logs (organization_id, actor_type, actor_label, action, target_type, target_id, after)
       VALUES ($1,'operator',$2,'org.created','organization',$1,$3)`,
      [org.id, input.actorLabel, JSON.stringify({ slug: input.slug, name: input.name.trim(), timezone })],
    );
    return { orgId: org.id, userId: user.id, membershipId: m.id, createdUser };
  });
}

type Log = { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };

/**
 * 環境変数による初回セットアップ(ホスティングの画面で環境変数を設定するだけで始められるように)。
 *   SETUP_ORG_SLUG / SETUP_ORG_NAME / SETUP_OWNER_EMAIL / SETUP_OWNER_PASSWORD
 *   [SETUP_OWNER_NAME / SETUP_LOCATION_NAME / SETUP_TIMEZONE]
 * - 本番の組織(サンプル以外)が1つもないときだけ作る。2回目以降の起動では何もしない
 * - パスワードはログに出さない。作成後は SETUP_OWNER_PASSWORD を環境変数から削除するよう案内する
 * SEED_SAMPLE_ON_START=true: サンプル組織が無ければ作る(メールは送信されない)
 */
export async function bootstrapFromEnv(
  pool: pg.Pool,
  opts: { appBaseUrl: string; sessionSecret: string; log: Log },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // 空文字(docker compose の `${X:-}` やホスティング画面の空欄)は未設定として扱う
  const val = (k: string): string => (env[k] ?? '').trim();
  const client = await pool.connect();
  try {
    // 複数インスタンスが同時に起動しても1回だけ行う
    await client.query('SELECT pg_advisory_lock($1::bigint)', [lockKey('servicehub:bootstrap').toString()]);
    const slug = val('SETUP_ORG_SLUG');
    const email = val('SETUP_OWNER_EMAIL');
    const password = env.SETUP_OWNER_PASSWORD ?? '';
    if (slug || email || password) {
      const existing = await withSystem(pool, (q) => q.one<{ n: number }>(`SELECT count(*)::int AS n FROM organizations WHERE NOT is_sample`));
      if (existing.n > 0) {
        if (password) opts.log.warn('[setup] 組織が既にあるため SETUP_* の環境変数は使いません。SETUP_OWNER_PASSWORD は環境変数から削除してください。');
      } else if (!slug || !email || !password) {
        opts.log.warn('[setup] 初回セットアップには SETUP_ORG_SLUG / SETUP_OWNER_EMAIL / SETUP_OWNER_PASSWORD がすべて必要です(今回は作成していません)');
      } else {
        const input = {
          slug,
          name: val('SETUP_ORG_NAME') || slug,
          ownerEmail: email,
          ownerName: val('SETUP_OWNER_NAME') || undefined,
          password,
          timezone: val('SETUP_TIMEZONE') || 'Asia/Tokyo',
          locationName: val('SETUP_LOCATION_NAME') || undefined,
          actorLabel: 'setup-env',
        };
        const problem = validateSetupInput(input);
        if (problem) {
          opts.log.warn(`[setup] 初回セットアップを行えません: ${problem}`);
        } else {
          const r = await createOrganizationWithOwner(pool, input);
          opts.log.info(`[setup] 組織「${input.name}」(${slug})とオーナー(${email.replace(/^(.{2}).*@/, '$1***@')})を作成しました${r.createdUser ? '' : '(既存のユーザー。パスワードは変更していません)'}。ログインを確認したら SETUP_OWNER_PASSWORD を環境変数から削除してください。`);
        }
      }
    }
    if (val('SEED_SAMPLE_ON_START') === 'true') {
      const sample = await withSystem(pool, (q) => q.maybeOne('SELECT 1 FROM organizations WHERE slug = $1', [SAMPLE_SLUG]));
      if (!sample) {
        await seedSampleOrganization(pool, { appBaseUrl: opts.appBaseUrl, sessionSecret: opts.sessionSecret });
        opts.log.info(`[setup] サンプル組織を作成しました: /p/${SAMPLE_SLUG}(ログイン owner@sample-wellness.example、パスワードは説明書「サンプル組織説明」を参照)`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey('servicehub:bootstrap').toString()]).catch(() => undefined);
    client.release();
  }
}
