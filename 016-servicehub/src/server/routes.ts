import type { FastifyInstance } from 'fastify';
import type { Deps } from './deps.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerBookingRoutes } from './modules/bookings/routes.js';
import { registerCustomerRoutes } from './modules/customers/routes.js';
import { registerNotificationRoutes } from './modules/notifications/routes.js';
import { registerPublicRoutes } from './modules/public/routes.js';
import { registerLocationRoutes } from './modules/locations/routes.js';
import { registerMemberRoutes } from './modules/members/routes.js';
import { registerOrgRoutes } from './modules/org/routes.js';
import { registerResourceRoutes } from './modules/resources/routes.js';
import { registerServiceRoutes } from './modules/services/routes.js';
import { registerShiftRoutes } from './modules/shifts/routes.js';
import { registerStaffRoutes } from './modules/staff/routes.js';

export async function registerRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  await registerAuthRoutes(app, deps);
  await registerOrgRoutes(app, deps);
  await registerLocationRoutes(app, deps);
  await registerMemberRoutes(app, deps);
  await registerStaffRoutes(app, deps);
  await registerServiceRoutes(app, deps);
  await registerResourceRoutes(app, deps);
  await registerShiftRoutes(app, deps);
  await registerBookingRoutes(app, deps);
  await registerCustomerRoutes(app, deps);
  await registerPublicRoutes(app, deps);
  await registerNotificationRoutes(app, deps);
}
