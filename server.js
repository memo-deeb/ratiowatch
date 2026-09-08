const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const BASE_SYMBOLS = [
  { sym: 'CL=F', name: 'USOIL', sub: 'CFDs on WTI Crude Oil', isStock: false },
  { sym: 'GC=F', name: 'GOLD', sub: 'CFDs on Gold', isStock: false },
  { sym: 'SI=F', name: 'SILVER', sub: 'CFDs on Silver', isStock: false },
  { sym: 'BTC-USD', name: 'BTCUSD', sub: 'Bitcoin / U.S. Dollar', isStock: false },
  { sym: 'MSTR', name: 'MSTR', sub: 'Strategy Inc', isStock: true, webullId: '913253396' },
  { sym: 'MARA', name: 'MARA', sub: 'MARA Holdings, Inc.', isStock: true, webullId: '913254556' },
  { sym: 'IREN', name: 'IREN', sub: 'IREN LIMITED', isStock: true, webullId: '913444436' },
  { sym: 'NBIS', name: 'NBIS', sub: 'Nebius Group N.V.', isStock: true, webullId: '913255280' },
  { sym: 'CRWV', name: 'CRWV', sub: 'CoreWeave, Inc.', isStock: true, webullId: null },
  { sym: 'ORCL', name: 'ORCL', sub: 'Oracle Corporation', isStock: true, webullId: '913254287' },
  { sym: 'CIFR', name: 'CIFR', sub: 'Cipher Digital Inc.', isStock: true, webullId: '913444211' },
  { sym: 'BTDR', name: 'BTDR', sub: 'Bitdeer Technologies Group', isStock: true, webullId: '913446973' },
  { sym: 'SMCI', name: 'SMCI', sub: 'Super Micro Computer, Inc.', isStock: true, webullId: '913254245' },
  { sym: 'SLNH', name: 'SLNH', sub: 'Soluna Holdings, Inc.', isStock: true, webullId: '913255167' },
  { sym: 'WULF', name: 'WULF', sub: 'TeraWulf Inc.', isStock: true, webullId: '913255146' }
];

const RATIO_PAIRS = [
  { t1: 'ORCL', t2: 'IREN' },
  { t1: 'ORCL', t2: 'MARA' },
  { t1: 'CRWV', t2: 'IREN' },
  { t1: 'IREN', t2: 'SMCI' },
  { t1: 'IREN', t2: 'BTDR' },
  { t1: 'IREN', t2: 'CIFR' },
  { t1: 'IREN', t2: 'SLNH' },
  { t1: 'IREN', t2: 'MARA' },
  { t1: 'SMCI', t2: 'MARA' },
  { t1: 'IREN', t2: 'WULF' }
];

let CACHED_DATA = [];
let LAST_UPDATE = 0;

// 1. Primary Off-Market & Live Quote Fetcher (Yahoo v7 Quote API)
async function fetchAllQuotes(symbols) {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.map(encodeURIComponent).join(',')}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });
    if (!res.ok) return {};
    const json = await res.json();
    const list = json.quoteResponse?.result || [];
    const map = {};
    for (const q of list) {
      map[q.symbol] = q;
    }
    return map;
  } catch (e) {
    return {};
  }
}

// 2. Blue Ocean ATS Overnight Quote Fetcher
async function fetchBlueOceanQuote(webullId) {
  if (!webullId) return null;
  try {
    const url = `https://quotes-gw.webullfintech.com/api/quote/tickerRealTime/getQuote?tickerId=${webullId}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'hl': 'en', 'gl': 'us', 'platform': 'pc'
      }
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const d = await res.json();
    if (d.nightPrice && parseFloat(d.nightPrice) > 0) {
      return { price: parseFloat(d.nightPrice), label: 'BOATS' };
    }
    if (d.pPrice && parseFloat(d.pPrice) > 0) {
      return { price: parseFloat(d.pPrice), label: d.status === 'P' ? 'PRE' : 'AH' };
    }
  } catch (e) {}
  return null;
}

// 3. Intraday & 5-Day Historical Candles
async function fetchTickerChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=5m&includePrePost=true`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const r = json.chart.result[0];
  const meta = r.meta;
  const times = r.timestamp || [];
  const quotes = r.indicators.quote[0].close || [];

  const history = [];
  for (let i = 0; i < times.length; i++) {
    if (quotes[i] !== null && quotes[i] !== undefined) {
      history.push({ t: times[i], c: quotes[i] });
    }
  }

  const curPrice = meta.regularMarketPrice || (history.length ? history[history.length - 1].c : 0);
  const dailyPrevClose = meta.previousClose || meta.regularMarketPreviousClose || (history.length ? history[0].c : 1);
  const weeklyPrevClose = meta.chartPreviousClose || (history.length ? history[0].c : 1);

  const reg = meta.currentTradingPeriod?.regular;
  let sessionStart = reg?.start;
  let sessionEnd = reg?.end;

  const now = Math.floor(Date.now() / 1000);
  const lastTick = history.length ? history[history.length - 1] : null;
  if (!sessionStart) {
    sessionStart = (lastTick?.t || now) - 23400;
    sessionEnd = lastTick?.t || now;
  }

  return {
    symbol,
    price: curPrice,
    dailyPrevClose,
    weeklyPrevClose,
    sessionStart,
    sessionEnd,
    history
  };
}

async function syncAll() {
  const allSymbols = BASE_SYMBOLS.map(s => s.sym);

  const [chartMap, quotesMap, boMap] = await Promise.all([
    (async () => {
      const map = {};
      await Promise.allSettled(BASE_SYMBOLS.map(async (item) => {
        try { map[item.sym] = await fetchTickerChart(item.sym); } catch (e) {}
      }));
      return map;
    })(),
    fetchAllQuotes(allSymbols),
    (async () => {
      const map = {};
      await Promise.allSettled(BASE_SYMBOLS.filter(s => s.isStock && s.webullId).map(async (item) => {
        try { map[item.sym] = await fetchBlueOceanQuote(item.webullId); } catch (e) {}
      }));
      return map;
    })()
  ]);

  const results = [];

  // 1. Process Individual Symbols
  for (const item of BASE_SYMBOLS) {
    const c = chartMap[item.sym];
    if (!c || !c.history.length) continue;

    const q = quotesMap[item.sym] || {};
    const bo = boMap[item.sym];

    const curPrice = q.regularMarketPrice || c.price;
    const dailyPrevClose = q.regularMarketPreviousClose || c.dailyPrevClose;
    const weeklyPrevClose = c.weeklyPrevClose;

    const dailyChangePct = ((curPrice - dailyPrevClose) / dailyPrevClose) * 100;
    const weeklyChangePct = ((curPrice - weeklyPrevClose) / weeklyPrevClose) * 100;

    // Strict regular session filtering for 1D chart
    const dayTicks = c.history.filter(h => h.t >= (c.sessionStart - 300) && h.t <= (c.sessionEnd + 300));
    const dayHistory = dayTicks.length > 3 ? dayTicks : c.history.slice(-78);

    // Multi-tier off-market detection
    let extPrice = null;
    let extChangePct = null;
    let extLabel = '';

    // A. Webull Blue Ocean ATS
    if (bo && bo.price && bo.price !== curPrice) {
      extPrice = bo.price;
      extLabel = bo.label;
      extChangePct = ((extPrice - curPrice) / curPrice) * 100;
    }
    // B. Yahoo Quote API (Official Post-Market)
    else if (q.postMarketPrice && q.postMarketPrice > 0 && Math.abs(q.postMarketPrice - curPrice) > 0.0001) {
      extPrice = q.postMarketPrice;
      extLabel = 'AH';
      extChangePct = q.postMarketChangePercent !== undefined 
        ? q.postMarketChangePercent 
        : ((extPrice - curPrice) / curPrice) * 100;
    }
    // C. Yahoo Quote API (Official Pre-Market)
    else if (q.preMarketPrice && q.preMarketPrice > 0 && Math.abs(q.preMarketPrice - curPrice) > 0.0001) {
      extPrice = q.preMarketPrice;
      extLabel = 'PRE';
      extChangePct = q.preMarketChangePercent !== undefined 
        ? q.preMarketChangePercent 
        : ((extPrice - curPrice) / curPrice) * 100;
    }
    // D. Extended candle tick fallback
    else if (c.history.length) {
      const lastTick = c.history[c.history.length - 1];
      if (lastTick.t > (c.sessionEnd + 300) && Math.abs(lastTick.c - curPrice) > 0.0001) {
        extPrice = lastTick.c;
        extLabel = 'AH';
        extChangePct = ((extPrice - curPrice) / curPrice) * 100;
      }
    }

    results.push({
      id: item.name,
      name: item.name,
      sub: item.sub,
      price: curPrice,
      extPrice,
      extChangePct,
      extLabel,
      dailyPrevClose,
      weeklyPrevClose,
      dailyChangePct,
      weeklyChangePct,
      sessionStart: c.sessionStart,
      sessionEnd: c.sessionEnd,
      daySeries: dayHistory,
      weekSeries: c.history
    });
  }

  // 2. Process Ratio Spreads
  for (const pair of RATIO_PAIRS) {
    const c1 = chartMap[pair.t1];
    const c2 = chartMap[pair.t2];
    if (!c1 || !c2 || !c1.history.length || !c2.history.length) continue;

    const q1 = quotesMap[pair.t1] || {};
    const q2 = quotesMap[pair.t2] || {};

    const p1 = q1.regularMarketPrice || c1.price;
    const p2 = q2.regularMarketPrice || c2.price;
    if (p2 <= 0) continue;

    const curRatio = p1 / p2;
    const dailyPrevRatio = (q1.regularMarketPreviousClose || c1.dailyPrevClose) / (q2.regularMarketPreviousClose || c2.dailyPrevClose);
    const weeklyPrevRatio = c1.weeklyPrevClose / c2.weeklyPrevClose;

    const dailyChangePct = ((curRatio - dailyPrevRatio) / dailyPrevRatio) * 100;
    const weeklyChangePct = ((curRatio - weeklyPrevRatio) / weeklyPrevRatio) * 100;

    const map2 = new Map(c2.history.map(h => [h.t, h.c]));
    const matched = c1.history
      .filter(h => map2.has(h.t))
      .map(h => ({ t: h.t, c: h.c / map2.get(h.t) }));

    const sessionStart = Math.max(c1.sessionStart, c2.sessionStart);
    const sessionEnd = Math.max(c1.sessionEnd, c2.sessionEnd);
    const dayTicks = matched.filter(m => m.t >= (sessionStart - 300) && m.t <= (sessionEnd + 300));
    const dayHistory = dayTicks.length > 3 ? dayTicks : matched.slice(-78);

    // Compute synthetic off-market ratio & % difference
    const s1 = results.find(r => r.id === pair.t1);
    const s2 = results.find(r => r.id === pair.t2);

    let extRatio = null;
    let extChangePct = null;
    let extLabel = '';

    if (s1 && s2 && (s1.extPrice || s2.extPrice)) {
      const activeP1 = s1.extPrice || s1.price;
      const activeP2 = s2.extPrice || s2.price;
      if (activeP2 > 0) {
        extRatio = activeP1 / activeP2;
        extChangePct = ((extRatio - curRatio) / curRatio) * 100;
        extLabel = (s1.extLabel === 'BOATS' || s2.extLabel === 'BOATS') 
          ? 'BOATS' 
          : (s1.extLabel || s2.extLabel || 'EXT');
      }
    }

    const id = `${pair.t1}/${pair.t2}`;
    results.push({
      id,
      name: id,
      sub: 'Spread',
      price: curRatio,
      extPrice: extRatio,
      extChangePct,
      extLabel,
      dailyPrevClose: dailyPrevRatio,
      weeklyPrevClose: weeklyPrevRatio,
      dailyChangePct,
      weeklyChangePct,
      sessionStart,
      sessionEnd,
      daySeries: dayHistory,
      weekSeries: matched
    });
  }

  if (results.length > 0) {
    CACHED_DATA = results;
    LAST_UPDATE = Date.now();
  }
}

syncAll();
setInterval(syncAll, 3000);

app.get('/api/data', (req, res) => {
  res.json({ updated: LAST_UPDATE, items: CACHED_DATA });
});

app.get('/manifest.json', (req, res) => {
  res.json({
    name: "RatioWatch Pro",
    short_name: "RatioWatch",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0b0e",
    theme_color: "#0a0b0e",
    icons: [{ src: "https://cdn-icons-png.flaticon.com/512/2422/2422796.png", sizes: "512x512", type: "image/png" }]
  });
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en" data-theme="darkgray">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>RatioWatch Pro</title>
  <link rel="manifest" href="/manifest.json">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root[data-theme="oled"] {
      --bg: #000000;
      --card-bg: #0b0c10;
      --card-border: #161822;
      --chart-bg: #040507;
      --text: #f3f5f9;
      --text-sub: #6c738c;
      --axis: #525974;
      --grid: #151822;
      --base: #373e54;
      --btn-bg: #141722;
      --btn-border: #23283a;
      --ext-blue: #38bdf8;
      --ext-bg: rgba(56, 189, 248, 0.12);
      --ext-border: rgba(56, 189, 248, 0.35);
      --flash-up: rgba(0, 230, 100, 0.85);
      --flash-down: rgba(255, 60, 60, 0.85);
    }
    :root[data-theme="darkgray"] {
      --bg: #111216;
      --card-bg: #18191f;
      --card-border: #262832;
      --chart-bg: #131418;
      --text: #f3f5f9;
      --text-sub: #828a9e;
      --axis: #6e768b;
      --grid: #22242c;
      --base: #42495d;
      --btn-bg: #22242c;
      --btn-border: #313542;
      --ext-blue: #38bdf8;
      --ext-bg: rgba(56, 189, 248, 0.14);
      --ext-border: rgba(56, 189, 248, 0.35);
      --flash-up: rgba(0, 230, 100, 0.85);
      --flash-down: rgba(255, 60, 60, 0.85);
    }
    :root[data-theme="navy"] {
      --bg: #090e1a;
      --card-bg: #0f172a;
      --card-border: #1e293b;
      --chart-bg: #0b1120;
      --text: #f8fafc;
      --text-sub: #94a3b8;
      --axis: #64748b;
      --grid: #1e293b;
      --base: #3b4252;
      --btn-bg: #1e293b;
      --btn-border: #334155;
      --ext-blue: #60a5fa;
      --ext-bg: rgba(96, 165, 250, 0.14);
      --ext-border: rgba(96, 165, 250, 0.35);
      --flash-up: rgba(16, 185, 129, 0.85);
      --flash-down: rgba(239, 68, 68, 0.85);
    }
    :root[data-theme="warm"] {
      --bg: #f3efe6;
      --card-bg: #ffffff;
      --card-border: #e0d9cc;
      --chart-bg: #faf7f2;
      --text: #1f2329;
      --text-sub: #7a8192;
      --axis: #8b92a2;
      --grid: #eae4d7;
      --base: #b4bccb;
      --btn-bg: #ebe5d8;
      --btn-border: #dcd3bf;
      --ext-blue: #0284c7;
      --ext-bg: rgba(2, 132, 199, 0.12);
      --ext-border: rgba(2, 132, 199, 0.3);
      --flash-up: rgba(16, 185, 129, 0.7);
      --flash-down: rgba(239, 68, 68, 0.7);
    }
    :root[data-theme="light"] {
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --card-border: #e2e8f0;
      --chart-bg: #f1f5f9;
      --text: #0f172a;
      --text-sub: #64748b;
      --axis: #94a3b8;
      --grid: #e2e8f0;
      --base: #cbd5e1;
      --btn-bg: #e2e8f0;
      --btn-border: #cbd5e1;
      --ext-blue: #2563eb;
      --ext-bg: rgba(37, 99, 235, 0.1);
      --ext-border: rgba(37, 99, 235, 0.25);
      --flash-up: rgba(16, 185, 129, 0.7);
      --flash-down: rgba(239, 68, 68, 0.7);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-feature-settings: "tnum" 1; }
    body { background: var(--bg); color: var(--text); padding: 8px 10px 60px; user-select: none; -webkit-tap-highlight-color: transparent; }

    header { display: flex; justify-content: space-between; align-items: center; padding: 4px 4px 10px; border-bottom: 1px solid var(--card-border); gap: 8px; flex-wrap: wrap; }
    .header-left { display: flex; align-items: baseline; gap: 8px; }
    h1 { font-size: 1.1rem; font-weight: 800; letter-spacing: 0.5px; }
    .status { font-size: 0.72rem; color: #00c805; display: flex; align-items: center; gap: 5px; font-weight: 700; }
    .dot { width: 7px; height: 7px; background: #00c805; border-radius: 50%; box-shadow: 0 0 6px #00c805; }

    .header-actions { display: flex; align-items: center; gap: 6px; }
    .action-btn, select.theme-select {
      background: var(--btn-bg); border: 1px solid var(--btn-border); color: var(--text);
      font-size: 0.72rem; font-weight: 700; padding: 5px 8px; border-radius: 5px; outline: none; cursor: pointer;
    }

    .watchlist { margin-top: 8px; }
    .watchlist.card-view {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
      gap: 10px;
    }
    .watchlist.list-view {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 8px 10px 10px;
      transition: background 0.2s, border-color 0.2s;
    }
    .card.dragging { opacity: 0.35; border: 1px dashed #00c805; }

    .card-topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      flex-wrap: nowrap;
    }
    .topbar-left {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex-shrink: 1;
      overflow: hidden;
    }
    .topbar-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .drag-handle { color: var(--text-sub); cursor: grab; font-size: 0.95rem; line-height: 1; }
    .reorder-btns { display: flex; gap: 2px; }
    .btn-ctrl {
      background: var(--btn-bg); border: 1px solid var(--btn-border); color: var(--text-sub);
      font-size: 0.65rem; padding: 2px 4px; border-radius: 3px; cursor: pointer; line-height: 1;
    }
    .btn-ctrl:active { background: #00c805; color: #000; }

    .sym { font-size: 0.95rem; font-weight: 800; white-space: nowrap; }
    .price-val {
      font-size: 1.12rem;
      font-weight: 800;
      padding: 1px 4px;
      border-radius: 4px;
      white-space: nowrap;
      display: inline-block;
    }

    /* Off-Market Price & Percentage Badge */
    .ext-price-badge {
      display: inline-flex;
      align-items: baseline;
      gap: 4px;
      color: var(--ext-blue);
      background: var(--ext-bg);
      border: 1px solid var(--ext-border);
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 0.92rem;
      font-weight: 800;
      white-space: nowrap;
      box-shadow: 0 0 8px rgba(56, 189, 248, 0.12);
    }
    .ext-price {
      font-weight: 800;
    }
    .ext-pct {
      font-size: 0.72rem;
      font-weight: 700;
      opacity: 0.95;
    }
    .ext-label {
      font-size: 0.58rem;
      font-weight: 900;
      letter-spacing: 0.4px;
      opacity: 0.8;
      text-transform: uppercase;
    }

    .badge {
      font-size: 0.75rem;
      font-weight: 800;
      padding: 2px 6px;
      border-radius: 4px;
      white-space: nowrap;
    }
    .sub {
      font-size: 0.68rem;
      color: var(--text-sub);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 110px;
      font-weight: 500;
    }

    .up-bg { background: rgba(0, 200, 5, 0.16); color: #00c805; }
    .down-bg { background: rgba(255, 59, 48, 0.16); color: #ff3b30; }

    .scrub-readout {
      font-size: 0.72rem;
      color: #00c805;
      font-weight: 800;
      white-space: nowrap;
      min-width: 70px;
      text-align: right;
    }
    .week-pill {
      background: var(--btn-bg); border: 1px solid var(--btn-border); color: var(--text-sub);
      font-size: 0.65rem; font-weight: 800; padding: 2px 6px; border-radius: 4px; cursor: pointer;
    }
    .week-pill.active { background: #00c805; color: #000; border-color: #00c805; }

    @keyframes flashGreen {
      0% { background: var(--flash-up); color: #fff; box-shadow: 0 0 16px var(--flash-up); }
      40% { background: rgba(0, 230, 100, 0.35); }
      100% { background: transparent; color: inherit; box-shadow: none; }
    }
    @keyframes flashRed {
      0% { background: var(--flash-down); color: #fff; box-shadow: 0 0 16px var(--flash-down); }
      40% { background: rgba(255, 60, 60, 0.35); }
      100% { background: transparent; color: inherit; box-shadow: none; }
    }
    .flash-up { animation: flashGreen 1.4s ease-out; }
    .flash-down { animation: flashRed 1.4s ease-out; }

    .chart-box {
      width: 100%;
      background: var(--chart-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 6px 8px;
      position: relative;
    }
    .svg-wrap { width: 100%; height: 130px; position: relative; }
    svg { width: 100%; height: 100%; overflow: visible; display: block; }

    .axis-label { font-size: 10.5px; fill: var(--axis); font-weight: 700; }
    .grid-line { stroke: var(--grid); stroke-width: 1; }
    .base-line { stroke: var(--base); stroke-dasharray: 3,3; stroke-width: 1.2; }
    .day-divider { stroke: var(--grid); stroke-width: 1; stroke-dasharray: 2,2; }
    .chart-line { fill: none; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
    .chart-area { stroke: none; opacity: 0.12; }
    .day-dot { stroke: var(--chart-bg); stroke-width: 1.2; }

    .live-dot-outer {
      animation: pulseBeacon 2s infinite ease-in-out;
      transform-origin: center;
    }
    @keyframes pulseBeacon {
      0% { r: 5px; opacity: 0.8; }
      50% { r: 9px; opacity: 0.2; }
      100% { r: 5px; opacity: 0.8; }
    }

    .cursor-line { stroke: var(--text); stroke-dasharray: 2,2; stroke-width: 1; opacity: 0.7; }
    .cursor-dot { fill: var(--text); stroke: var(--bg); stroke-width: 2; }

    .week-drawer {
      display: none;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--card-border);
    }
    .week-drawer.open { display: block; }
    .week-drawer-hdr {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
      font-size: 0.72rem;
    }
  </style>
</head>
<body>

  <header>
    <div class="header-left">
      <h1>RATIOS & STOCKS</h1>
      <div class="status"><div class="dot"></div> LIVE (24H EXT)</div>
    </div>
    <div class="header-actions">
      <button class="action-btn" id="viewToggleBtn" onclick="toggleViewMode()">⊞ Cards</button>
      <button class="action-btn" onclick="toggleAllWeek()">1W All</button>
      <select class="theme-select" id="themeSelect" onchange="switchTheme(this.value)">
        <option value="darkgray">Dark Gray (Charcoal)</option>
        <option value="oled">OLED Black</option>
        <option value="navy">Midnight Navy</option>
        <option value="warm">Warm Paper</option>
        <option value="light">Classic Light</option>
      </select>
    </div>
  </header>

  <div class="watchlist card-view" id="watchlist"></div>

  <script>
    let savedOrder = JSON.parse(localStorage.getItem('user_order') || '[]');
    let previousPrices = {};
    let latestData = {};
    let openWeekDrawers = JSON.parse(localStorage.getItem('open_drawers') || '{}');
    let allWeekOpen = false;

    let currentView = localStorage.getItem('rw_view') || 'card';
    applyViewMode(currentView);

    function applyViewMode(mode) {
      currentView = mode;
      localStorage.setItem('rw_view', mode);
      const container = document.getElementById('watchlist');
      const btn = document.getElementById('viewToggleBtn');
      if (mode === 'card') {
        container.className = 'watchlist card-view';
        btn.textContent = '⊞ Cards';
      } else {
        container.className = 'watchlist list-view';
        btn.textContent = '☰ List';
      }
    }

    function toggleViewMode() {
      applyViewMode(currentView === 'card' ? 'list' : 'card');
    }

    const currentTheme = localStorage.getItem('rw_theme') || 'darkgray';
    document.documentElement.setAttribute('data-theme', currentTheme);
    document.getElementById('themeSelect').value = currentTheme;

    function switchTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('rw_theme', theme);
      renderList();
    }

    function formatTime(ts) {
      return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    function formatDay(ts) {
      return new Date(ts * 1000).toLocaleDateString([], { weekday: 'short' });
    }

    function buildSvg(id, series, baselineVal, isDay, sStart, sEnd) {
      if (!series || series.length < 2) return '';
      const w = 440, h = 130;
      const padTop = 10, padBtm = 20, padLeft = 6, padRight = 55;
      const ch = h - padTop - padBtm;
      const cw = w - padLeft - padRight;

      const vals = series.map(s => s.c);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const range = max === min ? 1 : max - min;

      let sessionDuration = (sEnd && sStart && sEnd > sStart) ? (sEnd - sStart) : 23400;

      const pts = series.map((s, i) => {
        let xFrac;
        if (isDay && sStart) {
          xFrac = Math.max(0, Math.min(1, (s.t - sStart) / sessionDuration));
        } else {
          xFrac = i / (series.length - 1);
        }
        const x = padLeft + xFrac * cw;
        const y = padTop + ch - ((s.c - min) / range) * ch;
        return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), val: s.c, t: s.t };
      });

      const strokePath = 'M ' + pts.map(p => p.x + ',' + p.y).join(' L ');
      const areaPath = strokePath + ' L ' + pts[pts.length - 1].x + ',' + (padTop + ch) + ' L ' + pts[0].x + ',' + (padTop + ch) + ' Z';

      const isPos = vals[vals.length - 1] >= (baselineVal || vals[0]);
      const themeColor = isPos ? '#00c805' : '#ff3b30';

      const midVal = (max + min) / 2;
      const midY = padTop + ch / 2;

      let baseSvg = '';
      if (baselineVal && baselineVal >= min && baselineVal <= max) {
        const by = padTop + ch - ((baselineVal - min) / range) * ch;
        baseSvg = '<line class="base-line" x1="' + padLeft + '" y1="' + by.toFixed(1) + '" x2="' + (padLeft + cw) + '" y2="' + by.toFixed(1) + '" />';
      }

      let dayMarkersSvg = '';
      if (!isDay) {
        let lastDay = '';
        const dayEndPts = [];
        pts.forEach((p, idx) => {
          const dayStr = formatDay(p.t);
          if (lastDay && dayStr !== lastDay) {
            dayMarkersSvg += '<line class="day-divider" x1="' + p.x + '" y1="' + padTop + '" x2="' + p.x + '" y2="' + (padTop + ch) + '" />';
            dayEndPts.push(pts[idx - 1]);
          }
          lastDay = dayStr;
        });
        dayEndPts.push(pts[pts.length - 1]);
        dayEndPts.forEach(dp => {
          if (dp) dayMarkersSvg += '<circle class="day-dot" cx="' + dp.x + '" cy="' + dp.y + '" r="3" fill="' + themeColor + '" />';
        });
      }

      const lastPt = pts[pts.length - 1];
      const liveDotSvg = \`
        <g>
          <circle class="live-dot-outer" cx="\${lastPt.x}" cy="\${lastPt.y}" r="6" fill="\${themeColor}" opacity="0.4" />
          <circle cx="\${lastPt.x}" cy="\${lastPt.y}" r="4.5" fill="\${themeColor}" stroke="#ffffff" stroke-width="1.8" />
        </g>
      \`;

      const fmtY = v => v >= 1000 ? v.toFixed(0) : v >= 10 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toFixed(4);

      let xStart, xMid, xEnd;
      if (isDay && sStart && sEnd) {
        xStart = formatTime(sStart);
        xMid = formatTime(sStart + sessionDuration / 2);
        xEnd = formatTime(sEnd);
      } else {
        xStart = formatDay(series[0].t);
        xMid = formatDay(series[Math.floor(series.length / 2)].t);
        xEnd = formatDay(series[series.length - 1].t);
      }

      return \`
        <svg viewBox="0 0 \${w} \${h}" id="\${id}" 
             data-pad-left="\${padLeft}" data-cw="\${cw}" data-points='\${JSON.stringify(pts)}' 
             onpointermove="scrubExact(event, '\${id}')" onpointerleave="leaveExact('\${id}')">
          <line class="grid-line" x1="\${padLeft}" y1="\${padTop}" x2="\${padLeft + cw}" y2="\${padTop}" />
          <line class="grid-line" x1="\${padLeft}" y1="\${midY.toFixed(1)}" x2="\${padLeft + cw}" y2="\${midY.toFixed(1)}" />
          <line class="grid-line" x1="\${padLeft}" y1="\${padTop + ch}" x2="\${padLeft + cw}" y2="\${padTop + ch}" />
          \${baseSvg}
          \${dayMarkersSvg}

          <text class="axis-label" x="\${w - 2}" y="\${padTop + 8}" text-anchor="end">\${fmtY(max)}</text>
          <text class="axis-label" x="\${w - 2}" y="\${(midY + 4).toFixed(1)}" text-anchor="end">\${fmtY(midVal)}</text>
          <text class="axis-label" x="\${w - 2}" y="\${padTop + ch}" text-anchor="end">\${fmtY(min)}</text>

          <path class="chart-area" d="\${areaPath}" fill="\${themeColor}" />
          <path class="chart-line" d="\${strokePath}" stroke="\${themeColor}" />
          \${liveDotSvg}

          <text class="axis-label" x="\${padLeft}" y="\${h - 4}">\${xStart}</text>
          <text class="axis-label" x="\${padLeft + cw / 2}" y="\${h - 4}" text-anchor="middle">\${xMid}</text>
          <text class="axis-label" x="\${padLeft + cw}" y="\${h - 4}" text-anchor="end">\${xEnd}</text>

          <g id="\${id}-cursor" style="display:none;">
            <line id="\${id}-vline" class="cursor-line" y1="\${padTop}" y2="\${padTop + ch}" />
            <circle id="\${id}-dot" class="cursor-dot" r="4.5" />
          </g>
        </svg>
      \`;
    }

    function scrubExact(e, id) {
      const svg = document.getElementById(id);
      if (!svg) return;
      const pts = JSON.parse(svg.getAttribute('data-points') || '[]');
      if (!pts.length) return;

      const padLeft = parseFloat(svg.getAttribute('data-pad-left'));
      const cw = parseFloat(svg.getAttribute('data-cw'));

      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());

      let closest = pts[0];
      let minDiff = 999999;
      pts.forEach(p => {
        const diff = Math.abs(p.x - svgP.x);
        if (diff < minDiff) { minDiff = diff; closest = p; }
      });

      const cursor = document.getElementById(id + '-cursor');
      const vline = document.getElementById(id + '-vline');
      const dot = document.getElementById(id + '-dot');
      const readout = document.getElementById(id + '-readout');

      if (cursor && vline && dot) {
        cursor.style.display = 'block';
        vline.setAttribute('x1', closest.x);
        vline.setAttribute('x2', closest.x);
        dot.setAttribute('cx', closest.x);
        dot.setAttribute('cy', closest.y);
      }
      if (readout) {
        const d = new Date(closest.t * 1000);
        const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        const valStr = closest.val >= 100 ? closest.val.toFixed(2) : closest.val >= 1 ? closest.val.toFixed(3) : closest.val.toFixed(4);
        readout.textContent = timeStr + ' | ' + valStr;
      }
    }

    function leaveExact(id) {
      const cursor = document.getElementById(id + '-cursor');
      const readout = document.getElementById(id + '-readout');
      if (cursor) cursor.style.display = 'none';
      if (readout) readout.textContent = '';
    }

    function toggleWeek(id) {
      openWeekDrawers[id] = !openWeekDrawers[id];
      localStorage.setItem('open_drawers', JSON.stringify(openWeekDrawers));
      renderList();
    }

    function toggleAllWeek() {
      allWeekOpen = !allWeekOpen;
      Object.keys(latestData).forEach(k => openWeekDrawers[k] = allWeekOpen);
      localStorage.setItem('open_drawers', JSON.stringify(openWeekDrawers));
      renderList();
    }

    function reorderItem(id, dir) {
      const idx = savedOrder.indexOf(id);
      if (idx === -1) return;
      const targetIdx = idx + dir;
      if (targetIdx < 0 || targetIdx >= savedOrder.length) return;
      const temp = savedOrder[idx];
      savedOrder[idx] = savedOrder[targetIdx];
      savedOrder[targetIdx] = temp;
      localStorage.setItem('user_order', JSON.stringify(savedOrder));
      renderList();
    }

    function sendToTop(id) {
      const idx = savedOrder.indexOf(id);
      if (idx > 0) {
        savedOrder.splice(idx, 1);
        savedOrder.unshift(id);
        localStorage.setItem('user_order', JSON.stringify(savedOrder));
        renderList();
      }
    }

    function sendToBottom(id) {
      const idx = savedOrder.indexOf(id);
      if (idx !== -1 && idx < savedOrder.length - 1) {
        savedOrder.splice(idx, 1);
        savedOrder.push(id);
        localStorage.setItem('user_order', JSON.stringify(savedOrder));
        renderList();
      }
    }

    function renderList() {
      const container = document.getElementById('watchlist');
      if (!Object.keys(latestData).length) return;

      if (!savedOrder.length) {
        savedOrder = Object.keys(latestData);
        localStorage.setItem('user_order', JSON.stringify(savedOrder));
      } else {
        Object.keys(latestData).forEach(k => {
          if (!savedOrder.includes(k)) savedOrder.push(k);
        });
      }

      let html = '';
      savedOrder.forEach(id => {
        const item = latestData[id];
        if (!item) return;

        const dayPos = item.dailyChangePct >= 0;
        const dayBadge = dayPos ? 'up-bg' : 'down-bg';
        const daySign = dayPos ? '+' : '';

        const weekPos = item.weeklyChangePct >= 0;
        const weekBadge = weekPos ? 'up-bg' : 'down-bg';
        const weekSign = weekPos ? '+' : '';

        const formatNumber = num => num >= 1000 ? num.toLocaleString('en-US', { maximumFractionDigits: 1 }) :
                                    num >= 10 ? num.toFixed(2) : num.toFixed(4);

        const priceStr = formatNumber(item.price);

        // Off-market Blue Badge with price, percentage difference, and session tag
        let extHtml = '';
        if (item.extPrice && item.extPrice > 0) {
          const extPriceStr = formatNumber(item.extPrice);
          const extSign = item.extChangePct >= 0 ? '+' : '';
          const extPctStr = item.extChangePct !== null ? `${extSign}${item.extChangePct.toFixed(2)}%` : '';
          extHtml = `
            <span class="ext-price-badge">
              <span class="ext-price">${extPriceStr}</span>
              ${extPctStr ? `<span class="ext-pct">${extPctStr}</span>` : ''}
              <span class="ext-label">${item.extLabel || 'EXT'}</span>
            </span>
          `;
        }

        let flashClass = '';
        if (previousPrices[id] !== undefined && previousPrices[id] !== item.price) {
          flashClass = item.price > previousPrices[id] ? 'flash-up' : 'flash-down';
        }
        previousPrices[id] = item.price;

        const daySvgId = 'day-' + id.replace(/[^a-zA-Z0-9]/g, '_');
        const weekSvgId = 'week-' + id.replace(/[^a-zA-Z0-9]/g, '_');

        const isWeekOpen = !!openWeekDrawers[id];
        const daySvg = buildSvg(daySvgId, item.daySeries, item.dailyPrevClose, true, item.sessionStart, item.sessionEnd);
        const weekSvg = isWeekOpen ? buildSvg(weekSvgId, item.weekSeries, item.weeklyPrevClose, false) : '';

        html += `
          <div class="card" draggable="true" data-id="${item.id}">
            <div class="card-topbar">
              <div class="topbar-left">
                <span class="drag-handle">⋮⋮</span>
                <div class="reorder-btns">
                  <button class="btn-ctrl" onclick="sendToTop('${item.id}')" title="Top">⤒</button>
                  <button class="btn-ctrl" onclick="reorderItem('${item.id}', -1)" title="Up">▲</button>
                  <button class="btn-ctrl" onclick="reorderItem('${item.id}', 1)" title="Down">▼</button>
                  <button class="btn-ctrl" onclick="sendToBottom('${item.id}')" title="Bottom">⤓</button>
                </div>
                <span class="sym">${item.name}</span>
                <span class="price-val ${flashClass}">${priceStr}</span>
                ${extHtml}
                <span class="badge ${dayBadge}">${daySign}${item.dailyChangePct.toFixed(2)}%</span>
                <span class="sub">${item.sub}</span>
              </div>
              <div class="topbar-right">
                <span id="${daySvgId}-readout" class="scrub-readout"></span>
                <button class="week-pill ${isWeekOpen ? 'active' : ''}" onclick="toggleWeek('${item.id}')">1W</button>
              </div>
            </div>

            <div class="chart-box">
              <div class="svg-wrap">${daySvg}</div>
            </div>

            <div class="week-drawer ${isWeekOpen ? 'open' : ''}">
              <div class="week-drawer-hdr">
                <div style="display:flex; align-items:center; gap:6px;">
                  <span class="badge ${weekBadge}">${weekSign}${item.weeklyChangePct.toFixed(2)}%</span>
                  <span class="sub">5D Trend</span>
                </div>
                <span id="${weekSvgId}-readout" class="scrub-readout"></span>
              </div>
              <div class="chart-box">
                <div class="svg-wrap">${weekSvg}</div>
              </div>
            </div>
          </div>
        `;
      });

      container.innerHTML = html;
    }

    async function poll() {
      try {
        const res = await fetch('/api/data');
        const json = await res.json();
        if (json.items && json.items.length) {
          json.items.forEach(i => latestData[i.id] = i);
          renderList();
        }
      } catch (e) {
        console.error('Polling error', e);
      }
    }

    poll();
    setInterval(poll, 1500);
  </script>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
