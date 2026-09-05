import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function readOptionalJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function writeJson(path, data) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 1) + '\n', 'utf8');
  await rename(temporary, path);
}
export async function saveCollection(directory, result, checkedAt = new Date().toISOString()) {
  await mkdir(directory, { recursive: true });
  await writeJson(join(directory, 'listing-history.json'), result.history);
  await writeJson(join(directory, 'listings.json'), result.listings);
  await writeJson(join(directory, 'collection-status.json'), {
    status: 'success', checkedAt, lastSuccessDate: result.listings.updated,
    capturedAt: result.listings.capturedAt, unique: result.listings.unique, postings: result.listings.postings,
  });
}
export async function saveFailure(directory, status = 'failed') {
  await mkdir(directory, { recursive: true });
  const latest = await readOptionalJson(join(directory, 'listings.json'), {});
  // Do not publish URLs, tokens, raw HTTP bodies or supplier error text.
  await writeJson(join(directory, 'collection-status.json'), {
    status, checkedAt: new Date().toISOString(), lastSuccessDate: latest.updated || null,
    capturedAt: latest.capturedAt || null,
  });
}
