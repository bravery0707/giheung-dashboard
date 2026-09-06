import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, PRIVATE_DATA, privateDirectory, withDataLock } from './private-storage.mjs';
import { readOptionalJson, writeJson, saveCollection, saveFailure } from './listing-storage.mjs';
import { readGuard } from './collect-listings.mjs';
import { calendarDate, kstDate, validateEnvelope, mergeSnapshot } from './listing-model.mjs';
import { readNaverDOM, screenTotals, expectedAds, envelopeFromScreens } from './naver-dom.mjs';

export const NAVER_URL = 'https://fin.land.naver.com/complexes/109996';
export const LIMITS = Object.freeze({ requests: 300, dataRequests: 100, actions: 45, durationMs: 240000, pauseMs: 2000 });
const fault = (code, message) => Object.assign(new Error(message), { code });
export function checkNaverConfig(config, now = new Date()) {
  if (config?.enabled !== true || config.mode !== 'naver-browser' || config.privateUseAcknowledged !== true) throw new Error('개인 PC 브라우저 수집 설정이 필요합니다.');
  const start = calendarDate(config.trial?.startDate);
  if (!Number.isInteger(config.trial.days) || config.trial.days < 1 || config.trial.days > 14) throw new Error('시험 기간은 1~14일입니다.');
  const offset = (Date.parse(kstDate(now)) - Date.parse(start)) / 86400000;
  if (offset < 0 || offset >= config.trial.days) throw new Error('브라우저 수집 시험 기간 밖입니다.');
  // User acknowledgement is not represented as permission from Naver.
}
export class BrowserBudget {
  constructor(limits = LIMITS) { this.limits = limits; this.requests = 0; this.dataRequests = 0; this.actions = 0; this.types = {}; this.error = null; }
  stop(code, message) { this.error ||= fault(code, message); return this.error; }
  check() { if (this.error) throw this.error; }
  request(type) {
    if (this.error) return false;
    this.types[type] = (this.types[type] || 0) + 1;
    if (++this.requests > this.limits.requests || (['xhr', 'fetch', 'document'].includes(type) && ++this.dataRequests > this.limits.dataRequests)) {
      this.stop('BUDGET', '브라우저 요청 상한에 도달했습니다.'); return false;
    }
    return true;
  }
  action() { this.check(); if (++this.actions > this.limits.actions) throw this.stop('BUDGET', '화면 조작 상한에 도달했습니다.'); }
}
export async function captureNaver({ chromium, profile, report = () => {} }) {
  const budget = new BrowserBudget();
  let context;
  const startedAt = new Date().toISOString();
  const timer = setTimeout(() => { budget.stop('BUDGET', '수집 시간 상한에 도달했습니다.'); void context?.close().catch(() => {}); }, LIMITS.durationMs);
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, timeout: 30000 });
    context.setDefaultTimeout(20000);
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', async route => {
      const req = route.request();
      // Do not download photos, media or web fonts. No network replay, proxy or stealth.
      if (['image', 'media', 'font'].includes(req.resourceType()) || !budget.request(req.resourceType())) return route.abort();
      return route.continue();
    });
    context.on('response', response => {
      const url = new URL(response.url());
      if ((url.hostname === 'naver.com' || url.hostname.endsWith('.naver.com')) && [401, 403, 429].includes(response.status())) {
        budget.stop('ACCESS_DENIED', '네이버 접근 거부·요청 제한 응답으로 중지했습니다.');
        void context.close().catch(() => {});
      }
    });
    const page = context.pages()[0] || await context.newPage();
    const checkScreen = async () => {
      budget.check();
      const url = new URL(page.url());
      if (url.hostname !== 'fin.land.naver.com') throw budget.stop('ACCESS_DENIED', '로그인 또는 다른 사이트로 이동했습니다.');
      const challenged = await page.evaluate(() => /자동입력\s*방지|비정상적인\s*접근|접근이\s*제한|보안\s*확인|로봇이\s*아닙니다|captcha/i.test(document.body.innerText) || !!document.querySelector('iframe[src*="captcha"], input[name*="captcha"]'));
      if (challenged) throw budget.stop('ACCESS_DENIED', '보안 확인 화면으로 자동 수집을 중단했습니다.');
    };
    const act = async callback => { await checkScreen(); budget.action(); await delay(LIMITS.pauseMs); budget.check(); await callback(); };
    budget.action();
    await page.goto(NAVER_URL, { waitUntil: 'domcontentloaded' });
    await checkScreen();
    await act(() => page.getByRole('tab', { name: '매물', exact: true }).click());
    await page.waitForFunction(() => /매물\s*[1-9][\d,]*\s*개/.test(document.querySelector('#complex_detail')?.innerText || ''), null, { timeout: 20000 });
    let before;
    for (let scroll = 0; scroll <= 10; scroll++) {
      await checkScreen();
      before = await page.evaluate(readNaverDOM);
      const { expectedUnique } = screenTotals(before);
      if (before.cards.length === expectedUnique) break;
      if (before.cards.length > expectedUnique || scroll === 10) throw fault('INCOMPLETE', '전체 매물 목록을 읽지 못했습니다.');
      await act(() => page.locator('#complex_detail [data-sentry-component="ArticleCard"]').last().scrollIntoViewIfNeeded());
    }
    report(`대표 매물 ${before.cards.length}건 확인. 광고 묶음을 순서대로 확인합니다.`);
    const cards = page.locator('#complex_detail [data-sentry-component="ArticleCard"]');
    for (let i = 0; i < before.cards.length; i++) {
      if (!before.cards[i].grouped) continue;
      const count = expectedAds(before.cards[i]);
      await act(() => cards.nth(i).getByRole('button', { name: '매물목록 펼치기', exact: true }).click());
      await page.waitForFunction(({ index, count }) => document.querySelectorAll('#complex_detail [data-sentry-component="ArticleCard"]')[index]?.querySelectorAll('[data-sentry-component="ArticleCardSub"]').length === count, { index: i, count }, { timeout: 15000 });
      await checkScreen();
    }
    const after = await page.evaluate(readNaverDOM);
    const capturedAt = new Date().toISOString();
    const envelope = envelopeFromScreens(before, after, { startedAt, capturedAt });
    return { envelope, audit: { startedAt, capturedAt, requests: budget.requests, dataRequests: budget.dataRequests, actions: budget.actions,
      displayedUnique: screenTotals(before).expectedUnique, displayedPostings: before.cards.reduce((n, c) => n + expectedAds(c), 0), displayedDeals: screenTotals(before).deals,
      requestTypes: budget.types, extractedIds: envelope.listings.flatMap(x => x.sourceIds).length, pricesVerified: true } };
  } catch (error) {
    const failure = budget.error || error;
    failure.audit = { startedAt, finishedAt: new Date().toISOString(), status: 'failed', reason: failure.code || 'CHECK_FAILED',
      requests: budget.requests, dataRequests: budget.dataRequests, actions: budget.actions, requestTypes: budget.types, limits: LIMITS };
    throw failure;
  } finally {
    clearTimeout(timer);
    await context?.close().catch(() => {});
  }
}
export async function collectNaver({ config, directory = PRIVATE_DATA, now = new Date(), capture = captureNaver, chromium, report = () => {} }) {
  checkNaverConfig(config, now);
  return withDataLock(directory, async dir => {
    const state = await readGuard(dir), today = kstDate(now), guardPath = join(dir, 'request-state.json');
    if (state.halted) throw fault('PAUSED', '접근 제한으로 수집이 중지되어 있습니다.');
    if (state.lastAttemptDate && state.lastAttemptDate >= today) throw fault('DAILY_LIMIT', '오늘 수집은 이미 시도했습니다. 자동 재시도하지 않습니다.');
    const reserved = { ...state, lastAttemptDate: today, attemptedAt: now.toISOString(), mode: 'naver-browser' };
    await writeJson(guardPath, reserved);
    try {
      const profile = await privateDirectory(join(ROOT, '.private/naver-browser-profile'));
      const { envelope, audit } = await capture({ chromium, profile, report });
      if (envelope.source !== 'naver-dom-v1') throw new Error('브라우저 수집 출처가 다릅니다.');
      const history = await readOptionalJson(join(dir, 'listing-history.json'), null);
      const previous = history?.snapshots?.at(-1);
      const snapshot = validateEnvelope(envelope, { live: true, now, previous });
      const newBaseline = previous && previous.source !== envelope.source;
      if (newBaseline) {
        // Preserve the Excel history privately; don't manufacture changes across incompatible sources.
        await writeJson(join(dir, `history-before-naver-${today}.json`), history);
      }
      const result = mergeSnapshot(newBaseline ? null : history, snapshot);
      await writeJson(join(dir, 'naver-audit.json'), { ...audit, newBaseline: !!newBaseline, limits: LIMITS });
      await saveCollection(dir, result, envelope.capturedAt);
      return result;
    } catch (error) {
      const halted = error.code === 'ACCESS_DENIED';
      if (halted) await writeJson(guardPath, { ...reserved, halted: true, reason: error.code });
      await writeJson(join(dir, 'naver-last-attempt.json'), error.audit || { startedAt: now.toISOString(), status: 'failed', reason: error.code || 'CHECK_FAILED' });
      await saveFailure(dir, halted ? 'paused' : 'failed');
      throw error;
    }
  });
}
export async function loadChromium() {
  // Optional explicit local package path supports a bundled runtime without copying credentials.
  const module = process.env.NAVER_PLAYWRIGHT_MODULE;
  return (await import(module ? pathToFileURL(resolve(module)).href : 'playwright')).chromium;
}
export async function loadNaverConfig() {
  return JSON.parse(await readFile(join(ROOT, '.private/naver-config.json'), 'utf8'));
}
async function main() {
  if (process.env.CI) throw new Error('개인 PC에서만 수집할 수 있습니다.');
  const config = await loadNaverConfig();
  checkNaverConfig(config);
  const chromium = await loadChromium();
  const result = await collectNaver({ config, chromium, directory: resolve(process.env.LISTING_DATA_DIR || PRIVATE_DATA), report: console.log });
  console.log(`네이버 화면 수집 완료: ${result.listings.updated}, 대표 ${result.listings.unique}건, 광고 ${result.listings.postings}건`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); } catch (error) { console.error(`수집 중단 [${error.code || 'CHECK_FAILED'}]: ${['DAILY_LIMIT', 'PAUSED', 'INCOMPLETE', 'ACCESS_DENIED', 'BUDGET'].includes(error.code) ? error.message : '실행 환경 또는 화면 표시를 확인하세요. 기존 정상 자료는 유지됩니다.'}`); process.exitCode = 1; }
}
