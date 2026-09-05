import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { validateEnvelope, mergeSnapshot, kstDate, calendarDate } from './listing-model.mjs';
import { readOptionalJson, saveCollection, saveFailure } from './listing-storage.mjs';

export function checkSource(config, address, now = new Date()) {
  if (!config.enabled || config.permission?.collection !== true || config.permission?.publicRedistribution !== true || !config.permission?.reference?.trim()) throw new Error('데이터 수집·공개 허용 근거가 아직 설정되지 않았습니다.');
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== config.allowedOrigin || url.hash) throw new Error('허용된 HTTPS 제공처 주소를 설정하세요.');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(config.source || '')) throw new Error('제공처 식별자가 필요합니다.');
  const start = calendarDate(config.trial?.startDate);
  if (!Number.isInteger(config.trial.days) || config.trial.days < 1 || config.trial.days > 14) throw new Error('시험 기간은 1~14일입니다.');
  const offset = (Date.parse(kstDate(now)) - Date.parse(start)) / 86400000;
  if (offset < 0 || offset >= config.trial.days) throw new Error('시험 수집 기간 밖입니다. 결과 검토 후 일정을 설정하세요.');
  return url;
}
export async function collect({ config, address, token, directory, fetchImpl = fetch, now = new Date() }) {
  const url = checkSource(config, address, now);
  const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (!response.ok) throw new Error(`제공처 응답 오류 (${response.status}).`);
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('JSON 형식의 응답이 아닙니다.');
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 5 * 1024 * 1024) throw new Error('허용 응답 크기를 초과했습니다.');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (input.source !== config.source) throw new Error('제공처 식별자가 다릅니다.');
  const history = await readOptionalJson(join(directory, 'listing-history.json'), null);
  const previous = history?.snapshots?.at(-1);
  const snapshot = validateEnvelope(input, { live: true, now, previous });
  const result = mergeSnapshot(history, snapshot);
  await saveCollection(directory, result, now.toISOString());
  return result;
}
async function main() {
  const root = new URL('../', import.meta.url);
  const directory = resolve(process.env.LISTING_DATA_DIR || fileURLToPath(new URL('data/', root)));
  if (process.argv.includes('--check')) {
    try {
      const config = JSON.parse(await readFile(new URL('config/listing-source.json', root), 'utf8'));
      checkSource(config, process.env.LISTING_FEED_URL);
      console.log('ready=true');
    } catch { console.log('ready=false'); }
    return;
  }
  try {
    const config = JSON.parse(await readFile(new URL('config/listing-source.json', root), 'utf8'));
    const result = await collect({ config, address: process.env.LISTING_FEED_URL, token: process.env.LISTING_FEED_TOKEN, directory });
    console.log(`매물 수집 완료: ${result.listings.updated}, 대표 ${result.listings.unique}건, 게시 ${result.listings.postings}건`);
  } catch {
    await saveFailure(directory);
    console.error('매물 갱신을 중단했습니다. 제공처 설정, 수집 시각, 전체 건수와 수집 완료 여부를 확인하세요. 기존 매물 데이터는 유지됩니다.');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
