import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, PRIVATE_DATA, privateDirectory } from './private-storage.mjs';
import { PUBLIC_DATA, STATIC_FILES, readStatic } from './build-public.mjs';
import { readOptionalJson } from './listing-storage.mjs';
import { collect, checkSource } from './collect-listings.mjs';
import { kstDate } from './listing-model.mjs';

export function dueAt(now, time = '21:10') {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('예약 시각은 HH:MM 형식입니다.');
  const local = new Date(now.getTime() + 9 * 3600000).toISOString().slice(11, 16);
  return local >= time;
}
export function startScheduler(run, { time = '21:10', clock = () => new Date(), intervalMs = 30000 } = {}) {
  let busy = false;
  let attemptedDate;
  const tick = async () => {
    const now = clock();
    if (busy || !dueAt(now, time) || attemptedDate === kstDate(now)) return;
    attemptedDate = kstDate(now);
    busy = true;
    try { await run(now); }
    catch { /* A failed attempt is never retried today. The collector persists its status. */ }
    finally { busy = false; }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  return { tick, stop: () => clearInterval(timer) };
}
export async function createDashboard({ root = ROOT, directory = PRIVATE_DATA, mode = 'private', port = 8787 } = {}) {
  if (!['private', 'public'].includes(mode)) throw new Error('잘못된 실행 모드');
  if (mode === 'private') directory = await privateDirectory(directory);
  const server = createServer(async (req, res) => {
    const expectedHost = `127.0.0.1:${server.address().port}`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'");
    if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`) || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403); res.end('접근할 수 없습니다.'); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    try {
      const url = new URL(req.url, `http://${expectedHost}`);
      const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      let body;
      if (path === 'data/site-mode.json') body = JSON.stringify({ mode });
      else if (path.startsWith('data/') && Object.hasOwn(PUBLIC_DATA, path.slice(5))) {
        const name = path.slice(5);
        const fallback = name === 'collection-status.json' ? { status: 'pending' } : PUBLIC_DATA[name];
        body = JSON.stringify(mode === 'private' ? await readOptionalJson(join(directory, name), fallback) : PUBLIC_DATA[name]);
      } else if (STATIC_FILES.includes(path)) body = await readStatic(root, path);
      else { res.writeHead(404); res.end(); return; }
      const ext = path.split('.').at(-1);
      res.setHeader('Content-Type', ({ html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json' })[ext] + '; charset=utf-8');
      res.writeHead(200);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(500); res.end('저장된 자료를 읽지 못했습니다.'); }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); });
  return server;
}
async function main() {
  const mode = process.argv.includes('--public') ? 'public' : 'private';
  const directory = resolve(process.env.LISTING_DATA_DIR || PRIVATE_DATA);
  let scheduler;
  // No collection merely from opening or refreshing the dashboard.
  if (process.argv.includes('--schedule')) {
    if (mode !== 'private' || process.env.CI) throw new Error('예약 수집은 개인 PC의 비공개 모드에서만 가능합니다.');
    const config = JSON.parse(await readFile(process.env.LISTING_CONFIG || join(ROOT, 'config/listing-source.json'), 'utf8'));
    checkSource(config, process.env.LISTING_FEED_URL);
    scheduler = startScheduler(now => collect({ config, address: process.env.LISTING_FEED_URL, token: process.env.LISTING_FEED_TOKEN, directory, now }));
  }
  const server = await createDashboard({ mode, directory, port: Number(process.env.PORT || 8787) });
  console.log(`개인 PC 대시보드: http://127.0.0.1:${server.address().port}/#listings (${mode})`);
  if (scheduler) { console.log('한국시간 21:10 이후 하루 1회. PC와 이 프로그램이 켜져 있어야 합니다.'); await scheduler.tick(); }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { scheduler?.stop(); server.close(); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
