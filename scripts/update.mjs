#!/usr/bin/env node
/**
 * 국토교통부 실거래가 → data/transactions.json
 *
 *   export DATA_GO_KR_KEY="발급받은 디코딩 키"
 *   node scripts/update.mjs --months 36
 *
 * 활용신청이 필요한 API (인증키는 계정당 하나, API마다 '활용신청'만 추가하면 된다)
 *   ① 아파트 매매 실거래가 상세 자료  https://www.data.go.kr/data/15126468/openapi.do  (선택, 동·등기일자 포함)
 *   ② 아파트 매매 실거래가 자료       https://www.data.go.kr/data/15126469/openapi.do  (필수, ①이 없으면 자동 사용)
 *   ③ 아파트 전월세 실거래가 자료     https://www.data.go.kr/data/15126474/openapi.do  (전세·월세 분석용)
 *
 * 신청하지 않은 API는 자동으로 건너뛰고, 어떤 소스를 썼는지 로그와 JSON에 남긴다.
 *
 * 브라우저에서 직접 부르지 않는 이유: apis.data.go.kr 이 CORS 헤더를 주지 않아
 * GitHub Pages 같은 정적 호스팅에서는 fetch 가 차단된다. 수집은 여기서, 페이지는 JSON만 읽는다.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { setDefaultResultOrder } from "node:dns";
import { XMLParser } from "./tiny-xml.mjs";

setDefaultResultOrder("ipv4first");

let KEY = (process.env.DATA_GO_KR_KEY || "").trim();
if (!KEY) {
  console.error("DATA_GO_KR_KEY 환경변수가 없습니다. 공공데이터포털의 '일반 인증키(Decoding)'를 넣어주세요.");
  process.exit(1);
}
/* 포털은 Encoding 키와 Decoding 키를 함께 준다.
   URLSearchParams가 다시 인코딩하므로 Encoding 키를 그대로 쓰면 %252B 처럼 이중 인코딩돼 인증이 실패한다.
   %2B/%2F/%3D 가 보이면 Encoding 키로 보고 한 번 디코딩해서 맞춰준다. */
if (/%[0-9A-Fa-f]{2}/.test(KEY)) {
  const dec = decodeURIComponent(KEY);
  if (dec !== KEY) { KEY = dec; console.log("· Encoding 키로 보여 자동으로 디코딩했습니다."); }
}

const LAWD_CD  = process.env.LAWD_CD  || "41463";           // 용인시 기흥구
const APT_NAME = process.env.APT_NAME || "힐스테이트기흥";   // 신고 원문 표기(공백 없음)
const MONTHS   = Number(argv("--months", 24));
const CHECK    = process.argv.includes("--check");   // API 3종 등록 여부만 점검

const BASE = process.env.DATA_GO_KR_BASE || "https://apis.data.go.kr/1613000";  // 테스트용 오버라이드
const SOURCES = [
  { key: "tradeDev", kind: "매매",  label: "아파트 매매 실거래가 상세 자료", dataId: "15126468",
    url: `${BASE}/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev`, optional: true, group: "trade" },
  { key: "trade",    kind: "매매",  label: "아파트 매매 실거래가 자료",      dataId: "15126469",
    url: `${BASE}/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade`,       optional: true, group: "trade" },
  { key: "rent",     kind: "전월세", label: "아파트 전월세 실거래가 자료",    dataId: "15126474",
    url: `${BASE}/RTMSDataSvcAptRent/getRTMSDataSvcAptRent`,         optional: true, group: "rent" },
];

function argv(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => Number(String(v ?? "").replace(/[^\d.-]/g, "")) || 0;
// 힐스테이트 기흥 실제 전용면적: 104형 72㎡ / 120·121형 84.95㎡ / 137형 95.9㎡
const pyOf = a => (a < 79 ? 31 : a < 90 ? 36 : 41);
const norm = s => String(s).replace(/\s|·|\(.*?\)/g, "");

function monthList(n) {
  const out = [], d = new Date();
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

/** 인증되지 않은 서비스인지 판별 (활용신청 안 한 API) */
const NOT_REGISTERED = /SERVICE_KEY_IS_NOT_REGISTERED|등록되지\s*않은|NOT_REGISTERED_ERROR|SERVICE ACCESS DENIED/i;

function requestText(url) {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, {
      family: 4,
      signal: AbortSignal.timeout(60_000),
      headers: {
        accept: "application/xml",
        "user-agent": "giheung-dashboard/1.0",
      },
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        body += chunk;
      });
      res.on("end", () => resolve({
        ok: (res.statusCode || 0) >= 200 &&
            (res.statusCode || 0) < 300,
        status: res.statusCode || 0,
        text: body,
      }));
    });

    req.on("error", reject);
  });
}

async function call(src, ym) {
  const qs = new URLSearchParams({
    serviceKey: KEY,
    LAWD_CD,
    DEAL_YMD: ym,
    pageNo: "1",
    numOfRows: "1000",
  });

  const res = await requestText(`${src.url}?${qs}`);
  const text = res.text;

  if (NOT_REGISTERED.test(text)) {
    const e = new Error("not_registered");
    e.notRegistered = true;
    throw e;
  }

  if (!res.ok ||
      /SERVICE ERROR|LIMITED_NUMBER|OpenAPI_ServiceResponse/.test(text)) {
    const code =
      (text.match(/<returnReasonCode>(.*?)<\/returnReasonCode>/) || [])[1];
    const msg =
      (text.match(/<(?:returnAuthMsg|errMsg|resultMsg)>(.*?)<\//) || [])[1];

    throw new Error(`${code || res.status} ${msg || ""}`.trim());
  }

  return XMLParser(text);
}

async function fetchMonth(src, ym, attempt = 0) {
  let items;
  try { items = await call(src, ym); }
  catch (e) {
    if (e.notRegistered) throw e;
    if (attempt < 3) { await sleep(1500 * (attempt + 1)); return fetchMonth(src, ym, attempt + 1); }
    throw new Error(`${src.kind} ${ym} 실패 — ${e.message}`);
  }
  return items.map(it => {
    const area = num(it.excluUseAr);
    const date = `${num(it.dealYear)}-${String(num(it.dealMonth)).padStart(2, "0")}-${String(num(it.dealDay)).padStart(2, "0")}`;
    const base = {
      date, area: +area.toFixed(2), py: pyOf(area),
      floor: num(it.floor), apt: (it.aptNm || "").trim(),
      dong: (it.aptDong || "").trim() || undefined,      // 상세 자료에만 있음
      jibun: (it.jibun || "").trim(), umd: (it.umdNm || "").trim(),
    };
    if (src.group === "trade") {
      return { ...base, deal: "매매", amount: num(it.dealAmount), src: `국토부 ${src.key === "tradeDev" ? "매매 상세" : "매매"}`,
               canceled: (it.cdealType || "").trim() === "O" };
    }
    const rent = num(it.monthlyRent);
    return { ...base, deal: rent > 0 ? "월세" : "전세", amount: num(it.deposit), rent,
             src: "국토부 전월세", contractType: (it.contractType || "").trim() };
  });
}

/** --check: 최근 1개월로 API 3종의 활용신청 상태만 확인 */
async function checkOnly() {
  const ym = monthList(1)[0];
  console.log(`인증키 점검 — ${ym} 기준, 지역코드 ${LAWD_CD}\n`);
  let ok = 0;
  for (const src of SOURCES) {
    try {
      const rows = await fetchMonth(src, ym);
      const mine = rows.filter(r => norm(r.apt).includes(norm(APT_NAME)));
      console.log(`  ✅ ${src.label}  —  ${ym} 전체 ${rows.length}건 / ${APT_NAME} ${mine.length}건`);
      ok++;
    } catch (e) {
      if (e.notRegistered)
        console.log(`  ❌ ${src.label}  —  활용신청 안 됨 (data.go.kr/data/${src.dataId}/openapi.do)`);
      else
        console.log(`  ⚠️  ${src.label}  —  ${e.message}`);
    }
    await sleep(150);
  }
  console.log(`\n${ok}/${SOURCES.length}개 정상. 3개 모두 ✅ 면 'node scripts/update.mjs --months 36' 으로 수집하세요.`);
  if (!ok) {
    console.log("하나도 안 되면 키를 다시 확인하세요 — 마이페이지의 '일반 인증키(Decoding)' 값이어야 하고,");
    console.log("신청 직후에는 반영까지 몇 분에서 최대 1시간이 걸릴 수 있습니다.");
    process.exit(1);
  }
  process.exit(0);
}

(async () => {
  if (CHECK) return checkOnly();
  const months = monthList(MONTHS);
  const all = [];
  const used = [], skipped = [], problems = [];
  const doneGroups = new Set();

  for (const src of SOURCES) {
    if (doneGroups.has(src.group)) continue;   // 매매는 상세가 되면 기본은 건너뜀
    let registered = true, got = 0;
    for (const ym of months) {
      try {
        const rows = await fetchMonth(src, ym);
        const mine = rows.filter(r => norm(r.apt).includes(norm(APT_NAME)));
        all.push(...mine); got += mine.length;
        process.stdout.write(`${src.key} ${ym}: ${mine.length}/${rows.length}\n`);
      } catch (e) {
        if (e.notRegistered) {
          registered = false;
          console.log(`· ${src.label} — 활용신청이 안 되어 있어 건너뜁니다 (data.go.kr/data/${src.dataId}/openapi.do)`);
          skipped.push(src.label);
          break;
        }
        problems.push(e.message);
        process.stdout.write(`${e.message}\n`);
      }
      await sleep(120); // 포털 초당 호출 제한 여유
    }
    if (registered) { used.push(src.label); doneGroups.add(src.group); console.log(`· ${src.label} — ${got}건`); }
  }

  const seen = new Set();
  const rows = all
    .filter(r => !r.canceled && r.amount > 0)
    .filter(r => {
      const k = [r.date, r.deal, r.area, r.floor, r.amount].join("|");
      if (seen.has(k)) return false;
      seen.add(k); return true;
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  if (!rows.length) {
    console.error("\n수집된 거래가 0건입니다. 인증키 또는 APT_NAME 표기를 확인하세요.");
    if (problems.length) console.error(problems.slice(0, 5).join("\n"));
    process.exit(2);
  }

  const payload = {
    updated: new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC",
    source: "국토교통부 실거래가 (공공데이터포털 OpenAPI)",
    apisUsed: used, apisSkipped: skipped,
    lawdCd: LAWD_CD, apt: APT_NAME, months: MONTHS,
    count: rows.length,
    transactions: rows,
  };

  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(new URL("../data/transactions.json", import.meta.url),
                  JSON.stringify(payload, null, 1) + "\n", "utf8");

  const sale = rows.filter(r => r.deal === "매매").length;
  console.log(`\ndata/transactions.json — ${rows.length}건 (매매 ${sale} / 전월세 ${rows.length - sale})`);
  if (skipped.length) console.log(`※ 미신청 API: ${skipped.join(", ")} — 신청하면 다음 실행부터 자동 포함됩니다.`);
})();
