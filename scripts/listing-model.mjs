import { createHash } from 'node:crypto';

export const COMPLEX = '힐스테이트기흥';
export const SCOPE = 'hillstate-giheung:APT:all-deals:all-areas';
const text = value => String(value ?? '').trim();
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 16).toUpperCase();
const fail = message => { throw new Error(message); };
export function calendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('조사일은 실제 날짜 YYYY-MM-DD여야 합니다.');
  return value;
}
export function kstDate(value) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
function timestamp(value) {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail('수집 시각에는 시간대가 필요합니다.');
  calendarDate(value.slice(0, 10));
  return value;
}
function phoneFree(value) {
  return text(value).replace(/[(（]\s*0\d{1,2}\s*[)）][\s.\-]?\d{3,4}[\s.\-]?\d{4}/g, '')
    .replace(/0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g, '')
    .replace(/(?<!\d)\d{3,4}[-.]\d{4}(?!\d)/g, '').replace(/[()（）]/g, '').trim();
}
export function normalizeListing(item, index, source) {
  if (!item || typeof item !== 'object') fail('매물 형식이 잘못되었습니다.');
  const deal = text(item.deal);
  if (!['매매', '전세', '월세'].includes(deal)) fail('거래 종류가 잘못되었습니다.');
  if (!Number.isFinite(item.price) || item.price < 0 || !Number.isFinite(item.area) || item.area <= 0) fail('가격·면적은 유효한 숫자여야 합니다.');
  if (deal !== '월세' && item.price === 0) fail('매매·전세 가격은 0보다 커야 합니다.');
  if (item.priceMax != null && (!Number.isFinite(item.priceMax) || item.priceMax < item.price)) fail('최대 호가가 잘못되었습니다.');
  if (deal === '월세' && (!Number.isFinite(item.rent) || item.rent <= 0)) fail('월세 금액을 확인하세요.');
  if (item.floor != null && (!Number.isInteger(item.floor) || item.floor < 1 || item.floor > 100)) fail('실제 층이 잘못되었습니다.');
  if (!/^\d+$/.test(text(item.dong)) || !text(item.type)) fail('동·타입이 필요합니다.');
  const sourceIds = item.sourceIds ?? [];
  if (!Array.isArray(sourceIds) || sourceIds.some(id => typeof id !== 'string' || !id.trim())) fail('원본 광고 ID는 문자열 배열이어야 합니다.');
  if (new Set(sourceIds).size !== sourceIds.length) fail('중복 광고 ID가 있습니다.');
  const agents = (item.agents || []).map(a => ({ name: phoneFree(a.name || a.agent) })).filter(a => a.name);
  const count = item.count ?? (sourceIds.length || agents.length || 1);
  if (!Number.isInteger(count) || count < 1 || (sourceIds.length && sourceIds.length !== count)) fail('게시 건수와 광고 ID 수가 다릅니다.');
  // Allowlist only: no contact details, descriptions, cookies, tokens or arbitrary provider fields.
  return {
    id: `L${String(index + 1).padStart(3, '0')}`, dong: text(item.dong), deal,
    price: item.price, priceMax: item.priceMax ?? null, rent: deal === '월세' ? item.rent : 0,
    priceText: '', type: text(item.type), area: item.area,
    py: item.area < 79 ? 31 : item.area < 90 ? 36 : 41,
    floor: item.floor ?? null,
    band: item.floor != null ? (item.floor >= 34 ? '고' : item.floor >= 17 ? '중' : '저') : (['고','중','저'].includes(item.band) ? item.band : ''),
    face: text(item.face), listed: text(item.listed), first: text(item.first), last: text(item.last),
    source, sourceIds: sourceIds.slice().sort(), count, agents,
  };
}
export function validateEnvelope(input, { now = new Date(), live = false, acceptCountDrop = false, previous } = {}) {
  if (input?.schemaVersion !== 2 || input.complex !== COMPLEX || input.scope !== SCOPE) fail('단지·전체 수집 범위·스키마를 확인하세요.');
  if (typeof input.source !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.source)) fail('데이터 출처 ID가 필요합니다.');
  const date = calendarDate(input.date);
  if (date > kstDate(now)) fail('미래 조사일은 저장할 수 없습니다.');
  const capturedAt = input.capturedAt == null ? null : timestamp(input.capturedAt);
  const startedAt = input.startedAt == null ? capturedAt : timestamp(input.startedAt);
  if (capturedAt && kstDate(capturedAt) !== date) fail('조사일과 한국시간 수집일이 다릅니다.');
  if (startedAt && capturedAt && Date.parse(startedAt) > Date.parse(capturedAt)) fail('수집 시작·종료 시각을 확인하세요.');
  if (live) {
    if (!capturedAt || !startedAt) fail('자동 수집은 수집 시각이 필수입니다.');
    if (kstDate(startedAt) !== date || date !== kstDate(now) || Date.parse(capturedAt) > +now + 300000 || +now - Date.parse(capturedAt) > 6 * 3600000) fail('오늘 수집한 최신 데이터가 아닙니다.');
    if (previous?.capturedAt && Date.parse(capturedAt) <= Date.parse(previous.capturedAt)) fail('이전보다 오래되거나 같은 수집 결과입니다.');
  }
  const q = input.quality;
  if (q?.complete !== true || !Number.isInteger(q.expectedUnique) || q.expectedUnique < 0 || !Number.isInteger(q.expectedPostings) || q.expectedPostings < 0) fail('전체 수집 완료와 예상 건수가 필요합니다.');
  if (!Number.isInteger(q.expectedPages) || q.expectedPages < 1 || q.pagesFetched !== q.expectedPages) fail('일부 페이지가 누락되었습니다.');
  if (!Array.isArray(input.listings) || input.listings.length !== q.expectedUnique) fail('대표 매물 수가 원본 총계와 다릅니다.');
  const listings = input.listings.map((item, i) => normalizeListing(item, i, input.source));
  if (listings.reduce((sum, item) => sum + item.count, 0) !== q.expectedPostings) fail('중개소 게시 수가 원본 총계와 다릅니다.');
  const ids = listings.flatMap(item => item.sourceIds);
  if (new Set(ids).size !== ids.length) fail('여러 대표 매물에 같은 광고 ID가 중복되었습니다.');
  if (live && listings.some(item => !item.sourceIds.length)) fail('자동 수집에는 모든 광고의 원본 ID가 필요합니다.');
  if (!acceptCountDrop && previous?.unique > 0 && listings.length < previous.unique * 0.5) fail('매물 수가 절반 미만으로 급감했습니다. 전체 수집 여부를 확인한 뒤 수동 승인하세요.');
  return { date, capturedAt, startedAt, source: input.source, scope: SCOPE, quality: { complete: true, expectedUnique: q.expectedUnique, expectedPostings: q.expectedPostings, expectedPages: q.expectedPages, pagesFetched: q.pagesFetched }, listings };
}

const agentNames = item => new Set((item.agents || []).map(a => text(a.name || a.agent).replace(/\s/g, '')).filter(Boolean));
function compatible(a, b) {
  return a.deal === b.deal && a.dong === b.dong && a.type === b.type && a.area === b.area
    && !(a.floor != null && b.floor != null && a.floor !== b.floor)
    && !(a.band && b.band && a.band !== b.band) && !(a.face && b.face && a.face !== b.face);
}
function identity(a, b) {
  if (!compatible(a, b)) return '';
  if (a.source && a.source === b.source && (a.sourceIds || []).some(id => b.sourceIds?.includes(id))) return 'source-id';
  // Different advertisement IDs from the same provider are only a possible re-listing.
  // Keep them separate until a provider supplies a verified property identifier.
  if ((a.sourceIds?.length || 0) && (b.sourceIds?.length || 0)) return '';
  const oldAgents = agentNames(a);
  const common = [...agentNames(b)].filter(agent => oldAgents.has(agent)).length;
  if (!a.face || !b.face) return '';
  if (a.floor != null && a.floor === b.floor && common >= 1) return 'attributes';
  if (a.band && a.band === b.band && common >= 2) return 'attributes';
  return '';
}
function assignTracking(catalog, items, date, anchor) {
  const previous = [...catalog.values()];
  const candidates = items.map(item => {
    const matches = previous.map(p => ({ p, kind: identity(p, item) })).filter(x => x.kind);
    const exact = matches.filter(x => x.kind === 'source-id');
    return exact.length ? exact : matches;
  });
  const claimed = new Set();
  return items.map((item, index) => {
    const matches = candidates[index];
    const match = matches.length === 1 && candidates.filter(set => set.some(x => x.p.trackId === matches[0].p.trackId)).length === 1 ? matches[0] : null;
    let trackId = match?.p.trackId;
    if (!trackId && anchor && item.trackId && !claimed.has(item.trackId)) trackId = item.trackId;
    if (!trackId) trackId = `HG-${digest(JSON.stringify([date, item.source, item.sourceIds, item.deal, item.dong, item.type, item.floor, item.band, item.face, index]))}`;
    claimed.add(trackId);
    return { ...item, trackId, matchMethod: match?.kind || (matches.length ? 'ambiguous' : 'new'), firstSeen: match?.p.firstSeen || date, lastSeen: date };
  });
}
const median = values => {
  const a = values.slice().sort((x, y) => x - y), m = Math.floor(a.length / 2);
  return !a.length ? null : a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
function makeSnapshot(metadata, listings) {
  const sales = listings.filter(x => x.deal === '매매');
  return { ...metadata, unique: listings.length, postings: listings.reduce((n, x) => n + x.count, 0),
    counts: { total: listings.length, sale: sales.length, jeonse: listings.filter(x => x.deal === '전세').length, monthly: listings.filter(x => x.deal === '월세').length },
    medianSaleByArea: Object.fromEntries([...new Set(sales.map(x => x.area))].map(area => [area, median(sales.filter(x => x.area === area).map(x => x.price))])), listings };
}
function changeBetween(before, after, seen) {
  const oldMap = new Map(before.listings.map(x => [x.trackId, x]));
  const newIds = new Set(after.listings.map(x => x.trackId));
  const arrivals = after.listings.filter(x => !oldMap.has(x.trackId));
  const added = arrivals.filter(x => !seen.has(x.trackId));
  const reappeared = arrivals.filter(x => seen.has(x.trackId));
  const gone = before.listings.filter(x => !newIds.has(x.trackId));
  const priceChanges = after.listings.flatMap(item => {
    const old = oldMap.get(item.trackId);
    if (!old || old.price === item.price && old.priceMax === item.priceMax && old.rent === item.rent) return [];
    return [{ ...item, beforePrice: old.price, beforePriceMax: old.priceMax, beforeRent: old.rent, afterPrice: item.price, afterPriceMax: item.priceMax, afterRent: item.rent }];
  });
  return { from: before.date, to: after.date, summary: { before: before.unique, after: after.unique, new: added.length, gone: gone.length, reappeared: reappeared.length, priceChanges: priceChanges.length }, new: added, gone, reappeared, priceChanges };
}
export function mergeSnapshot(existing, incoming) {
  if (existing && (!Array.isArray(existing.snapshots) || existing.complex !== COMPLEX)) fail('기존 이력 파일이 손상되었거나 단지가 다릅니다.');
  const inputs = (existing?.snapshots || []).filter(s => s.date !== incoming.date).concat(incoming).sort((a, b) => a.date.localeCompare(b.date));
  if (inputs.some(s => s.quality?.complete === false || (s.scope && s.scope !== SCOPE))) fail('완전하지 않거나 범위가 다른 과거 스냅샷입니다.');
  const catalog = new Map(), seen = new Set(), snapshots = [], changes = [];
  for (const [index, snapshot] of inputs.entries()) {
    const listings = assignTracking(catalog, snapshot.listings, snapshot.date, index === 0);
    const next = makeSnapshot(snapshot, listings);
    if (index) changes.push(changeBetween(snapshots.at(-1), next, seen));
    for (const item of listings) {
      const old = catalog.get(item.trackId);
      const aliases = old?.source === item.source ? [...new Set([...(old.sourceIds || []), ...(item.sourceIds || [])])] : item.sourceIds;
      catalog.set(item.trackId, { ...item, sourceIds: aliases });
      seen.add(item.trackId);
    }
    snapshots.push(next);
  }
  const latest = snapshots.at(-1);
  return { history: { version: 2, updated: latest.date, complex: COMPLEX, snapshots, changes },
    listings: { updated: latest.date, source: latest.source || '네이버 부동산 엑셀', complex: COMPLEX, unique: latest.unique, postings: latest.postings, capturedAt: latest.capturedAt || null, listings: latest.listings } };
}
