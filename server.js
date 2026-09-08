const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const BASE_SYMBOLS = [
  { sym: 'CL=F', name: 'USOIL', sub: 'CFDs on WTI Crude Oil', isCrypto: false, isCommodity: true },
  { sym: 'GC=F', name: 'GOLD', sub: 'CFDs on Gold', isCrypto: false, isCommodity: true },
  { sym: 'SI=F', name: 'SILVER', sub: 'CFDs on Silver', isCrypto: false, isCommodity: true },
  { sym: 'BTC-USD', name: 'BTCUSD', sub: 'Bitcoin / U.S. Dollar', isCrypto: true, isCommodity: false },
  { sym: 'MSTR', name: 'MSTR', sub: 'Strategy Inc', isCrypto: false, isCommodity: false },
  { sym: 'MARA', name: 'MARA', sub: 'MARA Holdings, Inc.', isCrypto: false, isCommodity: false },
  { sym: 'IREN', name: 'IREN', sub: 'IREN LIMITED', isCrypto: false, isCommodity: false },
  { sym: 'NBIS', name: 'NBIS', sub: 'Nebius Group N.V.', isCrypto: false, isCommodity: false },
  { sym: 'CRWV', name: 'CRWV', sub: 'CoreWeave, Inc.', isCrypto: false, isCommodity: false },
  { sym: 'ORCL', name: 'ORCL', sub: 'Oracle Corporation', isCrypto: false, isCommodity: false },
  { sym: 'CIFR', name: 'CIFR', sub: 'Cipher Digital Inc.', isCrypto: false, isCommodity: false },
  { sym: 'BTDR', name: 'BTDR', sub: 'Bitdeer Technologies Group', isCrypto: false, isCommodity: false },
  { sym: 'SMCI', name: 'SMCI', sub: 'Super Micro Computer, Inc.', isCrypto: false, isCommodity: false },
  { sym: 'SLNH', name: 'SLNH', sub: 'Soluna Holdings, Inc.', isCrypto: false, isCommodity: false },
  { sym: 'WULF', name: 'WULF', sub: 'TeraWulf Inc.', isCrypto: false, isCommodity: false }
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

// Filters ticks strictly to regular cash session (09:30 - 16:00 ET)
function isRegularUsTick(ts) {
  const d = new Date(ts * 1000);
  const etStr = d.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= (9 * 60 + 30) && mins <= (16 * 60);
}

async function fetchTicker(item) {
  const symbol = item.sym;
  // Cache-busting URL parameter ensures fresh quotes from Yahoo CDN
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=5m&includePrePost=true&nocache=${Date.now()}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const r = json.chart.result[0];
  const meta = r.meta;
  const times = r.timestamp || [];
  const quotes = r.indicators.quote[0].close || [];

  const rawHistory = [];
  for (let i = 0; i < times.length; i++) {
    if (quotes[i] !== null && quotes[i] !== undefined) {
      rawHistory.push({ t: times[i], c: quotes[i] });
    }
  }

  // 1. Regular market calculations only
  const regPrice = meta.regularMarketPrice || (rawHistory.length ? rawHistory[rawHistory.length - 1].c : 0);
  const dailyPrevClose = meta.previousClose || meta.regularMarketPreviousClose || (rawHistory.length ? rawHistory[0].c : 1);
  const weeklyPrevClose = meta.chartPreviousClose || (rawHistory.length ? rawHistory[0].c : 1);

  // 2. Off-market (extended) price detection
  let extPrice = null;
  const lastTick = rawHistory.length ? rawHistory[rawHistory.length - 1] : null;

  if (meta.postMarketPrice && Math.abs(meta.postMarketPrice - regPrice) > 0.0001) {
    extPrice = meta.postMarketPrice;
  } else if (meta.preMarketPrice && Math.abs(meta.preMarketPrice - regPrice) > 0.0001) {
    extPrice = meta.preMarketPrice;
  } else if (lastTick && !item.isCrypto && !item.isCommodity) {
    if (!isRegularUsTick(lastTick.t) && Math.abs(lastTick.c - regPrice) > 0.0001) {
      extPrice = lastTick.c;
    }
  }

  // 3. Strictly isolate regular ticks for charts (no pre/post/overnight in candles)
  let regHistory = rawHistory;
  if (!item.isCrypto && !item.isCommodity) {
    regHistory = rawHistory.filter(h => isRegularUsTick(h.t));
  }

  // Determine latest regular day boundary
  let daySeries = [];
  let sStart = 0;
  let sEnd = 0;

  if (regHistory.length > 0) {
    const lastRegT = regHistory[regHistory.length - 1].t;
    const lastDateStr = new Date(lastRegT * 1000).toDateString();
    daySeries = regHistory.filter(h => new Date(h.t * 1000).toDateString() === lastDateStr);

    if (daySeries.length > 0) {
      sStart = daySeries[0].t;
      sEnd = sStart + 23400; // Standard 6.5h regular session (09:30 - 16:00 ET)
    }
  }

  return {
    symbol,
    price: regPrice,
    extPrice,
    dailyPrevClose,
    weeklyPrevClose,
    sessionStart: sStart,
    sessionEnd: sEnd,
    daySeries,
    weekSeries: regHistory
  };
}

async function syncAll() {
  const map = {};
  await Promise.allSettled(
    BASE_SYMBOLS.map(async (item) => {
      try {
        map[item.name] = await fetchTicker(item);
      } catch (e) {
        console.error(`Error loading ${item.sym}:`, e.message);
      }
    })
  );

  const results = [];

  // Base assets
  for (const item of BASE_SYMBOLS) {
    const d = map[item.name];
    if (!d || !d.daySeries.length) continue;

    const dailyChangePct = ((d.price - d.dailyPrevClose) / d.dailyPrevClose) * 100;
    const weeklyChangePct = ((d.price - d.weeklyPrevClose) / d.weeklyPrevClose) * 100;

    let extChangePct = null;
    if (d.extPrice && d.price > 0) {
      extChangePct = ((d.extPrice - d.price) / d.price) * 100;
    }

    results.push({
      id: item.name,
      name: item.name,
      sub: item.sub,
      price: d.price,
      extPrice: d.extPrice,
      extChangePct,
      dailyPrevClose: d.dailyPrevClose,
      weeklyPrevClose: d.weeklyPrevClose,
      dailyChangePct,
      weeklyChangePct,
      sessionStart: d.sessionStart,
      sessionEnd: d.sessionEnd,
      daySeries: d.daySeries,
      weekSeries: d.weekSeries
    });
  }

  // Ratios (Pure regular session calculations)
  for (const pair of RATIO_PAIRS) {
    const d1 = map[pair.t1];
    const d2 = map[pair.t2];
    if (!d1 || !d2 || !d1.daySeries.length || !d2.daySeries.length) continue;

    // Regular ratio
    const curRatio = d1.price / d2.price;
    const prevRatio = d1.dailyPrevClose / d2.dailyPrevClose;
    const weeklyPrevRatio = d1.weeklyPrevClose / d2.weeklyPrevClose;

    const dailyChangePct = ((curRatio - prevRatio) / prevRatio) * 100;
    const weeklyChangePct = ((curRatio - weeklyPrevRatio) / weeklyPrevRatio) * 100;

    // Extended ratio (only if either stock has an active off-market price)
    let extRatio = null;
    let extRatioPct = null;
    if (d1.extPrice || d2.extPrice) {
      const p1 = d1.extPrice || d1.price;
      const p2 = d2.extPrice || d2.price;
      if (p2 > 0) {
        extRatio = p1 / p2;
        extRatioPct = ((extRatio - curRatio) / curRatio) * 100;
      }
    }

    // Match regular intraday ticks for ratio chart
    const map2 = new Map(d2.daySeries.map(h => [h.t, h.c]));
    const matchedDay = d1.daySeries
      .filter(h => map2.has(h.t))
      .map(h => ({ t: h.t, c: h.c / map2.get(h.t) }));

    const map2Week = new Map(d2.weekSeries.map(h => [h.t, h.c]));
    const matchedWeek = d1.weekSeries
      .filter(h => map2Week.has(h.t))
      .map(h => ({ t: h.t, c: h.c / map2Week.get(h.t) }));

    const id = `${pair.t1}/${pair.t2}`;
    results.push({
      id,
      name: id,
      sub: 'Spread',
      price: curRatio,
      extPrice: extRatio,
      extChangePct: extRatioPct,
      dailyPrevClose: prevRatio,
      weeklyPrevClose: weeklyPrevRatio,
      dailyChangePct,
      weeklyChangePct,
      sessionStart: Math.max(d1.sessionStart, d2.sessionStart),
      sessionEnd: Math.max(d1.sessionEnd, d2.sessionEnd),
      daySeries: matchedDay.length ? matchedDay : d1.daySeries,
      weekSeries: matchedWeek.length ? matchedWeek : d1.weekSeries
    });
  }

  if (results.length > 0) {
    CACHED_DATA = results;
    LAST_UPDATE = Date.now();
  }
}

// Low-latency polling every 2.5 seconds
syncAll();
setInterval(syncAll, 2500);

// API endpoint with aggressive anti-cache headers
app.get('/api/data', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.json({ updated: LAST_UPDATE, serverTime: Date.now(), items: CACHED_DATA });
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
      --blue-ext: #38bdf8;
      --blue-ext-bg: rgba(56, 189, 248, 0.15);
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
      --blue-ext: #38bdf8;
      --blue-ext-bg: rgba(56, 189, 248, 0.15);
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
      --blue-ext: #38bdf8;
      --blue-ext-bg: rgba(56, 189, 248, 0.15);
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
      --blue-ext: #0284c7;
      --blue-ext-bg: rgba(2, 132, 199, 0.15);
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
      --blue-ext: #0284c7;
      --blue-ext-bg: rgba(2, 132, 199, 0.15);
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
    .live-age { color: var(--text-sub); font-weight: 500; font-size: 0.68rem; margin-left: 2px; }

    .header-actions { display: flex; align-items: center; gap: 6px; }
    .action-btn, select.theme-select {
      background: var(--btn-bg); border: 1px solid var(--btn-border); color: var(--text);
      font-size: 0.72rem; font-weight: 700; padding: 5px 8px; border-radius: 5px; outline: none; cursor: pointer;
    }
    .action-btn.active { background: #00c805; color: #000; border-color: #00c805; }

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

    /* Original regular price */
    .price-val {
      font-size: 1.12rem;
      font-weight: 800;
      padding: 1px 4px;
      border-radius: 4px;
      white-space: nowrap;
      display: inline-block;
    }
    .badge {
      font-size: 0.75rem;
      font-weight: 800;
      padding: 2px 5px;
      border-radius: 4px;
      white-space: nowrap;
    }

    /* Off-market blue price style (No labels) */
    .ext-block {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: 2px;
    }
    .ext-price-val {
      color: var(--blue-ext);
      font-size: 0.95rem;
      font-weight: 800;
      white-space: nowrap;
    }
    .ext-badge {
      background: var(--blue-ext-bg);
      color: var(--blue-ext);
      font-size: 0.68rem;
      font-weight: 800;
      padding: 1px 4px;
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

    /* Chart Canvas strictly regular session */
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
      <div class="status">
        <div class="dot"></div> LIVE <span id="liveAge" class="live-age"></span>
      </div>
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
    let lastDataTime = Date.now();

    // Timer indicating how many seconds ago data refreshed
    setInterval(() => {
      const sec = Math.round((Date.now() - lastDataTime) / 1000);
      const el = document.getElementById('liveAge');
      if (el) el.textContent = '• ' + sec + 's ago';
    }, 1000);

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

      // Regular cash session span: 6.5 hours (23400s)
      const sessionDuration = (sEnd && sStart && sEnd > sStart) ? (sEnd - sStart) : 23400;

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

        const priceStr = item.price >= 1000 ? item.price.toLocaleString('en-US', { maximumFractionDigits: 1 }) :
                         item.price >= 10 ? item.price.toFixed(2) : item.price.toFixed(4);

        // Off-market price in blue (No labels)
        let extHtml = '';
        if (item.extPrice && Math.abs(item.extPrice - item.price) > 0.0001) {
          const extStr = item.extPrice >= 1000 ? item.extPrice.toLocaleString('en-US', { maximumFractionDigits: 1 }) :
                         item.extPrice >= 10 ? item.extPrice.toFixed(2) : item.extPrice.toFixed(4);
          const extSign = item.extChangePct >= 0 ? '+' : '';
          extHtml = \`
            <div class="ext-block">
              <span class="ext-price-val">\${extStr}</span>
              <span class="ext-badge">\${extSign}\${item.extChangePct.toFixed(2)}%</span>
            </div>
          \`;
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

        html += \`
          <div class="card" draggable="true" data-id="\${item.id}">
            <div class="card-topbar">
              <div class="topbar-left">
                <span class="drag-handle">⋮⋮</span>
                <div class="reorder-btns">
                  <button class="btn-ctrl" onclick="sendToTop('\${item.id}')" title="Top">⤒</button>
                  <button class="btn-ctrl" onclick="reorderItem('\${item.id}', -1)" title="Up">▲</button>
                  <button class="btn-ctrl" onclick="reorderItem('\${item.id}', 1)" title="Down">▼</button>
                  <button class="btn-ctrl" onclick="sendToBottom('\${item.id}')" title="Bottom">⤓</button>
                </div>
                <span class="sym">\${item.name}</span>
                <span class="price-val \${flashClass}">\${priceStr}</span>
                <span class="badge \${dayBadge}">\${daySign}\${item.dailyChangePct.toFixed(2)}%</span>
                \${extHtml}
                <span class="sub">\${item.sub}</span>
              </div>
              <div class="topbar-right">
                <span id="\${daySvgId}-readout" class="scrub-readout"></span>
                <button class="week-pill \${isWeekOpen ? 'active' : ''}" onclick="toggleWeek('\${item.id}')">1W</button>
              </div>
            </div>

            <div class="chart-box">
              <div class="svg-wrap">\${daySvg}</div>
            </div>

            <div class="week-drawer \${isWeekOpen ? 'open' : ''}">
              <div class="week-drawer-hdr">
                <div style="display:flex; align-items:center; gap:6px;">
                  <span class="badge \${weekBadge}">\${weekSign}\${item.weeklyChangePct.toFixed(2)}%</span>
                  <span class="sub">5D Trend</span>
                </div>
                <span id="\${weekSvgId}-readout" class="scrub-readout"></span>
              </div>
              <div class="chart-box">
                <div class="svg-wrap">\${weekSvg}</div>
              </div>
            </div>
          </div>
        \`;
      });

      container.innerHTML = html;
    }

    async function poll() {
      try {
        // Cache-busting timestamp prevents Android Chrome disk cache
        const res = await fetch('/api/data?_=' + Date.now(), { cache: 'no-store' });
        const json = await res.json();
        if (json.items && json.items.length) {
          json.items.forEach(i => latestData[i.id] = i);
          lastDataTime = Date.now();
          renderList();
        }
      } catch (e) {
        console.error('Polling error', e);
      }
    }

    poll();
    setInterval(poll, 2000);
  </script>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
