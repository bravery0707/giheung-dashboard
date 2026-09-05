import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { calendarDate, kstDate, validateEnvelope, mergeSnapshot, COMPLEX, SCOPE } from '../scripts/listing-model.mjs';
import { collect, checkSource } from '../scripts/collect-listings.mjs';
import { persistentGone } from '../assets/listing-history.mjs';

const now = new Date('2026-09-06T12:11:00Z');
const listing = (id, extra = {}) => ({ dong: '203', deal: '매매', type: '120A', area: 84,
  floor: 20, band: '중', face: '남동향', price: 130000, priceMax: null, rent: 0,
  sourceIds: [id], count: 1, agents: [{ name: '시험중개소' }], ...extra });
const envelope = (date, listings) => ({ schemaVersion: 2, complex: COMPLEX, scope: SCOPE, source: 'test-provider', date,
  startedAt: `${date}T21:09:00+09:00`, capturedAt: `${date}T21:10:00+09:00`,
  quality: { complete: true, expectedPages: 1, pagesFetched: 1, expectedUnique: listings.length, expectedPostings: listings.reduce((n, x) => n + x.count, 0) }, listings });
const add = (history, date, listings) => mergeSnapshot(history, validateEnvelope(envelope(date, listings), { now: new Date('2026-10-01'), acceptCountDrop: true })).history;
const approved = () => ({ enabled: true, source: 'test-provider', allowedOrigin: 'https://example.com',
  permission: { collection: true, publicRedistribution: true, reference: 'synthetic-test-only' }, trial: { startDate: '2026-09-06', days: 14 } });
async function temporary(t) { const dir = await mkdtemp(join(tmpdir(), 'giheung-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('collection date is KST, not listing confirmation date', () => {
  const item = listing('A', { listed: '26.08.20', last: '26.09.01' });
  const result = validateEnvelope(envelope('2026-09-06', [item]), { now, live: true });
  assert.equal(result.date, '2026-09-06');
  assert.equal(result.listings[0].last, '26.09.01');
  assert.equal(kstDate('2026-09-05T15:10:00Z'), '2026-09-06');
});
test('invalid dates, scope and timestamp mismatch are rejected', () => {
  assert.throws(() => calendarDate('2026-02-30'));
  for (const change of [{ scope: 'sale-only' }, { complex: '다른단지' }, { capturedAt: '2026-09-05T12:10:00Z' }, { capturedAt: '2026-09-06 21:10' }]) {
    assert.throws(() => validateEnvelope({ ...envelope('2026-09-06', [listing('A')]), ...change }, { now, live: true }));
  }
});
test('partial pagination, duplicate IDs and missing ID reject a live capture', () => {
  const good = envelope('2026-09-06', [listing('A')]);
  for (const quality of [{ ...good.quality, complete: false }, { ...good.quality, expectedPages: 2 }, { ...good.quality, expectedUnique: 2 }, { ...good.quality, expectedPostings: 2 }]) {
    assert.throws(() => validateEnvelope({ ...good, quality }, { now, live: true }));
  }
  assert.throws(() => validateEnvelope(envelope('2026-09-06', [listing('A'), listing('A')]), { now, live: true }));
  assert.throws(() => validateEnvelope(envelope('2026-09-06', [listing('A', { sourceIds: [] })]), { now, live: true }));
});
test('invalid amounts are rejected instead of converted into zero', () => {
  for (const bad of [{ price: null }, { price: 0 }, { price: '130000' }, { area: 0 }, { priceMax: 120000 }, { deal: '월세', rent: null }, { floor: -1 }, { count: 3 }]) {
    assert.throws(() => validateEnvelope(envelope('2026-09-06', [listing('A', bad)]), { now }));
  }
});
test('stale and replayed feeds are not new observations', () => {
  assert.throws(() => validateEnvelope(envelope('2026-09-05', [listing('A')]), { now, live: true }));
  const e = envelope('2026-09-06', [listing('A')]);
  assert.throws(() => validateEnvelope(e, { now, live: true, previous: { capturedAt: e.capturedAt } }));
});
test('sharp count drop requires an explicit review, including complete zero', () => {
  const input = envelope('2026-09-06', []);
  assert.throws(() => validateEnvelope(input, { now, previous: { unique: 30 } }));
  assert.equal(validateEnvelope(input, { now, previous: { unique: 30 }, acceptCountDrop: true }).listings.length, 0);
});
test('source IDs preserve identity through price changes and source order changes', () => {
  let h = add(null, '2026-09-01', [listing('A'), listing('B', { floor: 21 })]);
  const ids = h.snapshots[0].listings.map(x => x.trackId);
  h = add(h, '2026-09-02', [listing('B', { floor: 21 }), listing('A', { price: 128000 })]);
  assert.equal(h.snapshots[1].listings[1].trackId, ids[0]);
  assert.equal(h.changes[0].priceChanges.length, 1);
  assert.equal(h.changes[0].new.length, 0);
});
test('price range and monthly rent changes survive diffing', () => {
  let h = add(null, '2026-09-01', [listing('A', { priceMax: 140000 }), listing('B', { deal: '월세', price: 15000, rent: 230 })]);
  h = add(h, '2026-09-02', [listing('A', { priceMax: 138000 }), listing('B', { deal: '월세', price: 15000, rent: 220 })]);
  assert.equal(h.changes[0].priceChanges.length, 2);
  assert.equal(h.changes[0].priceChanges[1].beforeRent, 230);
});
test('reappearance clears disappearance and a later disappearance starts a new interval', () => {
  let h = add(null, '2026-09-01', [listing('A')]);
  h = add(h, '2026-09-02', []);
  h = add(h, '2026-09-04', []);
  assert.equal(persistentGone(h.snapshots)[0].missingObservations, 2);
  h = add(h, '2026-09-05', [listing('A')]);
  assert.equal(persistentGone(h.snapshots).length, 0);
  assert.equal(h.changes.at(-1).reappeared.length, 1);
  assert.equal(h.changes.at(-1).new.length, 0);
  h = add(h, '2026-09-06', []);
  assert.equal(persistentGone(h.snapshots).length, 0);
  h = add(h, '2026-09-07', []);
  const gone = persistentGone(h.snapshots)[0];
  assert.equal(gone.lastSeen, '2026-09-05');
  assert.equal(gone.missingSince, '2026-09-06');
  assert.equal(gone.daysSinceLastSeen, 2);
});
test('missing calendar days and failed captures do not increase observations', () => {
  let h = add(null, '2026-09-01', [listing('A')]);
  h = add(h, '2026-09-05', []);
  assert.equal(persistentGone(h.snapshots).length, 0);
  assert.equal(persistentGone([...h.snapshots, { date: '2026-09-06', quality: { complete: false }, listings: [] }]).length, 0);
});
test('different floor, new advertisement IDs and ambiguous legacy matches stay separate', () => {
  for (const changed of [listing('B'), listing('A', { floor: 21 })]) {
    let h = add(null, '2026-09-01', [listing('A')]);
    h = add(h, '2026-09-02', [changed]);
    assert.equal(h.changes[0].new.length, 1);
  }
  const legacy = listing('A', { sourceIds: [], agents: [{name:'A'}, {name:'B'}], floor: null });
  let h = add(null, '2026-09-01', [legacy, { ...legacy }]);
  h = add(h, '2026-09-02', [{ ...legacy }]);
  assert.equal(h.snapshots[1].listings[0].matchMethod, 'ambiguous');
});
test('split groups are not silently assigned to one property', () => {
  let h = add(null, '2026-09-01', [listing('A', { sourceIds: ['A','B'], count: 2 })]);
  h = add(h, '2026-09-02', [listing('A'), listing('B')]);
  assert.equal(h.changes[0].new.length, 2);
});
test('historical advertisement aliases can identify a returning group', () => {
  let h = add(null, '2026-09-01', [listing('A', { sourceIds: ['A','B'], count: 2 })]);
  h = add(h, '2026-09-02', [listing('B')]);
  h = add(h, '2026-09-03', []);
  h = add(h, '2026-09-04', [listing('A')]);
  assert.equal(h.changes.at(-1).reappeared.length, 1);
  assert.deepEqual(h.snapshots.at(-1).listings[0].sourceIds, ['A']);
});
test('same-day replacement and backfill rebuild chronological differences', () => {
  let h = add(null, '2026-09-01', [listing('A')]);
  h = add(h, '2026-09-03', [listing('A', { price: 125000 })]);
  h = add(h, '2026-09-02', [listing('A', { price: 128000 })]);
  h = add(h, '2026-09-02', [listing('A', { price: 127000 })]);
  assert.equal(h.snapshots.length, 3);
  assert.equal(h.changes[1].priceChanges[0].beforePrice, 127000);
});
test('raw fields and contact numbers are excluded from normalized public data', () => {
  const r = validateEnvelope(envelope('2026-09-06', [listing('A', { memo: 'private', token: 'secret', agents: [{ name: '중개소 (031) 123 4567', phone: '01012345678', memo: 'private' }] })]), { now });
  const raw = JSON.stringify(r);
  assert.ok(!raw.includes('private') && !raw.includes('secret') && !raw.includes('4567'));
});
test('permission, destination and trial period checked before sending a request', async t => {
  let calls = 0;
  const directory = await temporary(t);
  await assert.rejects(collect({ config: { ...approved(), enabled: false }, address: 'https://example.com/feed', directory, now, fetchImpl: () => { calls++; } }));
  assert.equal(calls, 0);
  assert.throws(() => checkSource(approved(), 'https://elsewhere.example/feed', now));
  assert.throws(() => checkSource(approved(), 'http://example.com/feed', now));
  assert.throws(() => checkSource(approved(), 'https://example.com/feed', new Date('2026-09-20T12:00Z')));
});
test('feed -> validation -> stored JSON works and incomplete result preserves last good data', async t => {
  const directory = await temporary(t);
  const good = envelope('2026-09-06', [listing('A')]);
  let options;
  const run = input => collect({ config: approved(), address: 'https://example.com/feed', token: 'test-token', directory, now,
    fetchImpl: async (_url, request) => { options = request; return new Response(JSON.stringify(input), { headers: { 'content-type': 'application/json' } }); } });
  await run(good);
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, 'Bearer test-token');
  const before = await readFile(join(directory, 'listing-history.json'), 'utf8');
  await assert.rejects(run({ ...good, quality: { ...good.quality, complete: false } }));
  assert.equal(await readFile(join(directory, 'listing-history.json'), 'utf8'), before);
  assert.equal(JSON.parse(await readFile(join(directory, 'listings.json'), 'utf8')).unique, 1);
});
test('CLI rejects undated legacy JSON and corrupt history without replacing saved listings', async t => {
  const directory = await temporary(t);
  const input = join(directory, 'input.json');
  await writeFile(input, JSON.stringify({listings:[listing('A')]}));
  await writeFile(join(directory, 'listings.json'), '{"updated":"2026-09-01","listings":[]}');
  const script = fileURLToPath(new URL('../scripts/import-listings.mjs', import.meta.url));
  const run = args => spawnSync(process.execPath, [script, input, '--data-dir', directory, ...args], { encoding: 'utf8' });
  assert.equal(run([]).status, 1);
  assert.equal(JSON.parse(await readFile(join(directory, 'collection-status.json'))).status, 'failed');
  await writeFile(join(directory, 'listing-history.json'), '{broken');
  assert.equal(run(['--date','2026-09-01']).status, 1);
  assert.equal(await readFile(join(directory, 'listing-history.json'), 'utf8'), '{broken');
  assert.equal(JSON.parse(await readFile(join(directory, 'listings.json'))).updated, '2026-09-01');
});
test('14-day synthetic trial distinguishes price changes, disappearance and reappearance', () => {
  let h;
  for (let day = 1; day <= 14; day++) {
    const items = [listing('A', {price: day >= 3 ? 128000 : 130000}), listing('D', {floor: 24})];
    if (day <= 3 || day >= 6 && day <= 9) items.push(listing('B', {floor: 21}));
    h = add(h, `2026-09-${String(day).padStart(2,'0')}`, items);
  }
  assert.equal(h.snapshots.length, 14);
  assert.equal(h.changes.reduce((n,x)=>n+x.priceChanges.length,0), 1);
  assert.equal(h.changes.reduce((n,x)=>n+x.reappeared.length,0), 1);
  const gone = persistentGone(h.snapshots);
  assert.equal(gone.length, 1);
  assert.equal(gone[0].lastSeen, '2026-09-09');
  assert.equal(gone[0].missingObservations, 5);
});
