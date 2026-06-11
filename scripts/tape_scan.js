/**
 * Tape mining on resolved markets ("who bought the winner early") — candidate
 * sourcing that does NOT rely on the Falcon leaderboard. Design 2026-06-10.
 *
 * Pipeline:
 *   1. Universe: slugs of resolved watchlist-habitat markets from our own
 *      closed_trades (last UNIVERSE_DAYS days, booked 0/1 exits).
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
// Candidate gate (loose-ish on purpose — survivors go to the observation bench)
const GATE_MIN_MARKETS = 5;
const GATE_MIN_WR      = 0.55;
const GATE_MIN_PNL     = 500;
const GATE_MIN_ROI     = 0.10;

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
  return { conditionId: m.conditionId, payouts: prices.map(p => (p >= 0.995 ? 1 : 0)) };
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

// Score one market's tape. Returns Map(addr → {pnl, invested, entryVwapNum/Den}).
function scoreMarket(prints, payouts) {
  const perAddr = new Map();
  for (const p of prints) {
    const w = String(p.proxyWallet || '').toLowerCase();
    const idx = Number(p.outcomeIndex);
    const price = Number(p.price), size = Number(p.size);
    if (!w || !Number.isFinite(idx) || !Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
    let e = perAddr.get(w);
    if (!e) { e = { byIdx: new Map() }; perAddr.set(w, e); }
    let t = e.byIdx.get(idx);
    if (!t) { t = { cost: 0, proceeds: 0, net: 0, buyCost: 0, buyShares: 0 }; e.byIdx.set(idx, t); }
    if (p.side === 'BUY') { t.cost += price * size; t.net += size; t.buyCost += price * size; t.buyShares += size; }
    else { t.proceeds += price * size; t.net -= size; }
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
    out.set(w, { pnl, invested, winBuyCost, winBuyShares });
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
  const slugs = db.prepare(`
    SELECT DISTINCT market_slug FROM closed_trades
    WHERE copied_trader_source='watchlist'
      AND exit_price IN (0.0, 1.0)
      AND closed_at >= datetime('now', ?)
    ORDER BY market_slug`).all(`-${UNIVERSE_DAYS} days`).map(r => r.market_slug).slice(0, MAX_MARKETS);
  const watchlist = new Set(db.prepare('SELECT lower(address) AS a FROM watchlist_traders').all().map(r => r.a));
  const excluded  = new Set(db.prepare('SELECT lower(address) AS a FROM excluded_traders').all().map(r => r.a));
  db.close();
  console.log(`[tape] universe: ${slugs.length} resolved slugs (last ${UNIVERSE_DAYS}d), watchlist=${watchlist.size}, excluded=${excluded.size}`);

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
    const scores = scoreMarket(tape.prints, mk.payouts);
    for (const [w, s] of scores) {
      if (watchlist.has(w) || excluded.has(w)) continue;
      let g = agg.get(w);
      if (!g) { g = { markets: 0, wins: 0, pnl: 0, invested: 0, winBuyCost: 0, winBuyShares: 0 }; agg.set(w, g); }
      g.markets++;
      if (s.pnl > 0) g.wins++;
      g.pnl += s.pnl;
      g.invested += s.invested;
      g.winBuyCost += s.winBuyCost;
      g.winBuyShares += s.winBuyShares;
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
  }));

  const fmt = r => `${r.addr}  ${String(r.markets).padStart(4)}  ${(r.wr * 100).toFixed(0).padStart(3)}%  ${('$' + r.pnl.toFixed(0)).padStart(9)}  ${('$' + r.invested.toFixed(0)).padStart(10)}  ${(r.roi * 100).toFixed(1).padStart(6)}%  ${r.avgEntryVwap != null ? r.avgEntryVwap.toFixed(2) : '   —'}  ${r.avgEntryVwap != null ? '+' + ((r.wr - r.avgEntryVwap) * 100).toFixed(0) + 'pp' : ''}`;
  const header = 'addr                                        mkts   WR        pnl    invested     roi  vwap  calib';

  console.log(`\n========== TOP 30 BY PNL (n_markets >= 3, scored on tape cash flows) ==========`);
  console.log(header);
  for (const r of rows.filter(r => r.markets >= 3).sort((a, b) => b.pnl - a.pnl).slice(0, 30)) console.log(fmt(r));

  const cands = rows
    .filter(r => r.markets >= GATE_MIN_MARKETS && r.wr > GATE_MIN_WR && r.pnl > GATE_MIN_PNL && r.roi > GATE_MIN_ROI)
    .sort((a, b) => b.pnl - a.pnl);
  console.log(`\n========== CANDIDATES (mkts>=${GATE_MIN_MARKETS}, WR>${GATE_MIN_WR * 100}%, pnl>$${GATE_MIN_PNL}, roi>${GATE_MIN_ROI * 100}%) ==========`);
  console.log(header);
  for (const r of cands.slice(0, 20)) console.log(fmt(r));
  console.log('\nCANDIDATES_JSON ' + JSON.stringify(cands.slice(0, 20).map(r => ({
    address: r.addr, markets: r.markets, winRate: +(r.wr * 100).toFixed(1),
    pnl: +r.pnl.toFixed(0), invested: +r.invested.toFixed(0), roi: +(r.roi * 100).toFixed(1),
    avgEntryVwap: r.avgEntryVwap != null ? +r.avgEntryVwap.toFixed(3) : null,
  }))));
})();
