const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const BASE_SYMBOLS = [
  { sym: 'CL=F', name: 'USOIL', sub: 'CFDs on WTI Crude Oil' },
  { sym: 'GC=F', name: 'GOLD', sub: 'CFDs on Gold' },
  { sym: 'SI=F', name: 'SILVER', sub: 'CFDs on Silver' },
  { sym: 'BTC-USD', name: 'BTCUSD', sub: 'Bitcoin / U.S. Dollar' },
  { sym: 'MSTR', name: 'MSTR', sub: 'Strategy Inc' },
  { sym: 'MARA', name: 'MARA', sub: 'MARA Holdings, Inc.' },
  { sym: 'IREN', name: 'IREN', sub: 'IREN LIMITED' },
  { sym: 'NBIS', name: 'NBIS', sub: 'Nebius Group N.V.' },
  { sym: 'CRWV', name: 'CRWV', sub: 'CoreWeave, Inc.' },
  { sym: 'ORCL', name: 'ORCL', sub: 'Oracle Corporation' },
  { sym: 'CIFR', name: 'CIFR', sub: 'Cipher Digital Inc.' },
  { sym: 'BTDR', name: 'BTDR', sub: 'Bitdeer Technologies Group' },
  { sym: 'SMCI', name: 'SMCI', sub: 'Super Micro Computer, Inc.' },
  { sym: 'SLNH', name: 'SLNH', sub: 'Soluna Holdings, Inc.' },
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

async function fetchTicker(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=5m&includePrePost=false`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
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

  // Determine standard regular market hours (6.5 hours)
  const reg = meta.currentTradingPeriod?.regular;
  let sessionStart = reg?.start;
  let sessionEnd = reg?.end;

  const lastTickT = history.length ? history[history.length - 1].t : 0;
  if (!sessionStart || lastTickT < sessionStart - 3600) {
    const lastDate = new Date(lastTickT * 1000).toDateString();
    const sameDay = history.filter(h => new Date(h.t * 1000).toDateString() === lastDate);
    if (sameDay.length) {
      sessionStart = sameDay[0].t;
      sessionEnd = sessionStart + 23400; // standard 6.5h session
    } else {
      sessionStart = lastTickT - 23400;
      sessionEnd = lastTickT;
    }
  }

  return { symbol, price: curPrice, dailyPrevClose, weeklyPrevClose, sessionStart, sessionEnd, history };
}

async function syncAll() {
  const map = {};
  await Promise.allSettled(
    BASE_SYMBOLS.map(async (item) => {
      try {
        map[item.sym] = await fetchTicker(item.sym);
      } catch (e) {
        console.error(`Error loading ${item.sym}:`, e.message);
      }
    })
  );

  const results = [];

  // 1. Base Singles
  for (const item of BASE_SYMBOLS) {
    const d = map[item.sym];
    if (!d || !d.history.length) continue;

    const curPrice = d.price;
    const dailyChangePct = ((curPrice - d.dailyPrevClose) / d.dailyPrevClose) * 100;
    const weeklyChangePct = ((curPrice - d.weeklyPrevClose) / d.weeklyPrevClose) * 100;

    const dayTicks = d.history.filter(h => h.t >= (d.sessionStart - 300));
    const dayHistory = dayTicks.length > 3 ? dayTicks : d.history.slice(-78);

    results.push({
      id: item.name,
      name: item.name,
      sub: item.sub,
      price: curPrice,
      dailyPrevClose: d.dailyPrevClose,
      weeklyPrevClose: d.weeklyPrevClose,
      dailyChangePct,
      weeklyChangePct,
      sessionStart: d.sessionStart,
      sessionEnd: d.sessionEnd,
      daySeries: dayHistory,
      weekSeries: d.history
    });
  }

  // 2. Ratio Spreads
  for (const pair of RATIO_PAIRS) {
    const d1 = map[pair.t1];
    const d2 = map[pair.t2];
    if (!d1 || !d2 || !d1.history.length || !d2.history.length) continue;

    const map2 = new Map(d2.history.map(h => [h.t, h.c]));
    const matched = d1.history
      .filter(h => map2.has(h.t))
      .map(h => ({ t: h.t, c: h.c / map2.get(h.t) }));

    if (!matched.length) continue;

    const curRatio = matched[matched.length - 1].c;
    const dailyPrevRatio = d1.dailyPrevClose / d2.dailyPrevClose;
    const weeklyPrevRatio = d1.weeklyPrevClose / d2.weeklyPrevClose;

    const dailyChangePct = ((curRatio - dailyPrevRatio) / dailyPrevRatio) * 100;
    const weeklyChangePct = ((curRatio - weeklyPrevRatio) / weeklyPrevRatio) * 100;

    const sessionStart = Math.max(d1.sessionStart, d2.sessionStart);
    const sessionEnd = Math.max(d1.sessionEnd, d2.sessionEnd);
    const dayTicks = matched.filter(m => m.t >= (sessionStart - 300));
    const dayHistory = dayTicks.length > 3 ? dayTicks : matched.slice(-78);

    const id = `${pair.t1}/${pair.t2}`;
    results.push({
      id,
      name: id,
      sub: 'Spread',
      price: curRatio,
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
      --card-bg: #0c0d11;
      --card-border: #181b24;
      --chart-bg: #040507;
      --text: #f3f5f9;
      --text-sub: #697188;
      --axis: #525974;
      --grid: #151822;
      --base: #373e54;
      --btn-bg: #141722;
      --btn-border: #23283a;
      --flash-up: rgba(0, 230, 100, 0.85);
      --flash-down: rgba(255, 60, 60, 0.85);
    }
    :root[data-theme="darkgray"] {
      --bg: #131417;
      --card-bg: #1c1d22;
      --card-border: #292b33;
      --chart-bg: #16171b;
      --text: #f3f5f9;
      --text-sub: #828a9e;
      --axis: #6e768b;
      --grid: #252730;
      --base: #42495d;
      --btn-bg: #262830;
      --btn-border: #353844;
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
      --flash-up: rgba(16, 185, 129, 0.7);
      --flash-down: rgba(239, 68, 68, 0.7);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-feature-settings: "tnum" 1; }
    body { background: var(--bg); color: var(--text); padding: 10px 12px 60px; user-select: none; -webkit-tap-highlight-color: transparent; }

    header { display: flex; justify-content: space-between; align-items: center; padding: 4px 6px 12px; border-bottom: 1px solid var(--card-border); gap: 8px; flex-wrap: wrap; }
    .header-left { display: flex; align-items: baseline; gap: 8px; }
    h1 { font-size: 1.1rem; font-weight: 800; letter-spacing: 0.5px; }
    .status { font-size: 0.72rem; color: #00c805; display: flex; align-items: center; gap: 5px; font-weight: 700; }
    .dot { width: 7px; height: 7px; background: #00c805; border-radius: 50%; box-shadow: 0 0 6px #00c805; }

    .header-actions { display: flex; align-items: center; gap: 6px; }
    .action-btn, select.theme-select {
      background: var(--btn-bg); border: 1px solid var(--btn-border); color: var(--text);
      font-size: 0.72rem; font-weight: 700; padding: 5px 8px; border-radius: 5px; outline: none; cursor: pointer;
    }
    .action-btn.active { background: #00c805; color: #000; border-color: #00c805; }

    /* Layout Containers */
    .watchlist { margin-top: 10px; }
    .watchlist.card-view {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(430px, 1fr));
      gap: 10px;
    }
    .watchlist.list-view {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 10px 12px;
      transition: background 0.2s, border-color 0.2s;
    }
    .card.dragging { opacity: 0.35; border: 1px dashed #00c805; }

    .main-row {
      display: grid;
      grid-template-columns: minmax(130px, 155px) 1fr;
      align-items: center;
      gap: 12px;
    }

    .meta-block { display: flex; flex-direction: column; gap: 3px; }
    .top-meta { display: flex; align-items: center; gap: 5px; }
    .drag-handle { color: var(--text-sub); cursor: grab; font-size: 1rem; line-height: 1; }
    .reorder-btns { display: flex; gap: 2px; }
    .btn-ctrl {
      background: var(--btn-bg); border: 1px solid var(--btn-border); color: var(--text-sub);
      font-size: 0.65rem; padding: 2px 4px; border-radius: 3px; cursor: pointer; line-height: 1;
    }
    .btn-ctrl:active { background: #00c805; color: #000; }
    .sym { font-size: 0.95rem; font-weight: 800; white-space: nowrap; }

    .price-group {
      display: flex;
      align-items: baseline;
      gap: 6px;
      margin-top: 2px;
    }
    .price-val {
      font-size: 1.15rem;
      font-weight: 800;
      padding: 1px 4px;
      border-radius: 4px;
      display: inline-block;
    }
    .badge {
      font-size: 0.75rem;
      font-weight: 800;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .up-bg { background: rgba(0, 200, 5, 0.16); color: #00c805; }
    .down-bg { background: rgba(255, 59, 48, 0.16); color: #ff3b30; }

    .sub-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 2px;
    }
    .sub { font-size: 0.68rem; color: var(--text-sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 105px; font-weight: 500; }
    .week-pill {
      background: var(--btn-bg); border: 1px solid var(--btn-border); color: var(--text-sub);
      font-size: 0.65rem; font-weight: 800; padding: 1px 6px; border-radius: 4px; cursor: pointer;
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

    /* Expanded Chart Canvas */
    .chart-box {
      background: var(--chart-bg);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 6px 8px;
      position: relative;
    }
    .chart-hdr {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2px;
    }
    .chart-label { font-size: 0.68rem; font-weight: 800; color: var(--text-sub); }
    .scrub-readout { font-size: 0.72rem; color: #00c805; font-weight: 800; text-align: right; }

    .svg-wrap { width: 100%; height: 115px; position: relative; }
    svg { width: 100%; height: 100%; overflow: visible; display: block; }

    .axis-label { font-size: 10px; fill: var(--axis); font-weight: 700; }
    .grid-line { stroke: var(--grid); stroke-width: 1; }
    .base-line { stroke: var(--base); stroke-dasharray: 3,3; stroke-width: 1.2; }
    .day-divider { stroke: var(--grid); stroke-width: 1; stroke-dasharray: 2,2; }
    .chart-line { fill: none; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
    .chart-area { stroke: none; opacity: 0.12; }
    .day-dot { stroke: var(--chart-bg); stroke-width: 1.2; }

    /* Glowing Live Price Beacon */
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
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid var(--card-border);
    }
    .week-drawer.open { display: block; }
  </style>
</head>
<body>

  <header>
    <div class="header-left">
      <h1>RATIOS & STOCKS</h1>
      <div class="status"><div class="dot"></div> LIVE</div>
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

    // View Mode Initialization
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

    // Theme Initialization
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
      const w = 360, h = 115;
      const padTop = 10, padBtm = 18, padLeft = 6, padRight = 50;
      const ch = h - padTop - padBtm; // 87
      const cw = w - padLeft - padRight; // 304

      const vals = series.map(s => s.c);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const range = max === min ? 1 : max - min;

      // In 1D mode, X-axis spans the full trading session bounds
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

      // Glowing current price beacon point
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
          <text class="axis-label" x="\${w - 2}" y="\${(midY + 3).toFixed(1)}" text-anchor="end">\${fmtY(midVal)}</text>
          <text class="axis-label" x="\${w - 2}" y="\${padTop + ch}" text-anchor="end">\${fmtY(min)}</text>

          <path class="chart-area" d="\${areaPath}" fill="\${themeColor}" />
          <path class="chart-line" d="\${strokePath}" stroke="\${themeColor}" />
          \${liveDotSvg}

          <text class="axis-label" x="\${padLeft}" y="\${h - 3}">\${xStart}</text>
          <text class="axis-label" x="\${padLeft + cw / 2}" y="\${h - 3}" text-anchor="middle">\${xMid}</text>
          <text class="axis-label" x="\${padLeft + cw}" y="\${h - 3}" text-anchor="end">\${xEnd}</text>

          <g id="\${id}-cursor" style="display:none;">
            <line id="\${id}-vline" class="cursor-line" y1="\${padTop}" y2="\${padTop + ch}" />
            <circle id="\${id}-dot" class="cursor-dot" r="4" />
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
            <div class="main-row">
              <div class="meta-block">
                <div class="top-meta">
                  <div class="drag-handle">⋮⋮</div>
                  <div class="reorder-btns">
                    <button class="btn-ctrl" onclick="sendToTop('\${item.id}')" title="Top">⤒</button>
                    <button class="btn-ctrl" onclick="reorderItem('\${item.id}', -1)" title="Up">▲</button>
                    <button class="btn-ctrl" onclick="reorderItem('\${item.id}', 1)" title="Down">▼</button>
                    <button class="btn-ctrl" onclick="sendToBottom('\${item.id}')" title="Bottom">⤓</button>
                  </div>
                  <div class="sym">\${item.name}</div>
                </div>

                <div class="price-group">
                  <span class="price-val \${flashClass}">\${priceStr}</span>
                  <span class="badge \${dayBadge}">\${daySign}\${item.dailyChangePct.toFixed(2)}%</span>
                </div>

                <div class="sub-meta">
                  <div class="sub">\${item.sub}</div>
                  <button class="week-pill \${isWeekOpen ? 'active' : ''}" onclick="toggleWeek('\${item.id}')">1W</button>
                </div>
              </div>

              <div class="chart-box">
                <div class="chart-hdr">
                  <span class="chart-label">1D INTRADAY</span>
                  <span id="\${daySvgId}-readout" class="scrub-readout"></span>
                </div>
                <div class="svg-wrap">\${daySvg}</div>
              </div>
            </div>

            <div class="week-drawer \${isWeekOpen ? 'open' : ''}">
              <div class="chart-box">
                <div class="chart-hdr">
                  <div style="display:flex; align-items:center; gap:6px;">
                    <span class="chart-label">1W TREND</span>
                    <span class="badge \${weekBadge}">\${weekSign}\${item.weeklyChangePct.toFixed(2)}%</span>
                  </div>
                  <span id="\${weekSvgId}-readout" class="scrub-readout"></span>
                </div>
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
