/**
 * 本番用の組織と最初のオーナーを作成する(サンプルデータは入れない)。
 *   pnpm setup:org -- --slug my-salon --name "My Salon" --owner-email owner@example.com --owner-name "山田 花子" \
 *                     [--password '<10文字以上>'] [--timezone Asia/Tokyo] [--location-name "本店" --location-slug main]
 * --password を省略すると安全なパスワードを生成して一度だけ表示する。
 */
import { argValue, loadConfigForCli } from './cli-config.js';
import { hashPassword, randomToken } from '../auth/crypto.js';
import { createPool } from '../db/pool.js';
import { withSystem } from '../db/tx.js';
import { normalizeEmail } from '../../shared/normalize.js';
import { isValidZone } from '../../shared/time.js';

const config = loadConfigForCli();
const slug = argValue('slug');
const name = argValue('name');
const ownerEmail = argValue('owner-email');
const ownerName = argValue('owner-name') ?? 'オーナー';
const timezone = argValue('timezone') ?? 'Asia/Tokyo';
const locationName = argValue('location-name');
const locationSlug = argValue('location-slug') ?? 'main';
let password = argValue('password');

if (!slug || !name || !ownerEmail) {
  console.error('Usage: setup-org --slug <slug> --name <name> --owner-email <email> [--owner-name <name>] [--password <pw>] [--timezone <tz>] [--location-name <name> --location-slug <slug>]');
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
  console.error('slug は英小文字・数字・ハイフン 3〜40文字で指定してください');
  process.exit(1);
}
if (!isValidZone(timezone)) {
  console.error(`invalid timezone: ${timezone}`);
  process.exit(1);
}
const generated = !password;
if (!password) password = randomToken(12);
if (password.length < 10) {
  console.error('password は10文字以上にしてください');
  process.exit(1);
}

const pool = createPool({ connectionString: config.DATABASE_URL, ssl: config.DATABASE_SSL, max: 2, applicationName: 'servicehub-setup' });
try {
  const hash = await hashPassword(password);
  const result = await withSystem(pool, async (q) => {
    const exists = await q.maybeOne('SELECT 1 FROM organizations WHERE slug = $1', [slug]);
    if (exists) throw new Error(`organization slug "${slug}" already exists`);
    const org = await q.one<{ id: string }>(
      'INSERT INTO organizations (slug, name, timezone, is_sample) VALUES ($1,$2,$3,false) RETURNING id',
      [slug, name, timezone],
    );
    const emailNorm = normalizeEmail(ownerEmail)!;
    let user = await q.maybeOne<{ id: string }>('SELECT id FROM users WHERE email_normalized = $1', [emailNorm]);
    let createdUser = false;
    if (!user) {
      user = await q.one<{ id: string }>(
        `INSERT INTO users (email, email_normalized, password_hash, display_name, password_changed_at)
         VALUES ($1,$2,$3,$4,now()) RETURNING id`,
        [ownerEmail, emailNorm, hash, ownerName],
      );
      createdUser = true;
    }
    const m = await q.one<{ id: string }>(
      `INSERT INTO memberships (organization_id, user_id, role, all_locations) VALUES ($1,$2,'owner',true) RETURNING id`,
      [org.id, user.id],
    );
    if (locationName) {
      await q.exec(
        `INSERT INTO locations (organization_id, slug, name, timezone) VALUES ($1,$2,$3,$4)`,
        [org.id, locationSlug, locationName, timezone],
      );
    }
    await q.exec(
      `INSERT INTO audit_logs (organization_id, actor_type, actor_label, action, target_type, target_id, after)
       VALUES ($1,'operator','setup-org','org.created','organization',$1,$2)`,
      [org.id, JSON.stringify({ slug, name, timezone })],
    );
    return { orgId: org.id, userId: user.id, membershipId: m.id, createdUser };
  });
  console.info(`organization created: ${slug} (${result.orgId})`);
  console.info(`owner: ${ownerEmail}${result.createdUser ? '' : ' (existing user, password unchanged)'}`);
  if (generated && result.createdUser) {
    console.info(`initial password (shown once, change after first login): ${password}`);
  }
} catch (err) {
  console.error(`setup failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
