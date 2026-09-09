import { readFile, writeFile, mkdir, rm, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './private-storage.mjs';

export const PUBLIC_DATA = {
  'listings.json': { visibility: 'private', updated: null, listings: [] },
  'listing-history.json': { visibility: 'private', snapshots: [], changes: [] },
  'collection-status.json': { status: 'private' },
  'site-mode.json': { mode: 'public' },
};
export const STATIC_FILES = ['index.html', 'assets/app.js', 'assets/styles.css', 'assets/listing-history.mjs', 'data/transactions.json'];

export async function readStatic(root, path) {
  const expected = resolve(root, path);
  if (await realpath(expected) !== expected) throw new Error('배포 파일에 심볼릭 링크를 사용할 수 없습니다.');
  return readFile(expected);
}
export async function assertPublicData(root = ROOT) {
  for (const [name, expected] of Object.entries(PUBLIC_DATA)) {
    const actual = JSON.parse(await readStatic(root, `data/${name}`));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`공개 데이터 검사가 실패했습니다: ${name}. 매물 원본을 .private 폴더로 옮기세요.`);
  }
  const { readdir } = await import('node:fs/promises');
  for (const name of await readdir(join(root, 'incoming'))) {
    if (name !== 'README.md') throw new Error('incoming 폴더에 원본 자료가 있습니다. 공개 배포를 중단합니다.');
  }
}
export async function buildPublic(root = ROOT) {
  root = await realpath(root);
  await assertPublicData(root);
  // The only removable target is this repository's resolved _site directory.
  const out = join(root, '_site');
  try {
    const info = await lstat(out);
    if (info.isSymbolicLink() || await realpath(out) !== out) throw new Error('배포 경로가 올바르지 않습니다.');
    await rm(out, { recursive: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const file of STATIC_FILES) {
    const path = join(out, file);
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, await readStatic(root, file));
  }
  for (const [name, data] of Object.entries(PUBLIC_DATA)) await writeFile(join(out, 'data', name), JSON.stringify(data) + '\n');
  await writeFile(join(out, '.nojekyll'), '');
  return out;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--check')) { await assertPublicData(); console.log('공개 데이터 검사 통과'); }
  else { await buildPublic(); console.log('공개 실거래 대시보드 생성 완료: _site'); }
}
