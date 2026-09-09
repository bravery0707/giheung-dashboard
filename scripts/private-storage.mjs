import { mkdir, realpath, open, unlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const PRIVATE_DATA = join(ROOT, '.private', 'listing-data');
const within = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
export async function privateDirectory(directory = PRIVATE_DATA) {
  const path = resolve(directory);
  if (within(ROOT, path) && !within(join(ROOT, '.private'), path)) throw new Error('매물 자료는 공개 저장소 경로에 저장할 수 없습니다. .private 폴더를 사용하세요.');
  await mkdir(path, { recursive: true });
  const actual = await realpath(path);
  const root = await realpath(ROOT);
  if (within(root, actual) && !within(join(root, '.private'), actual)) throw new Error('비공개 저장 경로가 공개 폴더를 가리킵니다.');
  return actual;
}
export async function withDataLock(directory, action) {
  directory = await privateDirectory(directory);
  const path = join(directory, 'collection.lock');
  let lock;
  try { lock = await open(path, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('다른 작업이 실행 중이거나 이전 작업의 잠금이 남아 있습니다.'), { code: 'LOCKED' });
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await action(directory);
  } finally {
    await lock.close();
    await unlink(path);
  }
}
