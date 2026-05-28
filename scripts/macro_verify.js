// Verify top "low-trade-count" Falcon candidates are actually macro (not scalpers).
const https = require('https');
const DATA_API = 'https://data-api.polymarket.com';

function get(url, timeoutMs=15000) {
  return new Promise((resolve,reject) => {
    const req = https.get(url, { timeout: timeoutMs }, res => {
      let buf=''; res.on('data',c=>buf+=c);
      res.on('end',()=> {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(buf)); } catch(e){ reject(new Error('bad json')); }
      });
    });
    req.on('error',reject);
    req.on('timeout',()=>{req.destroy(); reject(new Error('timeout'));});
  });
}
async function fetchActivity(address, maxTrades=1500) {
  const out = []; const PAGE = 500;
  for (let page=0; page*PAGE < maxTrades; page++) {
    const url = `${DATA_API}/activity?user=${encodeURIComponent(address)}&limit=${PAGE}&offset=${page*PAGE}`;
    let data; try { data = await get(url); } catch(e){ console.error(e.message); break; }
    if (!Array.isArray(data) || data.length === 0) break;
    for (const it of data) {
      if (it.type !== 'TRADE') continue;
      out.push({ ts: typeof it.timestamp==='number'?it.timestamp*1000:0, slug:String(it.slug||''), outcome:String(it.outcome||''), side:String(it.side||'').toUpperCase(), price:Number(it.price||0), size:Number(it.size||0) });
    }
    if (data.length < PAGE) break;
  }
  return out;
}
function analyze(trades) {
  trades.sort((a,b)=>a.ts-b.ts);
  const open=new Map(); const closed=[];
  for (const t of trades) {
    const k=`${t.slug}|${t.outcome}`;
    if (!open.has(k)) open.set(k,[]);
    const q=open.get(k);
    if (t.side==='BUY') q.push({ts:t.ts,size:t.size,price:t.price});
    else if (t.side==='SELL') {
      let r=t.size;
      while (r>1e-9 && q.length) {
        const h=q[0], take=Math.min(r,h.size);
        closed.push({hold:t.ts-h.ts, pnl:take*(t.price-h.price)});
        h.size-=take; r-=take; if (h.size<1e-9) q.shift();
      }
    }
  }
  const allTs=trades.map(t=>t.ts).filter(t=>t>0);
  const span=(Math.max(...allTs)-Math.min(...allTs))/86400000||1;
  const open_remaining=[...open.values()].reduce((a,q)=>a+q.length,0);
  const oldestOpenTs=Math.min(...[...open.values()].flat().map(p=>p.ts), Date.now());
  return {
    trades: trades.length,
    span_days: span.toFixed(1),
    trades_per_week: (trades.length*7/span).toFixed(2),
    closed: closed.length,
    open_remaining,
    oldest_open_age_days: open_remaining ? ((Date.now()-oldestOpenTs)/86400000).toFixed(1) : 'n/a',
    avg_hold_days:  closed.length ? (closed.reduce((a,c)=>a+c.hold,0)/closed.length/86400000).toFixed(2) : 'n/a',
    median_hold_h:  closed.length ? ((()=>{const s=closed.map(c=>c.hold).sort((a,b)=>a-b); return s[Math.floor(s.length/2)]/3600000;})()).toFixed(1) : 'n/a',
    pct_over_48h:   closed.length ? (100*closed.filter(c=>c.hold>48*3600000).length/closed.length).toFixed(0)+'%' : 'n/a',
    pct_over_7d:    closed.length ? (100*closed.filter(c=>c.hold>7*86400000).length/closed.length).toFixed(0)+'%' : 'n/a',
    wr:             closed.length ? (100*closed.filter(c=>c.pnl>0).length/closed.length).toFixed(0)+'%' : 'n/a',
    pnl:            closed.reduce((a,c)=>a+c.pnl,0).toFixed(2),
  };
}

const targets = [
  ['0x6c743aafd813475986dcd930f380a1f50901bd4e', 'sharpe 0.91, 10 tr, 100%WR'],
  ['0x45c9c799e0e6ddf19c50e9dac5ab5a925f9b414b', 'sharpe 0.75, 15 tr, 75%WR'],
  ['0x971a4bb4c480c7bbee0a4e1bee72459b21ac447d', 'sharpe 0.68, 42 tr, 100%WR'],
  ['0x1abe1368601330a310162064e04d3c2628cb6497', 'sharpe 0.53, 18 tr, 2315% ROI'],
  ['0x46fbcf38492da5bc3694b7a27e59f014dc39b1d5', 'sharpe 0.83, 227 tr, 93%WR'],
];
(async () => {
  for (const [addr,label] of targets) {
    console.log(`\n--- ${addr.slice(0,12)}… (${label}) ---`);
    const h = await fetchActivity(addr, 1500);
    const m = analyze(h);
    for (const [k,v] of Object.entries(m)) console.log(`  ${k.padEnd(22)} ${v}`);
  }
})().catch(e=>{console.error(e); process.exit(1);});
