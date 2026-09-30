/**
 * 設定 > バックアップ(Owner のみ: backup.manage)
 *   GET  /api/v1/backup/status    暗号化の有無・直近の作成/復元の記録
 *   GET  /api/v1/backup/download  バックアップを作成してダウンロード(監査ログに記録)
 *   POST /api/v1/backup/verify    ファイルを検証(DBは変更しない)。本文はファイルそのもの(application/octet-stream)
 *   POST /api/v1/backup/restore   ?confirm=<組織のURL名>&dryRun=true|false&allowOtherOrg=true|false
 *        現在の組織をバックアップの内容で置き換える(1トランザクション。失敗時は何も変わらない)。
 *        実行前2時間以内に現在のデータのバックアップを作成していること(dryRun は不要)。
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { actorOf, writeAudit } from '../../audit.js';
import { requireAuth } from '../../auth/context.js';
import { createBackup } from '../../backup/dump.js';
import { restoreBackup } from '../../backup/restore.js';
import { BACKUP_FILE_EXT, EXCLUDED_TABLES, TABLE_LABELS } from '../../backup/spec.js';
import { verifyBackup, type VerifyReport } from '../../backup/verify.js';
import { withTenant } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { AppError } from '../../errors.js';
import { parse } from '../../http/validate.js';
import { enforceRateLimit } from '../../ratelimit.js';
import { contentDisposition } from '../csv/format.js';

/** 展開後の上限(圧縮爆弾対策) */
const MAX_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024;
/** 復元の前に必要な「現在のデータのバックアップ」の新しさ */
const RECENT_BACKUP_HOURS = 2;
/** 監査ログ・画面に出す主要な件数 */
const SUMMARY_TABLES = ['locations', 'staff', 'memberships', 'services', 'resources', 'customers', 'bookings', 'service_records', 'customer_passes', 'pass_ledger_entries', 'customer_plans', 'plan_ledger_entries', 'waitlist_entries', 'notifications', 'audit_logs'];

function summaryCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(SUMMARY_TABLES.filter((t) => t in counts).map((t) => [t, counts[t]]));
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'servicehub-backup-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** アップロードされたファイルを一時ファイルへ保存(上限を超えたら中止) */
async function saveUpload(req: FastifyRequest, file: string, maxBytes: number): Promise<number> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maxBytes) throw new AppError('PAYLOAD_TOO_LARGE', `ファイルが大きすぎます(上限 ${Math.round(maxBytes / 1024 / 1024)}MB)。コマンド(backup:restore)で復元してください。`);
  const body = req.body as Readable | undefined;
  if (!body || typeof (body as Readable).pipe !== 'function') {
    throw new AppError('VALIDATION_ERROR', 'バックアップファイルを選択してください');
  }
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) cb(new AppError('PAYLOAD_TOO_LARGE', `ファイルが大きすぎます(上限 ${Math.round(maxBytes / 1024 / 1024)}MB)`));
      else cb(null, chunk);
    },
  });
  await pipeline(body, limiter, createWriteStream(file, { mode: 0o600 }));
  if (bytes === 0) throw new AppError('VALIDATION_ERROR', 'バックアップファイルが空です');
  return bytes;
}

function verifyDto(r: VerifyReport, orgId: string) {
  return {
    ok: r.ok,
    errors: r.errors,
    warnings: r.warnings,
    encrypted: r.encrypted,
    backup: r.header
      ? {
          organization: r.header.organization,
          createdAt: r.header.createdAt,
          appVersion: r.header.appVersion,
          schemaVersion: r.header.schemaVersion,
        }
      : null,
    currentSchemaVersion: r.currentSchemaVersion,
    sameOrganization: r.header ? r.header.organization.id === orgId : false,
    counts: Object.entries(r.counts)
      .filter(([, n]) => n > 0)
      .map(([name, count]) => ({ name, label: TABLE_LABELS[name] ?? name, count })),
    sha256: r.sha256,
  };
}

export async function registerBackupRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool, clock, config } = deps;
  const uploadMax = config.BACKUP_UPLOAD_MAX_MB * 1024 * 1024;
  const encryptionKey = config.BACKUP_ENCRYPTION_KEY || null;

  await app.register(async (scope) => {
    // 本文をそのままストリームで受け取る(JSON として読み込まない)
    scope.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

    scope.get('/api/v1/backup/status', async (req) => {
      const ctx = requireAuth(req, 'backup.manage');
      return withTenant(pool, { orgId: ctx.orgId }, async (q) => {
        const org = await q.one<{ slug: string; name: string; timezone: string }>('SELECT slug, name, timezone FROM organizations WHERE id = $1', [ctx.orgId]);
        const history = await q.many<{ id: string; action: string; actor_label: string | null; created_at: Date; metadata: Record<string, unknown> | null; recent: boolean }>(
          `SELECT id, action, actor_label, created_at, metadata,
                  (action = 'backup.created' AND created_at > now() - make_interval(hours => $2)) AS recent
             FROM audit_logs
            WHERE organization_id = $1 AND action IN ('backup.created', 'backup.restored', 'backup.restore_tested')
            ORDER BY created_at DESC, id DESC LIMIT 20`,
          [ctx.orgId, RECENT_BACKUP_HOURS],
        );
        return {
          organization: org,
          encryption: Boolean(encryptionKey),
          uploadLimitMb: config.BACKUP_UPLOAD_MAX_MB,
          recentBackupHours: RECENT_BACKUP_HOURS,
          hasRecentBackup: history.some((h) => h.recent),
          excluded: Object.entries(EXCLUDED_TABLES).map(([name, reason]) => ({ name, reason })),
          history: history.map((h) => ({
            id: h.id,
            action: h.action,
            actor: h.actor_label,
            at: h.created_at,
            via: (h.metadata?.via as string | undefined) ?? null,
            bytes: (h.metadata?.bytes as number | undefined) ?? null,
            encrypted: (h.metadata?.encrypted as boolean | undefined) ?? null,
            backupCreatedAt: (h.metadata?.backupCreatedAt as string | undefined) ?? null,
            mode: (h.metadata?.mode as string | undefined) ?? null,
          })),
        };
      });
    });

    scope.get('/api/v1/backup/download', async (req, reply) => {
      const ctx = requireAuth(req, 'backup.manage');
      await enforceRateLimit(pool, `backup:create:${ctx.orgId}`, 12, 3600, clock.now(), 'バックアップの作成回数が多すぎます。しばらく待ってからもう一度お試しください。');
      const dir = await mkdtemp(path.join(os.tmpdir(), 'servicehub-backup-'));
      const file = path.join(dir, `backup${BACKUP_FILE_EXT}`);
      let handedOff = false;
      try {
        const now = clock.now();
        const result = await createBackup(pool, ctx.orgId, createWriteStream(file, { mode: 0o600 }), {
          encryptionKey,
          sessionSecret: config.SESSION_SECRET,
          now,
        });
        const { size } = await stat(file);
        await withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, (q) =>
          writeAudit(q, ctx.orgId, actorOf(ctx), {
            action: 'backup.created',
            targetType: 'organization',
            targetId: ctx.orgId,
            metadata: { via: 'web', bytes: size, encrypted: result.encrypted, sha256: result.sha256, counts: summaryCounts(result.counts) },
            requestId: req.id,
          }),
        );
        const org = result.header.organization;
        const stamp = DateTime.fromJSDate(now).setZone(org.timezone).toFormat('yyyyLLdd-HHmm');
        const name = `servicehub-backup_${org.slug}_${stamp}${BACKUP_FILE_EXT}`;
        const stream = createReadStream(file);
        stream.on('close', () => void rm(dir, { recursive: true, force: true }));
        handedOff = true;
        return reply
          .header('Content-Type', 'application/octet-stream')
          .header('Content-Disposition', contentDisposition(name, name))
          .header('Content-Length', String(size))
          .header('Cache-Control', 'no-store')
          .header('X-Backup-Sha256', result.sha256)
          .send(stream);
      } finally {
        if (!handedOff) await rm(dir, { recursive: true, force: true });
      }
    });

    scope.post('/api/v1/backup/verify', async (req) => {
      const ctx = requireAuth(req, 'backup.manage');
      await enforceRateLimit(pool, `backup:verify:${ctx.orgId}`, 30, 3600, clock.now());
      return withTempDir(async (dir) => {
        const file = path.join(dir, `upload${BACKUP_FILE_EXT}`);
        await saveUpload(req, file, uploadMax);
        const report = await verifyBackup(file, { pool, encryptionKey, maxBytes: MAX_EXPANDED_BYTES, sessionSecret: config.SESSION_SECRET });
        return verifyDto(report, ctx.orgId);
      });
    });

    scope.post('/api/v1/backup/restore', async (req) => {
      const ctx = requireAuth(req, 'backup.manage');
      const qy = parse(
        z.object({
          confirm: z.string().max(100),
          dryRun: z.enum(['true', 'false']).default('false'),
          allowOtherOrg: z.enum(['true', 'false']).default('false'),
        }),
        req.query,
      );
      const dryRun = qy.dryRun === 'true';
      await enforceRateLimit(pool, `backup:restore:${ctx.orgId}`, 20, 3600, clock.now());
      const state = await withTenant(pool, { orgId: ctx.orgId }, (q) =>
        q.one<{ slug: string; recent: boolean }>(
          `SELECT o.slug, EXISTS (SELECT 1 FROM audit_logs a WHERE a.organization_id = o.id AND a.action = 'backup.created'
                                     AND a.created_at > now() - make_interval(hours => $2)) AS recent
             FROM organizations o WHERE o.id = $1`,
          [ctx.orgId, RECENT_BACKUP_HOURS],
        ),
      );
      if (qy.confirm !== state.slug) {
        throw new AppError('VALIDATION_ERROR', '確認のため、この組織のURL名を正しく入力してください', { fields: { confirm: `「${state.slug}」と入力してください` } });
      }
      if (!dryRun && !state.recent) {
        throw new AppError('INVALID_STATE', `復元の前に、現在のデータのバックアップを作成してください(${RECENT_BACKUP_HOURS}時間以内)。復元に失敗した場合や、誤ったファイルを選んだ場合に元へ戻せるようにするためです。`);
      }
      return withTempDir(async (dir) => {
        const file = path.join(dir, `upload${BACKUP_FILE_EXT}`);
        await saveUpload(req, file, uploadMax);
        const pre = await verifyBackup(file, { pool, encryptionKey, maxBytes: MAX_EXPANDED_BYTES, sessionSecret: config.SESSION_SECRET });
        if (!pre.ok || !pre.header) throw new AppError('VALIDATION_ERROR', `バックアップの検証に失敗しました: ${pre.errors.join(' / ')}`);
        if (pre.header.organization.id !== ctx.orgId && qy.allowOtherOrg !== 'true') {
          throw new AppError('INVALID_STATE', '別の組織のバックアップです。置き換える場合は確認の項目にチェックしてください。');
        }
        const report = await restoreBackup(pool, file, {
          mode: 'replace',
          replaceOrgId: ctx.orgId,
          encryptionKey,
          actor: actorOf(ctx),
          requireOwnerUserId: ctx.userId,
          existingUserPolicy: 'restrict',
          dryRun,
          sessionSecret: config.SESSION_SECRET,
          maxBytes: MAX_EXPANDED_BYTES,
          requestId: req.id,
          now: clock.now(),
        });
        if (dryRun) {
          // 復元テストの結果は取り消されるため、実施した事実だけを別に記録する
          await withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, (q) =>
            writeAudit(q, ctx.orgId, actorOf(ctx), {
              action: 'backup.restore_tested',
              targetType: 'organization',
              targetId: ctx.orgId,
              metadata: { backupCreatedAt: report.backupCreatedAt, sha256: pre.sha256, counts: summaryCounts(Object.fromEntries(report.tables.map((t) => [t.name, t.restored]))) },
              requestId: req.id,
            }),
          );
        } else {
          req.log.warn({ orgId: ctx.orgId, backupCreatedAt: report.backupCreatedAt, replacedSlug: report.replaced?.slug }, 'organization restored from backup');
        }
        return {
          dryRun: report.dryRun,
          organization: report.organization,
          backupCreatedAt: report.backupCreatedAt,
          tables: report.tables.filter((t) => t.expected > 0 || t.restored > 0),
          ledger: report.ledger,
          users: report.users,
          notificationsSkipped: report.notificationsSkipped,
          warnings: report.warnings,
          durationMs: report.durationMs,
          reloginRequired: !report.dryRun,
        };
      });
    });
  });
}
