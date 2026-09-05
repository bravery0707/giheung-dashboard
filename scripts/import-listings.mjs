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
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateEnvelope, mergeSnapshot, COMPLEX, SCOPE } from "./listing-model.mjs";
import { readOptionalJson, saveCollection, saveFailure } from "./listing-storage.mjs";
import { readFile } from "node:fs/promises";
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

// Legacy files have no trustworthy collection timestamp. Require an explicit survey date.
const directory = resolve(arg("--data-dir", fileURLToPath(new URL("../data/", import.meta.url))));
try {
  const history = await readOptionalJson(join(directory, "listing-history.json"), null);
  let payload;
  if (/\.json$/i.test(input)) payload = JSON.parse(await readFile(input, "utf8"));
  else payload = { listings: parseRows(xlsxRows(await readFile(input))) };
  if (payload.schemaVersion !== 2) {
    const date = arg("--date", bootstrap ? payload.updated || "" : "");
    if (!date) throw new Error("엑셀·구형 JSON에는 --date YYYY-MM-DD로 실제 조사일을 지정해야 합니다.");
    const listings = Array.isArray(payload) ? payload : payload.listings;
    if (!Array.isArray(listings) || !listings.length) throw new Error("구형 파일에서 유효한 매물을 읽지 못했습니다.");
    payload = { schemaVersion: 2, complex: COMPLEX, scope: SCOPE, source: "legacy-excel",
      date, capturedAt: null, quality: { complete: true, expectedPages: 1, pagesFetched: 1,
        expectedUnique: listings.length, expectedPostings: listings.reduce((n, x) => n + (x.count || 1), 0) }, listings };
  } else if (arg("--date") && arg("--date") !== payload.date) {
    throw new Error("입력 JSON 조사일과 --date가 다릅니다.");
  }
  const previous = history?.snapshots?.filter(s => s.date < payload.date).at(-1);
  const sameDate = history?.snapshots?.find(s => s.date === payload.date);
  if (sameDate && !process.argv.includes("--replace-date")) throw new Error("같은 조사일이 이미 있습니다. 교체하려면 --replace-date를 지정하세요.");
  const snapshot = validateEnvelope(payload, { previous, acceptCountDrop: process.argv.includes("--accept-count-drop") });
  const result = mergeSnapshot(history, snapshot);
  await saveCollection(directory, result);
  console.log(`매물 ${result.listings.unique}건 / 게시 ${result.listings.postings}건 / 조사 ${result.listings.updated}`);
  console.log(`스냅샷 ${result.history.snapshots.length}회 / 변동 ${result.history.changes.length}구간`);
} catch (error) {
  await saveFailure(directory);
  console.error(error.message);
  process.exitCode = 1;
}
