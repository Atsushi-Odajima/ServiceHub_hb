/**
 * 本番用の組織と最初のオーナーを作成する(サンプルデータは入れない)。
 *   pnpm setup:org -- --slug my-salon --name "My Salon" --owner-email owner@example.com --owner-name "山田 花子" \
 *                     [--password '<10文字以上>'] [--timezone Asia/Tokyo] [--location-name "本店" --location-slug main]
 * --password を省略すると安全なパスワードを生成して一度だけ表示する。
 */
import { argValue, loadConfigForCli } from './cli-config.js';
import { randomToken } from '../auth/crypto.js';
import { createPool } from '../db/pool.js';
import { createOrganizationWithOwner, validateSetupInput } from '../setup.js';

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
const generated = !password;
if (!password) password = randomToken(12);
const problem = validateSetupInput({ slug, name, ownerEmail, password, timezone });
if (problem) {
  console.error(problem);
  process.exit(1);
}

const pool = createPool({ connectionString: config.DATABASE_URL, ssl: config.DATABASE_SSL, max: 2, applicationName: 'servicehub-setup' });
try {
  const result = await createOrganizationWithOwner(pool, { slug, name, ownerEmail, ownerName, password, timezone, locationName, locationSlug, actorLabel: 'setup-org' });
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
