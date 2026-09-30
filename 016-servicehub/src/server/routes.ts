import type { FastifyInstance } from 'fastify';
import type { Deps } from './deps.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerLocationRoutes } from './modules/locations/routes.js';
import { registerMemberRoutes } from './modules/members/routes.js';
import { registerOrgRoutes } from './modules/org/routes.js';

export async function registerRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  await registerAuthRoutes(app, deps);
  await registerOrgRoutes(app, deps);
  await registerLocationRoutes(app, deps);
  await registerMemberRoutes(app, deps);
}
