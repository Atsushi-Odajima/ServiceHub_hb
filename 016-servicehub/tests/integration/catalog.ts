import { localToUtcLenient } from '../../src/shared/time.js';
import type { ApiSession, OrgFixture } from './helpers.js';

export interface Catalog {
  rooms: { roomA: string; roomB: string; bed1: string; studio: string };
  staff: { aki: string; mika: string; ken: string };
  services: { personal60: string; trial30: string; yoga6: string };
}

export const TZ = 'Asia/Tokyo';
export const at = (date: string, time: string) => localToUtcLenient(date, time, TZ).toISOString();

let seq = 0;
export const idem = (p = 't') => `${p}-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 10)}`;

async function ok<T = any>(p: Promise<{ status: number; body: T }>): Promise<T> {
  const r = await p;
  if (r.status !== 200) throw new Error(`API failed ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

/** API 経由でサンプル相当のカタログを作る(拠点1=池袋, 拠点2=新宿) */
export async function setupCatalog(owner: ApiSession, f: OrgFixture): Promise<Catalog> {
  const [ike, shin] = f.locations;
  const res = async (locationId: string, name: string, category: string) =>
    (await ok(owner.post('/api/v1/resources', { locationId, name, category, capacity: 1 }))).id as string;
  const rooms = {
    roomA: await res(ike.id, 'Room A', 'room'),
    bed1: await res(ike.id, 'Bed 1', 'bed'),
    roomB: await res(shin.id, 'Room B', 'room'),
    studio: await res(shin.id, 'Studio', 'studio'),
  };
  const aki = f.staffIds[0];
  const mika = (await ok(owner.post('/api/v1/staff', { displayName: 'Mika', locationIds: [ike.id] }))).id as string;
  const ken = (await ok(owner.post('/api/v1/staff', { displayName: 'Ken', locationIds: [shin.id] }))).id as string;
  const personal60 = (
    await ok(
      owner.post('/api/v1/services', {
        name: '60分パーソナル',
        durationMin: 60,
        locationIds: [ike.id, shin.id],
        staffIds: [aki, mika, ken],
        requirements: [{ label: '個室', quantity: 1, resourceIds: [rooms.roomA, rooms.roomB] }],
        priceLabel: '8,800円',
      }),
    )
  ).id as string;
  const trial30 = (
    await ok(
      owner.post('/api/v1/services', {
        name: '30分体験',
        durationMin: 30,
        bufferAfterMin: 10,
        locationIds: [ike.id, shin.id],
        staffIds: [aki, mika, ken],
        requirements: [{ label: 'ベッド/個室', quantity: 1, resourceIds: [rooms.bed1, rooms.roomB] }],
      }),
    )
  ).id as string;
  const yoga6 = (
    await ok(
      owner.post('/api/v1/services', {
        name: '6名ヨガ',
        durationMin: 60,
        capacity: 6,
        maxPartySize: 3,
        locationIds: [shin.id],
        staffIds: [ken, aki],
        requirements: [{ label: 'スタジオ', quantity: 1, resourceIds: [rooms.studio] }],
      }),
    )
  ).id as string;
  return { rooms, staff: { aki, mika, ken }, services: { personal60, trial30, yoga6 } };
}

export async function addShift(owner: ApiSession, staffId: string, locationId: string | null, date: string, from: string, to: string, type = 'work') {
  return ok(owner.post('/api/v1/shifts', { staffId, locationId, type, startsAt: at(date, from), endsAt: at(date, to), acknowledgeConflicts: true }));
}
