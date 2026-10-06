/**
 * Copy-model backtest for ONE watchlist trader on their real on-chain
 * activity (2026-09-26). Question: would proportional POSITION MIRRORING
 * have copied the trader profitably where the live per-fill model did not?
 *
 * Models, all replayed on the same data-api /activity stream with the same
 * cost model:
 *   A   live model (monitor.ts): $5 per BUY (one per tx hash, like the
 *       processed-id dedup), per-market entry cap, 0x12d6 longshot filter,
 *       wallet cap, each SELL closes the oldest lot 100%, 7d max hold.
 *   A*  A without the 7d max-hold expiry.
 *   C1  A's entries; exit only when the trader sold >=50% of the position
 *       (then close all our lots), otherwise hold. No 7d expiry.
 *   C2  A's entries; pro-rata exits (sell the fraction the trader sold).
 *   B   position mirroring: every BUY/SELL/SPLIT/MERGE/CONVERSION scaled by
 *       one fixed factor (sized so peak capital = $800 of the $1000 wallet),
 *       pro-rata exits, no entry cap, hold while the trader holds.
 *   Bs  B with share-delta exits (sell s*q shares) instead of pro-rata.
 *   Bm  B with the 5-share minimum order (buys accumulate until >= 5 shares).
 *   D*  slow mirror: hold B's cost-free book, but only trade toward it every
 *       1h / 6h / 24h (nets out the trader's in-and-out churn), at the last
 *       trader fill price +- gap; SPLIT/MERGE/CONVERSION still mirrored live.
 *
 * Costs: every taker leg pays the empirical entry gap (best_ask - trader
 * price, floored at 0) measured on our own copies of this trader, by price
 * bucket; buys pay p+gap, sells get p-gap. SPLIT/MERGE/redemption are free
 * on-chain ops. Cost levels: x0 = the trader's own prices (upper bound),
 * x0.8 = zero-latency taker (pays only the spread: min(gap, spread) is 79% of
 * the measured gap for 0x12d6), x1 = measured (~33s poll latency), x2 = slower.
 * On top of the gap, every copy leg pays the market's CURRENT Polymarket taker
 * fee from Gamma (feesEnabled + feeSchedule; rate 0 for geopolitics), applied to
 * the whole history -- fee rollouts during 2026 are ignored, which is
 * conservative for older trades. BACKTEST_FEES=0 turns fees off.
 * Payouts: Gamma outcomePrices for resolved markets; open markets are marked
 * at current price minus the gap (liquidation value).
 *
 * negRisk conversions: the /activity CONVERSION row only carries the event's
 * negRiskMarketID, so the burned NO legs (indexSet) are decoded from the
 * NegRiskAdapter PositionsConverted log in the Polygon tx receipt; question
 * index = last byte of the Gamma questionID. PnL is attributed per negRisk
 * EVENT (value moves between its markets on conversion), per market otherwise.
 * Not modelled: the depth gate and the sim's price-proxy resolution.
 *
 * Usage (data-api/Gamma/CLOB are geo-blocked from the host -> VPN namespace):
 *   docker run --rm -u 1000:1000 --network container:gluetun \
 *     -v "$PWD":/app:ro -v <cache-dir>:/cache \
 *     node:20-alpine node /app/scripts/backtest_mirror.js <address> [since] [db]
 * db defaults to the newest data/backups/store-*.db (never the live WAL file).
 * BACKTEST_REFRESH=1 re-fetches instead of using /cache. Per-unit results are
 * written to /cache/results_<addr>_<since>.json.
 */
const fs = require('fs');
const path = require('path');
const Database = require('/app/node_modules/better-sqlite3');

const ADDRESS = String(process.argv[2] || '').toLowerCase();
const SINCE = process.argv[3] || '2026-06-10';
const CACHE = process.env.BACKTEST_CACHE || '/cache';
const REFRESH = process.env.BACKTEST_REFRESH === '1';
const FEES = process.env.BACKTEST_FEES !== '0'; // current per-market taker fees on every copy leg

const DATA = 'https://data-api.polymarket.com';
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
// drpc serves archive receipts; publicnode is pruned (null for txs older than ~weeks).
const POLYGON_RPCS = ['https://polygon.drpc.org', 'https://polygon-bor-rpc.publicnode.com'];
const NEG_RISK_ADAPTER = '0xd91e80cf2e7be2e162c6513ced06f1dd0da35296';
const POSITIONS_CONVERTED = '0xb03d19dddbc72a87e735ff0ea3b57bef133ebe44e1894284916a84044deb367e';

// ── Live-model constants (src/config.ts + docker-compose.yml) ───────────────
const TRADE_AMOUNT = 5;
const WALLET_CAP = 1000 * 0.80;
const MAX_ENTRIES_NON_DATED = 2;
const ENTRY_WINDOW_MS = 12 * 3600_000;
const LONGSHOT_TRADER = '0x12d6cccfc7470a3f4bafc53599a4779cbf2cf2a8';
const LONGSHOT_MAX_PRICE = 0.10;
const MAX_HOLD_MS = 7 * 86_400_000;
const MIN_ORDER_SHARES = 5;
const MIRROR_PEAK_CAPITAL = WALLET_CAP;

const ACTIVITY_PAGE = 500;       // /activity silently caps limit at 500
const ACTIVITY_MAX_OFFSET = 4500; // offset 5000 still works, 10000 is HTTP 400
const COST_MULTS = [0, 0.8, 1, 2];
const BOOT_ITERS = 10_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isMatchStyleSlug = slug => /-\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(-|$)/.test(slug);

async function getJson(url, tries = 4) {
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
      await sleep(1000 * (i + 1));
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

// Activity is the trader's full history (window-independent); everything
// derived from the window's market set is cached per SINCE.
function cached(name, fetcher) {
  const suffix = name === 'activity' ? '' : `_${SINCE}`;
  const file = path.join(CACHE, `${name}_${ADDRESS.slice(0, 10)}${suffix}.json`);
  if (!REFRESH && fs.existsSync(file)) return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8')));
  return fetcher().then(v => { fs.writeFileSync(file, JSON.stringify(v)); return v; });
}

// ── Data: trader activity (full history, for position reconstruction) ───────
const KEEP = ['timestamp', 'type', 'side', 'conditionId', 'outcomeIndex', 'outcome', 'price',
  'size', 'usdcSize', 'slug', 'asset', 'transactionHash'];
const slim = r => Object.fromEntries(KEEP.map(k => [k, r[k]]));

async function fetchSlice(start, end) {
  const out = [];
  for (let offset = 0; offset <= ACTIVITY_MAX_OFFSET; offset += ACTIVITY_PAGE) {
    const page = await getJson(`${DATA}/activity?user=${ADDRESS}&start=${start}&end=${end}&limit=${ACTIVITY_PAGE}&offset=${offset}`);
    out.push(...page.map(slim));
    if (page.length < ACTIVITY_PAGE) return out;
  }
  // Slice denser than the offset cap: split it (re-fetches the slice, rare).
  const mid = Math.floor((start + end) / 2);
  if (mid <= start) throw new Error(`activity slice ${start}-${end} exceeds the offset cap`);
  return [...await fetchSlice(start, mid), ...await fetchSlice(mid + 1, end)];
}

async function fetchActivity() {
  const first = await getJson(`${DATA}/activity?user=${ADDRESS}&limit=1&sortDirection=ASC`);
  if (!first.length) return [];
  // 30-day slices (unix seconds): one page for quiet traders; fetchSlice
  // halves any slice that hits the offset cap.
  const SLICE = 30 * 86400;
  const t0 = Math.floor(first[0].timestamp / 86400) * 86400;
  const now = Math.floor(Date.now() / 1000);
  const starts = [];
  for (let d = t0; d <= now; d += SLICE) starts.push(d);
  const parts = new Array(starts.length);
  let done = 0;
  await pool(starts, async (d, i) => {
    parts[i] = await fetchSlice(d, d + SLICE - 1);
    if (++done % 10 === 0) console.log(`  ... activity ${done}/${starts.length} slices`);
  }, 6);
  return parts.flat();
}

// ── Data: market outcomes (Gamma) ───────────────────────────────────────────
const parseArr = v => { try { return Array.isArray(v) ? v : JSON.parse(v); } catch { return null; } };
const parseGammaTime = s => {
  if (!s) return null;
  const ms = Date.parse(String(s).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  return Number.isNaN(ms) ? null : ms;
};

const marketInfo = m => ({
  closed: m.closed === true,
  prices: (parseArr(m.outcomePrices) || []).map(Number),
  tokens: parseArr(m.clobTokenIds) || [],
  closedTime: parseGammaTime(m.closedTime),
  negRiskId: m.negRisk ? m.negRiskMarketID || null : null,
  questionIndex: m.negRisk && m.questionID ? parseInt(String(m.questionID).slice(-2), 16) : null,
  eventSlug: m.events?.[0]?.slug || null,
  // Taker fee = shares * rate * (p * (1 - p))^exponent (docs.polymarket.com/trading/fees).
  feeRate: m.feesEnabled ? Number(m.feeSchedule?.rate ?? 0) : 0,
  feeExp: Number(m.feeSchedule?.exponent ?? 1),
});

async function fetchMarkets(cids) {
  const info = {};
  const batches = [];
  for (let i = 0; i < cids.length; i += 20) batches.push(cids.slice(i, i + 20));
  await pool(batches, async b => {
    const q = b.map(c => `condition_ids=${c}`).join('&');
    for (const extra of ['', '&closed=true']) {
      for (const m of await getJson(`${GAMMA}/markets?${q}${extra}&limit=100`)) info[m.conditionId] = marketInfo(m);
    }
  }, 4);
  return info;
}

// Every market of the negRisk events the trader converted in: a conversion
// mints YES in all non-burned questions, including ones the trader never traded.
async function fetchEventMarkets(eventSlugs) {
  const info = {};
  await pool(eventSlugs, async slug => {
    for (const ev of await getJson(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`)) {
      for (const m of ev.markets || []) info[m.conditionId] = { ...marketInfo(m), eventSlug: slug };
    }
  }, 4);
  return info;
}

// ── Data: negRisk conversions decoded from Polygon receipts ─────────────────
// Returns null when no endpoint has the result (e.g. receipt unknown).
async function rpc(method, params, tries = 3) {
  for (const url of POLYGON_RPCS) {
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (j.result) return j.result;
        if (!j.error) break; // null result: try the next endpoint
        throw new Error(JSON.stringify(j.error).slice(0, 200));
      } catch {
        await sleep(1000 * (i + 1));
      }
    }
  }
  return null;
}

async function decodeConversions(convRows) {
  const out = {};
  await pool(convRows, async r => {
    const rc = await rpc('eth_getTransactionReceipt', [r.transactionHash]);
    if (!rc) return; // stays undecoded (reported in diagnostics)
    const log = (rc.logs || []).find(l => l.address.toLowerCase() === NEG_RISK_ADAPTER
      && l.topics[0] === POSITIONS_CONVERTED && l.topics[2].toLowerCase() === r.conditionId.toLowerCase());
    if (log) out[r.transactionHash] = { indexSet: BigInt(log.topics[3]).toString(), amount: Number(BigInt(log.data)) / 1e6 };
  }, 4);
  return out;
}

// ── Cost model: empirical taker gap on our own copies of this trader ────────
const BUCKETS = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0001];

function newestBackup() {
  const dir = '/app/data/backups';
  const f = fs.readdirSync(dir).filter(x => /^store-\d{4}-\d{2}-\d{2}\.db$/.test(x)).sort().pop();
  if (!f) throw new Error('no data/backups/store-*.db found; pass a db path');
  return path.join(dir, f);
}

function loadGapModel(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const gapRows = where => db.prepare(`
    SELECT entry_price AS p, entry_price_gap AS g FROM closed_trades WHERE ${where} AND entry_price_gap IS NOT NULL
    UNION ALL
    SELECT entry_price, entry_price_gap FROM open_trades WHERE ${where} AND entry_price_gap IS NOT NULL`);
  let rows = gapRows('copied_trader = ?').all(ADDRESS, ADDRESS);
  let scope = 'this trader';
  if (rows.length < 50) {
    rows = gapRows("copied_trader_source = 'watchlist'").all();
    scope = 'all watchlist copies (too few for this trader)';
  }
  // Live-sim result for the same trader/window, cost-adjusted like
  // tradeCostAdjustedPnl (open trades marked with the 2% exit charge).
  const live = db.prepare(`
    SELECT (SELECT COUNT(*) FROM closed_trades WHERE copied_trader = @a AND copied_trader_source = 'watchlist' AND timestamp >= @s) AS n,
           (SELECT SUM(cost_adjusted_pnl) FROM closed_trades WHERE copied_trader = @a AND copied_trader_source = 'watchlist' AND timestamp >= @s) AS pnl,
           (SELECT COUNT(*) FROM open_trades WHERE copied_trader = @a AND timestamp >= @s) AS nOpen,
           (SELECT SUM(COALESCE(unrealized_pnl, 0) - COALESCE(entry_gas_cost, 0) - COALESCE(entry_slippage_cost, 0)
                       - 0.02 * COALESCE(current_price, entry_price) * simulated_shares)
              FROM open_trades WHERE copied_trader = @a AND timestamp >= @s) AS openPnl`).get({ a: ADDRESS, s: SINCE });
  db.close();
  const cost = g => Math.max(0, g);
  const pooled = rows.reduce((s, r) => s + cost(r.g), 0) / Math.max(1, rows.length);
  const raw = BUCKETS.slice(0, -1).map((lo, i) => {
    const b = rows.filter(r => r.p >= lo && r.p < BUCKETS[i + 1]);
    return { lo, hi: BUCKETS[i + 1], n: b.length, gap: b.length >= 10 ? b.reduce((s, r) => s + cost(r.g), 0) / b.length : null };
  });
  // A thin bucket borrows its mirror bucket (YES at p trades in the same book
  // as NO at 1-p; e.g. the 0x12d6 longshot filter leaves 0-0.1 empty), else pooled.
  const means = raw.map((m, i) => ({ ...m, gap: m.gap ?? raw[raw.length - 1 - i].gap ?? pooled }));
  const gap = p => (means.find(m => p >= m.lo && p < m.hi) || means[means.length - 1]).gap;
  return { gap, means, pooled, n: rows.length, scope, live };
}

// ── Trader position reconstruction + event stream ───────────────────────────
const TYPE_ORDER = { SPLIT: 0, TRADE: 1, MERGE: 2, CONVERSION: 3, REDEEM: 4 };
const key = (cid, oi) => `${cid}|${oi}`;

function buildEvents(rows, payouts, markets, conversions, eventIndex) {
  const sinceSec = Date.parse(SINCE) / 1000;
  const evs = rows
    .filter(r => TYPE_ORDER[r.type] !== undefined && r.conditionId)
    .sort((a, b) => a.timestamp - b.timestamp || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
  const tpos = new Map();
  const get = k => tpos.get(k) || 0;
  const diag = { sellOverPosition: 0, sells: 0, conversionsInWindow: 0, conversionSizeInWindow: 0, conversionsUndecoded: 0 };
  const out = [];
  // Per-transaction sell fraction: the live bot sees one row per tx hash, so
  // the per-fill models decide on the whole order's fraction, not the first fill's.
  const txSell = new Map(); // tx|key -> {before, q, evs}
  for (const r of evs) {
    const inWindow = r.timestamp >= sinceSec;
    const cid = r.conditionId;
    const q = Number(r.size) || 0;
    const e = { t: r.timestamp * 1000, type: r.type, cid, oi: r.outcomeIndex, p: Number(r.price), q,
                slug: r.slug, asset: r.asset, tx: r.transactionHash, side: r.side };
    if (r.type === 'TRADE') {
      if (!(e.p > 0 && e.p <= 1 && q > 0) || (r.side !== 'BUY' && r.side !== 'SELL')) continue;
      const k = key(cid, e.oi);
      if (r.side === 'BUY') tpos.set(k, get(k) + q);
      else {
        const before = get(k);
        e.f = before > 1e-9 ? Math.min(1, q / before) : 1;
        if (inWindow) { diag.sells++; if (q > before + 1e-6) diag.sellOverPosition++; }
        tpos.set(k, Math.max(0, before - q));
        const tk = `${e.tx}|${k}`;
        const agg = txSell.get(tk) || { before, q: 0, evs: [] };
        agg.q += q; agg.evs.push(e);
        txSell.set(tk, agg);
      }
    } else if (r.type === 'SPLIT') {
      tpos.set(key(cid, 0), get(key(cid, 0)) + q);
      tpos.set(key(cid, 1), get(key(cid, 1)) + q);
    } else if (r.type === 'MERGE') {
      const b0 = get(key(cid, 0)), b1 = get(key(cid, 1));
      e.f0 = b0 > 1e-9 ? Math.min(1, q / b0) : 1;
      e.f1 = b1 > 1e-9 ? Math.min(1, q / b1) : 1;
      tpos.set(key(cid, 0), Math.max(0, b0 - q));
      tpos.set(key(cid, 1), Math.max(0, b1 - q));
    } else if (r.type === 'REDEEM') {
      tpos.set(key(cid, 0), 0);
      tpos.set(key(cid, 1), 0);
    } else if (r.type === 'CONVERSION') {
      // Burn `amount` NO in every indexSet question, mint `amount` YES in all
      // the others, receive (burned - 1) * amount USDC. cid = negRiskMarketID.
      if (inWindow) { diag.conversionsInWindow++; diag.conversionSizeInWindow += q; }
      const dec = conversions[r.transactionHash];
      const legs = eventIndex[cid];
      if (!dec || !legs) { if (inWindow) diag.conversionsUndecoded++; continue; }
      const bits = BigInt(dec.indexSet);
      const burned = l => ((bits >> BigInt(l.index)) & 1n) === 1n;
      e.q = dec.amount;
      e.burn = legs.filter(burned).map(l => {
        const k = key(l.cid, 1);
        const before = get(k);
        tpos.set(k, Math.max(0, before - dec.amount));
        return { cid: l.cid, f: before > 1e-9 ? Math.min(1, dec.amount / before) : 1 };
      });
      e.mint = legs.filter(l => !burned(l)).map(l => l.cid);
      for (const c of e.mint) tpos.set(key(c, 0), get(key(c, 0)) + dec.amount);
    }
    if (inWindow) out.push(e);
  }
  for (const { before, q, evs: txEvs } of txSell.values()) {
    const ftx = before > 1e-9 ? Math.min(1, q / before) : 1;
    for (const e of txEvs) e.ftx = ftx;
  }
  // Synthetic resolution events: settle every model's holdings at the payout
  // when the market resolved (Gamma closedTime, else the trader's first redeem).
  // negRisk date ladders resolve question by question while the event stays
  // open, and later conversions still burn those (unredeemed) NO legs — so a
  // negRisk market settles only after its event's last conversion.
  const firstRedeem = {};
  const lastConv = {};
  for (const e of out) {
    if (e.type === 'REDEEM' && !(e.cid in firstRedeem)) firstRedeem[e.cid] = e.t;
    if (e.type === 'CONVERSION' && e.burn) lastConv[e.cid] = e.t;
  }
  // Per-fill models don't convert, so they keep settling at the real close.
  const push = (t, scope, cid, pay) => { if (t >= Date.parse(SINCE)) out.push({ t, type: 'RESOLVE', scope, cid, payouts: pay.prices }); };
  for (const [cid, pay] of Object.entries(payouts)) {
    if (!pay.resolved) continue;
    const t = markets[cid]?.closedTime ?? firstRedeem[cid];
    if (t == null) continue;
    const nr = markets[cid]?.negRiskId;
    const tMirror = nr && lastConv[nr] != null ? Math.max(t, lastConv[nr] + 1000) : t;
    if (tMirror === t) push(t, 'all', cid, pay);
    else { push(t, 'lots', cid, pay); push(tMirror, 'mirror', cid, pay); }
  }
  out.sort((a, b) => a.t - b.t || (a.type === 'RESOLVE') - (b.type === 'RESOLVE'));
  return { events: out, diag };
}

// Final payout per outcome. Gamma first; if Gamma has no closed/pinned market,
// fall back to the trader's REDEEM rows (size > 0 = that outcome paid out).
function payoutOf(cid, markets, redeems) {
  const m = markets[cid];
  if (m && m.closed && m.prices.length === 2 && m.prices.every(p => p <= 0.005 || p >= 0.995)) {
    return { resolved: true, prices: m.prices.map(p => (p >= 0.5 ? 1 : 0)) };
  }
  if (!m) {
    const red = (redeems.get(cid) || []).filter(r => r.outcomeIndex === 0 || r.outcomeIndex === 1);
    const win = red.find(r => Number(r.size) > 0);
    if (win) return { resolved: true, prices: win.outcomeIndex === 0 ? [1, 0] : [0, 1] };
    if (red.length) return { resolved: true, prices: red[0].outcomeIndex === 0 ? [0, 1] : [1, 0] };
  }
  return { resolved: false, prices: m ? m.prices : null };
}

// ── Models ──────────────────────────────────────────────────────────────────
class Ledger {
  constructor(name) {
    this.name = name;
    this.cash = 0; this.peak = 0; this.deployed = 0; this.legs = 0; this.fees = 0;
    this.mcash = new Map();   // unit (negRisk event or market) -> cash flow
    this.firstT = new Map();  // unit -> first entry ms
    this.settled = new Set(); // resolved conditionIds
    this.openMtm = 0;
  }
  flow(cid, amount, t) {
    const unit = this.ctx.unitOf(cid);
    this.cash += amount;
    this.mcash.set(unit, (this.mcash.get(unit) || 0) + amount);
    if (amount < 0) {
      this.deployed -= amount;
      if (!this.firstT.has(unit)) this.firstT.set(unit, t);
    }
    this.peak = Math.max(this.peak, -this.cash);
  }
  // Taker leg at execution price p: buys pay shares*p + fee, sells get shares*p - fee.
  taker(cid, side, p, shares, t) {
    const fee = this.ctx.fee(cid, p, shares);
    this.fees += fee;
    this.flow(cid, side === 'BUY' ? -(shares * p + fee) : shares * p - fee, t);
    this.legs++;
  }
}

// Per-fill $5 lots (live model and its exit-rule variants).
class LotModel extends Ledger {
  constructor(name, ctx, { exit, expiry }) {
    super(name);
    Object.assign(this, { ctx, exit, expiry });
    this.lots = new Map();    // key -> [{shares, amount, t, asset}]
    this.entries = new Map(); // slug -> [ms]
    this.seenTx = new Set();
    this.openAmount = 0;
    this.capSkips = 0;
  }
  closeLot(k, lot, frac, price, cid, t) {
    const sh = lot.shares * frac;
    this.taker(cid, 'SELL', price, sh, t);
    lot.shares -= sh;
    this.openAmount -= lot.amount * frac;
    lot.amount -= lot.amount * frac;
  }
  expire(now) {
    if (!this.expiry) return;
    for (const [k, lots] of this.lots) {
      const cid = k.split('|')[0];
      for (const lot of lots) {
        const at = lot.t + MAX_HOLD_MS;
        if (lot.shares <= 1e-12 || at > now) continue;
        const p = this.ctx.priceAt(lot.asset, at, k);
        this.closeLot(k, lot, 1, Math.max(0, p - this.ctx.k * this.ctx.gap(p)), cid, at);
      }
      this.lots.set(k, lots.filter(l => l.shares > 1e-12));
    }
  }
  on(e) {
    this.expire(e.t);
    if (e.type === 'RESOLVE') return e.scope === 'mirror' ? undefined : this.resolve(e);
    if (e.type !== 'TRADE' || this.settled.has(e.cid)) return;
    if (this.seenTx.has(e.tx)) return; // live bot dedups activity by transaction hash
    this.seenTx.add(e.tx);
    const k = key(e.cid, e.oi);
    const { gap, k: mult } = this.ctx;
    if (e.side === 'BUY') {
      if (ADDRESS === LONGSHOT_TRADER && e.p < LONGSHOT_MAX_PRICE) return;
      const ts = this.entries.get(e.slug) || [];
      const n = isMatchStyleSlug(e.slug) ? ts.length : ts.filter(x => x >= e.t - ENTRY_WINDOW_MS).length;
      if (n >= (isMatchStyleSlug(e.slug) ? 1 : MAX_ENTRIES_NON_DATED)) return;
      if (this.openAmount + TRADE_AMOUNT > WALLET_CAP) { this.capSkips++; return; }
      const shares = TRADE_AMOUNT / e.p;
      this.taker(e.cid, 'BUY', e.p + mult * gap(e.p), shares, e.t);
      this.openAmount += TRADE_AMOUNT;
      ts.push(e.t); this.entries.set(e.slug, ts);
      const lots = this.lots.get(k) || [];
      lots.push({ shares, amount: TRADE_AMOUNT, t: e.t, asset: e.asset });
      this.lots.set(k, lots);
      return;
    }
    const lots = (this.lots.get(k) || []).filter(l => l.shares > 1e-12);
    if (!lots.length) return;
    const px = Math.max(0, e.p - mult * gap(e.p));
    if (this.exit === 'fifo') this.closeLot(k, lots[0], 1, px, e.cid, e.t);
    else if (this.exit === 'half' && e.ftx >= 0.5) for (const l of lots) this.closeLot(k, l, 1, px, e.cid, e.t);
    else if (this.exit === 'prorata') for (const l of lots) this.closeLot(k, l, e.ftx, px, e.cid, e.t);
    this.lots.set(k, lots.filter(l => l.shares > 1e-12));
  }
  resolve(e) {
    this.settled.add(e.cid);
    for (const oi of [0, 1]) {
      const k = key(e.cid, oi);
      for (const l of this.lots.get(k) || []) {
        this.flow(e.cid, l.shares * e.payouts[oi], e.t);
        this.openAmount -= l.amount;
      }
      this.lots.delete(k);
    }
  }
  finish(end) {
    this.expire(end);
    for (const [k, lots] of this.lots) {
      const [cid, oi] = k.split('|');
      for (const l of lots) {
        const p = this.ctx.markPrice(cid, Number(oi), k);
        const v = l.shares * p - this.ctx.markFee(cid, p, l.shares);
        this.flow(cid, v, end);
        this.openMtm += v;
      }
    }
  }
}

// Proportional position mirroring.
class MirrorModel extends Ledger {
  constructor(name, ctx, { scale, exit = 'prorata', minShares = 0 }) {
    super(name);
    Object.assign(this, { ctx, scale, exit, minShares });
    this.held = new Map();
    this.pending = new Map(); // unexecuted buy shares below the order minimum
  }
  h(k) { return this.held.get(k) || 0; }
  on(e) {
    if (e.type === 'RESOLVE') return e.scope === 'lots' ? undefined : this.resolve(e);
    if (this.settled.has(e.cid)) return;
    const { gap, k: mult } = this.ctx;
    const s = this.scale;
    if (e.type === 'TRADE') {
      const k = key(e.cid, e.oi);
      if (e.side === 'BUY') {
        let sh = s * e.q + (this.pending.get(k) || 0);
        if (sh < this.minShares) { this.pending.set(k, sh); return; }
        this.pending.delete(k);
        this.taker(e.cid, 'BUY', e.p + mult * gap(e.p), sh, e.t);
        this.held.set(k, this.h(k) + sh);
      } else {
        this.pending.delete(k);
        const have = this.h(k);
        const sh = this.exit === 'shares' ? Math.min(have, s * e.q) : have * e.f;
        if (sh <= 1e-12) return;
        if (sh < this.minShares && have - sh > 1e-9) return; // below minimum and not a full exit
        this.taker(e.cid, 'SELL', Math.max(0, e.p - mult * gap(e.p)), sh, e.t);
        this.held.set(k, have - sh);
      }
    } else if (e.type === 'SPLIT') {
      const sh = s * e.q;
      this.flow(e.cid, -sh, e.t);
      for (const oi of [0, 1]) this.held.set(key(e.cid, oi), this.h(key(e.cid, oi)) + sh);
    } else if (e.type === 'MERGE') {
      const h0 = this.h(key(e.cid, 0)), h1 = this.h(key(e.cid, 1));
      const m = this.exit === 'shares' ? Math.min(h0, h1, s * e.q) : Math.min(h0 * e.f0, h1 * e.f1);
      if (m <= 1e-12) return;
      this.flow(e.cid, m, e.t);
      this.held.set(key(e.cid, 0), h0 - m);
      this.held.set(key(e.cid, 1), h1 - m);
    } else if (e.type === 'CONVERSION' && e.burn) {
      if (!e.burn.length || e.burn.some(b => this.settled.has(b.cid))) return;
      const no = b => this.h(key(b.cid, 1));
      const c = this.exit === 'shares'
        ? Math.min(s * e.q, ...e.burn.map(no))
        : Math.min(...e.burn.map(b => no(b) * b.f));
      if (!(c > 1e-12)) return;
      for (const b of e.burn) this.held.set(key(b.cid, 1), no(b) - c);
      for (const m of e.mint) if (!this.settled.has(m)) this.held.set(key(m, 0), this.h(key(m, 0)) + c);
      if (e.burn.length > 1) this.flow(e.cid, (e.burn.length - 1) * c, e.t);
    }
  }
  resolve(e) {
    this.settled.add(e.cid);
    for (const oi of [0, 1]) {
      const k = key(e.cid, oi);
      const sh = this.h(k);
      if (sh > 1e-12) this.flow(e.cid, sh * e.payouts[oi], e.t);
      this.held.delete(k);
      this.pending.delete(k);
    }
  }
  finish(end) {
    for (const [k, sh] of this.held) {
      if (sh <= 1e-12) continue;
      const [cid, oi] = k.split('|');
      const p = this.ctx.markPrice(cid, Number(oi), k);
      const v = sh * p - this.ctx.markFee(cid, p, sh);
      this.flow(cid, v, end);
      this.openMtm += v;
    }
  }
}

// Slow mirror: trades toward a cost-free MirrorModel's book (run in lockstep,
// before this model) only at fixed intervals. Free on-chain ops are applied
// immediately and pro-rata, exactly like MirrorModel.
class RebalanceModel extends MirrorModel {
  constructor(name, ctx, { scale, everyMs, target }) {
    super(name, ctx, { scale });
    Object.assign(this, { everyMs, target });
    this.next = Date.parse(SINCE) + everyMs;
    this.px = new Map();
  }
  rebalance(t) {
    const { gap, k: mult } = this.ctx;
    for (const k of new Set([...this.held.keys(), ...this.target.held.keys()])) {
      const cid = k.split('|')[0];
      if (this.settled.has(cid)) continue;
      const diff = this.target.h(k) - this.h(k);
      const p = this.px.get(k);
      if (p == null || Math.abs(diff) <= 1e-9) continue;
      if (diff > 0) this.taker(cid, 'BUY', p + mult * gap(p), diff, t);
      else this.taker(cid, 'SELL', Math.max(0, p - mult * gap(p)), -diff, t);
      this.held.set(k, this.h(k) + diff);
    }
  }
  on(e) {
    while (e.t >= this.next) { this.rebalance(this.next); this.next += this.everyMs; }
    if (e.type === 'TRADE') {
      this.px.set(key(e.cid, e.oi), e.p);
      this.px.set(key(e.cid, 1 - e.oi), 1 - e.p);
      return;
    }
    super.on(e); // RESOLVE settles; SPLIT/MERGE/CONVERSION mirrored live
  }
}

// ── Reporting ───────────────────────────────────────────────────────────────
// 90% CI of the sum of `values`, resampling units with replacement.
function bootstrapCI(values) {
  if (!values.length) return [0, 0];
  let seed = 42; // mulberry32: deterministic
  const rnd = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const boots = [];
  for (let i = 0; i < BOOT_ITERS; i++) {
    let s = 0;
    for (let j = 0; j < values.length; j++) s += values[Math.floor(rnd() * values.length)];
    boots.push(s);
  }
  boots.sort((a, b) => a - b);
  return [boots[Math.floor(0.05 * BOOT_ITERS)], boots[Math.floor(0.95 * BOOT_ITERS)]];
}

function summarize(m) {
  const pnl = [...m.mcash.entries()].filter(([u]) => m.firstT.has(u)).map(([u, v]) => ({ cid: u, v, t: m.firstT.get(u) }));
  const total = pnl.reduce((s, x) => s + x.v, 0);
  const sorted = [...pnl].sort((a, b) => b.v - a.v);
  const byMonth = {};
  for (const x of pnl) {
    const mo = new Date(x.t).toISOString().slice(0, 7);
    byMonth[mo] = (byMonth[mo] || 0) + x.v;
  }
  return {
    markets: pnl.length, legs: m.legs, deployed: m.deployed, peak: m.peak, total, capSkips: m.capSkips, fees: m.fees,
    openMtm: m.openMtm, top1: sorted[0]?.v ?? 0, top5: sorted.slice(0, 5).reduce((s, x) => s + x.v, 0),
    worst1: sorted[sorted.length - 1]?.v ?? 0,
    win: pnl.filter(x => x.v > 0).length,
    ci: bootstrapCI(pnl.map(x => x.v)),
    byMonth, best: sorted.slice(0, 5), worst: sorted.slice(-3),
  };
}

const f2 = x => (x >= 0 ? '+' : '') + x.toFixed(2);

async function main() {
  if (!/^0x[0-9a-f]{40}$/.test(ADDRESS)) throw new Error('usage: backtest_mirror.js <address> [since] [db]');
  const dbPath = process.argv[4] || newestBackup();
  console.log(`[bt] trader ${ADDRESS} since ${SINCE} | db ${dbPath}`);
  const gm = loadGapModel(dbPath);

  const rows = await cached('activity', fetchActivity);
  const sinceSec = Date.parse(SINCE) / 1000;
  const win = rows.filter(r => r.timestamp >= sinceSec);
  // CONVERSION rows carry the negRisk event id, not a market conditionId.
  const cids = [...new Set(win.filter(r => ['TRADE', 'SPLIT', 'MERGE'].includes(r.type)).map(r => r.conditionId).filter(Boolean))];
  const markets = await cached('markets', () => fetchMarkets(cids));
  const negRiskIds = new Set(Object.values(markets).map(m => m.negRiskId).filter(Boolean));
  const convRows = rows.filter(r => r.type === 'CONVERSION' && negRiskIds.has(r.conditionId));
  const convEvents = new Set(convRows.map(r => r.conditionId));
  const eventSlugs = [...new Set(Object.values(markets).filter(m => convEvents.has(m.negRiskId)).map(m => m.eventSlug).filter(Boolean))];
  Object.assign(markets, await cached('events', () => fetchEventMarkets(eventSlugs)));
  const conversions = await cached('conversions', () => decodeConversions(convRows));
  const eventIndex = {};
  for (const [cid, m] of Object.entries(markets)) {
    if (m.negRiskId && m.questionIndex != null) (eventIndex[m.negRiskId] ||= []).push({ cid, index: m.questionIndex });
  }
  const redeems = new Map();
  for (const r of rows) if (r.type === 'REDEEM') redeems.set(r.conditionId, [...(redeems.get(r.conditionId) || []), r]);
  const allCids = [...new Set([...cids, ...Object.keys(markets)])];
  const payouts = Object.fromEntries(allCids.map(c => [c, payoutOf(c, markets, redeems)]));
  const { events, diag } = buildEvents(rows, payouts, markets, conversions, eventIndex);
  const unitOf = cid => markets[cid]?.negRiskId || cid;
  const slugOf = {};
  for (const r of rows) if (r.conditionId && r.slug) slugOf[r.conditionId] = r.slug;
  for (const m of Object.values(markets)) if (m.negRiskId && m.eventSlug) slugOf[m.negRiskId] = m.eventSlug;

  // Last trader price per outcome, as a fallback mark when Gamma has nothing.
  const lastPx = new Map();
  for (const r of [...rows].sort((a, b) => a.timestamp - b.timestamp)) {
    if (r.type !== 'TRADE' || !(r.price > 0)) continue;
    lastPx.set(key(r.conditionId, r.outcomeIndex), r.price);
    lastPx.set(key(r.conditionId, 1 - r.outcomeIndex), 1 - r.price);
  }

  // Historical prices for the 7d-expiry exits (CLOB prices-history), cached.
  const priceFile = path.join(CACHE, `prices_${ADDRESS.slice(0, 10)}_${SINCE}.json`);
  const priceCache = !REFRESH && fs.existsSync(priceFile) ? JSON.parse(fs.readFileSync(priceFile, 'utf8')) : {};
  const priceNeeds = new Map();

  const mkCtx = (k, withFees = FEES) => ({
    k,
    gap: gm.gap,
    unitOf,
    fee(cid, p, shares) {
      const m = markets[cid];
      return withFees && m && m.feeRate ? shares * m.feeRate * Math.pow(p * (1 - p), m.feeExp) : 0;
    },
    markFee(cid, p, shares) { // liquidating an unresolved position is a taker sell
      return payouts[cid]?.resolved ? 0 : this.fee(cid, p, shares);
    },
    priceAt(asset, atMs, kk) {
      const id = `${asset}@${Math.floor(atMs / 600_000)}`;
      if (priceCache[id] != null) return priceCache[id];
      if (asset) priceNeeds.set(id, { asset, atMs });
      return lastPx.get(kk) ?? 0.5;
    },
    markPrice(cid, oi, kk) {
      const pay = payouts[cid];
      if (pay && pay.resolved) return pay.prices[oi]; // redemption: no spread
      const m = markets[cid];
      const p = m && m.prices.length === 2 ? m.prices[oi] : lastPx.get(kk);
      if (p == null) return 0;
      return Math.max(0, p - k * gm.gap(p));
    },
  });

  const end = Date.now();
  const run = (models) => { for (const e of events) for (const m of models) m.on(e); for (const m of models) m.finish(end); return models; };

  // Scale: the trader's own in-window capital path, then fit peak to $800.
  const [traderSelf] = run([new MirrorModel('trader@own-prices', mkCtx(0, false), { scale: 1 })]);
  const scale = MIRROR_PEAK_CAPITAL / Math.max(1, traderSelf.peak);

  const build = k => {
    const ctx = mkCtx(k);
    const book = new MirrorModel('book', mkCtx(0, false), { scale }); // target for the slow mirrors
    return [
      new LotModel('A  live', ctx, { exit: 'fifo', expiry: true }),
      new LotModel('A* no-7d', ctx, { exit: 'fifo', expiry: false }),
      new LotModel('C1 exit>=50%', ctx, { exit: 'half', expiry: false }),
      new LotModel('C2 prorata', ctx, { exit: 'prorata', expiry: false }),
      new MirrorModel('B  mirror', ctx, { scale }),
      new MirrorModel('Bs mirror-sh', ctx, { scale, exit: 'shares' }),
      new MirrorModel('Bm mirror-min5', ctx, { scale, minShares: MIN_ORDER_SHARES }),
      new RebalanceModel('D1h rebal-1h', ctx, { scale, everyMs: 3600_000, target: book }),
      new RebalanceModel('D6h rebal-6h', ctx, { scale, everyMs: 6 * 3600_000, target: book }),
      new RebalanceModel('D24 rebal-24h', ctx, { scale, everyMs: 24 * 3600_000, target: book }),
      book, // after the slow mirrors: they rebalance toward its state BEFORE each event
    ];
  };

  // Pass 1 discovers which 7d-expiry prices are needed; fetch them, then rerun.
  for (const k of COST_MULTS) run(build(k));
  if (priceNeeds.size) {
    console.log(`[bt] fetching ${priceNeeds.size} historical prices for 7d-expiry exits`);
    await pool([...priceNeeds.entries()], async ([id, { asset, atMs }]) => {
      const t = Math.floor(atMs / 1000);
      try {
        const r = await getJson(`${CLOB}/prices-history?market=${asset}&startTs=${t - 6 * 3600}&endTs=${t + 3600}&fidelity=10`);
        const h = (r && r.history) || [];
        const before = h.filter(x => x.t <= t);
        const pt = before.length ? before[before.length - 1] : h[0];
        if (pt) priceCache[id] = Number(pt.p);
      } catch { /* keep the last-trader-price fallback */ }
    }, 4);
    fs.writeFileSync(priceFile, JSON.stringify(priceCache));
  }
  const results = COST_MULTS.map(k => ({
    k,
    models: run(build(k)).filter(m => m.name !== 'book').map(m => ({ name: m.name, s: summarize(m), units: Object.fromEntries(m.mcash) })),
  }));
  fs.writeFileSync(path.join(CACHE, `results_${ADDRESS.slice(0, 10)}_${SINCE}.json`),
    JSON.stringify({ scale, traderSelf: Object.fromEntries(traderSelf.mcash), labels: slugOf, results }));
  const missingPrices = [...priceNeeds.keys()].filter(id => priceCache[id] == null).length;

  // ── Diagnostics ──
  const byType = {};
  for (const r of win) {
    const t = r.type === 'TRADE' ? `TRADE ${r.side}` : r.type;
    byType[t] = byType[t] || { n: 0, usdc: 0 };
    byType[t].n++; byType[t].usdc += Number(r.usdcSize) || 0;
  }
  const multiFillTx = (() => {
    const c = new Map();
    for (const r of win) if (r.type === 'TRADE') c.set(r.transactionHash, (c.get(r.transactionHash) || 0) + 1);
    return [...c.values()].filter(n => n > 1).length / Math.max(1, c.size);
  })();
  const res = Object.values(payouts);
  console.log(`\n== Data  rows total ${rows.length}, in window ${win.length}, markets in window ${cids.length}`);
  for (const [t, v] of Object.entries(byType).sort((a, b) => b[1].usdc - a[1].usdc)) {
    console.log(`   ${t.padEnd(14)} n=${String(v.n).padStart(6)}  usdc=${v.usdc.toFixed(0).padStart(12)}`);
  }
  console.log(`   markets: resolved ${res.filter(r => r.resolved).length}, open ${res.filter(r => !r.resolved && r.prices).length}, no price ${res.filter(r => !r.resolved && !r.prices).length}`);
  const feeMix = {};
  for (const c of cids) { const r = markets[c] ? markets[c].feeRate : 'unknown'; feeMix[r] = (feeMix[r] || 0) + 1; }
  console.log(`   taker fee rate -> window markets: ${JSON.stringify(feeMix)} (fees ${FEES ? 'ON' : 'OFF'})`);
  console.log(`   sells ${diag.sells}, sell > reconstructed position ${diag.sellOverPosition}; conversions in window ${diag.conversionsInWindow} ` +
    `(size ${diag.conversionSizeInWindow.toFixed(0)}, undecoded ${diag.conversionsUndecoded}); negRisk events with conversions ${convEvents.size}, event markets ${Object.keys(markets).length - cids.length} added`);
  console.log(`   multi-fill tx share ${(100 * multiFillTx).toFixed(1)}%; 7d-expiry prices missing ${missingPrices}/${priceNeeds.size}`);
  console.log(`== Gap model (${gm.scope}, n=${gm.n}, pooled ${gm.pooled.toFixed(4)}): ` +
    gm.means.map(m => `${m.lo}-${Math.min(1, m.hi)}: ${m.gap.toFixed(4)} (n=${m.n})`).join(' | '));
  console.log(`== Live sim entries since ${SINCE}: ${gm.live.n} closed ${f2(gm.live.pnl || 0)} + ${gm.live.nOpen} open ${f2(gm.live.openPnl || 0)} = ${f2((gm.live.pnl || 0) + (gm.live.openPnl || 0))} (cost-adjusted)`);
  console.log(`== Trader own in-window positions @ own prices: PnL ${f2(traderSelf.cash)} on peak capital ${traderSelf.peak.toFixed(0)} -> mirror scale ${scale.toExponential(3)}`);

  for (const { k, models } of results) {
    console.log(`\n== Cost x${k}`);
    console.log('   model           units  legs  deployed   peak     fees      PnL   PnL/dep  open-MTM   top1    top5  ex-top1  win%   90% CI (unit bootstrap)');
    for (const { name, s } of models) {
      console.log(`   ${name.padEnd(15)} ${String(s.markets).padStart(5)} ${String(s.legs).padStart(5)} ${s.deployed.toFixed(0).padStart(9)} ${s.peak.toFixed(0).padStart(6)} ${s.fees.toFixed(2).padStart(8)} ${f2(s.total).padStart(9)} ` +
        `${(100 * s.total / Math.max(1, s.deployed)).toFixed(1).padStart(7)}% ${f2(s.openMtm).padStart(9)} ${f2(s.top1).padStart(7)} ${f2(s.top5).padStart(7)} ${f2(s.total - s.top1).padStart(8)} ` +
        `${(100 * s.win / Math.max(1, s.markets)).toFixed(0).padStart(4)}%   [${f2(s.ci[0])}, ${f2(s.ci[1])}]`);
    }
    console.log('   wallet-cap skipped BUYs: ' + models.filter(m => m.s.capSkips != null).map(m => `${m.name.split(' ')[0]} ${m.s.capSkips}`).join(', '));
    // Paired vs the live model: per-unit differences share the trader's luck,
    // so this CI isolates the copy-rule effect far better than two totals.
    const base = models[0].units;
    console.log('   paired vs A, 90% CI: ' + models.slice(1).map(({ name, units }) => {
      const us = [...new Set([...Object.keys(base), ...Object.keys(units)])];
      const d = us.map(u => (units[u] || 0) - (base[u] || 0));
      const [lo, hi] = bootstrapCI(d);
      return `${name.split(' ')[0]} ${f2(d.reduce((s, x) => s + x, 0))} [${f2(lo)}, ${f2(hi)}]`;
    }).join(' | '));
    if (k === 1) {
      for (const { name, s } of models) {
        console.log(`   ${name.padEnd(15)} by month: ` + Object.entries(s.byMonth).sort().map(([mo, v]) => `${mo} ${f2(v)}`).join('  '));
      }
      for (const { name, s } of models.filter(m => /^(A |B |D24)/.test(m.name))) {
        console.log(`   ${name} best:  ` + s.best.map(x => `${(slugOf[x.cid] || x.cid).slice(0, 42)} ${f2(x.v)}`).join(' | '));
        console.log(`   ${name} worst: ` + s.worst.map(x => `${(slugOf[x.cid] || x.cid).slice(0, 42)} ${f2(x.v)}`).join(' | '));
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
