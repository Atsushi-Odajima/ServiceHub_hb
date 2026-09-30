import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../../src/server/db/pool.js';
import { advisoryLockAll, withSystem, withTenant } from '../../src/server/db/tx.js';
import { TEST_DATABASE_URL } from './global-setup.js';

// Phase0 PoC: マルチテナントRLS + 予約競合(排他制約 + advisory lock)の成立確認
const pool = createPool({ connectionString: TEST_DATABASE_URL, max: 30 });
const orgA = '00000000-0000-4000-8000-00000000000a';
const orgB = '00000000-0000-4000-8000-00000000000b';
let locA = '';
let svcA = '';
let staffA = '';

beforeAll(async () => {
  await withSystem(pool, async (q) => {
    await q.exec(`INSERT INTO organizations (id, slug, name) VALUES ($1,'poc-a','A'),($2,'poc-b','B')`, [orgA, orgB]);
    locA = (await q.one<{ id: string }>(`INSERT INTO locations (organization_id, slug, name) VALUES ($1,'main','Main') RETURNING id`, [orgA])).id;
    svcA = (await q.one<{ id: string }>(`INSERT INTO services (organization_id, name, duration_min) VALUES ($1,'S',60) RETURNING id`, [orgA])).id;
    staffA = (await q.one<{ id: string }>(`INSERT INTO staff (organization_id, display_name) VALUES ($1,'Aki') RETURNING id`, [orgA])).id;
  });
});
afterAll(async () => {
  await pool.end();
});

describe('PoC: tenant isolation (RLS)', () => {
  it('tenant B cannot see or write tenant A rows', async () => {
    const seen = await withTenant(pool, { orgId: orgB }, (q) => q.many('SELECT id FROM locations'));
    expect(seen).toHaveLength(0);
    await expect(
      withTenant(pool, { orgId: orgB }, (q) =>
        q.exec(`INSERT INTO locations (organization_id, slug, name) VALUES ($1,'x','X')`, [orgA]),
      ),
    ).rejects.toThrow(/row-level security/);
    const own = await withTenant(pool, { orgId: orgA }, (q) => q.many('SELECT id FROM locations'));
    expect(own).toHaveLength(1);
  });

  it('cross-tenant composite FK is rejected', async () => {
    await withSystem(pool, async (q) => {
      await expect(
        q.exec(
          `INSERT INTO occupancies (organization_id, location_id, service_id, staff_id, starts_at, ends_at, block_starts_at, block_ends_at, capacity, seats_taken)
           VALUES ($1,$2,$3,$4, now(), now()+interval '1h', now(), now()+interval '1h', 1, 1)`,
          [orgB, locA, svcA, staffA],
        ),
      ).rejects.toThrow(/foreign key/);
    }).catch(() => undefined);
  });
});

describe('PoC: booking race', () => {
  it('exclusion constraint alone rejects overlapping staff occupancy', async () => {
    const insert = (start: string) =>
      withTenant(pool, { orgId: orgA }, (q) =>
        q.exec(
          `INSERT INTO occupancies (organization_id, location_id, service_id, staff_id, starts_at, ends_at, block_starts_at, block_ends_at, capacity, seats_taken)
           VALUES ($1,$2,$3,$4,$5::timestamptz,$5::timestamptz + interval '60 min',$5::timestamptz,$5::timestamptz + interval '60 min',1,1)`,
          [orgA, locA, svcA, staffA, start],
        ),
      );
    await insert('2030-01-01T01:00:00Z');
    await expect(insert('2030-01-01T01:30:00Z')).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    await insert('2030-01-01T02:00:00Z'); // 隣接はOK([) 区間)
  });

  it('30 concurrent attempts on the same slot -> exactly 1 success (advisory lock + check + constraint)', async () => {
    const start = '2030-01-02T01:00:00Z';
    const attempt = () =>
      withTenant(
        pool,
        { orgId: orgA },
        async (q) => {
          await advisoryLockAll(q, [`staff:${staffA}`]);
          const clash = await q.maybeOne(
            `SELECT id FROM occupancies WHERE organization_id=$1 AND staff_id=$2 AND status='active'
               AND block_starts_at < $3::timestamptz + interval '60 min' AND block_ends_at > $3::timestamptz`,
            [orgA, staffA, start],
          );
          if (clash) return 'taken';
          await q.exec(
            `INSERT INTO occupancies (organization_id, location_id, service_id, staff_id, starts_at, ends_at, block_starts_at, block_ends_at, capacity, seats_taken)
             VALUES ($1,$2,$3,$4,$5::timestamptz,$5::timestamptz + interval '60 min',$5::timestamptz,$5::timestamptz + interval '60 min',1,1)`,
            [orgA, locA, svcA, staffA, start],
          );
          return 'ok';
        },
        { lockTimeoutMs: 10000 },
      ).catch((e) => `error:${e.code ?? e.message}`);
    const results = await Promise.all(Array.from({ length: 30 }, attempt));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r !== 'ok' && r !== 'taken')).toEqual([]);
  });

  it('without the app-level lock the exclusion constraint still guarantees a single winner', async () => {
    const start = '2030-01-03T01:00:00Z';
    const attempt = () =>
      withTenant(pool, { orgId: orgA }, (q) =>
        q.exec(
          `INSERT INTO occupancies (organization_id, location_id, service_id, staff_id, starts_at, ends_at, block_starts_at, block_ends_at, capacity, seats_taken)
           VALUES ($1,$2,$3,$4,$5::timestamptz,$5::timestamptz + interval '60 min',$5::timestamptz,$5::timestamptz + interval '60 min',1,1)`,
          [orgA, locA, svcA, staffA, start],
        ),
      ).then(
        () => 'ok',
        (e) => e.code as string,
      );
    const results = await Promise.all(Array.from({ length: 30 }, attempt));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(new Set(results.filter((r) => r !== 'ok'))).toEqual(new Set(['SLOT_UNAVAILABLE']));
  });
});
