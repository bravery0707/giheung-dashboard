import { COMPLEX, SCOPE, kstDate, calendarDate } from './listing-model.mjs';

// A count may exist on the old price tab while the article tab is still mounting.
export function naverListReady() {
  const root = document.getElementById('complex_detail');
  if (!root) return false;
  const selected = root.querySelector('[role="tab"][aria-selected="true"]');
  if (!selected || !/^매물(?:\s|현재|$)/.test(selected.textContent.trim())) return false;
  const buttons = Array.from(root.querySelectorAll('button')).filter(b => b.getClientRects().length).map(b => b.textContent.trim());
  return ['전체거래유형', '전체면적', '전체동'].every(t => buttons.includes(t))
    && Array.from(root.querySelectorAll('h3')).some(h => /^매물\s*[1-9][\d,]*\s*개/.test(h.textContent))
    && root.querySelectorAll('[data-sentry-component="ArticleCard"]').length > 0;
}

// Only rendered listing fields. No app state, response bodies, cookies or descriptions.
export function readNaverDOM() {
  const root = document.getElementById('complex_detail');
  if (!root) return null;
  const value = (el, selector) => el.querySelector(selector)?.textContent.trim() || '';
  const ad = el => ({
    id: Array.from(el.querySelectorAll('a[href]')).map(a => a.getAttribute('href')).find(h => /^\/articles\/\d+$/.test(h))?.split('/').at(-1) || '',
    price: value(el, '[class$="__price"]'),
    confirmed: value(el, '[class*="__type-confirmed"]'),
  });
  const buttons = Array.from(root.querySelectorAll('button')).map(b => b.textContent.trim());
  return {
    title: value(root, 'h3'),
    totalText: Array.from(root.querySelectorAll('h3')).find(h => /^매물[\s\d,]+개/.test(h.textContent))?.textContent || '',
    filters: ['전체거래유형', '전체면적', '전체동'].filter(t => buttons.includes(t)),
    deals: buttons.filter(t => /^(매매|전세|월세|단기)\s*\d+$/.test(t)),
    cards: Array.from(root.querySelectorAll('[data-sentry-component="ArticleCard"]')).map(card => {
      const header = card.querySelector('[class$="__area-data"]');
      const subs = Array.from(card.querySelectorAll('[data-sentry-component="ArticleCardSub"]'));
      return {
        name: value(header, '[class$="__name"]'), price: value(header, '[class$="__price"]'),
        summary: Array.from(header.querySelectorAll('[class$="__item-summary"]')).map(x => x.textContent.trim()),
        countText: value(header, '[class$="__text-more"]'),
        grouped: !!header.querySelector('[class$="__button-expand"]'),
        ads: subs.length ? subs.map(ad) : [ad(header)],
      };
    }),
  };
}
const fail = message => { throw Object.assign(new Error(message), { code: 'INCOMPLETE' }); };
export function money(text) {
  const clean = text.replace(/[\s,]/g, '');
  const match = clean.match(/^(?:(\d+)억)?(\d+)?$/);
  if (!match || (!match[1] && !match[2])) fail('지원하지 않는 가격 표시입니다.');
  return Number(match[1] || 0) * 10000 + Number(match[2] || 0);
}
export function parsePrice(text) {
  const m = text.match(/^(매매|전세|월세)\s*(.+)$/);
  if (!m) fail('거래 종류를 확인할 수 없습니다.');
  if (m[1] === '월세') {
    const parts = m[2].split('/');
    if (parts.length !== 2) fail('월세 범위를 확인할 수 없습니다.');
    return { deal: m[1], price: money(parts[0]), priceMax: null, rent: money(parts[1]) };
  }
  const parts = m[2].split('~');
  if (parts.length > 2) fail('가격 범위를 확인할 수 없습니다.');
  return { deal: m[1], price: money(parts[0]), priceMax: parts.length === 2 ? money(parts[1]) : null, rent: 0 };
}
export function screenTotals(screen) {
  if (!screen || screen.title !== COMPLEX || screen.filters.length !== 3) fail('전체 단지·거래·면적·동 범위가 아닙니다.');
  const total = screen.totalText.match(/^매물\s*([\d,]+)\s*개/);
  if (!total) fail('원본 매물 총계가 없습니다.');
  const deals = Object.fromEntries(screen.deals.map(t => { const m = t.match(/^(매매|전세|월세|단기)\s*(\d+)$/); return [m[1], Number(m[2])]; }));
  const expectedUnique = Number(total[1].replaceAll(',', ''));
  if (Object.keys(deals).length !== 4 || deals.단기 !== 0 || deals.매매 + deals.전세 + deals.월세 !== expectedUnique || !expectedUnique) fail('거래별 총계가 다르거나 빈 화면입니다.');
  return { expectedUnique, deals };
}
export function cardSignature(card) {
  return JSON.stringify([card.name, card.price, card.summary, card.countText, card.grouped]);
}
export function expectedAds(card) {
  if (!card.grouped) return 1;
  const m = card.countText.match(/^중개사\s*(\d+)곳에서 등록했어요$/);
  if (!m || Number(m[1]) < 2) fail('묶음 게시 건수를 확인할 수 없습니다.');
  return Number(m[1]);
}
export function envelopeFromScreens(before, after, { startedAt, capturedAt }) {
  const totals = screenTotals(before), end = screenTotals(after);
  if (JSON.stringify(totals) !== JSON.stringify(end) || before.cards.length !== totals.expectedUnique || after.cards.length !== totals.expectedUnique) fail('목록 일부가 누락되었거나 수집 중 총계가 변경되었습니다.');
  const counts = { 매매: 0, 전세: 0, 월세: 0 };
  let expectedPostings = 0;
  const listings = after.cards.map((card, i) => {
    if (cardSignature(before.cards[i]) !== cardSignature(card)) fail('수집 중 목록 순서 또는 표시가 변경되었습니다.');
    const count = expectedAds(before.cards[i]);
    expectedPostings += count; // Independent displayed broker count, never the extracted ID count.
    if (card.ads.length !== count || new Set(card.ads.map(a => a.id)).size !== count || card.ads.some(a => !/^\d+$/.test(a.id))) fail('광고 번호가 누락되거나 중복되었습니다.');
    const name = card.name.match(/^힐스테이트기흥\s+(\d+)동$/);
    const [kind, areaText, floorText, face] = card.summary;
    const area = areaText?.match(/^(.+?)㎡\s*\(전용(\d+(?:\.\d+)?)([A-Z0-9-]*)\)$/);
    const floor = floorText?.match(/^(\d+|고|중|저)\/(\d+)층$/);
    if (!name || kind !== '아파트' || !area || !floor || !/^(동|서|남|북|남동|남서|북동|북서)향$/.test(face)) fail('동·면적·층·방향 표시를 해석하지 못했습니다.');
    const price = parsePrice(card.price), adPrices = card.ads.map(a => parsePrice(a.price));
    if (adPrices.some(a => a.deal !== price.deal || a.rent !== price.rent || a.priceMax !== null) || Math.min(...adPrices.map(a => a.price)) !== price.price || Math.max(...adPrices.map(a => a.price)) !== (price.priceMax ?? price.price)) fail('대표 호가와 개별 광고 호가가 다릅니다.');
    counts[price.deal]++;
    const dates = card.ads.map(a => { const d = a.confirmed.match(/확인매물\s*(\d{4})\.(\d{2})\.(\d{2})/); if (!d) fail('광고 확인일이 없습니다.'); return calendarDate(`${d[1]}-${d[2]}-${d[3]}`); }).sort();
    return { ...price, dong: name[1], type: area[1], area: Number(area[2]), floor: /^\d+$/.test(floor[1]) ? Number(floor[1]) : null,
      band: /^[고중저]$/.test(floor[1]) ? floor[1] : '', face, count, sourceIds: card.ads.map(a => a.id), agents: [], listed: dates.at(-1), last: dates.at(-1), first: dates[0] };
  });
  if (Object.entries(counts).some(([deal, n]) => totals.deals[deal] !== n)) fail('추출된 거래별 매물 수가 화면과 다릅니다.');
  return { schemaVersion: 2, complex: COMPLEX, scope: SCOPE, source: 'naver-dom-v1', date: kstDate(capturedAt), startedAt, capturedAt,
    // One continuous rendered list, not a claim about Naver's internal API pagination.
    quality: { complete: true, expectedUnique: totals.expectedUnique, expectedPostings, expectedPages: 1, pagesFetched: 1 }, listings };
}
