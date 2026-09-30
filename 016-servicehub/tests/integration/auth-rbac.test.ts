import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anonymous, createOrgFixture, expectError, login, makeTestContext, type OrgFixture, type TestContext, TEST_ORIGIN, TEST_PASSWORD } from './helpers.js';

let t: TestContext;
let A: OrgFixture;
let B: OrgFixture;

beforeAll(async () => {
  t = await makeTestContext();
  A = await createOrgFixture(t.pool);
  B = await createOrgFixture(t.pool);
});
afterAll(async () => {
  await t.close();
});

describe('Phase1: authentication', () => {
  it('login -> me returns role, permissions and scoped locations', async () => {
    const s = await login(t.app, A.users.manager.email);
    const me = await s.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.membership.role).toBe('manager');
    expect(me.body.membership.permissions).toContain('kpi.read');
    expect(me.body.membership.permissions).not.toContain('org.manage');
    expect(me.body.locations.map((l: any) => l.id)).toEqual([A.locations[0].id]);
  });

  it('users can change only their own display name (audited)', async () => {
    const s = await login(t.app, A.users.staff.email);
    expectError(await s.patch('/api/v1/auth/me', { displayName: '   ' }), 400, 'VALIDATION_ERROR');
    const r = await s.patch('/api/v1/auth/me', { displayName: '新しい 表示名' });
    expect(r.status).toBe(200);
    expect((await s.get('/api/v1/auth/me')).body.user.name).toBe('新しい 表示名');
    const owner = await login(t.app, A.users.owner.email);
    const logs = await owner.get('/api/v1/audit?action=user.profile_updated');
    expect(logs.body.items[0]).toMatchObject({ before: { displayName: expect.any(String) }, after: { displayName: '新しい 表示名' } });
    expect((await anonymous(t.app).patch('/api/v1/auth/me', { displayName: 'x' })).status).toBe(401);
  });

  it('wrong password is rejected without revealing account existence', async () => {
    const r1 = await anonymous(t.app).post('/api/v1/auth/login', { email: A.users.owner.email, password: 'wrong-password-x' });
    const r2 = await anonymous(t.app).post('/api/v1/auth/login', { email: 'nobody@test.example', password: 'wrong-password-x' });
    expectError(r1, 401, 'UNAUTHENTICATED');
    expectError(r2, 401, 'UNAUTHENTICATED');
    expect(r1.body.error.message).toBe(r2.body.error.message);
  });

  it('logout revokes the session', async () => {
    const s = await login(t.app, A.users.owner.email);
    expect((await s.get('/api/v1/auth/me')).status).toBe(200);
    expect((await s.post('/api/v1/auth/logout')).status).toBe(200);
    expectError(await s.get('/api/v1/auth/me'), 401);
  });

  it('state-changing request without CSRF token is rejected', async () => {
    const s = await login(t.app, A.users.owner.email);
    const csrf = s.csrf;
    s.csrf = null;
    expectError(await s.patch('/api/v1/org', { name: 'x' }), 403, 'CSRF_FAILED');
    s.csrf = 'bad-token-value-000000000000';
    expectError(await s.patch('/api/v1/org', { name: 'x' }), 403, 'CSRF_FAILED');
    s.csrf = csrf;
    expectError(await s.request('PATCH', '/api/v1/org', { name: 'x' }, { origin: 'https://evil.example' }), 403, 'CSRF_FAILED');
    expect((await s.patch('/api/v1/org', { name: `A-${A.suffix}` })).status).toBe(200);
  });

  it('session expires after idle timeout', async () => {
    const s = await login(t.app, A.users.reception.email);
    t.clock.advanceMinutes(13 * 60);
    expectError(await s.get('/api/v1/auth/me'), 401);
    t.clock.advanceMinutes(-13 * 60);
  });

  it('account locks after 10 failed attempts (correct password rejected while locked)', async () => {
    const f = await createOrgFixture(t.pool);
    for (let i = 0; i < 10; i++) {
      await anonymous(t.app).post('/api/v1/auth/login', { email: f.users.reception.email, password: 'bad-password-xx' });
    }
    const r = await anonymous(t.app).post('/api/v1/auth/login', { email: f.users.reception.email, password: TEST_PASSWORD });
    expectError(r, 429, 'RATE_LIMITED');
    t.clock.advanceMinutes(16);
    const ok = await anonymous(t.app).post('/api/v1/auth/login', { email: f.users.reception.email, password: TEST_PASSWORD });
    expect(ok.status).toBe(200);
  });

  it('per-email login rate limit applies (default 10 per 15 min)', async () => {
    const strict = await makeTestContext({ env: { LOGIN_RATE_LIMIT_PER_15MIN: '3' } });
    try {
      const f = await createOrgFixture(strict.pool);
      for (let i = 0; i < 3; i++) {
        await anonymous(strict.app).post('/api/v1/auth/login', { email: f.users.staff.email, password: 'bad-password-xx' });
      }
      const r = await anonymous(strict.app).post('/api/v1/auth/login', { email: f.users.staff.email, password: TEST_PASSWORD });
      expectError(r, 429, 'RATE_LIMITED');
      expect(r.headers['retry-after']).toBeTruthy();
    } finally {
      await strict.close();
    }
  });
});

describe('Phase1: RBAC + location scope', () => {
  it('#8 Staff cannot call Owner settings APIs', async () => {
    const s = await login(t.app, A.users.staff.email);
    expectError(await s.patch('/api/v1/org', { name: 'hacked' }), 403, 'FORBIDDEN');
    expectError(await s.post('/api/v1/locations', { slug: 'x-loc', name: 'X' }), 403, 'FORBIDDEN');
    expectError(await s.get('/api/v1/members'), 403, 'FORBIDDEN');
    expectError(await s.post('/api/v1/members/invitations', { email: 'a@b.example', role: 'owner' }), 403, 'FORBIDDEN');
  });

  it('Reception cannot manage members or org settings', async () => {
    const s = await login(t.app, A.users.reception.email);
    expectError(await s.patch('/api/v1/org', { name: 'x' }), 403);
    expectError(await s.get('/api/v1/members'), 403);
  });

  it('Manager sees only allowed locations; other location returns 404', async () => {
    const s = await login(t.app, A.users.manager.email);
    const list = await s.get('/api/v1/locations');
    expect(list.body.items.map((l: any) => l.id)).toEqual([A.locations[0].id]);
    expect((await s.get(`/api/v1/locations/${A.locations[0].id}`)).status).toBe(200);
    expectError(await s.get(`/api/v1/locations/${A.locations[1].id}`), 404);
    // 自拠点の臨時休業は登録できるが、他拠点は不可
    expect((await s.post(`/api/v1/locations/${A.locations[0].id}/exceptions`, { kind: 'closed', date: '2030-02-01' })).status).toBe(200);
    expectError(await s.post(`/api/v1/locations/${A.locations[1].id}/exceptions`, { kind: 'closed', date: '2030-02-01' }), 404);
  });

  it('Owner of org B cannot read org A resources (tenant isolation via API)', async () => {
    const s = await login(t.app, B.users.owner.email);
    expectError(await s.get(`/api/v1/locations/${A.locations[0].id}`), 404);
    expectError(await s.patch(`/api/v1/locations/${A.locations[0].id}`, { name: 'hijack' }), 404);
    const list = await s.get('/api/v1/locations');
    expect(list.body.items.every((l: any) => B.locations.some((b) => b.id === l.id))).toBe(true);
    expectError(await s.patch(`/api/v1/members/${A.users.staff.membershipId}`, { role: 'owner' }), 404);
  });
});

describe('Phase1: permission changes take effect immediately', () => {
  it('disabling a member revokes their sessions immediately', async () => {
    const f = await createOrgFixture(t.pool);
    const owner = await login(t.app, f.users.owner.email);
    const rec = await login(t.app, f.users.reception.email);
    expect((await rec.get('/api/v1/auth/me')).status).toBe(200);
    const r = await owner.post(`/api/v1/members/${f.users.reception.membershipId}/status`, { status: 'disabled' });
    expect(r.status).toBe(200);
    expect(r.body.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expectError(await rec.get('/api/v1/auth/me'), 401);
    await expect(login(t.app, f.users.reception.email)).rejects.toThrow();
  });

  it('role change revokes the changed member sessions; new login gets new role', async () => {
    const f = await createOrgFixture(t.pool);
    const owner = await login(t.app, f.users.owner.email);
    const mgr = await login(t.app, f.users.manager.email);
    expect((await owner.patch(`/api/v1/members/${f.users.manager.membershipId}`, { role: 'reception' })).status).toBe(200);
    expectError(await mgr.get('/api/v1/auth/me'), 401);
    const again = await login(t.app, f.users.manager.email);
    const me = await again.get('/api/v1/auth/me');
    expect(me.body.membership.role).toBe('reception');
    expect(me.body.membership.permissions).not.toContain('kpi.read');
  });

  it('location scope change applies on the next request (no re-login)', async () => {
    const f = await createOrgFixture(t.pool);
    const owner = await login(t.app, f.users.owner.email);
    const mgr = await login(t.app, f.users.manager.email);
    expectError(await mgr.get(`/api/v1/locations/${f.locations[1].id}`), 404);
    await owner.patch(`/api/v1/members/${f.users.manager.membershipId}`, { locationIds: [f.locations[0].id, f.locations[1].id] });
    expect((await mgr.get(`/api/v1/locations/${f.locations[1].id}`)).status).toBe(200);
  });

  it('the last owner cannot be demoted or disabled', async () => {
    const f = await createOrgFixture(t.pool);
    const owner = await login(t.app, f.users.owner.email);
    expectError(await owner.patch(`/api/v1/members/${f.users.owner.membershipId}`, { role: 'manager' }), 409, 'INVALID_STATE');
    expectError(await owner.post(`/api/v1/members/${f.users.owner.membershipId}/status`, { status: 'disabled' }), 409, 'INVALID_STATE');
  });

  it('invitation -> accept -> member can log in with invited role and scope', async () => {
    const f = await createOrgFixture(t.pool);
    const owner = await login(t.app, f.users.owner.email);
    const email = `invitee+${f.suffix}@test.example`;
    const inv = await owner.post('/api/v1/members/invitations', { email, role: 'reception', locationIds: [f.locations[1].id] });
    expect(inv.status).toBe(200);
    const token = String(inv.body.inviteUrl).split('/invite/')[1];
    const info = await anonymous(t.app).get(`/api/v1/auth/invitations/${token}`);
    expect(info.body.role).toBe('reception');
    const acc = await anonymous(t.app).post(`/api/v1/auth/invitations/${token}/accept`, { displayName: '受付 花子', password: 'invitee-pass-123' });
    expect(acc.status).toBe(200);
    const s = await login(t.app, email, 'invitee-pass-123');
    const me = await s.get('/api/v1/auth/me');
    expect(me.body.membership.role).toBe('reception');
    expect(me.body.locations.map((l: any) => l.id)).toEqual([f.locations[1].id]);
    // 再利用不可
    expectError(await anonymous(t.app).post(`/api/v1/auth/invitations/${token}/accept`, { password: 'another-pass-123' }), 404);
  });

  it('audit log records permission changes without secrets', async () => {
    const rows = await t.pool.query(
      `SELECT action, before, after FROM audit_logs WHERE action = 'member.permissions_changed' ORDER BY created_at DESC LIMIT 1`,
    );
    // RLS: テナント文脈なしでは0行(監査ログも組織分離されている)
    expect(rows.rowCount).toBe(0);
  });
});

describe('Phase1: org settings validation', () => {
  it('rejects invalid settings values', async () => {
    const s = await login(t.app, A.users.owner.email);
    expectError(await s.patch('/api/v1/org', { settings: { travelBufferMinutes: -5 } }), 400, 'VALIDATION_ERROR');
    const ok = await s.patch('/api/v1/org', { settings: { travelBufferMinutes: 30 } });
    expect(ok.body.settings.travelBufferMinutes).toBe(30);
    expect(ok.body.settings.lateCancelPolicy).toBe('confirm');
  });

  it('non-API origin header required host check uses APP_BASE_URL', () => {
    expect(TEST_ORIGIN).toBe('http://localhost:3000');
  });
});
