// 90-day macro trader scan via Polymarket Data API for every cached trader.
// Replaces unsupported Falcon 90d period.
const https = require('https');
const Database = require('better-sqlite3');

const DATA_API = 'https://data-api.polymarket.com';
const FALCON_URL = 'https://narrative.agent.heisenberg.so/api/v2/semantic/retrieve/parameterized';
const KEY = process.env.POLYMARKET_ANALYTICS_API_KEY || '';
const CONCURRENCY = 8;
const PAGE = 500;
const MAX_PAGES = 5; // safety cap = 2500 trades
const NINETY_D_MS = 90 * 86400 * 1000;
const NOW = Date.now();
const CUTOFF = NOW - NINETY_D_MS;

function post(url, body, headers={}, timeoutMs=15000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type':'application/json','Content-Length':Buffer.byteLength(data), ...headers },
      timeout: timeoutMs,
    }, res => {
      let buf=''; res.on('data',c=>buf+=c);
      res.on('end',()=> {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0,200)}`));
        try { resolve(JSON.parse(buf)); } catch(e){ reject(new Error('bad json')); }
      });
    });
    req.on('error',reject);
    req.on('timeout',()=>{req.destroy(); reject(new Error('timeout'));});
    req.write(data); req.end();
  });
}
function get(url, timeoutMs=20000) {
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
const parseNum = v => v==null? undefined : (isNaN(Number(v)) ? undefined : Number(v));

async function fetchFalcon(period) {
  const out=[]; let offset=0;
  while (out.length < 300) {
    let data;
    try { data = await post(FALCON_URL, { agent_id:579, params:{wallet_address:'ALL',leaderboard_period:period}, pagination:{limit:100,offset}, formatter_config:{format_type:'raw'}}, {Authorization:`Bearer ${KEY}`}); }
    catch(e){ console.error(`falcon ${period}:`, e.message); break; }
    const raw = Array.isArray(data) ? data : data?.data?.results || data?.data?.items || (Array.isArray(data?.data)?data.data:null) || data?.results || data?.items || null;
    if (!raw || !raw.length) break;
    for (const r of raw) out.push({ address: String(r.address||'').toLowerCase() });
    if (raw.length < 100) break;
    offset += 100;
  }
  return out.filter(t=>t.address);
}

// Fetch activity, stop when items pre-date 90d cutoff.
async function fetch90dActivity(address) {
  const out=[];
  for (let p=0; p<MAX_PAGES; p++) {
    const url = `${DATA_API}/activity?user=${encodeURIComponent(address)}&limit=${PAGE}&offset=${p*PAGE}`;
    let data;
    try { data = await get(url); }
    catch(e){ return { error: e.message, trades: out }; }
    if (!Array.isArray(data) || data.length === 0) break;
    let hitCutoff=false;
    for (const it of data) {
      if (it.type !== 'TRADE') continue;
      const ts = typeof it.timestamp === 'number' ? it.timestamp*1000 : 0;
      if (ts < CUTOFF) { hitCutoff=true; continue; }
      out.push({ ts, slug:String(it.slug||''), outcome:String(it.outcome||''), side:String(it.side||'').toUpperCase(), price:Number(it.price||0), size:Number(it.size||0) });
    }
    if (hitCutoff || data.length < PAGE) break;
  }
  return { trades: out };
}

function analyze90d(trades) {
  if (!trades.length) return null;
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
  const allTs=trades.map(t=>t.ts);
  const span=Math.max(1, (Math.max(...allTs)-Math.min(...allTs))/86400000);
  const winN = closed.filter(c=>c.pnl>0).length;
  const avgHoldH = closed.length ? closed.reduce((a,c)=>a+c.hold,0)/closed.length/3600000 : null;
  return {
    trades_90d: trades.length,
    trades_per_week: trades.length*7/span,
    closed: closed.length,
    avg_hold_h: avgHoldH,
    avg_hold_d: avgHoldH==null ? null : avgHoldH/24,
    pct_over_48h: closed.length ? closed.filter(c=>c.hold>48*3600000).length/closed.length : null,
    pct_over_7d:  closed.length ? closed.filter(c=>c.hold>7*86400000).length/closed.length : null,
    wr: closed.length ? winN/closed.length : null,
    pnl: closed.reduce((a,c)=>a+c.pnl,0),
    open_remaining: [...open.values()].reduce((a,q)=>a+q.length,0),
  };
}

async function pool(items, fn, n) {
  const out = new Array(items.length); let i=0;
  const worker = async () => { while (true) { const idx=i++; if (idx>=items.length) return; out[idx]=await fn(items[idx], idx); } };
  await Promise.all(Array.from({length:n}, worker));
  return out;
}

(async () => {
  const db = new Database('/app/data/store.db', { readonly: true });
  const addrs = db.prepare('SELECT lower(address) AS a FROM trader_falcon_cache').all().map(r=>r.a);
  const watchlist = new Set(db.prepare('SELECT lower(address) AS a FROM watchlist_traders').all().map(r=>r.a));
  const excluded = new Set(db.prepare('SELECT lower(address) AS a FROM excluded_traders').all().map(r=>r.a));
  db.close();
  console.log(`[scan] cached=${addrs.length}, watchlist=${watchlist.size}, excluded=${excluded.size}`);

  console.log('[scan] fetching falcon 7d for cross-ref...');
  const fal7 = await fetchFalcon('7d');
  const set7 = new Set(fal7.map(t=>t.address));
  console.log(`[scan] falcon 7d: ${fal7.length} addrs`);

  console.log(`[scan] scanning 90d activity for ${addrs.length} addrs @ concurrency=${CONCURRENCY}...`);
  const t0 = Date.now();
  let done=0;
  const results = await pool(addrs, async (addr) => {
    const r = await fetch90dActivity(addr);
    done++;
    if (done % 20 === 0) console.log(`  ... ${done}/${addrs.length} (${((Date.now()-t0)/1000).toFixed(0)}s)`);
    if (r.error) return { addr, error: r.error };
    const m = analyze90d(r.trades);
    return { addr, m };
  }, CONCURRENCY);
  console.log(`[scan] done in ${((Date.now()-t0)/1000).toFixed(0)}s`);

  const errors = results.filter(r=>r.error).length;
  const noData = results.filter(r=>!r.error && !r.m).length;
  console.log(`[scan] errors=${errors}, empty=${noData}, with_data=${results.length-errors-noData}`);

  // Filter macro: low freq, long hold, high WR, positive PNL, not already on watchlist
  const macro = results
    .filter(r => !r.error && r.m && r.m.closed >= 5)
    .filter(r => !watchlist.has(r.addr) && !excluded.has(r.addr))
    .filter(r => r.m.trades_per_week < 20)
    .filter(r => (r.m.avg_hold_h||0) >= 48)
    .filter(r => (r.m.wr||0) > 0.60)
    .filter(r => (r.m.pnl||0) > 0)
    .sort((a,b)=>(b.m.pnl||0)-(a.m.pnl||0));

  console.log(`\n========== MACRO CANDIDATES (90d window, not on watchlist) ==========`);
  console.log(`matched filter (tpw<20, hold>=48h, wr>60%, pnl>0, closed>=5): ${macro.length}`);
  console.log('\naddr                                       on7d  tr90  t/wk  closed  hold_d  >48h  >7d  wr    pnl');
  for (const r of macro.slice(0,20)) {
    const m=r.m, on7=set7.has(r.addr)?'Y':'-';
    console.log(`${r.addr}    ${on7}  ${String(m.trades_90d).padStart(4)}  ${m.trades_per_week.toFixed(1).padStart(5)}  ${String(m.closed).padStart(5)}  ${(m.avg_hold_d||0).toFixed(1).padStart(5)}   ${((m.pct_over_48h||0)*100).toFixed(0).padStart(3)}%  ${((m.pct_over_7d||0)*100).toFixed(0).padStart(3)}%  ${((m.wr||0)*100).toFixed(0).padStart(3)}%  ${(m.pnl||0).toFixed(0)}`);
  }

  // Among matched: prioritize NOT-on-7d (truly patient, missed by weekly leaderboard).
  const macroNot7 = macro.filter(r => !set7.has(r.addr));
  console.log(`\n--- subset NOT on 7d Falcon (the patient/invisible cohort): ${macroNot7.length} ---`);
  for (const r of macroNot7.slice(0,10)) {
    const m=r.m;
    console.log(`${r.addr}  tr=${m.trades_90d} t/wk=${m.trades_per_week.toFixed(1)} closed=${m.closed} hold=${(m.avg_hold_d||0).toFixed(1)}d >48h=${((m.pct_over_48h||0)*100).toFixed(0)}% wr=${((m.wr||0)*100).toFixed(0)}% pnl=$${(m.pnl||0).toFixed(0)} open=${m.open_remaining}`);
  }
})().catch(e=>{console.error('FATAL',e); process.exit(1);});
