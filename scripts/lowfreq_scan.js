/**
 * Weekly low-frequency trader discovery (2026-09-26). Replaces the tape-mining
 * scan (scripts/tape_scan.js) as the weekly auto-observation source: all eight
 * traders the tape scan auto-added were bots trading hundreds of markets a day
 * and lost money as copies. This reproduces the manual search that found the
 * LowFreq-*-0926 traders (docs/decisions.md):
 *
 *   1. Pool: the Bullpen leaderboard (fetched on the host by the wrapper into
 *      /work/bullpen/*.json; it carries bot/farmer flags) plus the Polymarket
 *      data-api leaderboard (month + all-time, six categories).
 *   2. Edge per dollar: PnL >= $5k / $20k and PnL/volume >= 5% / 10% (Bullpen /
 *      data-api), recently active, not a bot or farmer, not on the watchlist
 *      or excluded_traders.
 *   3. Copyability, from the last 500 activity rows and the taker/maker split:
 *      active <= 14d, <= 300 orders and 5-120 markets in 30d, taker share
 *      >= 50%, no merge/split/conversion, <= 3 maker rebates.
 *   4. Quality: closed positions of the last 180d netted with open positions
 *      (losers held to zero stay "open", so closed-only win rates are fake);
 *      >= 20 closed, best position <= 50% of gains. Best MAX_BACKTESTS go on.
 *   5. Backtest gate (scripts/backtest_mirror.js: live copy rules, measured
 *      cost + current taker fees, last 365d): PnL > 0 with the 90% CI above
 *      zero, still > 0 at double cost, >= 40 markets over >= 4 months,
 *      profitable in both halves of its history, not carried by one market.
 *   6. LOWFREQ_AUTO_ADD=1: survivors join the watchlist as observation
 *      (copy_enabled=0) through the dashboard API -- the bot caches the store,
 *      so direct DB inserts would only take effect after a restart -- capped
 *      at AUTO_OBS_MAX_TOTAL standing observation traders. One
 *      "TELEGRAM_MSG_B64 <base64>" line per addition for the wrapper.
 *
 * Runs in its own container inside the VPN namespace (never in the bot's; the
 * dashboard is on localhost:8080 there). Run by scripts/weekly-lowfreq-scan.sh:
 *   docker run --rm -u 1000:1000 --network container:gluetun \
 *     -v /home/user/polymarket_bot:/app:ro -v <work>:/work \
 *     node:20-alpine node /app/scripts/lowfreq_scan.js
 * Output: stage counts, a candidate table, /work/report.json, SUMMARY line.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const WORK = process.env.LOWFREQ_WORK || '/work';
const AUTO_ADD = process.env.LOWFREQ_AUTO_ADD === '1';
const DASH = 'http://localhost:8080';
const DATA = 'https://data-api.polymarket.com';
const NOW_S = Date.now() / 1000;
const DAY_S = 86400;

// ── Gates (the thresholds used for the 2026-09-26 manual search) ────────────
const S2_MIN_PNL = { bullpen: 5000, polymarket: 20000 };
const S2_MIN_PNL_PER_VOLUME = { bullpen: 0.05, polymarket: 0.10 };
const S3_MAX_IDLE_DAYS = 14;
const S3_MAX_ORDERS_30D = 300;          // <= 10 orders/day
const S3_MARKETS_30D = [5, 120];
const S3_MIN_TAKER_SHARE = 0.5;         // copying a maker pays the spread it earns
const S3_MAX_ARB_ROWS = 5;              // merge/split/conversion = arbitrage flow
const S3_MAX_MAKER_REBATES = 3;
const S4_MIN_CLOSED_180D = 20;
const S4_MAX_TOP1_SHARE = 0.5;
const MAX_BACKTESTS = 15;               // runtime bound: ~1-3 min each
const S5_MIN_MARKETS = 40;
const S5_MIN_MONTHS = 4;
const AUTO_OBS_MAX_TOTAL = 10;          // standing copy_enabled=0 cap, as the tape scan had
const BACKTEST_TIMEOUT_MS = 20 * 60_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${url}`), { fatal: true });
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (e.fatal) throw e;
      await sleep(2000 * 2 ** i); // shares the IP with the bot: back off hard on 429
    }
  }
  throw lastErr;
}

async function pool(items, fn, n) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

// ── Stage 1: pool ────────────────────────────────────────────────────────────
function loadBullpenPool() {
  const dir = path.join(WORK, 'bullpen');
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
    try {
      for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).leaderboard || []) {
        if (r.wallet_address) out.set(r.wallet_address.toLowerCase(), r);
      }
    } catch { /* one bad query file doesn't sink the pool */ }
  }
  return out;
}

async function loadPolymarketPool() {
  const out = new Map();
  const queries = [];
  for (const tp of ['MONTH', 'ALL']) {
    for (const cat of ['OVERALL', 'POLITICS', 'SPORTS', 'CRYPTO', 'ECONOMICS', 'CULTURE']) queries.push({ tp, cat });
  }
  await pool(queries, async ({ tp, cat }) => {
    for (let off = 0; off < 1000; off += 50) {
      let rows;
      try { rows = await getJson(`${DATA}/v1/leaderboard?timePeriod=${tp}&orderBy=PNL&category=${cat}&limit=50&offset=${off}`); }
      catch { break; }
      for (const r of rows || []) {
        const a = String(r.proxyWallet || '').toLowerCase();
        if (a) out.set(a, { pnl: Number(r.pnl) || 0, vol: Number(r.vol) || 0, name: r.userName || null });
      }
      if (!rows || rows.length < 50) break;
    }
  }, 3);
  return out;
}

async function loadExclusions() {
  const skip = new Set();
  const wl = await getJson(`${DASH}/api/watchlist`);
  for (const w of wl.items || []) skip.add(String(w.address).toLowerCase());
  // excluded_traders from the newest daily backup (never the live WAL file).
  const Database = require('/app/node_modules/better-sqlite3');
  const dir = '/app/data/backups';
  const f = fs.readdirSync(dir).filter(x => /^store-\d{4}-\d{2}-\d{2}\.db$/.test(x)).sort().pop();
  if (f) {
    const db = new Database(path.join(dir, f), { readonly: true, fileMustExist: true });
    for (const r of db.prepare('SELECT address FROM excluded_traders').all()) skip.add(r.address.toLowerCase());
    db.close();
  }
  return { skip, watchlist: wl.items || [] };
}

function stage2(bullpen, polymarket, skip) {
  const cand = new Map();
  for (const [a, r] of bullpen) {
    if (skip.has(a) || r.is_bot || r.is_farmer) continue;
    const pnl = Number(r.lifetime_pnl) || 0, vol = Number(r.lifetime_volume) || 0;
    if (pnl >= S2_MIN_PNL.bullpen && vol > 0 && pnl / vol >= S2_MIN_PNL_PER_VOLUME.bullpen
        && (Number(r.realized_pnl_90d) || 0) > 0 && (Number(r.volume_30d) || 0) > 0) {
      cand.set(a, { src: 'bullpen', pnl, vol, style: r.trading_style || null, category: r.primary_category || null });
    }
  }
  for (const [a, r] of polymarket) {
    if (skip.has(a) || cand.has(a)) continue;
    if (r.pnl >= S2_MIN_PNL.polymarket && r.vol > 0 && r.pnl / r.vol >= S2_MIN_PNL_PER_VOLUME.polymarket) {
      cand.set(a, { src: 'polymarket', pnl: r.pnl, vol: r.vol, style: null, category: null });
    }
  }
  return cand;
}

// ── Stage 3: activity profile ───────────────────────────────────────────────
async function profile(a) {
  const act = await getJson(`${DATA}/activity?user=${a}&limit=500`);
  if (!Array.isArray(act) || !act.length) return null;
  const trades30 = act.filter(x => x.type === 'TRADE' && x.timestamp >= NOW_S - 30 * DAY_S);
  const count = t => act.filter(x => x.type === t).length;
  const all = await getJson(`${DATA}/trades?user=${a}&limit=500&takerOnly=false`);
  const taker = await getJson(`${DATA}/trades?user=${a}&limit=500&takerOnly=true`);
  const since = Math.min(...all.map(x => x.timestamp), NOW_S);
  return {
    idleDays: (NOW_S - Math.max(...act.map(x => x.timestamp))) / DAY_S,
    orders30: new Set(trades30.map(x => x.transactionHash)).size,
    markets30: new Set(trades30.map(x => x.conditionId)).size,
    takerShare: taker.filter(x => x.timestamp >= since).length / Math.max(1, all.length),
    arbRows: count('MERGE') + count('SPLIT') + count('CONVERSION'),
    makerRebates: count('MAKER_REBATE'),
  };
}

function stage3Pass(p) {
  return p && p.idleDays <= S3_MAX_IDLE_DAYS && p.orders30 <= S3_MAX_ORDERS_30D
    && p.markets30 >= S3_MARKETS_30D[0] && p.markets30 <= S3_MARKETS_30D[1]
    && p.takerShare >= S3_MIN_TAKER_SHARE && p.arbRows <= S3_MAX_ARB_ROWS
    && p.makerRebates <= S3_MAX_MAKER_REBATES;
}

// ── Stage 4: realised quality (closed + open netted) ────────────────────────
async function quality(a) {
  const horizon = NOW_S - 180 * DAY_S;
  const closed = [];
  for (let off = 0; off < 5000; off += 50) {
    const page = await getJson(`${DATA}/closed-positions?user=${a}&limit=50&offset=${off}&sortBy=TIMESTAMP&sortDirection=DESC`);
    closed.push(...page);
    if (page.length < 50 || page[page.length - 1].timestamp < horizon) break;
  }
  const pnl = closed.filter(x => x.timestamp >= horizon).map(x => Number(x.realizedPnl) || 0);
  const gains = pnl.filter(v => v > 0).reduce((s, v) => s + v, 0);
  const open = await getJson(`${DATA}/positions?user=${a}&sizeThreshold=1&limit=500`);
  const openPnl = (open || []).reduce((s, x) => s + (Number(x.cashPnl) || 0), 0);
  const closedPnl = pnl.reduce((s, v) => s + v, 0);
  return {
    closed180: pnl.length, closedPnl, openPnl, net: closedPnl + openPnl,
    top1Share: gains > 0 ? Math.max(...pnl) / gains : 1,
  };
}

const stage4Pass = q => q.closed180 >= S4_MIN_CLOSED_180D && q.top1Share <= S4_MAX_TOP1_SHARE && q.net > 0;

// ── Stage 5: backtest gate ──────────────────────────────────────────────────
function runBacktest(a, since) {
  return new Promise(resolve => {
    execFile('node', ['/app/scripts/backtest_mirror.js', a, since],
      { env: { ...process.env, BACKTEST_CACHE: path.join(WORK, 'btcache') }, timeout: BACKTEST_TIMEOUT_MS, maxBuffer: 16 << 20 },
      err => {
        const file = path.join(WORK, 'btcache', `results_${a.slice(0, 10)}_${since}.json`);
        if (err || !fs.existsSync(file)) return resolve(null);
        resolve(JSON.parse(fs.readFileSync(file, 'utf8')));
      });
  });
}

/** Gate on the live copy model ('A  live') at measured (x1) and double (x2) cost. */
function evaluateBacktest(res) {
  const live = k => res.results.find(r => r.k === k)?.models.find(m => m.name.startsWith('A '))?.s;
  const a1 = live(1), a2 = live(2);
  if (!a1 || !a2) return { pass: false, reason: 'no live-model result' };
  const months = Object.keys(a1.byMonth).sort();
  const vals = months.map(m => a1.byMonth[m]);
  const half = Math.floor(vals.length / 2);
  const sum = xs => xs.reduce((s, v) => s + v, 0);
  const firstHalf = sum(vals.slice(0, half)), secondHalf = sum(vals.slice(half));
  const checks = {
    profitable: a1.total > 0,
    ciAboveZero: a1.ci[0] > 0,
    survivesDoubleCost: a2.total > 0,
    enoughMarkets: a1.markets >= S5_MIN_MARKETS,
    enoughMonths: months.length >= S5_MIN_MONTHS,
    bothHalves: firstHalf > 0 && secondHalf > 0,
    notOneMarket: a1.total - a1.top1 > 0,
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  return {
    pass: failed.length === 0, failed,
    pnl: a1.total, ci: a1.ci, pnl2x: a2.total, fees: a1.fees, markets: a1.markets,
    months: months.length, firstHalf, secondHalf,
  };
}

// ── Stage 6: auto-add as observation ────────────────────────────────────────
async function addObservation(a, label) {
  const r = await fetch(`${DASH}/api/watchlist`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: a, label, copyEnabled: false }),
  });
  return r.ok;
}

const usd = v => (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(0);

async function main() {
  const t0 = Date.now();
  const since = new Date((NOW_S - 365 * DAY_S) * 1000).toISOString().slice(0, 10);
  const { skip, watchlist } = await loadExclusions();
  const bullpen = loadBullpenPool();
  const polymarket = await loadPolymarketPool();
  console.log(`[lowfreq] stage1 pool: bullpen ${bullpen.size}, data-api ${polymarket.size}, excluded ${skip.size}`);

  const s2 = stage2(bullpen, polymarket, skip);
  console.log(`[lowfreq] stage2 edge per dollar: ${s2.size}`);

  const s3 = [];
  await pool([...s2.keys()], async a => {
    try { const p = await profile(a); if (stage3Pass(p)) s3.push({ a, ...s2.get(a), ...p }); }
    catch (e) { /* unreachable trader: skip this week */ }
  }, 4);
  console.log(`[lowfreq] stage3 copyable activity: ${s3.length}`);

  const s4 = [];
  await pool(s3, async c => {
    try { const q = await quality(c.a); if (stage4Pass(q)) s4.push({ ...c, ...q }); }
    catch (e) { /* skip */ }
  }, 3);
  s4.sort((x, y) => y.net - x.net);
  const shortlist = s4.slice(0, MAX_BACKTESTS);
  console.log(`[lowfreq] stage4 realised quality: ${s4.length} (backtesting ${shortlist.length})`);

  const evaluated = [];
  for (const c of shortlist) { // sequential: Gamma's rate limit is shared with the bot's price sweep
    const res = await runBacktest(c.a, since);
    const ev = res ? evaluateBacktest(res) : { pass: false, failed: ['backtest failed'] };
    evaluated.push({ ...c, bt: ev });
    console.log(`  ${c.a} ${ev.pass ? 'PASS' : 'fail'} ` + (res
      ? `pnl ${usd(ev.pnl)} ci [${usd(ev.ci[0])}, ${usd(ev.ci[1])}] x2 ${usd(ev.pnl2x)} mkts ${ev.markets} months ${ev.months}` +
        (ev.pass ? '' : ` | failed: ${ev.failed.join(',')}`)
      : '| backtest failed'));
  }
  const survivors = evaluated.filter(c => c.bt.pass).sort((x, y) => y.bt.ci[0] - x.bt.ci[0]);

  const added = [];
  if (AUTO_ADD && survivors.length) {
    const standing = watchlist.filter(w => w.copyEnabled === false).length;
    let slots = Math.max(0, AUTO_OBS_MAX_TOTAL - standing);
    console.log(`[lowfreq] observation traders ${standing}/${AUTO_OBS_MAX_TOTAL}, slots ${slots}`);
    const tag = new Date().toISOString().slice(5, 10).replace('-', '');
    for (const c of survivors) {
      if (slots <= 0) { console.log(`  cap reached, not added: ${c.a}`); continue; }
      const label = `LowFreq-Obs-${tag}`;
      if (!(await addObservation(c.a, label))) { console.log(`  add failed: ${c.a}`); continue; }
      slots--;
      added.push(c.a);
      const msg = `\u{1F441} [polymarket_bot] New low-frequency trader on observation: ${label}\n${c.a}\n` +
        `Backtest 12 months, our copy rules, real costs + fees: ${usd(c.bt.pnl)} ` +
        `(90% CI ${usd(c.bt.ci[0])}..${usd(c.bt.ci[1])}), double cost ${usd(c.bt.pnl2x)}, ${c.bt.markets} markets\n` +
        `${c.orders30} orders / 30d, taker ${(100 * c.takerShare).toFixed(0)}%\n` +
        `copy_enabled=0 (observation, no real money). Enable copy on :8082 if it keeps performing.`;
      console.log('TELEGRAM_MSG_B64 ' + Buffer.from(msg).toString('base64'));
    }
  }

  fs.writeFileSync(path.join(WORK, 'report.json'), JSON.stringify({
    ranAt: new Date().toISOString(), since, autoAdd: AUTO_ADD,
    counts: { bullpen: bullpen.size, polymarket: polymarket.size, stage2: s2.size, stage3: s3.length, stage4: s4.length, backtested: evaluated.length, passed: survivors.length, added: added.length },
    evaluated,
  }, null, 2));
  console.log(`SUMMARY stage2=${s2.size} stage3=${s3.length} stage4=${s4.length} backtested=${evaluated.length} passed=${survivors.length} added=${added.length} minutes=${((Date.now() - t0) / 60000).toFixed(1)}`);
}

module.exports = { evaluateBacktest };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
