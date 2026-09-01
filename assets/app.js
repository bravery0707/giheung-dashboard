const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? "").replace(/[&<>'"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[ch]));
const state = {
  transactions: [], transactionMeta: {}, listings: [], listingMeta: {},
  history: { snapshots: [], changes: [] },
  filter: { deal: "매매", area: "84", period: 36, band: "all" },
  openListing: "", listingQuery: "", transactionQuery: "", selectedTransaction: null,
};

const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const formatNumber = value => new Intl.NumberFormat("ko-KR").format(Math.round(value || 0));
const formatMoney = value => {
  if (!Number.isFinite(Number(value))) return "-";
  const amount = Number(value);
  const eok = Math.floor(amount / 10000);
  const rest = amount % 10000;
  if (!eok) return `${formatNumber(rest)}만`;
  return rest ? `${eok}억 ${formatNumber(rest)}` : `${eok}억`;
};
const formatShortMoney = value => {
  if (!Number.isFinite(Number(value))) return "-";
  return `${(Number(value) / 10000).toFixed(Number(value) % 10000 ? 2 : 0).replace(/\.0+$/, "")}억`;
};
const listingPrice = item => {
  if (item.deal === "월세") return `${formatMoney(item.price)} / ${formatNumber(item.rent)}만`;
  if (item.priceMax) return `${formatShortMoney(item.price)}~${formatShortMoney(item.priceMax)}`;
  return formatShortMoney(item.price);
};
const transactionPrice = item => item.deal === "월세"
  ? `${formatMoney(item.amount)} / ${formatNumber(item.rent)}만`
  : formatMoney(item.amount);
const dealClass = deal => deal === "매매" ? "sale" : deal === "전세" ? "jeonse" : "monthly";
const bandOfFloor = floor => Number(floor) >= 34 ? "고" : Number(floor) >= 17 ? "중" : "저";
const parseShortDate = value => {
  const m = String(value || "").match(/(\d{2})[.\-/](\d{2})[.\-/](\d{2})/);
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : String(value || "");
};
const monthsBefore = (date, months) => {
  const d = new Date(`${date}T00:00:00`);
  d.setMonth(d.getMonth() - Number(months));
  return d.toISOString().slice(0, 10);
};
const latestDate = () => state.transactions.map(item => item.date).filter(Boolean).sort().at(-1) || new Date().toISOString().slice(0, 10);
const areaGroup = value => Number(value) < 79 ? 72 : Number(value) < 90 ? 84 : 95;
const areaMatches = item => state.filter.area === "all" || areaGroup(item.area) === Number(state.filter.area);
const listingMatches = item => item.deal === state.filter.deal && areaMatches(item) && (state.filter.band === "all" || item.band === state.filter.band);
const transactionMatches = item => item.deal === state.filter.deal && areaMatches(item)
  && (state.filter.band === "all" || bandOfFloor(item.floor) === state.filter.band)
  && item.date >= monthsBefore(latestDate(), state.filter.period);
const filteredListings = () => state.listings.filter(listingMatches);
const filteredTransactions = () => state.transactions.filter(transactionMatches).sort((a, b) => b.date.localeCompare(a.date));

function toast(message) {
  const box = $("#toast");
  box.textContent = message;
  box.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.remove("show"), 2600);
}
function kpi(label, value, note = "", tone = "") {
  return `<article class="kpi ${tone}"><span class="kpi-label">${esc(label)}</span><strong class="kpi-value">${value}</strong><span class="kpi-note">${esc(note)}</span></article>`;
}
function emptyState(title, copy) {
  return `<div class="empty-state"><strong>${esc(title)}</strong>${esc(copy)}</div>`;
}

async function fetchJson(path, version) {
  const response = await fetch(`${path}?v=${version}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return response.json();
}
async function loadData(userInitiated = false) {
  const button = $("#refreshButton");
  button.classList.add("loading");
  button.disabled = true;
  try {
    const version = Date.now();
    const [tx, listings, history] = await Promise.all([
      fetchJson("./data/transactions.json", version),
      fetchJson("./data/listings.json", version),
      fetchJson("./data/listing-history.json", version).catch(() => ({ snapshots: [], changes: [] })),
    ]);
    state.transactions = tx.transactions || [];
    state.transactionMeta = tx;
    state.listings = listings.listings || [];
    state.listingMeta = listings;
    state.history = history;
    $("#syncStamp").textContent = `실거래 ${String(tx.updated || "").replace(" UTC", "")} · 매물 ${listings.updated || "-"}`;
    renderAll();
    if (userInitiated) toast("GitHub에 저장된 최신 데이터를 불러왔습니다.");
  } catch (error) {
    console.error(error);
    $("#syncStamp").textContent = "데이터를 불러오지 못함";
    toast("데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
  } finally {
    button.classList.remove("loading");
    button.disabled = false;
  }
}

function renderHero() {
  const latestSale = state.transactions.filter(item => item.deal === "매매" && areaGroup(item.area) === 84)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  $("#heroCard").innerHTML = latestSale ? `<div><div class="hero-label">84㎡ 최근 매매 실거래</div><div class="hero-price">${formatShortMoney(latestSale.amount)} <small>${latestSale.floor}층</small></div></div><div class="hero-meta">${esc(latestSale.date)} · ${esc(latestSale.dong ? `${latestSale.dong}동` : "동 정보 없음")} · 국토교통부</div>`
    : `<div class="hero-empty">84㎡ 매매 실거래를<br>불러오는 중입니다.</div>`;
}

function renderLineChart(target, points, options = {}) {
  const el = typeof target === "string" ? $(target) : target;
  if (!el) return;
  const rows = points.filter(point => Number.isFinite(point.y) && point.x);
  if (!rows.length) {
    el.innerHTML = `<div class="chart-empty"><div><strong>${esc(options.emptyTitle || "표시할 데이터가 없습니다")}</strong>${esc(options.emptyCopy || "필터를 바꾸거나 데이터 갱신 후 다시 확인하세요.")}</div></div>`;
    return;
  }
  if (rows.length === 1) {
    el.innerHTML = `<div class="chart-empty"><div><strong>${esc(options.singleTitle || "스냅샷이 1회 쌓였습니다")}</strong>${esc(options.singleCopy || "다음 갱신부터 날짜별 선이 연결됩니다.")}</div></div>`;
    return;
  }
  const width = 820, height = options.height || 320, left = 62, right = 24, top = 20, bottom = 42;
  const times = rows.map(point => new Date(`${point.x}T00:00:00`).getTime());
  const minX = Math.min(...times), maxX = Math.max(...times);
  let minY = Math.min(...rows.map(point => point.y)), maxY = Math.max(...rows.map(point => point.y));
  const pad = (maxY - minY || Math.max(maxY * .08, 1)) * .12;
  minY -= pad; maxY += pad;
  const x = time => left + (time - minX) / (maxX - minX || 1) * (width - left - right);
  const y = value => top + (maxY - value) / (maxY - minY || 1) * (height - top - bottom);
  const ticks = Array.from({ length: 5 }, (_, i) => minY + (maxY - minY) * i / 4);
  const xTickIndexes = [...new Set([0, Math.floor((rows.length - 1) / 3), Math.floor((rows.length - 1) * 2 / 3), rows.length - 1])];
  const line = rows.map((point, i) => `${i ? "L" : "M"}${x(times[i]).toFixed(1)},${y(point.y).toFixed(1)}`).join(" ");
  const area = `${line} L${x(times.at(-1)).toFixed(1)},${height - bottom} L${x(times[0]).toFixed(1)},${height - bottom} Z`;
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(options.label || "데이터 추이 차트")}"><defs><linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14b8a6" stop-opacity=".25"/><stop offset="1" stop-color="#14b8a6" stop-opacity="0"/></linearGradient></defs>${ticks.map(tick => `<line class="grid-line" x1="${left}" y1="${y(tick)}" x2="${width - right}" y2="${y(tick)}"/><text class="axis-label" x="${left - 9}" y="${y(tick) + 4}" text-anchor="end">${esc(options.yFormat ? options.yFormat(tick) : formatNumber(tick))}</text>`).join("")}<path class="chart-area" d="${area}"/><path class="chart-line" d="${line}"/>${rows.map((point, i) => `<circle class="chart-point" data-index="${i}" cx="${x(times[i])}" cy="${y(point.y)}" r="5"><title>${esc(point.label || `${point.x} ${point.y}`)}</title></circle>`).join("")}${xTickIndexes.map(i => `<text class="axis-label" x="${x(times[i])}" y="${height - 14}" text-anchor="middle">${esc(rows[i].x.slice(2).replaceAll("-", "."))}</text>`).join("")}</svg>`;
  el.querySelectorAll("circle[data-index]").forEach(circle => circle.addEventListener("click", () => {
    el.querySelectorAll("circle").forEach(node => node.classList.remove("selected"));
    circle.classList.add("selected");
    options.onPoint?.(rows[Number(circle.dataset.index)]);
  }));
}

function renderScatter(target, listings) {
  const el = $(target);
  if (!listings.length) { el.innerHTML = `<div class="chart-empty"><div><strong>조건에 맞는 매물이 없습니다</strong>필터를 바꿔 확인해 보세요.</div></div>`; return; }
  const width = 760, height = 300, left = 62, right = 25, top = 18, bottom = 44;
  const values = listings.map(item => item.price);
  let min = Math.min(...values), max = Math.max(...values); const pad = (max - min || 10000) * .12; min -= pad; max += pad;
  const y = value => top + (max - value) / (max - min || 1) * (height - top - bottom);
  const jitter = item => [...String(item.trackId || item.id || "")].reduce((sum,ch)=>sum+ch.charCodeAt(0),0)%23-11;
  const x = item => left + ({ 저: .16, 중: .5, 고: .84 }[item.band] || .5) * (width - left - right) + jitter(item);
  const ticks = Array.from({ length: 5 }, (_, i) => min + (max - min) * i / 4);
  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="높이별 매물 호가 분포">${ticks.map(tick => `<line class="grid-line" x1="${left}" y1="${y(tick)}" x2="${width-right}" y2="${y(tick)}"/><text class="axis-label" x="${left-8}" y="${y(tick)+4}" text-anchor="end">${formatShortMoney(tick)}</text>`).join("")}${["저","중","고"].map((band,i)=>`<text class="axis-label" x="${left+(.16+i*.34)*(width-left-right)}" y="${height-14}" text-anchor="middle">${band}층</text>`).join("")}${listings.map((item,i)=>`<circle class="chart-point" data-track="${esc(item.trackId||item.id)}" cx="${x(item)}" cy="${y(item.price)}" r="6"><title>${esc(`${item.dong}동 ${item.type} ${listingPrice(item)}`)}</title></circle>`).join("")}</svg>`;
  el.querySelectorAll("circle").forEach(circle => circle.addEventListener("click", () => {
    state.openListing = circle.dataset.track;
    renderListingTable();
    setTimeout(() => $("#listingTable tr.highlight")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
  }));
}

function renderSummary() {
  const tx = filteredTransactions();
  const listings = filteredListings();
  const latest = tx[0];
  const asks = listings.map(item => item.price);
  const askMedian = median(asks);
  const latestAmount = latest?.amount;
  const gap = askMedian && latestAmount ? (askMedian / latestAmount - 1) * 100 : null;
  $("#summaryKpis").innerHTML = [
    kpi("최근 실거래", latest ? transactionPrice(latest) : "-", latest ? `${latest.date} · ${latest.floor}층` : "조건에 맞는 거래 없음"),
    kpi("현재 고유 매물", `${formatNumber(listings.length)}<small>건</small>`, `중개소 게시 ${formatNumber(listings.reduce((sum,item)=>sum+(item.count||1),0))}건`),
    kpi("중간 호가", askMedian ? formatShortMoney(askMedian) : "-", asks.length ? `범위 ${formatShortMoney(Math.min(...asks))}~${formatShortMoney(Math.max(...asks))}` : "조건에 맞는 매물 없음"),
    kpi("호가-최근 실거래", gap == null ? "-" : `${gap >= 0 ? "+" : ""}${gap.toFixed(1)}<small>%</small>`, "중간 호가와 최근 신고가 비교", gap > 0 ? "up" : gap < 0 ? "down" : ""),
  ].join("");
  $("#txChartCaption").textContent = `${state.filter.area === "all" ? "전체 면적" : `${state.filter.area}㎡`} · ${state.filter.deal} · 최근 ${state.filter.period}개월`;
  renderLineChart("#summaryTxChart", [...tx].reverse().map(item => ({ x:item.date, y:item.amount, label:`${item.date} ${transactionPrice(item)}` })), { yFormat: formatShortMoney, height: 285, singleTitle:"거래가 1건만 있습니다", singleCopy:"기간이나 필터를 넓히면 추이를 볼 수 있습니다." });
  const all = state.listings.filter(item => areaMatches(item));
  const counts = ["매매","전세","월세"].map(deal => ({ deal, count: all.filter(item=>item.deal===deal).length }));
  const total = Math.max(1, counts.reduce((sum,item)=>sum+item.count,0));
  $("#listingMix").innerHTML = `<div class="mix-list">${counts.map(item=>`<div class="mix-row"><span>${item.deal}</span><div class="progress"><span style="width:${item.count/total*100}%"></span></div><strong>${item.count}</strong></div>`).join("")}</div>`;
  const change = state.history.changes?.at(-1);
  const events = filteredChange(change);
  $("#recentSignals").innerHTML = change ? `<div class="signal-strip"><div class="signal new"><span>신규</span><b>${events.new.length}건</b><span>${change.from} → ${change.to}</span></div><div class="signal gone"><span>소멸 후보</span><b>${events.gone.length}건</b><span>재등록 가능성 포함</span></div><div class="signal price"><span>가격변동</span><b>${events.priceChanges.length}건</b><span>동일 매물 추적 기준</span></div></div>` : emptyState("변동 기록을 준비했습니다", "다음 날짜의 엑셀을 갱신하면 신규·소멸 후보·가격변동이 표시됩니다.");
}

function renderTransactions() {
  const rows = filteredTransactions();
  $("#transactionStamp").textContent = `국토교통부 · ${state.transactionMeta.updated || "-"} · 전체 ${formatNumber(state.transactions.length)}건`;
  $("#transactionChartTitle").textContent = `${state.filter.area === "all" ? "전체 면적" : `${state.filter.area}㎡`} ${state.filter.deal} 거래금액 추이`;
  renderLineChart("#transactionChart", [...rows].reverse().map(item=>({ x:item.date, y:item.amount, item, label:`${item.date} · ${item.floor}층 · ${transactionPrice(item)}` })), { yFormat:formatShortMoney, height:400, onPoint: point => {
    state.selectedTransaction = point.item;
    renderTransactionSelection();
  }, singleTitle:"거래가 1건만 있습니다", singleCopy:"기간·면적·높이 필터를 넓혀 보세요." });
  renderTransactionSelection();
  renderTransactionTable();
}
function renderTransactionSelection() {
  const item = state.selectedTransaction;
  $("#transactionSelection").innerHTML = item ? `<strong>${esc(item.date)} · ${esc(item.dong ? `${item.dong}동` : "동 미제공")} · ${item.floor}층</strong> &nbsp; ${esc(transactionPrice(item))} · 전용 ${item.area}㎡ · ${esc(item.src || "국토부")}` : "차트의 점을 누르면 거래 상세가 여기에 표시됩니다.";
}
function renderTransactionTable() {
  const query = state.transactionQuery.replace(/\s/g, "").toLowerCase();
  const rows = filteredTransactions().filter(item => !query || `${item.date}${item.dong||""}${item.floor}${item.area}`.replace(/\s/g,"").toLowerCase().includes(query));
  $("#transactionCount").textContent = `${formatNumber(rows.length)}건`;
  $("#transactionTable").innerHTML = rows.slice(0,500).map(item=>`<tr><td>${esc(item.date)}</td><td>${esc(item.dong ? `${item.dong}동` : "-")}</td><td>${item.area}㎡</td><td>${item.floor}층</td><td class="amount">${esc(transactionPrice(item))}</td><td><span class="deal-pill ${dealClass(item.deal)}">${item.deal}</span></td></tr>`).join("") || `<tr><td colspan="6">조건에 맞는 거래가 없습니다.</td></tr>`;
}

function renderListings() {
  const rows = filteredListings();
  const prices = rows.map(item=>item.price);
  $("#listingStamp").textContent = `네이버 부동산 스냅샷 · ${state.listingMeta.updated || "-"} · 전체 고유 ${state.listingMeta.unique || 0}건`;
  $("#listingKpis").innerHTML = [
    kpi("고유 매물", `${rows.length}<small>건</small>`, `${state.filter.deal} · ${state.filter.area === "all" ? "전체" : `${state.filter.area}㎡`}`),
    kpi("중개소 게시", `${rows.reduce((s,item)=>s+(item.count||1),0)}<small>건</small>`, "중복 게시 포함"),
    kpi("최저 호가", prices.length ? formatShortMoney(Math.min(...prices)) : "-", "고유 매물 기준"),
    kpi("중간 호가", prices.length ? formatShortMoney(median(prices)) : "-", prices.length ? `최고 ${formatShortMoney(Math.max(...prices))}` : "조건에 맞는 매물 없음"),
  ].join("");
  const bands = ["저","중","고"].map(band=>{ const list=rows.filter(item=>item.band===band); return {band,list,median:median(list.map(item=>item.price))}; });
  const maxCount = Math.max(1,...bands.map(item=>item.list.length));
  $("#bandBars").innerHTML = `<div class="band-list">${bands.map(item=>`<div><div class="band-head"><strong>${item.band}층 · ${item.list.length}건</strong><span>${item.median ? `중간 ${formatShortMoney(item.median)}` : "-"}</span></div><div class="band-bar"><span style="width:${item.list.length/maxCount*100}%"></span></div></div>`).join("")}</div>`;
  renderScatter("#listingScatter", rows);
  renderListingTable();
}
function renderListingTable() {
  const query = state.listingQuery.replace(/\s/g, "").toLowerCase();
  const rows = filteredListings().filter(item => {
    const text = [item.dong,item.type,item.face,item.priceText,...(item.agents||[]).flatMap(agent=>[agent.name,agent.memo])].join("").replace(/\s/g,"").toLowerCase();
    return !query || text.includes(query);
  }).sort((a,b)=>a.price-b.price);
  $("#listingCount").textContent = `고유 매물 ${rows.length}건`;
  $("#listingTable").innerHTML = rows.flatMap(item => {
    const id = item.trackId || item.id;
    const open = state.openListing === id;
    const main = `<tr data-track="${esc(id)}" class="${open?"highlight":""}"><td>${esc(item.dong)}동</td><td><span class="deal-pill ${dealClass(item.deal)}">${item.deal}</span></td><td>${esc(item.type)} · ${item.area}㎡</td><td>${item.floor ? `${item.floor}층` : `${esc(item.band)}층`}</td><td>${esc(item.face||"-")}</td><td class="amount">${esc(listingPrice(item))}</td><td>${item.count||1}곳</td></tr>`;
    if (!open) return [main];
    const detail = `<tr class="listing-detail"><td colspan="7"><div class="detail-inner"><p><strong>${esc(item.dong)}동 ${esc(item.type)}</strong><br>최초 ${esc(item.first||item.listed)} · 최근 ${esc(item.last||item.listed)}<br>추적 ID ${esc(id)}</p><div class="agent-list">${(item.agents||[]).slice(0,8).map(agent=>`<div class="agent-line"><strong>${esc(agent.name||agent.agent)}</strong> · ${esc(agent.date)}<br>${esc(agent.memo||"")}</div>`).join("")||"중개소 상세 없음"}</div></div></td></tr>`;
    return [main,detail];
  }).join("") || `<tr><td colspan="7">조건에 맞는 매물이 없습니다.</td></tr>`;
  $("#listingTable").querySelectorAll("tr[data-track]").forEach(row=>row.addEventListener("click",()=>{
    state.openListing = state.openListing === row.dataset.track ? "" : row.dataset.track;
    renderListingTable();
  }));
}

function snapshotFiltered(snapshot) {
  return (snapshot.listings || []).filter(listingMatches);
}
function renderTrends() {
  const snapshots = state.history.snapshots || [];
  const series = snapshots.map(snapshot=>({ date:snapshot.date, listings:snapshotFiltered(snapshot) }));
  const latest = series.at(-1), previous = series.at(-2);
  const delta = latest && previous ? latest.listings.length - previous.listings.length : null;
  const latestMedian = latest ? median(latest.listings.map(item=>item.price)) : null;
  $("#trendKpis").innerHTML = [
    kpi("스냅샷", `${series.length}<small>회</small>`, series.length>1?`${series[0].date} ~ ${series.at(-1).date}`:"첫 기준일 저장 완료"),
    kpi("현재 매물", `${latest?.listings.length||0}<small>건</small>`, "선택 조건 기준"),
    kpi("직전 대비", delta==null?"-":`${delta>0?"+":""}${delta}<small>건</small>`, delta==null?"비교할 다음 스냅샷 필요":"고유 매물 증감",delta>0?"up":delta<0?"down":""),
    kpi("현재 중간 호가", latestMedian?formatShortMoney(latestMedian):"-", "선택 조건 기준"),
  ].join("");
  renderLineChart("#trendCountChart", series.map(item=>({x:item.date,y:item.listings.length,label:`${item.date} ${item.listings.length}건`})), { height:390, yFormat:value=>`${Math.round(value)}건`, emptyTitle:"매물 스냅샷이 없습니다", singleTitle:"첫 스냅샷을 저장했습니다", singleCopy:"다음 날짜의 엑셀을 올리면 일별 추이가 시작됩니다." });
  $("#snapshotList").innerHTML = [...series].reverse().map(item=>`<div class="snapshot"><strong>${item.date}</strong><span>${item.listings.length}건</span></div>`).join("") || emptyState("기록 없음","엑셀 갱신 후 표시됩니다.");
  renderLineChart("#trendPriceChart", series.map(item=>({x:item.date,y:median(item.listings.map(listing=>listing.price)),label:`${item.date} ${formatShortMoney(median(item.listings.map(listing=>listing.price)))}`})), { yFormat:formatShortMoney, height:310, singleTitle:"중간 호가 기준점이 생겼습니다", singleCopy:"다음 날짜부터 가격 흐름이 연결됩니다." });
}

function filteredChange(change) {
  if (!change) return { new:[], gone:[], priceChanges:[] };
  return {
    new:(change.new||[]).filter(listingMatches),
    gone:(change.gone||[]).filter(listingMatches),
    priceChanges:(change.priceChanges||[]).filter(listingMatches),
  };
}
function eventCards(items, type) {
  if (!items.length) return emptyState(`${type} 매물이 없습니다`, "선택 조건과 비교 기간 기준입니다.");
  return `<div class="change-cards">${items.map(item=>`<div class="change-card"><span class="event-pill ${type==="신규"?"new":type==="소멸 후보"?"gone":"price"}">${type}</span><div><strong>${esc(item.dong)}동 · ${esc(item.type)} · ${item.floor?`${item.floor}층`:`${esc(item.band)}층`}</strong><br><span>${esc(item.face||"")} · ${esc(item.deal)} · 중개소 게시 ${item.count||1}곳</span></div><div class="change-price">${type==="가격변동"?`${formatShortMoney(item.beforePrice)} → ${formatShortMoney(item.afterPrice)}`:esc(listingPrice(item))}</div></div>`).join("")}</div>`;
}
function renderChanges() {
  const changes = state.history.changes || [];
  const select = $("#changePeriod");
  const current = select.value || String(Math.max(0,changes.length-1));
  select.innerHTML = changes.length ? changes.map((change,index)=>`<option value="${index}">${change.from} → ${change.to}</option>`).reverse().join("") : `<option value="">비교 기록 없음</option>`;
  if (changes.length) select.value = changes[Number(current)] ? current : String(changes.length-1);
  const change = changes[Number(select.value)] || changes.at(-1);
  const events = filteredChange(change);
  $("#changeBadge").textContent = change ? events.new.length+events.gone.length+events.priceChanges.length : 0;
  $("#changeKpis").innerHTML = [
    kpi("비교 기간", change?`${change.from.slice(5)} → ${change.to.slice(5)}`:"-", change?"스냅샷 간 비교":"다음 갱신부터 계산"),
    kpi("신규", `${events.new.length}<small>건</small>`, "새 추적 ID", events.new.length?"down":""),
    kpi("소멸 후보", `${events.gone.length}<small>건</small>`, "거래 확정 아님", events.gone.length?"up":""),
    kpi("가격변동", `${events.priceChanges.length}<small>건</small>`, "동일 매물 비교"),
  ].join("");
  $("#changeContent").innerHTML = change ? `<section class="change-group"><h3>신규 등록</h3>${eventCards(events.new,"신규")}</section><section class="change-group"><h3>소멸 후보</h3>${eventCards(events.gone,"소멸 후보")}</section><section class="change-group"><h3>가격변동</h3>${eventCards(events.priceChanges,"가격변동")}</section>` : emptyState("비교할 매물 스냅샷이 아직 없습니다","다음 날짜의 엑셀을 올리면 신규·소멸 후보·가격변동이 자동 계산됩니다.");
  renderPersistentGone();
}
function renderPersistentGone() {
  const snapshots = state.history.snapshots || [];
  const changes = state.history.changes || [];
  const latestIds = new Set((snapshots.at(-1)?.listings||[]).map(item=>item.trackId));
  const persistent = [];
  for (const change of changes) {
    const laterCount = snapshots.filter(snapshot=>snapshot.date>change.to).length;
    if (!laterCount) continue;
    for (const item of change.gone||[]) if (!latestIds.has(item.trackId) && listingMatches(item) && !persistent.some(old=>old.trackId===item.trackId)) persistent.push({...item,goneOn:change.to});
  }
  $("#persistentGone").innerHTML = persistent.length ? `<div class="table-wrap"><table><thead><tr><th>마지막 확인</th><th>동·타입</th><th>높이</th><th>마지막 호가</th></tr></thead><tbody>${persistent.map(item=>`<tr><td>${item.goneOn}</td><td>${esc(item.dong)}동 · ${esc(item.type)}</td><td>${item.floor?`${item.floor}층`:`${esc(item.band)}층`}</td><td class="amount">${esc(listingPrice(item))}</td></tr>`).join("")}</tbody></table></div>` : emptyState("지속 소멸 후보가 없습니다", snapshots.length<3?"후속 스냅샷이 더 쌓여야 지속 여부를 판단할 수 있습니다.":"현재 조건에서는 모두 재등장했거나 최근 소멸 후보입니다.");
}

function renderAll() {
  renderHero(); renderSummary(); renderTransactions(); renderListings(); renderTrends(); renderChanges();
}
function setTab(tab) {
  const valid = ["summary","transactions","listings","trends","changes"];
  const current = valid.includes(tab) ? tab : "summary";
  $$('[data-page]').forEach(page=>page.hidden=page.dataset.page!==current);
  $$('[data-tab]').forEach(link=>link.classList.toggle("active",link.dataset.tab===current));
  if (location.hash.slice(1)!==current) history.replaceState(null,"",`#${current}`);
  window.scrollTo({top:0,behavior:"smooth"});
}
function bind() {
  $("#refreshButton").addEventListener("click",()=>loadData(true));
  window.addEventListener("hashchange",()=>setTab(location.hash.slice(1)));
  $$('[data-tab]').forEach(link=>link.addEventListener("click",event=>{event.preventDefault();setTab(link.dataset.tab);}));
  $$('[data-go]').forEach(button=>button.addEventListener("click",()=>setTab(button.dataset.go)));
  $("#dealFilter").addEventListener("click",event=>{
    const button=event.target.closest("button"); if(!button)return;
    state.filter.deal=button.dataset.value; $$("#dealFilter button").forEach(node=>node.classList.toggle("active",node===button)); renderAll();
  });
  $("#bandFilter").addEventListener("click",event=>{
    const button=event.target.closest("button"); if(!button)return;
    state.filter.band=button.dataset.value; $$("#bandFilter button").forEach(node=>node.classList.toggle("active",node===button)); renderAll();
  });
  $("#areaFilter").addEventListener("change",event=>{state.filter.area=event.target.value;renderAll();});
  $("#periodFilter").addEventListener("change",event=>{state.filter.period=Number(event.target.value);renderAll();});
  $("#transactionSearch").addEventListener("input",event=>{state.transactionQuery=event.target.value;renderTransactionTable();});
  $("#listingSearch").addEventListener("input",event=>{state.listingQuery=event.target.value;renderListingTable();});
  $("#changePeriod").addEventListener("change",renderChanges);
  $$(".subtabs button").forEach(button=>button.addEventListener("click",()=>{
    $$(".subtabs button").forEach(node=>node.classList.toggle("active",node===button));
    $$('[data-transaction-view]').forEach(view=>view.hidden=view.dataset.transactionView!==button.dataset.view);
  }));
}

bind();
setTab(location.hash.slice(1));
loadData();
