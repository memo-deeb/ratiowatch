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
  
  // Explicitly separate daily close (yesterday) from 5-day close (start of chart)
  const dailyPrevClose = meta.previousClose || meta.regularMarketPreviousClose || (history.length ? history[0].c : 1);
  const weeklyPrevClose = meta.chartPreviousClose || (history.length ? history[0].c : 1);
  const sessionStart = meta.currentTradingPeriod?.regular?.start || (history.length ? history[history.length - 1].t - 23400 : 0);

  return { symbol, price: curPrice, dailyPrevClose, weeklyPrevClose, sessionStart, history };
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

  // 1. Process Singles
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
      daySeries: dayHistory,
      weekSeries: d.history
    });
  }

  // 2. Process Ratios
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
      daySeries: dayHistory,
      weekSeries: matched
    });
  }

  if (results.length > 0) {
    CACHED_DATA = results;
    LAST_UPDATE = Date.now();
  }
}

// Low-latency polling every 3.5 seconds
syncAll();
setInterval(syncAll, 3500);

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
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>RatioWatch Pro</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#0a0b0e">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; }
    body { background: #0a0b0e; color: #e4e7eb; padding: 12px 8px 60px; user-select: none; -webkit-tap-highlight-color: transparent; }

    header { display: flex; justify-content: space-between; align-items: center; padding: 6px 4px 14px; border-bottom: 1px solid #1a1c23; }
    h1 { font-size: 1.15rem; font-weight: 800; letter-spacing: 0.5px; }
    .status { font-size: 0.72rem; color: #00c805; display: flex; align-items: center; gap: 6px; font-weight: 700; }
    .dot { width: 8px; height: 8px; background: #00c805; border-radius: 50%; box-shadow: 0 0 8px #00c805; }

    .watchlist { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
    
    .card {
      background: #111319;
      border: 1px solid #1c202a;
      border-radius: 8px;
      padding: 10px 10px 12px;
      transition: background 0.3s ease, border-color 0.3s ease;
    }
    .card.dragging { opacity: 0.4; border: 1px dashed #00c805; }

    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .left-info { display: flex; align-items: center; gap: 6px; }
    .drag-handle { color: #5a6078; cursor: grab; font-size: 1rem; padding: 0 2px; }

    .reorder-group { display: flex; gap: 2px; align-items: center; }
    .btn-ctrl {
      background: #191c26;
      border: 1px solid #282d3d;
      color: #9098b6;
      font-size: 0.72rem;
      padding: 3px 5px;
      border-radius: 4px;
      cursor: pointer;
      line-height: 1;
    }
    .btn-ctrl:active { background: #00c805; color: #000; border-color: #00c805; }

    .sym { font-size: 0.95rem; font-weight: 800; color: #ffffff; }
    .sub { font-size: 0.65rem; color: #707792; }

    .price-tag {
      font-size: 1.1rem;
      font-weight: 800;
      padding: 2px 6px;
      border-radius: 4px;
      display: inline-block;
      transition: background-color 0.2s, color 0.2s;
    }

    @keyframes flashGreen {
      0% { background: rgba(0, 230, 100, 0.85); color: #fff; box-shadow: 0 0 16px rgba(0, 230, 100, 0.9); }
      40% { background: rgba(0, 230, 100, 0.4); }
      100% { background: transparent; color: inherit; box-shadow: none; }
    }
    @keyframes flashRed {
      0% { background: rgba(255, 60, 60, 0.85); color: #fff; box-shadow: 0 0 16px rgba(255, 60, 60, 0.9); }
      40% { background: rgba(255, 60, 60, 0.4); }
      100% { background: transparent; color: inherit; box-shadow: none; }
    }
    .flash-up { animation: flashGreen 1.4s ease-out; }
    .flash-down { animation: flashRed 1.4s ease-out; }

    .charts-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .chart-panel {
      background: #0b0c10;
      border: 1px solid #171a22;
      border-radius: 6px;
      padding: 6px 6px 4px;
      position: relative;
    }
    .chart-hdr {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .chart-title-box { display: flex; align-items: center; gap: 6px; }
    .chart-label { font-size: 0.65rem; font-weight: 800; color: #707792; text-transform: uppercase; }

    .badge {
      font-size: 0.68rem;
      font-weight: 800;
      padding: 1px 5px;
      border-radius: 4px;
      display: inline-block;
    }
    .up-bg { background: rgba(0, 200, 5, 0.16); color: #00c805; }
    .down-bg { background: rgba(255, 59, 48, 0.16); color: #ff3b30; }

    .scrub-readout {
      font-size: 0.62rem;
      color: #00c805;
      font-weight: 700;
      white-space: nowrap;
      text-align: right;
    }

    .svg-wrap { width: 100%; height: 95px; position: relative; }
    svg { width: 100%; height: 100%; overflow: visible; display: block; }

    .axis-label { font-size: 8.5px; fill: #505770; font-family: sans-serif; font-weight: 600; }
    .grid-line { stroke: #191c26; stroke-width: 1; }
    .base-line { stroke: #3a4156; stroke-dasharray: 2,2; stroke-width: 1; }
    .day-divider { stroke: #202433; stroke-width: 1; stroke-dasharray: 2,2; }
    .chart-line { fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .chart-area { stroke: none; opacity: 0.12; }
    .day-dot { stroke: #0b0c10; stroke-width: 1; }

    .cursor-line { stroke: #ffffff; stroke-dasharray: 2,2; stroke-width: 1; opacity: 0.7; }
    .cursor-dot { fill: #ffffff; stroke: #000; stroke-width: 1.5; }
  </style>
</head>
<body>

  <header>
    <h1>RATIOS & STOCKS</h1>
    <div class="status"><div class="dot"></div> LIVE (1.5s)</div>
  </header>

  <div class="watchlist" id="watchlist"></div>

  <script>
    let savedOrder = JSON.parse(localStorage.getItem('user_order') || '[]');
    let previousPrices = {};
    let latestData = {};

    function formatDate(ts, type) {
      const d = new Date(ts * 1000);
      if (type === 'day') {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      }
      return d.toLocaleDateString([], { weekday: 'short' });
    }

    function renderChartSvg(containerId, series, baselineVal, isDay) {
      if (!series || series.length < 2) return '';
      const w = 260, h = 95;
      const padTop = 10, padBtm = 16, padLeft = 4, padRight = 42;
      const ch = h - padTop - padBtm; // 69
      const cw = w - padLeft - padRight; // 214

      const vals = series.map(s => s.c);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const range = max === min ? 1 : max - min;

      const pts = series.map((s, i) => {
        const x = padLeft + (i / (series.length - 1)) * cw;
        const y = padTop + ch - ((s.c - min) / range) * ch;
        return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)), val: s.c, t: s.t };
      });

      const strokePath = 'M ' + pts.map(p => p.x + ',' + p.y).join(' L ');
      const areaPath = strokePath + ' L ' + pts[pts.length - 1].x + ',' + (padTop + ch) + ' L ' + pts[0].x + ',' + (padTop + ch) + ' Z';

      const isPos = vals[vals.length - 1] >= (baselineVal || vals[0]);
      const theme = isPos ? '#00c805' : '#ff3b30';

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
          const dayStr = new Date(p.t * 1000).toLocaleDateString([], { weekday: 'short' });
          if (lastDay && dayStr !== lastDay) {
            dayMarkersSvg += '<line class="day-divider" x1="' + p.x + '" y1="' + padTop + '" x2="' + p.x + '" y2="' + (padTop + ch) + '" />';
            dayEndPts.push(pts[idx - 1]);
          }
          lastDay = dayStr;
        });
        dayEndPts.push(pts[pts.length - 1]);
        dayEndPts.forEach(dp => {
          if (dp) dayMarkersSvg += '<circle class="day-dot" cx="' + dp.x + '" cy="' + dp.y + '" r="3" fill="' + theme + '" />';
        });
      }

      const fmtY = v => v >= 1000 ? v.toFixed(0) : v >= 10 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toFixed(4);

      const xStart = formatDate(series[0].t, isDay ? 'day' : 'week');
      const xMid = formatDate(series[Math.floor(series.length / 2)].t, isDay ? 'day' : 'week');
      const xEnd = formatDate(series[series.length - 1].t, isDay ? 'day' : 'week');

      return \`
        <svg viewBox="0 0 \${w} \${h}" id="\${containerId}" data-points='\${JSON.stringify(pts)}' onpointermove="scrubChart(event, '\${containerId}', \${padLeft}, \${cw})" onpointerleave="leaveChart('\${containerId}')">
          <line class="grid-line" x1="\${padLeft}" y1="\${padTop}" x2="\${padLeft + cw}" y2="\${padTop}" />
          <line class="grid-line" x1="\${padLeft}" y1="\${midY.toFixed(1)}" x2="\${padLeft + cw}" y2="\${midY.toFixed(1)}" />
          <line class="grid-line" x1="\${padLeft}" y1="\${padTop + ch}" x2="\${padLeft + cw}" y2="\${padTop + ch}" />
          \${baseSvg}
          \${dayMarkersSvg}

          <text class="axis-label" x="\${w - 2}" y="\${padTop + 6}" text-anchor="end">\${fmtY(max)}</text>
          <text class="axis-label" x="\${w - 2}" y="\${(midY + 3).toFixed(1)}" text-anchor="end">\${fmtY(midVal)}</text>
          <text class="axis-label" x="\${w - 2}" y="\${padTop + ch}" text-anchor="end">\${fmtY(min)}</text>

          <path class="chart-area" d="\${areaPath}" fill="\${theme}" />
          <path class="chart-line" d="\${strokePath}" stroke="\${theme}" />

          <text class="axis-label" x="\${padLeft}" y="\${h - 4}">\${xStart}</text>
          <text class="axis-label" x="\${padLeft + cw / 2}" y="\${h - 4}" text-anchor="middle">\${xMid}</text>
          <text class="axis-label" x="\${padLeft + cw}" y="\${h - 4}" text-anchor="end">\${xEnd}</text>

          <g id="\${containerId}-cursor" style="display:none;">
            <line id="\${containerId}-vline" class="cursor-line" y1="\${padTop}" y2="\${padTop + ch}" />
            <circle id="\${containerId}-dot" class="cursor-dot" r="4" />
          </g>
        </svg>
      \`;
    }

    // Precise 1:1 synchronization with zero drift
    function scrubChart(e, id, padLeft, cw) {
      const svg = document.getElementById(id);
      if (!svg) return;
      const pts = JSON.parse(svg.getAttribute('data-points') || '[]');
      if (!pts.length) return;

      const rect = svg.getBoundingClientRect();
      const svgX = ((e.clientX - rect.left) / rect.width) * 260;
      const clampedX = Math.max(padLeft, Math.min(padLeft + cw, svgX));

      const frac = (clampedX - padLeft) / cw;
      const idx = Math.min(pts.length - 1, Math.max(0, Math.round(frac * (pts.length - 1))));
      const closest = pts[idx];

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

    function leaveChart(id) {
      const cursor = document.getElementById(id + '-cursor');
      const readout = document.getElementById(id + '-readout');
      if (cursor) cursor.style.display = 'none';
      if (readout) readout.textContent = '';
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

        const daySvg = renderChartSvg(daySvgId, item.daySeries, item.dailyPrevClose, true);
        const weekSvg = renderChartSvg(weekSvgId, item.weekSeries, item.weeklyPrevClose, false);

        html += \`
          <div class="card" draggable="true" data-id="\${item.id}">
            <div class="top-bar">
              <div class="left-info">
                <div class="drag-handle">⋮⋮</div>
                <div class="reorder-group">
                  <button class="btn-ctrl" onclick="sendToTop('\${item.id}')" title="Top">⤒</button>
                  <button class="btn-ctrl" onclick="reorderItem('\${item.id}', -1)" title="Up">▲</button>
                  <button class="btn-ctrl" onclick="reorderItem('\${item.id}', 1)" title="Down">▼</button>
                  <button class="btn-ctrl" onclick="sendToBottom('\${item.id}')" title="Bottom">⤓</button>
                </div>
                <div>
                  <div class="sym">\${item.name}</div>
                  <div class="sub">\${item.sub}</div>
                </div>
              </div>
              <div>
                <span class="price-tag \${flashClass}">\${priceStr}</span>
              </div>
            </div>

            <div class="charts-grid">
              <div class="chart-panel">
                <div class="chart-hdr">
                  <div class="chart-title-box">
                    <span class="chart-label">1D</span>
                    <span class="badge \${dayBadge}">\${daySign}\${item.dailyChangePct.toFixed(2)}%</span>
                  </div>
                  <span id="\${daySvgId}-readout" class="scrub-readout"></span>
                </div>
                <div class="svg-wrap">\${daySvg}</div>
              </div>
              <div class="chart-panel">
                <div class="chart-hdr">
                  <div class="chart-title-box">
                    <span class="chart-label">1W</span>
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
