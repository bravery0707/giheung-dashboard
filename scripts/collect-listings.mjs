import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateEnvelope, mergeSnapshot, kstDate, calendarDate } from './listing-model.mjs';
import { readOptionalJson, writeJson, saveCollection, saveFailure } from './listing-storage.mjs';
import { ROOT, PRIVATE_DATA, withDataLock } from './private-storage.mjs';

const errorWith = (code, message) => Object.assign(new Error(message), { code });
const MAX_BYTES = 5 * 1024 * 1024;
export function checkSource(config, address, now = new Date()) {
  if (!config.enabled || config.permission?.collection !== true || !config.permission?.reference?.trim()) throw new Error('사용할 데이터 수집 경로와 이용 근거가 아직 설정되지 않았습니다.');
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== config.allowedOrigin || url.hash) throw new Error('허용된 HTTPS 제공처 주소를 설정하세요.');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(config.source || '')) throw new Error('제공처 식별자가 필요합니다.');
  const start = calendarDate(config.trial?.startDate);
  if (!Number.isInteger(config.trial.days) || config.trial.days < 1 || config.trial.days > 14) throw new Error('시험 기간은 1~14일입니다.');
  const offset = (Date.parse(kstDate(now)) - Date.parse(start)) / 86400000;
  if (offset < 0 || offset >= config.trial.days) throw new Error('시험 수집 기간 밖입니다. 결과 검토 후 일정을 설정하세요.');
  return url;
}
async function readGuard(directory) {
  const state = await readOptionalJson(join(directory, 'request-state.json'), { version: 1, lastAttemptDate: null, halted: false });
  if (state.version !== 1 || typeof state.halted !== 'boolean' || (state.lastAttemptDate !== null && calendarDate(state.lastAttemptDate) !== state.lastAttemptDate)) throw new Error('요청 제한 기록을 확인할 수 없습니다. 수집을 중단합니다.');
  return state;
}
export async function resumeCollection(directory, reason) {
  if (!reason?.trim()) throw new Error('접근 문제를 해결한 내용을 --reason으로 기록하세요.');
  return withDataLock(directory, async dir => {
    const state = await readGuard(dir);
    // Resuming never refunds today's request or restarts the trial.
    await writeJson(join(dir, 'request-state.json'), { ...state, halted: false, reason: null, resumedAt: new Date().toISOString(), resumeNote: reason.trim().slice(0, 300) });
  });
}
export async function collect({ config, address, token, directory = PRIVATE_DATA, fetchImpl = fetch, now = new Date(), timeoutMs = 30000 }) {
  const url = checkSource(config, address, now);
  return withDataLock(directory, async dir => {
    const guardPath = join(dir, 'request-state.json');
    const state = await readGuard(dir);
    if (state.halted) throw errorWith('PAUSED', '접근 거부로 수집이 중지되어 있습니다. 원인 해결 후 수동으로 재개하세요.');
    const today = kstDate(now);
    if (state.lastAttemptDate && state.lastAttemptDate >= today) throw errorWith('DAILY_LIMIT', '오늘의 요청을 이미 사용했습니다. 자동 재시도하지 않습니다.');
    // Persist before the request: errors, process exits and restarts consume the attempt.
    const reserved = { ...state, lastAttemptDate: today, attemptedAt: now.toISOString() };
    await writeJson(guardPath, reserved);
    try {
      const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(Math.min(30000, timeoutMs)),
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
      if ([401, 403, 429].includes(response.status) || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel();
        throw errorWith('ACCESS_DENIED', '접근 거부·요청 제한·리디렉션 응답으로 자동 수집을 중지했습니다.');
      }
      if (!response.ok) { await response.body?.cancel(); throw errorWith('HTTP_ERROR', '제공처가 정상 응답하지 않았습니다.'); }
      if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        await response.body?.cancel();
        throw errorWith('UNEXPECTED_CONTENT', '로그인·보안 확인 화면 또는 예상하지 않은 응답입니다.');
      }
      if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw errorWith('TOO_LARGE', '허용 응답 크기를 초과했습니다.'); }
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > MAX_BYTES) throw errorWith('TOO_LARGE', '허용 응답 크기를 초과했습니다.');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      if (/^\s*</.test(body)) throw errorWith('UNEXPECTED_CONTENT', 'JSON 대신 HTML 화면이 응답되었습니다.');
      const input = JSON.parse(body);
      if (input.source !== config.source) throw new Error('제공처 식별자가 다릅니다.');
      const history = await readOptionalJson(join(dir, 'listing-history.json'), null);
      const snapshot = validateEnvelope(input, { live: true, now, previous: history?.snapshots?.at(-1) });
      const result = mergeSnapshot(history, snapshot);
      await saveCollection(dir, result, now.toISOString());
      return result;
    } catch (error) {
      const halted = ['ACCESS_DENIED', 'UNEXPECTED_CONTENT'].includes(error.code);
      if (halted) await writeJson(guardPath, { ...reserved, halted: true, reason: error.code });
      await saveFailure(dir, halted ? 'paused' : 'failed');
      throw error;
    }
  });
}
async function main() {
  if (process.env.CI) throw new Error('매물 수집은 이 PC에서만 실행합니다.');
  const directory = resolve(process.env.LISTING_DATA_DIR || PRIVATE_DATA);
  if (process.argv.includes('--resume')) {
    const i = process.argv.indexOf('--reason');
    await resumeCollection(directory, i < 0 ? '' : process.argv[i + 1]);
    console.log('중지 상태를 해제했습니다. 일일 요청 제한과 시험 기간은 유지됩니다.');
    return;
  }
  const config = JSON.parse(await readFile(process.env.LISTING_CONFIG || join(ROOT, 'config/listing-source.json'), 'utf8'));
  if (process.argv.includes('--check')) {
    try { checkSource(config, process.env.LISTING_FEED_URL); console.log('ready=true'); }
    catch { console.log('ready=false'); }
    return;
  }
  const result = await collect({ config, address: process.env.LISTING_FEED_URL, token: process.env.LISTING_FEED_TOKEN, directory });
  console.log(`매물 수집 완료: ${result.listings.updated}, 대표 ${result.listings.unique}건, 게시 ${result.listings.postings}건`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    console.error(['DAILY_LIMIT', 'PAUSED', 'LOCKED'].includes(error.code) ? error.message : '수집을 중단했습니다. 비공개 설정과 수집 상태를 확인하세요. 기존 정상 자료는 유지됩니다.');
    process.exitCode = 1;
  }
}
