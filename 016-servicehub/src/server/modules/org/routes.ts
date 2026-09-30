import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OrgSettingsSchema, parseOrgSettings } from '../../../shared/constants.js';
import { isValidZone } from '../../../shared/time.js';
import { actorOf, changes, writeAudit } from '../../audit.js';
import { can, requireAuth } from '../../auth/context.js';
import { withTenant } from '../../db/tx.js';
import type { Deps } from '../../deps.js';
import { notFound } from '../../errors.js';
import { parse, zOptText } from '../../http/validate.js';

const OrgPatchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  timezone: z.string().refine(isValidZone, 'タイムゾーンが正しくありません').optional(),
  publicProfile: z
    .object({
      description: zOptText(2000),
      contact: zOptText(500),
    })
    .optional(),
  settings: OrgSettingsSchema.partial().optional(),
});

export async function registerOrgRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { pool } = deps;

  app.get('/api/v1/org', async (req) => {
    const ctx = requireAuth(req);
    const org = await withTenant(pool, { orgId: ctx.orgId }, (q) =>
      q.maybeOne<{ id: string; slug: string; name: string; timezone: string; is_sample: boolean; settings: unknown; public_profile: unknown }>(
        'SELECT id, slug, name, timezone, is_sample, settings, public_profile FROM organizations WHERE id = $1',
        [ctx.orgId],
      ),
    );
    if (!org) throw notFound('組織');
    const settings = parseOrgSettings(org.settings);
    return {
      id: org.id,
      slug: org.slug,
      name: org.name,
      timezone: org.timezone,
      isSample: org.is_sample,
      publicProfile: org.public_profile,
      // 設定の詳細は管理者のみ。他ロールには業務に必要な値だけ
      settings: can(ctx, 'org.manage')
        ? settings
        : {
            consumptionPrompt: settings.consumptionPrompt,
            lateCancelPolicy: settings.lateCancelPolicy,
            travelBufferMinutes: settings.travelBufferMinutes,
          },
    };
  });

  app.patch('/api/v1/org', async (req) => {
    const ctx = requireAuth(req, 'org.manage');
    const body = parse(OrgPatchSchema, req.body);
    return withTenant(pool, { orgId: ctx.orgId, userId: ctx.userId }, async (q) => {
      const cur = await q.one<{ name: string; timezone: string; settings: unknown; public_profile: Record<string, unknown> }>(
        'SELECT name, timezone, settings, public_profile FROM organizations WHERE id = $1 FOR UPDATE',
        [ctx.orgId],
      );
      const curSettings = parseOrgSettings(cur.settings);
      const nextSettings = body.settings
        ? OrgSettingsSchema.parse({
            ...curSettings,
            ...body.settings,
            notifications: { ...curSettings.notifications, ...(body.settings.notifications ?? {}) },
            retention: { ...curSettings.retention, ...(body.settings.retention ?? {}) },
          })
        : curSettings;
      const next = {
        name: body.name ?? cur.name,
        timezone: body.timezone ?? cur.timezone,
        public_profile: body.publicProfile ? { ...cur.public_profile, ...body.publicProfile } : cur.public_profile,
        settings: nextSettings,
      };
      await q.exec(
        'UPDATE organizations SET name = $2, timezone = $3, public_profile = $4, settings = $5 WHERE id = $1',
        [ctx.orgId, next.name, next.timezone, JSON.stringify(next.public_profile), JSON.stringify(next.settings)],
      );
      const diff = changes(
        { name: cur.name, timezone: cur.timezone, settings: curSettings },
        { name: next.name, timezone: next.timezone, settings: nextSettings },
      );
      if (diff) {
        await writeAudit(q, ctx.orgId, actorOf(ctx), {
          action: 'org.settings_updated',
          targetType: 'organization',
          targetId: ctx.orgId,
          before: diff.before,
          after: diff.after,
          requestId: req.id,
        });
      }
      return { ok: true, settings: nextSettings, name: next.name, timezone: next.timezone };
    });
  });
}
