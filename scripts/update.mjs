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
import { writeFile, readFile, mkdir } from "node:fs/promises";
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

/* ── 실패 폭주 방지 ────────────────────────────────────────────────
   예약 실행이 4시간 59분 돌다가 죽은 적이 있다. 원인은 단순하다.
   포털이 새벽에 응답을 안 주면 요청마다 60초 타임아웃 → 4회 시도 →
   36개월 × 2개 API = 4.98시간. 재시도 로직이 장애를 5시간짜리 작업으로 키운 것이다.
   그래서 세 겹으로 막는다: 짧은 요청 타임아웃, 연속 실패 시 그 소스 포기, 전체 데드라인. */
const REQ_TIMEOUT_MS   = Number(process.env.REQ_TIMEOUT_MS || 20_000);
const MAX_ATTEMPTS     = 3;    // 최초 1 + 재시도 2
const FAIL_STREAK_STOP = 4;    // 연속 실패가 이만큼이면 그 API는 포기
const DEADLINE_MIN     = Number(argv("--deadline", 15));
const startedAt        = Date.now();
const outOfTime        = () => (Date.now() - startedAt) > DEADLINE_MIN * 60_000;

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
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
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
    // 데드라인이 지났으면 재시도하지 않는다 — 재시도가 장애를 몇 시간짜리로 키우는 걸 막는다.
    if (attempt < MAX_ATTEMPTS - 1 && !outOfTime()) {
      await sleep(1200 * (attempt + 1));
      return fetchMonth(src, ym, attempt + 1);
    }
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
    let registered = true, got = 0, failStreak = 0;
    for (const ym of months) {
      if (outOfTime()) {
        const msg = `· ${src.label} — ${DEADLINE_MIN}분 데드라인 도달, 남은 달은 건너뜁니다 (${ym}부터)`;
        console.log(msg); problems.push(msg);
        break;
      }
      try {
        const rows = await fetchMonth(src, ym);
        const mine = rows.filter(r => norm(r.apt).includes(norm(APT_NAME)));
        all.push(...mine); got += mine.length;
        failStreak = 0;
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
        // 연속으로 계속 실패하면 포털 장애로 보고 이 소스는 포기한다.
        if (++failStreak >= FAIL_STREAK_STOP) {
          const msg = `· ${src.label} — 연속 ${failStreak}회 실패, 포털 장애로 보고 중단합니다`;
          console.log(msg); problems.push(msg);
          break;
        }
      }
      await sleep(120); // 포털 초당 호출 제한 여유
    }
    // 0건이면 대체 소스를 막지 않는다. 상세 자료가 포털 장애로 못 가져왔을 때
    // 기본 매매 자료로 넘어갈 수 있어야 한다.
    if (registered) {
      used.push(src.label);
      if (got > 0) doneGroups.add(src.group);
      console.log(`· ${src.label} — ${got}건`);
    }
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
    /* 0건이라고 무조건 실패로 끝내지 않는다.
       새벽 포털 장애로 한 번 못 받아온 것과, 인증키가 죽은 것은 대응이 다르다.
       기존 data/transactions.json 이 멀쩡하면 그대로 두고 경고만 남긴다 —
       매일 아침 실패 메일이 날아오는 것보다, 로그에 남고 다음 실행에 회복되는 편이 낫다. */
    const keyProblem = skipped.length === SOURCES.length;
    let hasExisting = false;
    try {
      const prev = JSON.parse(await readFile(new URL("../data/transactions.json", import.meta.url), "utf8"));
      hasExisting = Array.isArray(prev.transactions) && prev.transactions.length > 0;
    } catch { /* 파일이 없으면 그대로 실패 처리 */ }

    if (problems.length) console.error(problems.slice(0, 5).join("\n"));

    if (!keyProblem && hasExisting) {
      console.log("::warning::포털에서 거래를 못 받아왔습니다. 기존 data/transactions.json 을 그대로 둡니다.");
      console.log("일시적 장애면 다음 실행에서 회복됩니다. 며칠 이어지면 'node scripts/update.mjs --check' 로 인증키를 점검하세요.");
      process.exit(0);
    }

    console.error("\n수집된 거래가 0건입니다. 인증키 또는 APT_NAME 표기를 확인하세요.");
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
