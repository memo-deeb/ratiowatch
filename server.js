const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const BASE_SYMBOLS = [
  { sym: 'CL=F', name: 'USOIL', sub: 'CFDs on WTI Crude' },
  { sym: 'GC=F', name: 'GOLD', sub: 'CFDs on Gold' },
  { sym: 'SI=F', name: 'SILVER', sub: 'CFDs on Silver' },
  { sym: 'BTC-USD', name: 'BTCUSD', sub: 'Bitcoin / USD' },
  { sym: 'MSTR', name: 'MSTR', sub: 'Strategy Inc' },
  { sym: 'MARA', name: 'MARA', sub: 'MARA Holdings' },
  { sym: 'IREN', name: 'IREN', sub: 'IREN LIMITED' },
  { sym: 'NBIS', name: 'NBIS', sub: 'Nebius Group' },
  { sym: 'CRWV', name: 'CRWV', sub: 'CoreWeave, Inc.' },
  { sym: 'ORCL', name: 'ORCL', sub: 'Oracle Corp' },
  { sym: 'CIFR', name: 'CIFR', sub: 'Cipher Digital' },
  { sym: 'BTDR', name: 'BTDR', sub: 'Bitdeer Tech' },
  { sym: 'SMCI', name: 'SMCI', sub: 'Super Micro Computer' },
  { sym: 'SLNH', name: 'SLNH', sub: 'Soluna Holdings' },
  { sym: 'WULF', name: 'WULF', sub: 'TeraWulf Inc.' }
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
const RAW_CACHE = {};

async function fetchTicker(symbol) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=5d&interval=15m&includePrePost=true';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    clearTimeout(t);
    if (!res.ok) return null;

    const json = await res.json();
    const r = json.chart?.result?.[0];
    if (!r) return null;

    const meta = r.meta;
    const times = r.timestamp || [];
    const quotes = r.indicators?.quote?.[0]?.close || [];

    const history = [];
    for (let i = 0; i < times.length; i++) {
      if (quotes[i] !== null && quotes[i] !== undefined) {
        history.push({ t: times[i], c: quotes[i] });
      }
    }
    if (!history.length) return null;

    const curPrice = meta.regularMarketPrice || history[history.length - 1].c;
    const dailyPrevClose = meta.previousClose || meta.regularMarketPreviousClose || history[0].c;
    const weeklyPrevClose = meta.chartPreviousClose || history[0].c;

    const reg = meta.currentTradingPeriod?.regular;
    let sStart = reg?.start;
    let sEnd = reg?.end;
    const now = Math.floor(Date.now() / 1000);
    const lastTick = history[history.length - 1];

    if (!sStart || lastTick.t < sStart - 3600) {
      sStart = lastTick.t - 23400;
      sEnd = lastTick.t;
    }

    let extPrice = null;
    let extLabel = '';
    if (now > sEnd || now < sStart) {
      if (meta.postMarketPrice && Math.abs(meta.postMarketPrice - curPrice) > 0.0001) {
        extPrice = meta.postMarketPrice;
        extLabel = 'AH';
      } else if (meta.preMarketPrice && Math.abs(meta.preMarketPrice - curPrice) > 0.0001) {
        extPrice = meta.preMarketPrice;
        extLabel = 'PRE';
      } else if (lastTick.t > (sEnd + 120) && Math.abs(lastTick.c - curPrice) > 0.0001) {
        extPrice = lastTick.c;
        extLabel = 'AH';
      }
    }

    return { symbol, price: curPrice, extPrice, extLabel, dailyPrevClose, weeklyPrevClose, sStart, sEnd, history };
  } catch (e) {
    return null;
  }
}

async function updateMarketData() {
  await Promise.allSettled(BASE_SYMBOLS.map(async (item) => {
    const d = await fetchTicker(item.sym);
    if (d) RAW_CACHE[item.sym] = d;
  }));

  const list = [];

  for (const item of BASE_SYMBOLS) {
    const d = RAW_CACHE[item.sym];
    if (!d || !d.history.length) continue;

    const cur = d.price;
    const dayPct = ((cur - d.dailyPrevClose) / d.dailyPrevClose) * 100;
    const weekPct = ((cur - d.weeklyPrevClose) / d.weeklyPrevClose) * 100;

    const dayTicks = d.history.filter(h => h.t >= (d.sStart - 300) && h.t <= (d.sEnd + 300));
    const dayHistory = dayTicks.length > 2 ? dayTicks : d.history.slice(-30);

    let extPct = null;
    if (d.extPrice && d.extPrice > 0 && Math.abs(d.extPrice - cur) > 0.0001) {
      extPct = ((d.extPrice - cur) / cur) * 100;
    }

    list.push({
      id: item.name,
      name: item.name,
      sub: item.sub,
      price: cur,
      extPrice: extPct !== null ? d.extPrice : null,
      extPct,
      extLabel: d.extLabel,
      dailyPrev: d.dailyPrevClose,
      weeklyPrev: d.weeklyPrevClose,
      dayPct,
      weekPct,
      sStart: d.sStart,
      sEnd: d.sEnd,
      daySeries: dayHistory,
      weekSeries: d.history
    });
  }

  for (const pair of RATIO_PAIRS) {
    const d1 = RAW_CACHE[pair.t1];
    const d2 = RAW_CACHE[pair.t2];
    if (!d1 || !d2 || !d1.history.length || !d2.history.length) continue;

    const curRatio = d1.price / d2.price;
    const dailyPrevRatio = d1.dailyPrevClose / d2.dailyPrevClose;
    const weeklyPrevRatio = d1.weeklyPrevClose / d2.weeklyPrevClose;

    const dayPct = ((curRatio - dailyPrevRatio) / dailyPrevRatio) * 100;
    const weekPct = ((curRatio - weeklyPrevRatio) / weeklyPrevRatio) * 100;

    const map2 = new Map(d2.history.map(h => [h.t, h.c]));
    const matched = d1.history.filter(h => map2.has(h.t)).map(h => ({ t: h.t, c: h.c / map2.get(h.t) }));

    const sStart = Math.max(d1.sStart, d2.sStart);
    const sEnd = Math.max(d1.sEnd, d2.sEnd);
    const dayTicks = matched.filter(m => m.t >= (sStart - 300) && m.t <= (sEnd + 300));
    const dayHistory = dayTicks.length > 2 ? dayTicks : matched.slice(-30);

    const p1 = d1.extPrice || d1.price;
    const p2 = d2.extPrice || d2.price;

    let extRatio = null;
    let extPct = null;
    let extLabel = '';

    if ((d1.extPrice || d2.extPrice) && p2 > 0) {
      const candidate = p1 / p2;
      if (Math.abs(candidate - curRatio) > 0.0001) {
        extRatio = candidate;
        extPct = ((extRatio - curRatio) / curRatio) * 100;
        extLabel = d1.extLabel || d2.extLabel || 'EXT';
      }
    }

    list.push({
      id: pair.t1 + '/' + pair.t2,
      name: pair.t1 + '/' + pair.t2,
      sub: 'Spread',
      price: curRatio,
      extPrice: extRatio,
      extPct,
      extLabel,
      dailyPrev: dailyPrevRatio,
      weeklyPrev: weeklyPrevRatio,
      dayPct,
      weekPct,
      sStart,
      sEnd,
      daySeries: dayHistory,
      weekSeries: matched
    });
  }

  if (list.length > 0) {
    CACHED_DATA = list;
    LAST_UPDATE = Date.now();
  }
}

updateMarketData();
setInterval(updateMarketData, 3000);

app.get('/api/data', (req, res) => {
  res.json({ updated: LAST_UPDATE, items: CACHED_DATA });
});

app.get('/manifest.json', (req, res) => {
  res.json({
    name: "RatioWatch Pro", short_name: "RatioWatch", start_url: "/", display: "standalone",
    background_color: "#0a0b0e", theme_color: "#0a0b0e",
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
      --bg: #000000; --card-bg: #0b0c10; --card-border: #161822; --chart-bg: #040507;
      --text: #f3f5f9; --text-sub: #6c738c; --axis: #525974; --grid: #151822; --base: #373e54;
      --btn-bg: #141722; --btn-border: #23283a; --ext-blue: #38bdf8; --ext-bg: rgba(56, 189, 248, 0.12);
      --ext-border: rgba(56, 189, 248, 0.35); --flash-up: rgba(0, 230, 100, 0.85); --flash-down: rgba(255, 60, 60, 0.85);
    }
    :root[data-theme="darkgray"] {
      --bg: #111216; --card-bg: #18191f; --card-border: #262832; --chart-bg: #131418;
      --text: #f3f5f9; --text-sub: #828a9e; --axis: #6e768b; --grid: #22242c; --base: #42495d;
      --btn-bg: #22242c; --btn-border: #313542; --ext-blue: #38bdf8; --ext-bg: rgba(56, 189, 248, 0.14);
      --ext-border: rgba(56, 189, 248, 0.35); --flash-up: rgba(0, 230, 100, 0.85); --flash-down: rgba(255, 60, 60, 0.85);
    }
    :root[data-theme="navy"] {
      --bg: #090e1a; --card-bg: #0f172a; --card-border: #1e293b; --chart-bg: #0b1120;
      --text: #f8fafc; --text-sub: #94a3b8; --axis: #64748b; --grid: #1e293b; --base: #3b4252;
      --btn-bg: #1e293b; --btn-border: #334155; --ext-blue: #60a5fa; --ext-bg: rgba(96, 165, 250, 0.14);
      --ext-border: rgba(96, 165, 250, 0.35); --flash-up: rgba(16, 185, 129, 0.85); --flash-down: rgba(239, 68, 68, 0.85);
    }
    :root[data-theme="warm"] {
      --bg: #f3efe6; --card-bg: #ffffff; --card-border: #e0d9cc; --chart-bg: #faf7f2;
      --text: #1f2329; --text-sub: #7a8192; --axis: #8b92a2; --grid: #eae4d7; --base: #b4bccb;
      --btn-bg: #ebe5d8; --btn-border: #dcd3bf; --ext-blue: #0284c7; --ext-bg: rgba(2, 132, 199, 0.12);
      --ext-border: rgba(2, 132, 199, 0.3); --flash-up: rgba(16, 185, 129, 0.7); --flash-down: rgba(239, 68, 68, 0.7);
    }
    :root[data-theme="light"] {
      --bg: #f8fafc; --card-bg: #ffffff; --card-border: #e2e8f0; --chart-bg: #f1f5f9;
      --text: #0f172a; --text-sub: #64748b; --axis: #94a3b8; --grid: #e2e8f0; --base: #cbd5e1;
      --btn-bg: #e2e8f0; --btn-border: #cbd5e1; --ext-blue: #2563eb; --ext-bg: rgba(37, 99, 235, 0.1);
      --ext-border: rgba(37, 99, 235, 0.25); --flash-up: rgba(16, 185, 129, 0.7); --flash-down: rgba(239, 68, 68, 0.7);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-feature-settings: "tnum" 1; }
    body { background: var(--bg); color: var(--text); padding: 8px 10px 60px; user-select: none; -webkit-tap-highlight-color: transparent; }

    header { display: flex; justify-content: space-between; align-items: center; padding: 4px 4px 10px; border-bottom: 1px solid var(--card-border); gap: 8px; flex-wrap: wrap; }
    .header-left { display: flex; align-items: baseline; gap: 8px; }
    h1 { font-size: 1.1rem; font-weight: 800; letter-spacing: 0.5px; }
    .status { font-size: 0.72rem; color: #00c805; display: flex; align-items: center; gap: 5px; font-weight: 700; }
    .dot { width: 7px; height: 7px; background: #00c805; border-radius: 50%; box-shadow: 0 0 6px #00c805; }
    .dot.syncing { background: #eab308; box-shadow: 0 0 6px #eab308; }

    .header-actions { display: flex; align-items: center; gap: 6px; }
    .action-btn, select.theme-select {
      background: var(--btn-bg); border: 1px solid var(--btn-border); color: var(--text);
      font-size: 0.72rem; font-weight: 700; padding: 5px 8px; border-radius: 5px; outline: none; cursor: pointer;
    }

    .watchlist { margin-top: 8px; }
    .watchlist.card-view { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 10px; }
    .watchlist.list-view { display: flex; flex-direction: column; gap: 8px; }

    .notice { text-align: center; padding: 60px 16px; color: var(--text-sub); font-size: 0.9rem; font-weight: 600; }

    .card {
      background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 8px;
      padding: 8px 10px 10px; transition: background 0.2s, border-color 0.2s;
    }
    .card.dragging { opacity: 0.35; border: 1px dashed #00c805; }

    .card-topbar {
      display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: nowrap;
    }
    .topbar-left { display: flex; align-items: center; gap: 6px; min-width: 0; flex-shrink: 1; overflow: hidden; }
    .topbar-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

    .drag-handle { color: var(--text-sub); cursor: grab; font-size: 0.95rem; line-height: 1; }
    .reorder-btns { display: flex; gap: 2px; }
    .btn-ctrl {
      background: var(--btn-bg); border: 1px solid var(--btn-border); color: var(--text-sub);
      font-size: 0.65rem; padding: 2px 4px; border-radius: 3px; cursor: pointer; line-height: 1;
    }
    .btn-ctrl:active { background: #00c805; color: #000; }

    .sym { font-size: 0.95rem; font-weight: 800; white-space: nowrap; }
    .price-val { font-size: 1.12rem; font-weight: 800; padding: 1px 4px; border-radius: 4px; white-space: nowrap; display: inline-block; }

    .ext-price-badge {
      display: inline-flex; align-items: baseline; gap: 4px; color: var(--ext-blue); background: var(--ext-bg);
      border: 1px solid var(--ext-border); padding: 1px 6px; border-radius: 4px; font-size: 0.92rem; font-weight: 800;
      white-space: nowrap; box-shadow: 0 0 8px rgba(56, 189, 248, 0.12);
    }
    .ext-price { font-weight: 800; }
    .ext-pct { font-size: 0.72rem; font-weight: 700; opacity: 0.95; }
    .ext-label { font-size: 0.58rem; font-weight: 900; letter-spacing: 0.4px; opacity: 0.8; text-transform: uppercase; }

    .badge { font-size: 0.75rem; font-weight: 800; padding: 2px 6px; border-radius: 4px; white-space: nowrap; }
    .sub { font-size: 0.68rem; color: var(--text-sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 110px; font-weight: 500; }

    .up-bg { background: rgba(0, 200, 5, 0.16); color: #00c805; }
    .down-bg { background: rgba(255, 59, 48, 0.16); color: #ff3b30; }

    .scrub-readout { font-size: 0.72rem; color: #00c805; font-weight: 800; white-space: nowrap; min-width: 70px; text-align: right; }
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
      width: 100%; background: var(--chart-bg); border: 1px solid var(--card-border);
      border-radius: 6px; padding: 6px 8px; position: relative;
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

    .live-dot-outer { animation: pulseBeacon 2s infinite ease-in-out; transform-origin: center; }
    @keyframes pulseBeacon { 0% { r: 5px; opacity: 0.8; } 50% { r: 9px; opacity: 0.2; } 100% { r: 5px; opacity: 0.8; } }

    .cursor-line { stroke: var(--text); stroke-dasharray: 2,2; stroke-width: 1; opacity: 0.7; }
    .cursor-dot { fill: var(--text); stroke: var(--bg); stroke-width: 2; }

    .week-drawer { display: none; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--card-border); }
    .week-drawer.open { display: block; }
    .week-drawer-hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; font-size: 0.72rem; }
  </style>
</head>
<body>

  <header>
    <div class="header-left">
      <h1>RATIOS & STOCKS</h1>
      <div class="status"><div class="dot" id="liveDot"></div> <span id="statusTxt">CONNECTED</span></div>
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

  <div class="watchlist card-view" id="watchlist">
    <div class="notice">Loading market tickers...</div>
  </div>

  <script>
    var savedOrder = JSON.parse(localStorage.getItem('user_order') || '[]');
    var previousPrices = {};
    var latestData = JSON.parse(localStorage.getItem('cached_ratios') || '{}');
    var openWeekDrawers = JSON.parse(localStorage.getItem('open_drawers') || '{}');
    var allWeekOpen = false;
    window.CHART_STORE = {};

    var currentView = localStorage.getItem('rw_view') || 'card';
    applyViewMode(currentView);

    function applyViewMode(mode) {
      currentView = mode;
      localStorage.setItem('rw_view', mode);
      var container = document.getElementById('watchlist');
      var btn = document.getElementById('viewToggleBtn');
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

    var currentTheme = localStorage.getItem('rw_theme') || 'darkgray';
    document.documentElement.setAttribute('data-theme', currentTheme);
    document.getElementById('themeSelect').value = currentTheme;

    function switchTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('rw_theme', theme);
      renderList(true);
    }

    function formatTime(ts) {
      return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    function formatDay(ts) {
      return new Date(ts * 1000).toLocaleDateString([], { weekday: 'short' });
    }

    function buildSvg(id, series, baselineVal, isDay, sStart, sEnd) {
      if (!series || series.length < 2) return '';
      var w = 440, h = 130;
      var padTop = 10, padBtm = 20, padLeft = 6, padRight = 55;
      var ch = h - padTop - padBtm;
      var cw = w - padLeft - padRight;

      var vals = series.map(function(s) { return s.c; });
      var min = Math.min.apply(null, vals);
      var max = Math.max.apply(null, vals);
      var range = max === min ? 1 : max - min;
      var sessionDuration = (sEnd && sStart && sEnd > sStart) ? (sEnd - sStart) : 23400;

      var pts = series.map(function(s, i) {
        var xFrac = (isDay && sStart) ? Math.max(0, Math.min(1, (s.t - sStart) / sessionDuration)) : (i / (series.length - 1));
        var x = padLeft + xFrac * cw;
        var y = padTop + ch - ((s.c - min) / range) * ch;
        return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), val: s.c, t: s.t };
      });

      window.CHART_STORE[id] = { pts: pts, padLeft: padLeft, cw: cw };

      var strokePath = 'M ' + pts.map(function(p) { return p.x + ',' + p.y; }).join(' L ');
      var areaPath = strokePath + ' L ' + pts[pts.length - 1].x + ',' + (padTop + ch) + ' L ' + pts[0].x + ',' + (padTop + ch) + ' Z';
      var isPos = vals[vals.length - 1] >= (baselineVal || vals[0]);
      var themeColor = isPos ? '#00c805' : '#ff3b30';

      var midVal = (max + min) / 2;
      var midY = padTop + ch / 2;

      var baseSvg = '';
      if (baselineVal && baselineVal >= min && baselineVal <= max) {
        var by = padTop + ch - ((baselineVal - min) / range) * ch;
        baseSvg = '<line class="base-line" x1="' + padLeft + '" y1="' + by.toFixed(1) + '" x2="' + (padLeft + cw) + '" y2="' + by.toFixed(1) + '" />';
      }

      var dayMarkersSvg = '';
      if (!isDay) {
        var lastDay = '';
        var dayEndPts = [];
        pts.forEach(function(p, idx) {
          var dayStr = formatDay(p.t);
          if (lastDay && dayStr !== lastDay) {
            dayMarkersSvg += '<line class="day-divider" x1="' + p.x + '" y1="' + padTop + '" x2="' + p.x + '" y2="' + (padTop + ch) + '" />';
            dayEndPts.push(pts[idx - 1]);
          }
          lastDay = dayStr;
        });
        dayEndPts.push(pts[pts.length - 1]);
        dayEndPts.forEach(function(dp) {
          if (dp) dayMarkersSvg += '<circle class="day-dot" cx="' + dp.x + '" cy="' + dp.y + '" r="3" fill="' + themeColor + '" />';
        });
      }

      var lastPt = pts[pts.length - 1];
      var liveDotSvg = '<g>' +
        '<circle class="live-dot-outer" cx="' + lastPt.x + '" cy="' + lastPt.y + '" r="6" fill="' + themeColor + '" opacity="0.4" />' +
        '<circle cx="' + lastPt.x + '" cy="' + lastPt.y + '" r="4.5" fill="' + themeColor + '" stroke="#ffffff" stroke-width="1.8" />' +
      '</g>';

      var fmtY = function(v) {
        return v >= 1000 ? v.toFixed(0) : v >= 10 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toFixed(4);
      };

      var xStart = (isDay && sStart) ? formatTime(sStart) : formatDay(series[0].t);
      var xMid = (isDay && sStart) ? formatTime(sStart + sessionDuration / 2) : formatDay(series[Math.floor(series.length / 2)].t);
      var xEnd = (isDay && sEnd) ? formatTime(sEnd) : formatDay(series[series.length - 1].t);

      return '<svg viewBox="0 0 ' + w + ' ' + h + '" id="' + id + '" ' +
        'onpointermove="scrubExact(event, \'' + id + '\')" onpointerleave="leaveExact(\'' + id + '\')">' +
        '<line class="grid-line" x1="' + padLeft + '" y1="' + padTop + '" x2="' + (padLeft + cw) + '" y2="' + padTop + '" />' +
        '<line class="grid-line" x1="' + padLeft + '" y1="' + midY.toFixed(1) + '" x2="' + (padLeft + cw) + '" y2="' + midY.toFixed(1) + '" />' +
        '<line class="grid-line" x1="' + padLeft + '" y1="' + (padTop + ch) + '" x2="' + (padLeft + cw) + '" y2="' + (padTop + ch) + '" />' +
        baseSvg +
        dayMarkersSvg +
        '<text class="axis-label" x="' + (w - 2) + '" y="' + (padTop + 8) + '" text-anchor="end">' + fmtY(max) + '</text>' +
        '<text class="axis-label" x="' + (w - 2) + '" y="' + (midY + 4).toFixed(1) + '" text-anchor="end">' + fmtY(midVal) + '</text>' +
        '<text class="axis-label" x="' + (w - 2) + '" y="' + (padTop + ch) + '" text-anchor="end">' + fmtY(min) + '</text>' +
        '<path class="chart-area" d="' + areaPath + '" fill="' + themeColor + '" />' +
        '<path class="chart-line" d="' + strokePath + '" stroke="' + themeColor + '" />' +
        liveDotSvg +
        '<text class="axis-label" x="' + padLeft + '" y="' + (h - 4) + '">' + xStart + '</text>' +
        '<text class="axis-label" x="' + (padLeft + cw / 2) + '" y="' + (h - 4) + '" text-anchor="middle">' + xMid + '</text>' +
        '<text class="axis-label" x="' + (padLeft + cw) + '" y="' + (h - 4) + '" text-anchor="end">' + xEnd + '</text>' +
        '<g id="' + id + '-cursor" style="display:none;">' +
          '<line id="' + id + '-vline" class="cursor-line" y1="' + padTop + '" y2="' + (padTop + ch) + '" />' +
          '<circle id="' + id + '-dot" class="cursor-dot" r="4.5" />' +
        '</g>' +
      '</svg>';
    }

    function scrubExact(e, id) {
      var store = window.CHART_STORE[id];
      if (!store) return;
      var svg = document.getElementById(id);
      if (!svg) return;

      var pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      var svgP = pt.matrixTransform(svg.getScreenCTM().inverse());

      var pts = store.pts;
      var closest = pts[0];
      var minDiff = 999999;
      for (var i = 0; i < pts.length; i++) {
        var diff = Math.abs(pts[i].x - svgP.x);
        if (diff < minDiff) { minDiff = diff; closest = pts[i]; }
      }

      var cursor = document.getElementById(id + '-cursor');
      var vline = document.getElementById(id + '-vline');
      var dot = document.getElementById(id + '-dot');
      var readout = document.getElementById(id + '-readout');

      if (cursor && vline && dot) {
        cursor.style.display = 'block';
        vline.setAttribute('x1', closest.x);
        vline.setAttribute('x2', closest.x);
        dot.setAttribute('cx', closest.x);
        dot.setAttribute('cy', closest.y);
      }
      if (readout) {
        var d = new Date(closest.t * 1000);
        var timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        var valStr = closest.val >= 100 ? closest.val.toFixed(2) : closest.val >= 1 ? closest.val.toFixed(3) : closest.val.toFixed(4);
        readout.textContent = timeStr + ' | ' + valStr;
      }
    }

    function leaveExact(id) {
      var cursor = document.getElementById(id + '-cursor');
      var readout = document.getElementById(id + '-readout');
      if (cursor) cursor.style.display = 'none';
      if (readout) readout.textContent = '';
    }

    function toggleWeek(id) {
      openWeekDrawers[id] = !openWeekDrawers[id];
      localStorage.setItem('open_drawers', JSON.stringify(openWeekDrawers));
      renderList(true);
    }

    function toggleAllWeek() {
      allWeekOpen = !allWeekOpen;
      Object.keys(latestData).forEach(function(k) { openWeekDrawers[k] = allWeekOpen; });
      localStorage.setItem('open_drawers', JSON.stringify(openWeekDrawers));
      renderList(true);
    }

    function reorderItem(id, dir) {
      var idx = savedOrder.indexOf(id);
      if (idx === -1) return;
      var targetIdx = idx + dir;
      if (targetIdx < 0 || targetIdx >= savedOrder.length) return;
      var temp = savedOrder[idx];
      savedOrder[idx] = savedOrder[targetIdx];
      savedOrder[targetIdx] = temp;
      localStorage.setItem('user_order', JSON.stringify(savedOrder));
      renderList(true);
    }

    function sendToTop(id) {
      var idx = savedOrder.indexOf(id);
      if (idx > 0) {
        savedOrder.splice(idx, 1);
        savedOrder.unshift(id);
        localStorage.setItem('user_order', JSON.stringify(savedOrder));
        renderList(true);
      }
    }

    function sendToBottom(id) {
      var idx = savedOrder.indexOf(id);
      if (idx !== -1 && idx < savedOrder.length - 1) {
        savedOrder.splice(idx, 1);
        savedOrder.push(id);
        localStorage.setItem('user_order', JSON.stringify(savedOrder));
        renderList(true);
      }
    }

    function renderList(forceFullRebuild) {
      var container = document.getElementById('watchlist');
      var keys = Object.keys(latestData);
      if (!keys.length) return;

      if (!savedOrder.length) {
        savedOrder = keys;
        localStorage.setItem('user_order', JSON.stringify(savedOrder));
      } else {
        keys.forEach(function(k) {
          if (savedOrder.indexOf(k) === -1) savedOrder.push(k);
        });
      }

      var existingCards = container.querySelectorAll('.card');
      if (existingCards.length === savedOrder.length && !forceFullRebuild) {
        savedOrder.forEach(function(id) {
          var item = latestData[id];
          if (!item) return;

          var card = container.querySelector('[data-id="' + item.id + '"]');
          if (!card) return;

          var pEl = card.querySelector('.price-val');
          var formatNumber = function(num) {
            return num >= 1000 ? num.toLocaleString('en-US', { maximumFractionDigits: 1 }) :
                   num >= 10 ? num.toFixed(2) : num.toFixed(4);
          };

          var newPriceStr = formatNumber(item.price);
          if (pEl && pEl.textContent !== newPriceStr) {
            var flashClass = (previousPrices[id] !== undefined && item.price > previousPrices[id]) ? 'flash-up' : 'flash-down';
            pEl.className = 'price-val ' + flashClass;
            pEl.textContent = newPriceStr;
            previousPrices[id] = item.price;
          }
        });
        return;
      }

      var html = '';
      savedOrder.forEach(function(id) {
        var item = latestData[id];
        if (!item) return;

        var dayPos = item.dayPct >= 0;
        var dayBadge = dayPos ? 'up-bg' : 'down-bg';
        var daySign = dayPos ? '+' : '';

        var weekPos = item.weekPct >= 0;
        var weekBadge = weekPos ? 'up-bg' : 'down-bg';
        var weekSign = weekPos ? '+' : '';

        var formatNumber = function(num) {
          return num >= 1000 ? num.toLocaleString('en-US', { maximumFractionDigits: 1 }) :
                 num >= 10 ? num.toFixed(2) : num.toFixed(4);
        };

        var priceStr = formatNumber(item.price);

        var extHtml = '';
        if (item.extPrice && item.extPrice > 0) {
          var extPriceStr = formatNumber(item.extPrice);
          var extSign = item.extPct >= 0 ? '+' : '';
          var extPctStr = item.extPct !== null ? (extSign + item.extPct.toFixed(2) + '%') : '';
          extHtml = '<span class="ext-price-badge">' +
            '<span class="ext-price">' + extPriceStr + '</span>' +
            (extPctStr ? '<span class="ext-pct">' + extPctStr + '</span>' : '') +
            '<span class="ext-label">' + (item.extLabel || 'EXT') + '</span>' +
          '</span>';
        }

        var daySvgId = 'day-' + id.replace(/[^a-zA-Z0-9]/g, '_');
        var weekSvgId = 'week-' + id.replace(/[^a-zA-Z0-9]/g, '_');

        var isWeekOpen = !!openWeekDrawers[id];
        var daySvg = buildSvg(daySvgId, item.daySeries, item.dailyPrev, true, item.sStart, item.sEnd);
        var weekSvg = isWeekOpen ? buildSvg(weekSvgId, item.weekSeries, item.weeklyPrev, false) : '';

        html += '<div class="card" draggable="true" data-id="' + item.id + '">' +
          '<div class="card-topbar">' +
            '<div class="topbar-left">' +
              '<span class="drag-handle">⋮⋮</span>' +
              '<div class="reorder-btns">' +
                '<button class="btn-ctrl" onclick="sendToTop(\'' + item.id + '\')" title="Top">⤒</button>' +
                '<button class="btn-ctrl" onclick="reorderItem(\'' + item.id + '\', -1)" title="Up">▲</button>' +
                '<button class="btn-ctrl" onclick="reorderItem(\'' + item.id + '\', 1)" title="Down">▼</button>' +
                '<button class="btn-ctrl" onclick="sendToBottom(\'' + item.id + '\')" title="Bottom">⤓</button>' +
              '</div>' +
              '<span class="sym">' + item.name + '</span>' +
              '<span class="price-val">' + priceStr + '</span>' +
              extHtml +
              '<span class="badge ' + dayBadge + '">' + daySign + item.dayPct.toFixed(2) + '%</span>' +
              '<span class="sub">' + item.sub + '</span>' +
            '</div>' +
            '<div class="topbar-right">' +
              '<span id="' + daySvgId + '-readout" class="scrub-readout"></span>' +
              '<button class="week-pill ' + (isWeekOpen ? 'active' : '') + '" onclick="toggleWeek(\'' + item.id + '\')">1W</button>' +
            '</div>' +
          '</div>' +
          '<div class="chart-box"><div class="svg-wrap">' + daySvg + '</div></div>' +
          '<div class="week-drawer ' + (isWeekOpen ? 'open' : '') + '">' +
            '<div class="week-drawer-hdr">' +
              '<div style="display:flex; align-items:center; gap:6px;">' +
                '<span class="badge ' + weekBadge + '">' + weekSign + item.weekPct.toFixed(2) + '%</span>' +
                '<span class="sub">5D Trend</span>' +
              '</div>' +
              '<span id="' + weekSvgId + '-readout" class="scrub-readout"></span>' +
            '</div>' +
            '<div class="chart-box"><div class="svg-wrap">' + weekSvg + '</div></div>' +
          '</div>' +
        '</div>';
      });

      container.innerHTML = html;
    }

    async function poll() {
      try {
        var res = await fetch('/api/data');
        var json = await res.json();
        var dot = document.getElementById('liveDot');
        var txt = document.getElementById('statusTxt');

        if (json.items && json.items.length) {
          var mapped = {};
          json.items.forEach(function(i) { mapped[i.id] = i; });
          latestData = mapped;
          localStorage.setItem('cached_ratios', JSON.stringify(latestData));
          renderList(false);
          if (dot) dot.className = 'dot';
          if (txt) txt.textContent = 'CONNECTED (' + json.items.length + ')';
        }
      } catch (e) {
        var dot = document.getElementById('liveDot');
        var txt = document.getElementById('statusTxt');
        if (dot) dot.className = 'dot syncing';
        if (txt) txt.textContent = 'CONNECTING';
      }
    }

    // Fallback: If cache is empty on startup, paint mock skeleton or trigger immediate poll
    if (Object.keys(latestData).length > 0) {
      renderList(true);
    }
    poll();
    setInterval(poll, 2500);
  </script>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
