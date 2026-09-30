import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { safeEqual } from './auth/crypto.js';
import { loadSession, SESSION_COOKIE } from './auth/session.js';
import { findAppRoot } from './db/migrate.js';
import type { Deps } from './deps.js';
import { AppError } from './errors.js';
import { registerRoutes } from './routes.js';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** ログに出す URL からトークンを取り除く */
export function sanitizeUrl(url: string): string {
  return url
    .replace(/(\/manage\/)[^/?#]+/g, '$1***')
    .replace(/(\/invitations\/)[^/?#]+/g, '$1***')
    .replace(/(\/b\/)[^/?#]+/g, '$1***')
    .replace(/([?&](token|t)=)[^&#]+/g, '$1***');
}

function allowedOrigins(deps: Deps): Set<string> {
  const set = new Set<string>([new URL(deps.config.APP_BASE_URL).origin]);
  for (const o of (process.env.EXTRA_ALLOWED_ORIGINS ?? '').split(',')) {
    if (o.trim()) set.add(o.trim());
  }
  return set;
}

function originOk(req: FastifyRequest, origins: Set<string>): boolean {
  const origin = req.headers.origin;
  if (origin) return origins.has(origin);
  const referer = req.headers.referer;
  if (referer) {
    try {
      return origins.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  // Origin/Referer が無いクライアント(CLI 等)は CSRF トークン検査のみに依存
  return true;
}

export async function buildApp(deps: Deps, opts: { serveStatic?: boolean; logger?: boolean } = {}): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger:
      opts.logger === false || config.LOG_LEVEL === 'silent'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: {
              paths: [
                'req.headers.cookie',
                'req.headers.authorization',
                'req.headers["x-csrf-token"]',
                'res.headers["set-cookie"]',
              ],
              censor: '[redacted]',
            },
            serializers: {
              req(req: FastifyRequest) {
                return { method: req.method, url: sanitizeUrl(req.url), id: req.id };
              },
            },
          },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://challenges.cloudflare.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        frameSrc: ['https://challenges.cloudflare.com'],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
      },
    },
    hsts: config.cookieSecure ? { maxAge: 15552000, includeSubDomains: false } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);

  app.decorateRequest('session', null);
  const origins = allowedOrigins(deps);

  // 認証 + CSRF/Origin 検査
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const token = req.cookies[SESSION_COOKIE];
    req.session = token ? await loadSession(deps.pool, token, deps.clock.now()) : null;
    if (STATE_CHANGING.has(req.method)) {
      if (!originOk(req, origins)) {
        throw new AppError('CSRF_FAILED', '不正な送信元からのリクエストです');
      }
      const isPublic = req.url.startsWith('/api/v1/public/');
      if (req.session && !isPublic) {
        const header = req.headers['x-csrf-token'];
        if (typeof header !== 'string' || !safeEqual(header, req.session.csrf_token)) {
          throw new AppError('CSRF_FAILED', '画面の有効期限が切れました。ページを再読み込みしてください。');
        }
      }
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AppError) {
      if (err.code === 'RATE_LIMITED') {
        const d = err.details as { retryAfterSec?: number } | undefined;
        if (d?.retryAfterSec) reply.header('Retry-After', String(d.retryAfterSec));
      }
      if (err.status >= 500) req.log.error({ err }, 'app error');
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { code?: string; statusCode?: number; message?: string };
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'データが大きすぎます' } });
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply
        .status(e.statusCode)
        .send({ error: { code: 'VALIDATION_ERROR', message: 'リクエストの形式が正しくありません' } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL', message: 'サーバーでエラーが発生しました。時間をおいて再度お試しください。' },
    });
  });

  app.get('/healthz', async () => {
    let db = false;
    try {
      await deps.pool.query('SELECT 1');
      db = true;
    } catch {
      db = false;
    }
    return { ok: db, db, time: deps.clock.now().toISOString() };
  });

  await registerRoutes(app, deps);

  const staticDir = config.STATIC_DIR ?? path.join(findAppRoot(), 'dist', 'web');
  const serveStatic = opts.serveStatic ?? existsSync(path.join(staticDir, 'index.html'));
  if (serveStatic) {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: '/',
      index: false,
      wildcard: false,
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.header('Cache-Control', 'no-cache');
        }
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || (req.method !== 'GET' && req.method !== 'HEAD') || !serveStatic) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'ページが見つかりません' } });
    }
    // SPA フォールバック
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html');
  });

  return app;
}
