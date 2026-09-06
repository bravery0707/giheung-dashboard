import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envelopeFromScreens, money, parsePrice } from '../scripts/naver-dom.mjs';
import { BrowserBudget, collectNaver } from '../scripts/collect-naver.mjs';
import { readOptionalJson, writeJson } from '../scripts/listing-storage.mjs';
import { validateEnvelope, mergeSnapshot } from '../scripts/listing-model.mjs';
const now = new Date('2026-09-06T01:00:00Z');
const config = { enabled: true, mode: 'naver-browser', privateUseAcknowledged: true, trial: { startDate: '2026-09-06', days: 14 } };
function screen() {
  return { title: '힐스테이트기흥', totalText: '매물2개도움말 보기', filters: ['전체거래유형','전체면적','전체동'], deals: ['매매1','전세0','월세1','단기0'], cards: [
    { name: '힐스테이트기흥 201동', price: '매매 12억 ~ 12억 5,000', summary: ['아파트', '104B㎡ (전용72.89B)', '39/49층', '남서향'], countText: '중개사 2곳에서 등록했어요', grouped: true, ads: [
      { id: '10001', price: '매매 12억', confirmed: '확인매물 2026.09.05' }, { id: '10002', price: '매매 12억 5,000', confirmed: '확인매물 2026.09.06' }] },
    { name: '힐스테이트기흥 202동', price: '월세 1억 5,000/230', summary: ['아파트','121C㎡ (전용84.53C)', '고/49층','남동향'], countText: '', grouped: false,
      ads: [{ id: '10003', price: '월세 1억 5,000/230', confirmed: '확인매물 2026.09.06' }] },
  ] };
}
const envelope = (before = screen(), after = screen()) => envelopeFromScreens(before, after, { startedAt: now.toISOString(), capturedAt: now.toISOString() });
async function temporary(run) { const dir = await mkdtemp(join(tmpdir(), 'naver-test-')); try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); } }
test('Korean prices, rent and exact exclusive area preserve their units', () => {
  assert.equal(money('12억 5,000'), 125000);
  assert.equal(money('230'), 230);
  assert.throws(() => money('협의'));
  assert.throws(() => parsePrice('월세 1억/100~120'));
  const e = envelope();
  const validated = validateEnvelope(e, { now, live: true });
  assert.equal(validated.listings[0].area, 72.89);
  assert.equal(validated.listings[0].priceMax, 125000);
  assert.equal(validated.listings[1].rent, 230);
  assert.equal(e.quality.expectedPostings, 3);
  assert.equal(e.listings[1].floor, null);
});
test('missing group, missing ad, changed header, wrong filters and wrong prices fail closed', () => {
  for (const mutate of [s => s.cards.pop(), s => s.cards[0].ads.pop(), s => s.cards[0].price = '매매 11억', s => s.filters.pop(), s => s.cards[0].ads[0].price = '매매 11억', s => s.deals[0] = '매매2', s => s.cards[0].ads[1].id = '10001']) {
    const after = screen(); mutate(after); assert.throws(() => envelope(screen(), after));
  }
});
test('request and action budgets stop before allowing excess work', () => {
  const b = new BrowserBudget({ requests: 3, dataRequests: 1, actions: 1 });
  assert.equal(b.request('fetch'), true); assert.equal(b.request('fetch'), false); assert.throws(() => b.action(), { code: 'BUDGET' });
  const a = new BrowserBudget({ requests: 1, dataRequests: 1, actions: 1 });
  a.action(); assert.throws(() => a.action(), { code: 'BUDGET' });
});
test('real capture adapter is inside persistent daily quota and shares the feed lock', () => temporary(async dir => {
  let calls = 0;
  const options = { config, directory: dir, now, capture: async () => { calls++; return { envelope: envelope(), audit: {} }; } };
  const result = await collectNaver(options); assert.equal(result.listings.postings, 3);
  await assert.rejects(collectNaver(options), { code: 'DAILY_LIMIT' }); assert.equal(calls, 1);
}));
test('access denial remains paused tomorrow; no retry, previous data remains intact', () => temporary(async dir => {
  await writeJson(join(dir, 'listings.json'), { updated: '2026-09-05', listings: ['previous'] });
  const capture = async () => { throw Object.assign(new Error('denied'), { code: 'ACCESS_DENIED' }); };
  await assert.rejects(collectNaver({ config, directory: dir, now, capture }), { code: 'ACCESS_DENIED' });
  await assert.rejects(collectNaver({ config, directory: dir, now: new Date(+now + 86400000), capture }), { code: 'PAUSED' });
  assert.deepEqual((await readOptionalJson(join(dir, 'listings.json'))).listings, ['previous']);
}));
test('incomplete capture preserves good history and consumes the day', () => temporary(async dir => {
  await writeJson(join(dir, 'listing-history.json'), { marker: 'preserved' });
  const bad = envelope(); bad.listings.pop();
  const options = { config, directory: dir, now, capture: async () => ({ envelope: bad, audit: {} }) };
  await assert.rejects(collectNaver(options));
  assert.deepEqual(await readOptionalJson(join(dir, 'listing-history.json')), { marker: 'preserved' });
  await assert.rejects(collectNaver(options), { code: 'DAILY_LIMIT' });
}));
test('first browser sample archives old source instead of producing false new/gone changes', () => temporary(async dir => {
  const old = envelope(); old.date = '2026-09-05'; old.capturedAt = '2026-09-05T01:00:00Z'; old.startedAt = old.capturedAt; old.source = 'legacy-excel';
  const history = mergeSnapshot(null, validateEnvelope(old, { now })).history;
  await writeJson(join(dir, 'listing-history.json'), history);
  const result = await collectNaver({ config, directory: dir, now, capture: async () => ({ envelope: envelope(), audit: {} }) });
  assert.equal(result.history.snapshots.length, 1); assert.equal(result.history.changes.length, 0);
  assert.deepEqual(await readOptionalJson(join(dir, 'history-before-naver-2026-09-06.json')), history);
}));
