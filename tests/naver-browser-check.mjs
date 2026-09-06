// Explicit offline integration test. Every page request is fulfilled locally;
// this file is not part of the dependency-free unit test glob.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureNaver, loadChromium, collectNaver } from '../scripts/collect-naver.mjs';
import { kstDate } from '../scripts/listing-model.mjs';
import { readOptionalJson } from '../scripts/listing-storage.mjs';
const chromium = await loadChromium();
const date = kstDate(new Date());
const badge = `<span class="fixture__type-confirmed">확인매물 ${date.replaceAll('-', '.')}</span>`;
const sub = (id, price) => `<li data-sentry-component="ArticleCardSub"><span class="fixture__price">매매 ${price}</span>${badge}<a href="/articles/${id}">매물 보러가기</a></li>`;
const html = `<!doctype html><html lang="ko"><body><div id="complex_detail"><h3>힐스테이트기흥</h3>
<button role="tab">매물</button><h3>매물2개도움말 보기</h3>
<button>매매1</button><button>전세0</button><button>월세1</button><button>단기0</button>
<button>전체거래유형</button><button>전체면적</button><button>전체동</button><ul>
<li data-sentry-component="ArticleCard"><div class="fixture__area-data"><span class="fixture__name">힐스테이트기흥 201동</span>
<span class="fixture__price">매매 12억 ~ 12억 5,000</span><ul><li class="fixture__item-summary">아파트</li><li class="fixture__item-summary">104B㎡ (전용72.89B)</li><li class="fixture__item-summary">39/49층</li><li class="fixture__item-summary">남서향</li></ul>
<span class="fixture__text-more">중개사 2곳에서 등록했어요</span><button class="fixture__button-expand" onclick="this.closest('[data-sentry-component=ArticleCard]').querySelector('.ads').innerHTML=document.getElementById('ads').innerHTML;this.textContent='매물목록 접기'">매물목록 펼치기</button></div><ul class="ads"></ul></li>
<li data-sentry-component="ArticleCard"><div class="fixture__area-data"><span class="fixture__name">힐스테이트기흥 202동</span><span class="fixture__price">월세 1억 5,000/230</span><ul><li class="fixture__item-summary">아파트</li><li class="fixture__item-summary">121C㎡ (전용84.53C)</li><li class="fixture__item-summary">고/49층</li><li class="fixture__item-summary">남동향</li></ul>${badge}<a href="/articles/10003">매물 보러가기</a></div></li></ul></div>
<template id="ads">${sub('10001', '12억')}${sub('10002', '12억 5,000')}</template></body></html>`;
let requests = 0;
const offlineChromium = {
  async launchPersistentContext(profile, options) {
    const context = await chromium.launchPersistentContext(profile, { ...options, headless: true });
    for (const page of context.pages()) await page.route('**/*', route => {
      requests++;
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    });
    return context;
  },
};
const dir = await mkdtemp(join(tmpdir(), 'naver-offline-'));
try {
  const result = await collectNaver({ config: { enabled: true, mode: 'naver-browser', privateUseAcknowledged: true, trial: { startDate: date, days: 1 } }, directory: dir,
    capture: options => captureNaver({ ...options, chromium: offlineChromium, profile: join(dir, 'profile') }) });
  assert.equal(result.listings.unique, 2);
  assert.equal(result.listings.postings, 3);
  assert.equal(result.listings.listings[0].priceMax, 125000);
  assert.equal(result.listings.listings[1].rent, 230);
  assert.equal((await readOptionalJson(join(dir, 'collection-status.json'))).status, 'success');
  assert.equal((await readOptionalJson(join(dir, 'naver-audit.json'))).pricesVerified, true);
  assert.ok(requests > 0);
  console.log('PASS: offline Chrome DOM → grouped ad IDs → counts/prices → private storage. Naver network requests: 0.');
} finally { await rm(dir, { recursive: true, force: true }); }
