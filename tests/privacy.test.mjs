import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect, resumeCollection } from '../scripts/collect-listings.mjs';
import { ROOT, privateDirectory } from '../scripts/private-storage.mjs';
import { PUBLIC_DATA, STATIC_FILES, buildPublic } from '../scripts/build-public.mjs';
import { createDashboard, dueAt, startScheduler } from '../scripts/private-dashboard.mjs';
import { COMPLEX, SCOPE } from '../scripts/listing-model.mjs';

async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'giheung-private-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const day = n => new Date(`2026-09-${String(n).padStart(2, '0')}T12:11:00Z`);
const config = { enabled: true, source: 'test', allowedOrigin: 'https://example.com', permission: { collection: true, publicRedistribution: false, reference: 'synthetic test' }, trial: { startDate: '2026-09-06', days: 14 } };
const payload = n => ({ schemaVersion: 2, complex: COMPLEX, scope: SCOPE, source: 'test', date: `2026-09-${String(n).padStart(2, '0')}`,
  startedAt: day(n).toISOString(), capturedAt: day(n).toISOString(), quality: { complete: true, expectedPages: 1, pagesFetched: 1, expectedUnique: 1, expectedPostings: 1 },
  listings: [{ sourceIds: ['PRIVATE_TEST_AD'], count: 1, dong: '203', deal: '매매', type: '120A', area: 84.95, floor: 20, band: '중', face: '남동향', price: 130000, rent: 0, agents: [] }] });
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const run = (directory, now, fetchImpl, extra = {}) => collect({ directory, now, fetchImpl, config, address: 'https://example.com/feed?secret=NOT_FOR_LOGS', ...extra });

test('private collection needs no public redistribution permission; persisted daily quota survives restart', async t => {
  const directory = await temp(t); let calls = 0;
  const fetchImpl = async () => { calls++; return json(payload(6)); };
  await run(directory, day(6), fetchImpl);
  await assert.rejects(run(directory, day(6), fetchImpl), { code: 'DAILY_LIMIT' });
  await run(directory, day(7), async () => { calls++; return json(payload(7)); });
  assert.equal(calls, 2);
  assert.equal(JSON.parse(await readFile(join(directory, 'listing-history.json'))).snapshots.length, 2);
  assert.equal(JSON.parse(await readFile(join(directory, 'request-state.json'))).lastAttemptDate, '2026-09-07');
});
test('concurrent collectors cannot make two requests', async t => {
  const directory = await temp(t); let release, entered;
  const pending = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  const first = run(directory, day(6), async () => { entered(); await pending; return json(payload(6)); });
  await started;
  await assert.rejects(run(directory, day(6), () => assert.fail('second fetch')), { code: 'LOCKED' });
  release(); await first;
});
for (const [label, response] of [
  ['401', () => new Response('private denied body', { status: 401 })],
  ['403', () => new Response('private denied body', { status: 403 })],
  ['429', () => new Response('private denied body', { status: 429, headers: { 'retry-after': '1' } })],
  ['redirect', () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/login' } })],
  ['HTML CAPTCHA', () => new Response('<html>CAPTCHA login</html>', { headers: { 'content-type': 'text/html' } })],
  ['HTML mislabeled as JSON', () => new Response('<html>CAPTCHA</html>', { headers: { 'content-type': 'application/json' } })],
]) test(`${label} pauses across later days and resume never refunds today's quota`, async t => {
  const directory = await temp(t); let calls = 0;
  await run(directory, day(6), async () => json(payload(6)));
  const before = await readFile(join(directory, 'listing-history.json'), 'utf8');
  await assert.rejects(run(directory, day(7), async () => { calls++; return response(); }));
  await assert.rejects(run(directory, day(8), () => assert.fail('paused request')), { code: 'PAUSED' });
  assert.equal(JSON.parse(await readFile(join(directory, 'collection-status.json'))).status, 'paused');
  assert.equal(await readFile(join(directory, 'listing-history.json'), 'utf8'), before);
  const state = await readFile(join(directory, 'request-state.json'), 'utf8');
  assert.ok(!state.includes('NOT_FOR_LOGS') && !state.includes('private denied body'));
  await assert.rejects(resumeCollection(directory, ''));
  await resumeCollection(directory, 'Synthetic access issue resolved');
  await assert.rejects(run(directory, day(7), () => assert.fail('refunded request')), { code: 'DAILY_LIMIT' });
  await run(directory, day(8), async () => { calls++; return json(payload(8)); });
  assert.equal(calls, 2);
});
test('timeout consumes attempt, preserves history and does not retry', async t => {
  const directory = await temp(t);
  await run(directory, day(6), async () => json(payload(6)));
  const before = await readFile(join(directory, 'listing-history.json'), 'utf8');
  await assert.rejects(run(directory, day(7), async (_url, { signal }) => new Promise((ok, fail) => {
    const keepAlive = setTimeout(() => fail(new Error('timer failed')), 500);
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); fail(signal.reason); }, { once: true });
  }), { timeoutMs: 20 }));
  await assert.rejects(run(directory, day(7), () => assert.fail('retry')), { code: 'DAILY_LIMIT' });
  assert.equal(await readFile(join(directory, 'listing-history.json'), 'utf8'), before);
});
test('partial results and oversized response preserve last valid observation', async t => {
  const directory = await temp(t);
  await run(directory, day(6), async () => json(payload(6)));
  const before = await readFile(join(directory, 'listing-history.json'), 'utf8');
  const partial = payload(7); partial.quality.complete = false;
  await assert.rejects(run(directory, day(7), async () => json(partial)));
  await assert.rejects(run(directory, day(8), async () => new Response('x'.repeat(5 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })), { code: 'TOO_LARGE' });
  assert.equal(await readFile(join(directory, 'listing-history.json'), 'utf8'), before);
  assert.equal(JSON.parse(await readFile(join(directory, 'collection-status.json'))).status, 'failed');
});
test('corrupt request state and a stale lock fail closed before network', async t => {
  const directory = await temp(t);
  await writeFile(join(directory, 'request-state.json'), '{bad');
  await assert.rejects(run(directory, day(6), () => assert.fail('corrupt state request')));
  await writeFile(join(directory, 'collection.lock'), '{"pid":999999}');
  await assert.rejects(run(directory, day(6), () => assert.fail('stale lock request')), { code: 'LOCKED' });
});
test('public repository paths cannot be used for private collection or import storage', async () => {
  for (const path of ['data', 'incoming', 'assets', '_site', '.']) await assert.rejects(privateDirectory(join(ROOT, path)));
});
async function fixture(t) {
  const root = await temp(t);
  for (const file of STATIC_FILES) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), file.endsWith('.json') ? '{"transactions":[]}' : 'public test');
  }
  for (const [name, data] of Object.entries(PUBLIC_DATA)) await writeFile(join(root, 'data', name), JSON.stringify(data));
  await mkdir(join(root, 'incoming')); await writeFile(join(root, 'incoming/README.md'), 'No raw input');
  return root;
}
test('public build excludes private originals, config and stale output; fails if raw data enters public inputs', async t => {
  const root = await fixture(t);
  await mkdir(join(root, '.private')); await writeFile(join(root, '.private/raw.json'), 'PRIVATE_TEST_AD');
  await mkdir(join(root, '_site')); await writeFile(join(root, '_site/old-private.json'), 'PRIVATE_TEST_AD');
  const out = await buildPublic(root);
  assert.deepEqual((await readdir(out)).sort(), ['.nojekyll', 'assets', 'data', 'index.html']);
  assert.equal(await readFile(join(out, 'data/listings.json'), 'utf8'), JSON.stringify(PUBLIC_DATA['listings.json']) + '\n');
  await writeFile(join(root, 'data/listings.json'), JSON.stringify({ listings: payload(6).listings }));
  await assert.rejects(buildPublic(root), /공개 데이터/);
  await writeFile(join(root, 'data/listings.json'), JSON.stringify(PUBLIC_DATA['listings.json']));
  await writeFile(join(root, 'incoming/raw.xlsx'), 'raw');
  await assert.rejects(buildPublic(root), /incoming/);
});
test('private HTTP server serves local listings but blocks secret paths, writes, remote Host and cross-site access', async t => {
  const root = await fixture(t); const directory = await temp(t);
  await writeFile(join(directory, 'listings.json'), JSON.stringify({ listings: payload(6).listings }));
  const server = await createDashboard({ root, directory, port: 0 });
  t.after(() => new Promise(r => server.close(r)));
  assert.equal(server.address().address, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await (await fetch(base + '/data/site-mode.json')).json()).mode, 'private');
  const response = await fetch(base + '/data/listings.json');
  assert.equal((await response.json()).listings[0].sourceIds[0], 'PRIVATE_TEST_AD');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  for (const path of ['/.private/raw.json', '/.git/config', '/config/listing-source.json', '/scripts/collect-listings.mjs', '/data/request-state.json', '/data/%2e%2e%2f.private/raw.json']) assert.equal((await fetch(base + path)).status, 404);
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/data/listings.json', { headers: { Origin: 'https://elsewhere.example' } })).status, 403);
  // Use node:http to exercise Host directly (fetch implementations may normalize it).
  const { request } = await import('node:http');
  assert.equal(await new Promise((ok, fail) => { request(base, { headers: { Host: 'attacker.example' } }, r => { r.resume(); ok(r.statusCode); }).on('error', fail).end(); }), 403);
});
test('public HTTP mode never reads an existing private snapshot', async t => {
  const root = await fixture(t); const directory = await temp(t);
  await writeFile(join(directory, 'listings.json'), JSON.stringify({ listings: payload(6).listings }));
  const server = await createDashboard({ root, directory, mode: 'public', port: 0 });
  t.after(() => new Promise(r => server.close(r)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/data/listings.json`);
  assert.deepEqual(await response.json(), PUBLIC_DATA['listings.json']);
});
test('scheduler uses KST, runs once after 21:10 and never retries failed attempts', async () => {
  assert.equal(dueAt(new Date('2026-09-06T12:09:59Z')), false);
  assert.equal(dueAt(new Date('2026-09-06T12:10:00Z')), true);
  let clock = new Date('2026-09-06T12:09:00Z'); let count = 0;
  const scheduler = startScheduler(async () => { count++; throw new Error('test failure'); }, { clock: () => clock });
  try {
    await scheduler.tick(); assert.equal(count, 0);
    clock = day(6); await scheduler.tick(); await scheduler.tick(); assert.equal(count, 1);
    clock = day(7); await scheduler.tick(); assert.equal(count, 2);
  } finally { scheduler.stop(); }
});
