const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const BASE_SYMBOLS = [
  { sym: 'CL=F', name: 'USOIL', sub: 'CFDs on WTI Crude' },
  { sym: 'GC=F', name: 'GOLD', sub: 'CFDs on Gold' },
  { sym: 'SI=F', name: 'SILVER', sub: 'CFDs on Silver' },
  { sym: 'BTC-USD', name: 'BTCUSD', sub: 'Bitcoin / U.S. Dollar' },
  { sym: 'MSTR', name: 'MSTR', sub: 'Strategy Inc' },
  { sym: 'MARA', name: 'MARA', sub: 'MARA Holdings' },
  { sym: 'IREN', name: 'IREN', sub: 'IREN LIMITED' },
  { sym: 'NBIS', name: 'NBIS', sub: 'Nebius Group N.V.' },
  { sym: 'CRWV', name: 'CRWV', sub: 'CoreWeave, Inc.' },
  { sym: 'ORCL', name: 'ORCL', sub: 'Oracle Corporation' },
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

let CACHED_DATA = null;
let LAST_UPDATE = 0;

async function fetchTicker(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=15m&includePrePost=false`;
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

  return {
    symbol,
    price: meta.regularMarketPrice || history[history.length - 1]?.c || 0,
    prevClose: meta.chartPreviousClose || meta.previousClose || history[0]?.c || 1,
    sessionStart: meta.currentTradingPeriod?.regular?.start || (history[history.length - 1]?.t - 23400 || 0),
    history
  };
}

async function updateMarketData() {
  const rawMap = {};
  await Promise.allSettled(BASE_SYMBOLS.map(async (item) => {
    try { rawMap[item.sym] = await fetchTicker(item.sym); } catch (e) {}
  }));

  const list = [];
  for (const item of BASE_SYMBOLS) {
    const d = rawMap[item.sym];
    if (!d || !d.history.length) continue;
    const curPrice = d.price;
    const prevClose = d.prevClose;
    const changePct = ((curPrice - prevClose) / prevClose) * 100;
    const weekSeries = d.history.map(h => h.c);
    const dayTicks = d.history.filter(h => h.t >= (d.sessionStart - 900));
    const daySeries = (dayTicks.length > 1 ? dayTicks : d.history.slice(-16)).map(h => h.c);

    list.push({ category: 'single', name: item.name, sub: item.sub, price: curPrice, changePct, daySeries, weekSeries, prevClose });
  }

  for (const pair of RATIO_PAIRS) {
    const d1 = rawMap[pair.t1];
    const d2 = rawMap[pair.t2];
    if (!d1 || !d2 || !d1.history.length || !d2.history.length) continue;

    const map2 = new Map(d2.history.map(h => [h.t, h.c]));
    const matched = d1.history.filter(h => map2.has(h.t)).map(h => ({ t: h.t, c: h.c / map2.get(h.t) }));
    if (!matched.length) continue;

    const curRatio = matched[matched.length - 1].c;
    const prevRatio = d1.prevClose / d2.prevClose;
    const changePct = ((curRatio - prevRatio) / prevRatio) * 100;
    const weekSeries = matched.map(m => m.c);
    const sessionStart = Math.max(d1.sessionStart, d2.sessionStart);
    const dayTicks = matched.filter(m => m.t >= (sessionStart - 900));
    const daySeries = (dayTicks.length > 1 ? dayTicks : matched.slice(-16)).map(m => m.c);

    list.push({ category: 'ratio', name: `${pair.t1}/${pair.t2}`, sub: 'Spread', price: curRatio, changePct, daySeries, weekSeries, prevClose: prevRatio });
  }

  if (list.length > 0) {
    CACHED_DATA = list;
    LAST_UPDATE = Date.now();
  }
}

updateMarketData();
setInterval(updateMarketData, 20000);

app.get('/api/watchlist', async (req, res) => {
  if (!CACHED_DATA) await updateMarketData();
  res.json({ updated: LAST_UPDATE, data: CACHED_DATA || [] });
});

app.get('/manifest.json', (req, res) => {
  res.json({
    name: "RatioWatch Pro",
    short_name: "RatioWatch",
    start_url: "/",
    display: "standalone",
    background_color: "#0e0f14",
    theme_color: "#0e0f14",
    icons: [{ src: "https://cdn-icons-png.flaticon.com/512/2422/2422796.png", sizes: "512x512", type: "image/png" }]
  });
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0,user-scalable=no">
  <title>RatioWatch</title>
  <link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#0e0f14">
  <style>
    *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}
    body{background:#0e0f14;color:#fff;padding:12px 10px 40px;}
    header{display:flex;justify-content:space-between;align-items:center;padding-bottom:12px;border-bottom:1px solid #1a1c24;}
    h1{font-size:1.15rem;font-weight:800;}
    .status{font-size:0.75rem;color:#00c805;display:flex;align-items:center;gap:6px;font-weight:700;}
    .dot{width:7px;height:7px;background:#00c805;border-radius:50%;}
    .col-hdr{display:grid;grid-template-columns:110px 75px 75px 1fr;padding:10px 8px 4px;font-size:0.65rem;font-weight:700;color:#5d637c;text-transform:uppercase;}
    .list{display:flex;flex-direction:column;gap:4px;}
    .row{display:grid;grid-template-columns:110px 75px 75px 1fr;align-items:center;background:#14161f;padding:8px 10px;border-radius:6px;border:1px solid #1a1c26;}
    .sym{font-size:0.88rem;font-weight:700;}
    .sub{font-size:0.65rem;color:#6e748f;}
    .chart{width:75px;height:32px;}
    svg{width:100%;height:100%;overflow:visible;}
    .line{fill:none;stroke-width:1.6;stroke-linecap:round;}
    .area{stroke:none;opacity:0.12;}
    .base{stroke:#2a2e40;stroke-width:1;stroke-dasharray:2,2;}
    .price-col{text-align:right;}
    .price{font-size:0.88rem;font-weight:700;}
    .badge{display:inline-block;font-size:0.68rem;font-weight:700;padding:2px 4px;border-radius:4px;margin-top:2px;}
    .up{color:#00c805;stroke:#00c805;fill:#00c805;}
    .down{color:#ff3b30;stroke:#ff3b30;fill:#ff3b30;}
    .up-bg{background:rgba(0,200,5,0.15);color:#00c805;}
    .down-bg{background:rgba(255,59,48,0.15);color:#ff3b30;}
    .sec{font-size:0.68rem;font-weight:800;color:#8b92b2;text-transform:uppercase;padding:14px 4px 4px;}
  </style>
</head>
<body>
  <header><h1>RATIOS & WATCHLIST</h1><div class="status"><div class="dot"></div> LIVE</div></header>
  <div class="col-hdr"><div>Symbol</div><div style="text-align:center">1D</div><div style="text-align:center">1W</div><div style="text-align:right">Price / %</div></div>
  <div class="list" id="watchlist"></div>
  <script>
    function renderSvg(vals, baseVal) {
      if(!vals||vals.length<2) return {l:'',a:'',b:''};
      const min=Math.min(...vals), max=Math.max(...vals), r=(max===min?1:max-min), step=75/(vals.length-1);
      const pts=vals.map((v,i)=> (i*step).toFixed(1)+','+(32-((v-min)/r)*24-4).toFixed(1));
      const l='M '+pts.join(' L '), a=l+' L 75,32 L 0,32 Z';
      let b='';
      if(baseVal&&baseVal>=min&&baseVal<=max) b='<line class="base" x1="0" y1="'+(32-((baseVal-min)/r)*24-4).toFixed(1)+'" x2="75" y2="'+(32-((baseVal-min)/r)*24-4).toFixed(1)+'" />';
      return {l,a,b};
    }
    async function load() {
      try {
        const res = await fetch('/api/watchlist');
        const json = await res.json();
        let h='', last='';
        json.data.forEach(item => {
          if(item.category!==last){ h+='<div class="sec">'+(item.category==='single'?'Watchlist':'Spreads / Ratios')+'</div>'; last=item.category; }
          const isPos=item.changePct>=0, t=isPos?'up':'down', bg=isPos?'up-bg':'down-bg', s=isPos?'+':'';
          const dSvg=renderSvg(item.daySeries, item.prevClose);
          const wIsPos=item.weekSeries[item.weekSeries.length-1]>=item.weekSeries[0], wt=wIsPos?'up':'down';
          const wSvg=renderSvg(item.weekSeries, item.weekSeries[0]);
          const p=item.price>=1000?item.price.toLocaleString('en-US',{maximumFractionDigits:1}):item.price>=10?item.price.toFixed(2):item.price.toFixed(3);
          h+='<div class="row"><div><div class="sym">'+item.name+'</div><div class="sub">'+item.sub+'</div></div>'+
             '<div class="chart"><svg viewBox="0 0 75 32">'+dSvg.b+'<path class="area '+t+'" d="'+dSvg.a+'"/><path class="line '+t+'" d="'+dSvg.l+'"/></svg></div>'+
             '<div class="chart"><svg viewBox="0 0 75 32">'+wSvg.b+'<path class="area '+wt+'" d="'+wSvg.a+'"/><path class="line '+wt+'" d="'+wSvg.l+'"/></svg></div>'+
             '<div class="price-col"><div class="price">'+p+'</div><div class="badge '+bg+'">'+s+item.changePct.toFixed(2)+'%</div></div></div>';
        });
        document.getElementById('watchlist').innerHTML=h;
      }catch(e){}
    }
    load(); setInterval(load, 10000);
  </script>
</body>
</html>`);
});

app.listen(PORT, () => console.log('Running'));
