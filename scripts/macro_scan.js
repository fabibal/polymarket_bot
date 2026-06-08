// One-off macro/long-term trader scan. Runs INSIDE bot container (needs VPN + POLYMARKET_ANALYTICS_API_KEY).
// A) Falcon 7d/30d/90d diff
// B) Polymarket data-api history backfill for candidates
// C) Falcon enrichment for cached traders
const https = require('https');
const Database = require('better-sqlite3');

const FALCON_URL = 'https://narrative.agent.heisenberg.so/api/v2/semantic/retrieve/parameterized';
const DATA_API   = 'https://data-api.polymarket.com';
const KEY = process.env.POLYMARKET_ANALYTICS_API_KEY || '';
if (!KEY) { console.error('POLYMARKET_ANALYTICS_API_KEY missing'); process.exit(1); }

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
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${buf.slice(0,300)}`));
        try { resolve(JSON.parse(buf)); } catch(e){ reject(new Error('bad json: '+buf.slice(0,200))); }
      });
    });
    req.on('error',reject);
    req.on('timeout',()=>{req.destroy(); reject(new Error('timeout'));});
    req.write(data); req.end();
  });
}
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

function parseNum(v){ if(v==null) return undefined; const n=Number(v); return isNaN(n)?undefined:n; }

async function fetchFalconLeaderboard(period, maxItems=500) {
  const out = [];
  let offset = 0;
  while (out.length < maxItems) {
    let body = {
      agent_id: 579,
      params: { wallet_address: 'ALL', leaderboard_period: period },
      pagination: { limit: 100, offset },
      formatter_config: { format_type: 'raw' },
    };
    let data;
    try { data = await post(FALCON_URL, body, { Authorization: `Bearer ${KEY}` }); }
    catch (e) { console.error(`[falcon ${period}] page ${offset}: ${e.message}`); break; }
    let raw = Array.isArray(data) ? data
      : data?.data?.results || data?.data?.items
      || (Array.isArray(data?.data) ? data.data : null)
      || data?.results || data?.items || null;
    if (!raw || raw.length === 0) break;
    for (const r of raw) {
      out.push({
        address: String(r.address || '').toLowerCase(),
        rank: parseNum(r.rank),
        total_pnl: parseNum(r.total_pnl),
        roi: parseNum(r.roi),
        win_rate: parseNum(r.win_rate),
        sharpe_ratio: parseNum(r.sharpe_ratio),
        total_trades: parseNum(r.total_trades),
        markets_traded: parseNum(r.markets_traded),
        avg_trade_size: parseNum(r.avg_trade_size),
        total_invested: parseNum(r.total_invested),
      });
    }
    if (raw.length < 100) break;
    offset += 100;
  }
  return out.filter(t=>t.address);
}

async function fetchActivity(address, maxTrades=1500) {
  const out = [];
  const PAGE = 500;
  for (let page=0; page*PAGE < maxTrades; page++) {
    const url = `${DATA_API}/activity?user=${encodeURIComponent(address)}&limit=${PAGE}&offset=${page*PAGE}`;
    let data;
    try { data = await get(url); }
    catch(e){ console.error(`[activity ${address.slice(0,10)}] page ${page}: ${e.message}`); break; }
    if (!Array.isArray(data) || data.length === 0) break;
    for (const it of data) {
      if (it.type !== 'TRADE') continue;
      out.push({
        ts: typeof it.timestamp === 'number' ? it.timestamp*1000 : 0,
        slug: String(it.slug || ''),
        outcome: String(it.outcome || ''),
        side: String(it.side || '').toUpperCase(),
        price: Number(it.price || 0),
        size: Number(it.size || 0),
        usd: Number(it.usdcSize || 0),
      });
    }
    if (data.length < PAGE) break;
  }
  return out;
}

function analyzeHistory(trades) {
  // FIFO match BUY-SELL by (slug,outcome). Compute hold-weighted metrics.
  trades.sort((a,b)=>a.ts-b.ts);
  const open = new Map(); // key -> [{ts,size_left,price}]
  const closed = []; // {hold_ms, pnl, key}
  for (const t of trades) {
    const key = `${t.slug}|${t.outcome}`;
    if (!open.has(key)) open.set(key, []);
    const q = open.get(key);
    if (t.side === 'BUY') {
      q.push({ ts:t.ts, size:t.size, price:t.price });
    } else if (t.side === 'SELL') {
      let remain = t.size;
      while (remain > 1e-9 && q.length) {
        const head = q[0];
        const take = Math.min(remain, head.size);
        const pnl = take * (t.price - head.price);
        closed.push({ hold_ms: t.ts - head.ts, pnl, key, exit_ts: t.ts });
        head.size -= take;
        remain -= take;
        if (head.size < 1e-9) q.shift();
      }
    }
  }
  const openCount = [...open.values()].reduce((a,q)=>a+q.length,0);
  const openOldestMs = Math.min(...[...open.values()].flat().map(p=>p.ts), Date.now());
  const allTs = trades.map(t=>t.ts).filter(t=>t>0);
  const firstTs = Math.min(...allTs);
  const lastTs  = Math.max(...allTs);
  const spanDays = Math.max(1, (lastTs-firstTs)/86400000);
  const uniquePos = new Set(trades.map(t=>`${t.slug}|${t.outcome}`)).size;
  const wins = closed.filter(c=>c.pnl>0).length;
  return {
    trades: trades.length,
    unique_positions: uniquePos,
    closed: closed.length,
    open_remaining: openCount,
    span_days: spanDays.toFixed(1),
    trades_per_week: (trades.length*7/spanDays).toFixed(2),
    avg_hold_hours: closed.length ? (closed.reduce((a,c)=>a+c.hold_ms,0)/closed.length/3600000).toFixed(1) : 'n/a',
    avg_hold_days:  closed.length ? (closed.reduce((a,c)=>a+c.hold_ms,0)/closed.length/86400000).toFixed(2) : 'n/a',
    median_hold_hours: closed.length ? ((()=>{const s=closed.map(c=>c.hold_ms).sort((a,b)=>a-b); return s[Math.floor(s.length/2)]/3600000;})()).toFixed(1) : 'n/a',
    pct_holds_over_48h: closed.length ? (100*closed.filter(c=>c.hold_ms>48*3600000).length/closed.length).toFixed(0)+'%' : 'n/a',
    pct_holds_over_7d:  closed.length ? (100*closed.filter(c=>c.hold_ms>7*86400000).length/closed.length).toFixed(0)+'%' : 'n/a',
    win_rate: closed.length ? (100*wins/closed.length).toFixed(0)+'%' : 'n/a',
    total_pnl: closed.reduce((a,c)=>a+c.pnl,0).toFixed(2),
    open_oldest_age_days: openCount ? ((Date.now()-openOldestMs)/86400000).toFixed(1) : 'n/a',
  };
}

(async () => {
  const db = new Database('/app/data/store.db', { readonly: false });
  db.pragma('journal_mode = WAL');

  // ============ A) Falcon period diff ============
  console.log('\n========== A) FALCON 7d vs 30d vs 90d ==========');
  const [d7, d30, d90] = await Promise.all([
    fetchFalconLeaderboard('7d', 300),
    fetchFalconLeaderboard('30d', 300),
    fetchFalconLeaderboard('90d', 500),
  ]);
  console.log(`fetched: 7d=${d7.length}, 30d=${d30.length}, 90d=${d90.length}`);
  const set7  = new Set(d7.map(t=>t.address));
  const set30 = new Set(d30.map(t=>t.address));
  const macroOnly = d90.filter(t =>
    !set7.has(t.address) &&
    (t.sharpe_ratio||0) > 0.5 &&
    (t.roi||0) > 0.15 &&
    (t.win_rate||0) > 0.55 &&
    (t.total_trades||0) >= 10
  ).sort((a,b)=>(b.sharpe_ratio||0)-(a.sharpe_ratio||0));
  console.log(`90d-only (not on 7d) AND sharpe>0.5 AND roi>15% AND wr>55% AND trades>=10: ${macroOnly.length}`);
  console.log('addr                                       sharpe   roi    wr    trades  pnl');
  for (const t of macroOnly.slice(0, 20)) {
    console.log(`${t.address}  ${(t.sharpe_ratio||0).toFixed(2).padStart(6)}  ${((t.roi||0)*100).toFixed(1).padStart(5)}%  ${((t.win_rate||0)*100).toFixed(0).padStart(3)}%  ${String(t.total_trades||0).padStart(5)}  ${(t.total_pnl||0).toFixed(0)}`);
  }

  // ============ B) On-chain backfill for candidates ============
  console.log('\n========== B) HISTORY BACKFILL ==========');
  const targets = [
    { addr: '0x12d6cccfc7470a3f4bafc53599a4779cbf2cf2a8', label: 'watchlist macro candidate' },
    { addr: '0xc2e7800b5af46e6093872b177b7a5e7f0563be51', label: 'falcon sharpe 0.63' },
  ];
  for (const tgt of targets) {
    console.log(`\n--- ${tgt.addr} (${tgt.label}) ---`);
    const hist = await fetchActivity(tgt.addr, 1500);
    console.log(`raw TRADE rows: ${hist.length}`);
    const m = analyzeHistory(hist);
    for (const [k,v] of Object.entries(m)) console.log(`  ${k.padEnd(22)} ${v}`);
  }

  // ============ C) Falcon enrichment + filter ============
  console.log('\n========== C) FALCON ENRICHMENT ==========');
  // Build a map from 90d fetch we already did. Augment with 30d for misses.
  const falconAll = new Map();
  for (const list of [d90, d30, d7]) for (const t of list) if (!falconAll.has(t.address)) falconAll.set(t.address, t);
  console.log(`falcon coverage (union of 7/30/90): ${falconAll.size} addrs`);

  // Enrich the live watchlist with Falcon metrics from the in-memory fetch above.
  // (trader_falcon_cache was dropped in the 2026-05-29 watchlist-only cleanup.)
  const watchRows = db.prepare('SELECT address FROM watchlist_traders').all().map(r => r.address);
  const updWatch  = db.prepare('UPDATE watchlist_traders SET falcon_sharpe=?, falcon_roi=?, falcon_win_rate=? WHERE address=?');
  let updW = 0;
  for (const addr of watchRows) {
    const t = falconAll.get(addr.toLowerCase());
    if (!t) { console.log(`  skip ${addr} — not in Falcon top ${falconAll.size}`); continue; }
    const r = updWatch.run(t.sharpe_ratio??null, t.roi??null, t.win_rate??null, addr);
    updW += r.changes;
  }
  console.log(`watchlist enriched from falcon: ${updW}/${watchRows.length} rows updated`);

  // Build excluded/watchlist sets for shortlist.
  const watchlisted = new Set(db.prepare('SELECT lower(address) AS a FROM watchlist_traders').all().map(r=>r.a));
  const excluded    = new Set(db.prepare('SELECT lower(address) AS a FROM excluded_traders').all().map(r=>r.a));

  // Filter ALL falcon traders (not just cached) by criteria, exclude watchlist + excluded.
  const shortlist = [...falconAll.values()].filter(t =>
    !watchlisted.has(t.address) && !excluded.has(t.address) &&
    (t.sharpe_ratio||0) > 0.5 &&
    (t.roi||0) > 0.15 &&
    (t.win_rate||0) > 0.55 &&
    (t.total_trades||0) >= 10
  ).sort((a,b)=>(b.sharpe_ratio||0)-(a.sharpe_ratio||0)).slice(0,10);

  console.log(`\nTOP 10 not on watchlist (sharpe>0.5, roi>15%, wr>55%, trades>=10):`);
  console.log('addr                                       sharpe   roi    wr    trades  invested  pnl');
  for (const t of shortlist) {
    console.log(`${t.address}  ${(t.sharpe_ratio||0).toFixed(2).padStart(6)}  ${((t.roi||0)*100).toFixed(1).padStart(5)}%  ${((t.win_rate||0)*100).toFixed(0).padStart(3)}%  ${String(t.total_trades||0).padStart(5)}  ${(t.total_invested||0).toFixed(0).padStart(8)}  ${(t.total_pnl||0).toFixed(0)}`);
  }

  db.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
