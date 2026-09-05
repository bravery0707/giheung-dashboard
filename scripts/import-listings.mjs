#!/usr/bin/env node
/**
 * 네이버 부동산 엑셀 → data/listings.json + data/listing-history.json
 *
 *   node scripts/import-listings.mjs incoming/listings.xlsx
 *   node scripts/import-listings.mjs data/listings.json --bootstrap
 *
 * 엑셀의 대표 행과 ↳ 중개소 중복 게시를 한 매물로 묶는다. 이전 스냅샷과는
 * 동·거래·타입·층·향·중개소 겹침을 함께 비교해 신규/소멸 후보/가격변동을 기록한다.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const input = process.argv[2];
const bootstrap = process.argv.includes("--bootstrap");
if (!input) {
  console.error("사용법: node scripts/import-listings.mjs <xlsx|json> [--date YYYY-MM-DD]");
  process.exit(1);
}

const arg = (flag, fallback = "") => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const historyPath = new URL("../data/listing-history.json", import.meta.url);
const outputPath = new URL("../data/listings.json", import.meta.url);
const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
const unescapeXml = value => String(value ?? "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
const pyOf = area => area < 79 ? 31 : area < 90 ? 36 : 41;
const isoDate = value => {
  const m = clean(value).match(/^(?:(\d{4})|(\d{2}))[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (!m) return "";
  const year = m[1] || String(2000 + Number(m[2]));
  return `${year}-${String(m[3]).padStart(2, "0")}-${String(m[4]).padStart(2, "0")}`;
};
const shortDate = value => {
  const date = isoDate(value) || value;
  const m = String(date).match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1].slice(2)}.${m[2]}.${m[3]}` : clean(value);
};
const kstToday = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
/* 중개소 상호에서 전화번호만 지운다. 상호는 남긴다 —
   어느 사무소가 올렸는지는 중복 게시를 묶는 데 필요한 정보이기 때문이다.
   숫자를 무조건 지우면 "1번출구", "2차", "3단지" 같은 상호가 깨지므로
   '전화번호 모양'일 때만 지운다. GitHub Pages 는 저장소가 private 이어도
   항상 공개라, 여기서 거른 것이 곧 공개 웹에 안 올라가는 것이다. */
const phoneFree = value => clean(value)
  // (031) 284 1344 — 괄호가 지역번호만 감싼 형태
  .replace(/[(（]\s*0\d{1,2}\s*[)）][\s.\-]?\d{3,4}[\s.\-]?\d{4}/g, "")
  // (031-284-1344), (274-8945) — 괄호 안이 사실상 번호뿐
  .replace(/[(（][\s\d.\-‒–—~]{6,}[)）]/g, "")
  // 031-284-1344, 010.1234.5678, 0507 1234 5678
  .replace(/0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/g, "")
  // 274-8945, 1588-7777 — 국번만 남은 형태
  .replace(/(?<!\d)\d{3,4}[-.]\d{4}(?!\d)/g, "")
  .replace(/[(（]\s*[)）]/g, "")
  .replace(/\s{2,}/g, " ")
  .trim();

function unzipEntries(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("xlsx ZIP 구조를 읽지 못했습니다.");
  const entries = {};
  let count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(start, start + compressedSize);
    const content = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (content) entries[name] = new TextDecoder().decode(content);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function xlsxRows(buffer) {
  const files = unzipEntries(buffer);
  const shared = [];
  const stringsXml = files["xl/sharedStrings.xml"] || "";
  for (const item of stringsXml.match(/<si>[\s\S]*?<\/si>/g) || []) {
    const parts = [...item.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => unescapeXml(m[1]));
    shared.push(parts.join(""));
  }
  const sheetName = Object.keys(files).find(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  if (!sheetName) throw new Error("xlsx에서 워크시트를 찾지 못했습니다.");
  const xml = files[sheetName];
  const column = reference => {
    let n = 0;
    for (const ch of reference.replace(/\d+/g, "")) n = n * 26 + ch.charCodeAt(0) - 64;
    return n - 1;
  };
  return (xml.match(/<row[\s\S]*?<\/row>/g) || []).map(rowXml => {
    const row = [];
    for (const cellXml of rowXml.match(/<c[\s\S]*?(?:\/>|<\/c>)/g) || []) {
      const reference = (cellXml.match(/\br="([A-Z]+\d+)"/) || [])[1];
      if (!reference) continue;
      const type = (cellXml.match(/\bt="([^"]+)"/) || [])[1];
      let value = "";
      if (type === "inlineStr") {
        value = [...cellXml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => unescapeXml(m[1])).join("");
      } else {
        const raw = (cellXml.match(/<v[^>]*>([\s\S]*?)<\/v>/) || [])[1];
        if (raw != null) value = type === "s" ? shared[Number(raw)] ?? "" : unescapeXml(raw);
      }
      row[column(reference)] = value;
    }
    return Array.from(row, value => value == null ? "" : value);
  });
}

const HEADER = { "동": "dong", "매/전": "deal", "가격": "price", "면적": "area", "층": "floor",
  "향": "face", "정보": "info", "중개소": "agent", "에이전트": "provider", "등록일자": "date" };
function money(value) {
  const m = clean(value).match(/^\s*(?:(\d+)\s*억)?\s*([\d,]+)?\s*$/);
  if (!m || (!m[1] && !m[2])) return null;
  return (m[1] ? Number(m[1]) * 10000 : 0) + (m[2] ? Number(m[2].replace(/,/g, "")) : 0);
}
function parsePrice(text, deal) {
  const value = clean(text);
  if (value.includes("~")) {
    const [min, max] = value.split("~");
    return { price: money(min), priceMax: money(max), rent: 0 };
  }
  if (deal === "월세" && value.includes("/")) {
    const [deposit, rent] = value.split("/");
    return { price: money(deposit), priceMax: null, rent: Number(rent.replace(/[^\d]/g, "")) || 0 };
  }
  return { price: money(value), priceMax: null, rent: 0 };
}

function parseRows(rows) {
  const headerRow = rows.findIndex(row => row.some(value => /^(매\/전|가격)$/.test(clean(value))));
  if (headerRow < 0) throw new Error("머리글에서 ‘매/전’과 ‘가격’ 열을 찾지 못했습니다.");
  const indexes = {};
  rows[headerRow].forEach((value, i) => { if (HEADER[clean(value)]) indexes[HEADER[clean(value)]] = i; });
  const get = (row, key) => clean(row[indexes[key]] ?? "").replace(/^↳\s*/, "");
  const listings = [];
  let current = null;
  for (const row of rows.slice(headerRow + 1)) {
    const first = clean(row[indexes.dong ?? 0]);
    const child = first.startsWith("↳");
    const deal = get(row, "deal");
    const priceText = get(row, "price");
    if (!child) {
      if (!deal || !priceText) continue;
      const parsed = parsePrice(priceText, deal);
      if (parsed.price == null) continue;
      const areaMatch = get(row, "area").match(/^([\w-]+)\s*\/\s*([\d.]+)/);
      const type = areaMatch?.[1] || "";
      const area = Number(areaMatch?.[2] || 0);
      const floorText = get(row, "floor");
      const floorMatch = floorText.match(/^(\d+)\s*\//);
      const floor = floorMatch ? Number(floorMatch[1]) : null;
      const band = floor != null ? (floor >= 34 ? "고" : floor >= 17 ? "중" : "저")
        : (floorText.match(/^(고|중|저)/) || [""])[0];
      current = {
        id: `L${String(listings.length + 1).padStart(3, "0")}`,
        dong: get(row, "dong").replace(/[^\d]/g, ""), deal, priceText,
        ...parsed, type, area, py: area ? pyOf(area) : 0, floor, band,
        face: get(row, "face"), listed: shortDate(get(row, "date")), agents: [],
      };
      listings.push(current);
    } else if (current) {
      const agent = phoneFree(get(row, "agent"));
      current.agents.push({ agent, name: agent, memo: get(row, "info"),
        date: shortDate(get(row, "date")), provider: get(row, "provider") });
    }
  }
  if (!listings.length) throw new Error("엑셀에서 매물을 읽지 못했습니다.");
  for (const listing of listings) {
    const dates = listing.agents.map(item => item.date).filter(Boolean);
    listing.first = dates.length ? dates.reduce((a, b) => a < b ? a : b) : listing.listed;
    listing.last = dates.length ? dates.reduce((a, b) => a > b ? a : b) : listing.listed;
    listing.count = listing.agents.length || 1;
  }
  return listings;
}

const digest = value => createHash("sha1").update(value).digest("hex").slice(0, 10).toUpperCase();
const baseKey = item => [item.deal, item.dong, item.type, item.area, item.band, item.floor ?? "", item.face].join("|");
const agentSet = item => new Set((item.agents || []).map(agent => clean(agent.name || agent.agent).replace(/\s/g, "")).filter(Boolean));
function similarity(previous, current) {
  if (previous.deal !== current.deal || previous.dong !== current.dong || previous.type !== current.type) return -Infinity;
  let score = 5;
  if (previous.area === current.area) score += 2;
  if (previous.floor != null && current.floor != null && previous.floor === current.floor) score += 8;
  else if (previous.band && previous.band === current.band) score += 3;
  if (previous.face && previous.face === current.face) score += 2;
  const oldAgents = agentSet(previous);
  for (const agent of agentSet(current)) if (oldAgents.has(agent)) score += 4;
  const gap = Math.abs((previous.price || 0) - (current.price || 0));
  if (gap === 0) score += 3;
  else if (gap <= 5000) score += 1;
  return score;
}

function assignTracking(previous = [], current = []) {
  const unused = new Set(previous.map((_, index) => index));
  const usedIds = new Set(previous.map(item => item.trackId).filter(Boolean));
  const sorted = [...current].sort((a, b) => baseKey(a).localeCompare(baseKey(b)) || a.price - b.price);
  for (const item of sorted) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (const index of unused) {
      const score = similarity(previous[index], item);
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    }
    if (bestIndex >= 0 && bestScore >= 8) {
      item.trackId = previous[bestIndex].trackId;
      unused.delete(bestIndex);
    } else {
      const root = `HG-${digest(baseKey(item))}`;
      let id = root;
      let suffix = 2;
      while (usedIds.has(id)) id = `${root}-${suffix++}`;
      item.trackId = id;
      usedIds.add(id);
    }
  }
  return current;
}

const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};
function makeSnapshot(date, listings) {
  const sales = listings.filter(item => item.deal === "매매");
  const medians = {};
  for (const area of [...new Set(sales.map(item => item.area))]) medians[area] = median(sales.filter(item => item.area === area).map(item => item.price));
  return {
    date, unique: listings.length, postings: listings.reduce((sum, item) => sum + (item.count || 1), 0),
    counts: { total: listings.length, sale: sales.length,
      jeonse: listings.filter(item => item.deal === "전세").length,
      monthly: listings.filter(item => item.deal === "월세").length },
    medianSaleByArea: medians,
    listings: listings.map(item => ({
      id: item.id, trackId: item.trackId, dong: item.dong, deal: item.deal,
      priceText: item.priceText, price: item.price, priceMax: item.priceMax, rent: item.rent,
      type: item.type, area: item.area, py: item.py, floor: item.floor, band: item.band,
      face: item.face, listed: item.listed, first: item.first, last: item.last,
      count: item.count,
      agents: (item.agents || []).map(agent => ({ name: agent.name || agent.agent })).filter(agent => agent.name),
    })),
  };
}
function changeBetween(before, after) {
  const oldMap = new Map(before.listings.map(item => [item.trackId, item]));
  const newMap = new Map(after.listings.map(item => [item.trackId, item]));
  const added = after.listings.filter(item => !oldMap.has(item.trackId));
  const gone = before.listings.filter(item => !newMap.has(item.trackId));
  const priceChanges = after.listings.flatMap(item => {
    const old = oldMap.get(item.trackId);
    if (!old || old.price === item.price && old.priceMax === item.priceMax && old.rent === item.rent) return [];
    return [{ ...item, beforePrice: old.price, beforePriceMax: old.priceMax, beforeRent: old.rent,
      afterPrice: item.price, afterPriceMax: item.priceMax, afterRent: item.rent }];
  });
  return { from: before.date, to: after.date,
    summary: { before: before.unique, after: after.unique, new: added.length, gone: gone.length, priceChanges: priceChanges.length },
    new: added, gone, priceChanges };
}

async function readJsonSafe(url, fallback) {
  try { return JSON.parse(await readFile(url, "utf8")); } catch { return fallback; }
}

let listings;
if (/\.json$/i.test(input)) {
  const payload = JSON.parse(await readFile(input, "utf8"));
  listings = payload.listings || payload;
} else {
  listings = parseRows(xlsxRows(await readFile(input)));
}
if (!Array.isArray(listings) || !listings.length) throw new Error("매물 배열이 비어 있습니다.");

const existing = await readJsonSafe(historyPath, { version: 1, complex: "힐스테이트기흥", snapshots: [], changes: [] });
const inferredDate = listings.map(item => isoDate(item.last || item.listed)).filter(Boolean).sort().at(-1);
const date = arg("--date", inferredDate || kstToday());
let snapshots = (existing.snapshots || []).filter(snapshot => snapshot.date !== date).sort((a, b) => a.date.localeCompare(b.date));
const previous = snapshots.at(-1)?.listings || [];
assignTracking(previous, listings);
snapshots.push(makeSnapshot(date, listings));
snapshots = snapshots.sort((a, b) => a.date.localeCompare(b.date)).slice(-180);

// 같은 날짜를 교체했거나 과거 스냅샷을 넣어도 추적과 변화가 일관되도록 순서대로 다시 매칭한다.
for (let i = 0; i < snapshots.length; i++) {
  assignTracking(i ? snapshots[i - 1].listings : [], snapshots[i].listings);
  snapshots[i] = makeSnapshot(snapshots[i].date, snapshots[i].listings);
}
const changes = snapshots.slice(1).map((snapshot, index) => changeBetween(snapshots[index], snapshot));
const latest = snapshots.at(-1);
const listingsPayload = {
  updated: latest.date, source: "네이버 부동산 엑셀", complex: "힐스테이트기흥",
  unique: latest.unique, postings: latest.postings, listings: latest.listings,
};
const historyPayload = { version: 1, updated: latest.date, complex: "힐스테이트기흥", snapshots, changes };

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(outputPath, JSON.stringify(listingsPayload, null, 1) + "\n", "utf8");
await writeFile(historyPath, JSON.stringify(historyPayload, null, 1) + "\n", "utf8");
console.log(`data/listings.json — 고유 ${latest.unique}건 / 중개소 게시 ${latest.postings}건 (${latest.date})`);
console.log(`data/listing-history.json — 스냅샷 ${snapshots.length}회 / 변동 ${changes.length}구간`);
if (bootstrap) console.log("초기 스냅샷만 만들었습니다. 다음 날짜 엑셀부터 신규·소멸 후보·가격변동이 계산됩니다.");
