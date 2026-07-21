/**
 * Tape mining on resolved markets ("who bought the winner early") — candidate
 * sourcing that does NOT rely on the Falcon leaderboard. Design 2026-06-10.
 *
 * Pipeline:
 *   1. Universe (2026-07-21: expanded beyond our own trading history): union
 *      of (a) resolved watchlist-habitat slugs from our own closed_trades and
 *      (b) a broad, all-category sweep of every market Gamma closed in the
 *      last UNIVERSE_DAYS days (no category/tag filter -- Gamma's tag param
 *      is a silent no-op; "all categories" means not filtering at all).
 *   2. Per slug: Gamma ?closed=true → conditionId + authoritative final
 *      outcomePrices (ground truth — independent of our booked exits).
 *   3. Walk the public trade tape (data-api /trades?market=<conditionId>
 *      &takerOnly=false — CRITICAL: the default tape is taker-only and our own
 *      best trader fills 100% as maker, i.e. would be invisible without it).
 *      Newest-first, limit caps at 1000, HARD offset cap 3000 → max 4000 rows
 *      in 4 pages; markets with deeper tapes are SKIPPED in v1 (clean semantics).
 *      Rows are per-party views (a match yields one maker row + one taker row,
 *      different wallets), so per-wallet cash-flow scoring needs no dedup.
 *   4. Score per (market, address) by exact cash-flow PnL:
 *        pnl = Σ sellProceeds − Σ buyCost + netShares × payout
 *      MM-resistant by construction: two-sided churn nets ~0; per-market
 *      scoring kills burst-fill pseudo-replication (the 0x8a3ab8 artifact).
 *   5. Aggregate per address; gate; print table + CANDIDATES_JSON.
 *
 * Runs in the bot container (node20 fetch, better-sqlite3, /app/data/store.db
 * read-only). No bot-code dependencies. Usage:
 *   docker cp scripts/tape_scan.js polymarket_bot:/app/scripts/ &&
 *   docker exec polymarket_bot node /app/scripts/tape_scan.js
 */
const Database = require('/app/node_modules/better-sqlite3');

// ── Config ──────────────────────────────────────────────────────────────────
const UNIVERSE_DAYS   = 45;    // resolved markets newer than this
const MAX_MARKETS     = 1200;  // safety cap per run
const CONCURRENCY     = 6;     // parallel markets (≈10-14 req/s total, proven safe)
const PAGE_LIMIT      = 1000;  // API silently caps limit at 1000
const MAX_OFFSET      = 3000;  // API hard cap (400 beyond) → max 4000 rows/market
const MIN_NOTIONAL    = 100;   // $ net invested per market to count that market
const GAMMA_PAGE_LIMIT = 100;  // /markets listing hard-caps limit at 100 regardless of
                                // what's requested (empirically verified 2026-07-21 --
                                // unlike /trades and /activity, which cap at 1000). Must
                                // match reality: the "short page = last page" pagination
                                // stop check compares the returned count against this.
// Observation-bench gate (loosened 2026-07-21 -- see docs/decisions.md
// "Tape scanner gate loosened for observation bench"). Survivors go to the
// observation bench, NOT straight to the live watchlist.
const GATE_MIN_MARKETS = 5;
const GATE_MIN_WR      = 0.50;   // was 0.55
const GATE_MIN_PNL     = 200;    // was 500
const GATE_MIN_ROI     = 0.05;   // was 0.10
// Added 2026-07-21 after 0x7ea571c4/0x84ad9c5c (22.8 and 59.4 fills/market,
// in-game scalpers) cleared the PnL/WR/ROI gate on cash-flow alone. See
// project_candidate_tapescan_0721_livebots memory. NOT loosened alongside
// the thresholds above -- these are the ones that actually caught them.
const GATE_MAX_FILLS_PER_MARKET = 10;  // genuine discretionary traders are <5
const GATE_MIN_AVG_HOLD_HOURS   = 4;   // real macro/sports traders hold hours-to-days
// High-confidence tier: the original (pre-2026-07-21) thresholds, applied on
// top of the same GATE_MAX_FILLS_PER_MARKET / GATE_MIN_AVG_HOLD_HOURS gates.
// A subset flag on the observation-bench list, not a separate scan.
const HICONF_MIN_WR  = 0.55;
const HICONF_MIN_PNL = 500;
const HICONF_MIN_ROI = 0.10;

const GAMMA = 'https://gamma-api.polymarket.com';
const DATA  = 'https://data-api.polymarket.com';

async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.status === 429) { await new Promise(s => setTimeout(s, 2000 * (i + 1))); continue; }
      if (!r.ok) return { error: `HTTP ${r.status}` };
      return { data: await r.json() };
    } catch (e) {
      if (i === tries - 1) return { error: e.message };
      await new Promise(s => setTimeout(s, 1000 * (i + 1)));
    }
  }
  return { error: 'retries exhausted' };
}

// Gamma closed-market lookup: conditionId + final payouts. null → skip market.
async function resolveMarket(slug) {
  const r = await getJson(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}&closed=true`);
  if (r.error || !Array.isArray(r.data) || r.data.length === 0) return null;
  const m = r.data[0];
  if (m.closed !== true || !m.conditionId) return null;
  let prices = [];
  try { prices = JSON.parse(m.outcomePrices ?? '[]').map(Number); } catch { return null; }
  if (prices.length === 0 || !prices.every(p => p <= 0.005 || p >= 0.995)) return null; // not pinned → unresolved/voided
  // closedTime: when Gamma actually marked the market resolved -- used as the
  // implicit exit for positions never sold (hold-to-resolution), since it
  // tracks close to the real-world event end, unlike an individual trader's
  // own REDEEM timestamp (which lags settlement by days and is not visible
  // in this endpoint's tape anyway -- REDEEM is not a /trades event).
  const closedMs = m.closedTime ? new Date(m.closedTime).getTime() : null;
  return { conditionId: m.conditionId, payouts: prices.map(p => (p >= 0.995 ? 1 : 0)), closedMs: Number.isFinite(closedMs) ? closedMs : null };
}

// Walk the tape. Returns { prints } or { truncated: true } or { error }.
async function fetchTape(conditionId) {
  const prints = [];
  for (let offset = 0; offset <= MAX_OFFSET; offset += PAGE_LIMIT) {
    const r = await getJson(`${DATA}/trades?market=${conditionId}&limit=${PAGE_LIMIT}&offset=${offset}&takerOnly=false`);
    if (r.error) return { error: r.error };
    if (!Array.isArray(r.data)) return { error: 'non-array tape page' };
    prints.push(...r.data);
    if (r.data.length < PAGE_LIMIT) return { prints };
    if (offset === MAX_OFFSET) return { truncated: true }; // full page at the cap → deeper tape unreachable
  }
  return { prints };
}

// Broad, all-category resolved-market discovery via Gamma (added 2026-07-21).
// Independent of our own trade history -- unioned with the closed_trades-
// sourced slugs so the universe isn't limited to categories our current/
// former watchlist traders happened to touch (was: sports + geopolitics
// only). No category/tag param is used: `tag=crypto` was tested and Gamma
// silently ignores it (returns the same unfiltered page as no tag at all),
// so "all major categories" is covered by NOT filtering at all, sorted by
// recency and cut off client-side -- same early-stop pattern as
// macro_scan_90d.js's fetch90dActivity. `order=closedTime&ascending=false`
// verified empirically: default (unordered) order returns markets from
// 2020-2021 first, this param actually sorts newest-first.
async function fetchBroadUniverse(days) {
  const cutoffMs = Date.now() - days * 86400000;
  const slugs = [];
  for (let offset = 0; ; offset += GAMMA_PAGE_LIMIT) {
    const r = await getJson(`${GAMMA}/markets?closed=true&order=closedTime&ascending=false&limit=${GAMMA_PAGE_LIMIT}&offset=${offset}`);
    if (r.error || !Array.isArray(r.data) || r.data.length === 0) break;
    let hitCutoff = false;
    for (const m of r.data) {
      const ct = m.closedTime ? new Date(m.closedTime).getTime() : null;
      if (ct == null || ct < cutoffMs) { hitCutoff = true; continue; }
      if (m.slug) slugs.push(m.slug);
    }
    if (hitCutoff || r.data.length < GAMMA_PAGE_LIMIT) break;
  }
  return slugs;
}

// Score one market's tape. Returns Map(addr → {pnl, invested, entryVwapNum/Den, fills, holdHours}).
// marketClosedMs: Gamma closedTime for this market (see resolveMarket), used
// as the exit for positions that were never sold within the tape.
function scoreMarket(prints, payouts, marketClosedMs) {
  const perAddr = new Map();
  for (const p of prints) {
    const w = String(p.proxyWallet || '').toLowerCase();
    const idx = Number(p.outcomeIndex);
    const price = Number(p.price), size = Number(p.size);
    const ts = Number(p.timestamp) * 1000;
    if (!w || !Number.isFinite(idx) || !Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
    let e = perAddr.get(w);
    if (!e) { e = { byIdx: new Map(), fills: 0, firstBuyMs: null, lastSellMs: null }; perAddr.set(w, e); }
    let t = e.byIdx.get(idx);
    if (!t) { t = { cost: 0, proceeds: 0, net: 0, buyCost: 0, buyShares: 0 }; e.byIdx.set(idx, t); }
    if (p.side === 'BUY') {
      t.cost += price * size; t.net += size; t.buyCost += price * size; t.buyShares += size;
      if (Number.isFinite(ts) && (e.firstBuyMs === null || ts < e.firstBuyMs)) e.firstBuyMs = ts;
    } else {
      t.proceeds += price * size; t.net -= size;
      if (Number.isFinite(ts) && (e.lastSellMs === null || ts > e.lastSellMs)) e.lastSellMs = ts;
    }
    e.fills++;
  }
  const out = new Map();
  for (const [w, e] of perAddr) {
    let pnl = 0, invested = 0, winBuyCost = 0, winBuyShares = 0;
    for (const [idx, t] of e.byIdx) {
      const payout = payouts[idx] ?? 0;
      pnl += t.proceeds - t.cost + t.net * payout;
      invested += t.cost;
      if (payout === 1) { winBuyCost += t.buyCost; winBuyShares += t.buyShares; }
    }
    if (invested < MIN_NOTIONAL) continue;
    // Hold time: first BUY to last SELL; if never sold, first BUY to market
    // close (hold-to-resolution). NOT first-buy-to-REDEEM -- that lags the
    // real event by days and is invisible to this tape anyway (see
    // resolveMarket comment / project_tape_scanner memory).
    const exitMs = e.lastSellMs ?? marketClosedMs ?? null;
    const holdHours = (e.firstBuyMs != null && exitMs != null && exitMs >= e.firstBuyMs)
      ? (exitMs - e.firstBuyMs) / 3600000 : null;
    out.set(w, { pnl, invested, winBuyCost, winBuyShares, fills: e.fills, holdHours });
  }
  return out;
}

async function pool(items, fn, n) {
  let i = 0;
  const worker = async () => { while (true) { const idx = i++; if (idx >= items.length) return; await fn(items[idx], idx); } };
  await Promise.all(Array.from({ length: n }, worker));
}

(async () => {
  const t0 = Date.now();
  const db = new Database('/app/data/store.db', { readonly: true });
  const dbSlugs = db.prepare(`
    SELECT DISTINCT market_slug FROM closed_trades
    WHERE copied_trader_source='watchlist'
      AND exit_price IN (0.0, 1.0)
      AND closed_at >= datetime('now', ?)
    ORDER BY market_slug`).all(`-${UNIVERSE_DAYS} days`).map(r => r.market_slug);
  const watchlist = new Set(db.prepare('SELECT lower(address) AS a FROM watchlist_traders').all().map(r => r.a));
  const excluded  = new Set(db.prepare('SELECT lower(address) AS a FROM excluded_traders').all().map(r => r.a));
  db.close();
  console.log(`[tape] closed_trades-sourced universe: ${dbSlugs.length} slugs (last ${UNIVERSE_DAYS}d)`);

  const broadSlugs = await fetchBroadUniverse(UNIVERSE_DAYS);
  const dbSlugSet = new Set(dbSlugs);
  const addedByBroad = broadSlugs.filter(s => !dbSlugSet.has(s)).length;
  console.log(`[tape] broad all-category Gamma universe: ${broadSlugs.length} slugs (+${addedByBroad} beyond closed_trades)`);

  const slugs = [...new Set([...dbSlugs, ...broadSlugs])].sort().slice(0, MAX_MARKETS);
  console.log(`[tape] universe: ${slugs.length} resolved slugs scanned (cap ${MAX_MARKETS}), watchlist=${watchlist.size}, excluded=${excluded.size}`);

  const agg = new Map(); // addr → aggregate
  const stats = { scored: 0, gammaMiss: 0, truncated: 0, tapeErr: 0, prints: 0 };
  let done = 0;

  await pool(slugs, async (slug) => {
    const mk = await resolveMarket(slug);
    done++;
    if (done % 100 === 0) console.log(`  ... ${done}/${slugs.length} markets (${((Date.now() - t0) / 1000).toFixed(0)}s, scored=${stats.scored}, gammaMiss=${stats.gammaMiss}, truncated=${stats.truncated})`);
    if (!mk) { stats.gammaMiss++; return; }
    const tape = await fetchTape(mk.conditionId);
    if (tape.error) { stats.tapeErr++; return; }
    if (tape.truncated) { stats.truncated++; return; }
    stats.prints += tape.prints.length;
    const scores = scoreMarket(tape.prints, mk.payouts, mk.closedMs);
    for (const [w, s] of scores) {
      if (watchlist.has(w) || excluded.has(w)) continue;
      let g = agg.get(w);
      if (!g) { g = { markets: 0, wins: 0, pnl: 0, invested: 0, winBuyCost: 0, winBuyShares: 0, fills: 0, holdHoursSum: 0, holdHoursCount: 0 }; agg.set(w, g); }
      g.markets++;
      if (s.pnl > 0) g.wins++;
      g.pnl += s.pnl;
      g.invested += s.invested;
      g.winBuyCost += s.winBuyCost;
      g.winBuyShares += s.winBuyShares;
      g.fills += s.fills;
      if (s.holdHours != null) { g.holdHoursSum += s.holdHours; g.holdHoursCount++; }
    }
    stats.scored++;
  }, CONCURRENCY);

  console.log(`[tape] done in ${((Date.now() - t0) / 1000).toFixed(0)}s — scored=${stats.scored}, gammaMiss=${stats.gammaMiss}, truncated=${stats.truncated}, tapeErr=${stats.tapeErr}, prints=${stats.prints.toLocaleString()}, addresses=${agg.size}`);

  const rows = [...agg.entries()].map(([addr, g]) => ({
    addr,
    markets: g.markets,
    wr: g.markets ? g.wins / g.markets : 0,
    pnl: g.pnl,
    invested: g.invested,
    roi: g.invested > 0 ? g.pnl / g.invested : 0,
    avgEntryVwap: g.winBuyShares > 0 ? g.winBuyCost / g.winBuyShares : null,
    fillsPerMarket: g.markets ? g.fills / g.markets : 0,
    avgHoldHours: g.holdHoursCount ? g.holdHoursSum / g.holdHoursCount : null,
    highConfidence: g.wins / Math.max(1, g.markets) > HICONF_MIN_WR && g.pnl > HICONF_MIN_PNL && (g.invested > 0 ? g.pnl / g.invested : 0) > HICONF_MIN_ROI,
  }));

  const fmt = r => `${r.highConfidence ? 'HC ' : '   '}${r.addr}  ${String(r.markets).padStart(4)}  ${(r.wr * 100).toFixed(0).padStart(3)}%  ${('$' + r.pnl.toFixed(0)).padStart(9)}  ${('$' + r.invested.toFixed(0)).padStart(10)}  ${(r.roi * 100).toFixed(1).padStart(6)}%  ${r.avgEntryVwap != null ? r.avgEntryVwap.toFixed(2) : '   —'}  ${r.avgEntryVwap != null ? '+' + ((r.wr - r.avgEntryVwap) * 100).toFixed(0) + 'pp' : ''}  ${r.fillsPerMarket.toFixed(1).padStart(7)}  ${r.avgHoldHours != null ? r.avgHoldHours.toFixed(1).padStart(6) + 'h' : '     —'}`;
  const header = '    addr                                        mkts   WR        pnl    invested     roi  vwap  calib  fills/m  hold_h';

  console.log(`\n========== TOP 30 BY PNL (n_markets >= 3, scored on tape cash flows) ==========`);
  console.log(header);
  for (const r of rows.filter(r => r.markets >= 3).sort((a, b) => b.pnl - a.pnl).slice(0, 30)) console.log(fmt(r));

  // Observation-bench tier: loosened WR/PnL/ROI, same fills/hold gates as
  // before. High-confidence is a flag WITHIN this list (original thresholds),
  // not a separate scan -- every high-confidence row is by construction also
  // an observation-bench row, since 0.55>0.50, $500>$200, 10%>5%.
  const cands = rows
    .filter(r => r.markets >= GATE_MIN_MARKETS && r.wr > GATE_MIN_WR && r.pnl > GATE_MIN_PNL && r.roi > GATE_MIN_ROI)
    .filter(r => r.fillsPerMarket <= GATE_MAX_FILLS_PER_MARKET)
    .filter(r => r.avgHoldHours != null && r.avgHoldHours >= GATE_MIN_AVG_HOLD_HOURS)
    .sort((a, b) => (b.highConfidence - a.highConfidence) || (b.pnl - a.pnl));
  const hiConfCount = cands.filter(r => r.highConfidence).length;
  console.log(`\n========== OBSERVATION-BENCH CANDIDATES (mkts>=${GATE_MIN_MARKETS}, WR>${GATE_MIN_WR * 100}%, pnl>$${GATE_MIN_PNL}, roi>${GATE_MIN_ROI * 100}%, fills/mkt<=${GATE_MAX_FILLS_PER_MARKET}, hold>=${GATE_MIN_AVG_HOLD_HOURS}h) ==========`);
  console.log(`${cands.length} total, ${hiConfCount} marked HC = also clear high-confidence (WR>${HICONF_MIN_WR * 100}%, pnl>$${HICONF_MIN_PNL}, roi>${HICONF_MIN_ROI * 100}%)`);
  console.log(header);
  for (const r of cands.slice(0, 30)) console.log(fmt(r));
  console.log('\nCANDIDATES_JSON ' + JSON.stringify(cands.slice(0, 30).map(r => ({
    address: r.addr, markets: r.markets, winRate: +(r.wr * 100).toFixed(1),
    pnl: +r.pnl.toFixed(0), invested: +r.invested.toFixed(0), roi: +(r.roi * 100).toFixed(1),
    avgEntryVwap: r.avgEntryVwap != null ? +r.avgEntryVwap.toFixed(3) : null,
    fillsPerMarket: +r.fillsPerMarket.toFixed(1),
    avgHoldHours: r.avgHoldHours != null ? +r.avgHoldHours.toFixed(1) : null,
    highConfidence: r.highConfidence,
  }))));
})();
