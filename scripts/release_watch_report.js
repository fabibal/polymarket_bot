/**
 * Release-watch report (2026-10-20): what a buyer who learned the number when
 * this server did could have bought, rebuilt from the recorded CLOB websocket
 * book (scripts/release_watch.js). Run in the VPN namespace once the markets
 * resolve; before that the winners are provisional (last recorded prices):
 *
 *   docker run --rm -u 1000:1000 --network container:gluetun \
 *     -v "$PWD":/app:ro -v ~/polymarket_bot/logs/release-watch:/out \
 *     node:20-alpine node /app/scripts/release_watch_report.js <release-id>
 *
 * Winning tokens: per market the outcome that pays $1, i.e. YES of the winning
 * bracket and NO of every losing bracket. Cheap asks on either are the pool the
 * 2026-10-20 race analysis counted. /out/<id>/winners.json (["<token>", ...])
 * overrides the winners.
 *
 * Times: K = our detection, per event: the first changed response of the pages
 * that resolve it (a source's `events`, else every source). Host clock. The
 * book is replayed by server timestamp, assuming the NTP-synced host clock
 * matches the CLOB's; the min(receive - server ts) line bounds the offset.
 *
 * Bands: asks <= CHEAP_PRICE are the stale orders a release race is about; asks
 * above it up to MAX_PRICE are the routine near-par discount on near-certain
 * outcomes, there with or without a release, so they are reported apart.
 */
const fs = require('fs');
const path = require('path');

const OUT_ROOT = process.env.RELEASE_WATCH_OUT || '/out';
const GAMMA = 'https://gamma-api.polymarket.com';
const CHEAP_PRICE = 0.90;
const MAX_PRICE = 0.99;       // a fill above this earns < 1 cent per share
const WALLET_CAP = 800;       // SIMULATED_WALLET_SIZE * WALLET_CAP_UTILIZATION
const LATENCIES_MS = [0, 250, 500, 1000, 2000, 5000];

const id = process.argv[2];
const dir = path.join(OUT_ROOT, id || '');
if (!id || !fs.existsSync(path.join(dir, 'meta.json'))) {
  console.error(`usage: release_watch_report.js <release-id>  (needs ${dir}/meta.json)`);
  process.exit(2);
}
const readJson = (f, dflt = null) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return dflt; } };
const usd = x => '$' + Math.round(x).toLocaleString('en-US');
const secs = ms => (ms >= 0 ? '+' : '') + (ms / 1000).toFixed(2) + 's';

const meta = readJson('meta.json');
const sources = readJson('sources_summary.json', { sources: [] });
const book = readJson('book_summary.json', {});
const T = Date.parse(meta.at);
const tokenInfo = new Map();
for (const m of meta.markets) for (const t of m.tokens) tokenInfo.set(t.token, { market: m, outcome: t.outcome });

// ── websocket log -> server-time event list ─────────────────────────────────
const events = [];
let offsets = [];
for (const line of fs.readFileSync(path.join(dir, 'ws.jsonl'), 'utf8').split('\n')) {
  if (!line) continue;
  let rec, msgs;
  try { rec = JSON.parse(line); msgs = JSON.parse(rec.d); } catch { continue; }
  for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
    const ts = Number(m.timestamp);
    if (!ts) continue;
    offsets.push(rec.r - ts);
    if (m.event_type === 'book') events.push({ ts, type: 'book', asset: m.asset_id, bids: m.bids || [], asks: m.asks || [] });
    else if (m.event_type === 'price_change') {
      for (const pc of m.price_changes || m.changes || []) {
        events.push({ ts, type: 'pc', asset: pc.asset_id || m.asset_id, side: pc.side, price: pc.price, size: Number(pc.size) });
      }
    } else if (m.event_type === 'last_trade_price') {
      events.push({ ts, type: 'trade', asset: m.asset_id, side: m.side, price: Number(m.price), size: Number(m.size) });
    }
  }
}
events.sort((a, b) => a.ts - b.ts);          // stable: same-ts events keep file order
offsets.sort((a, b) => a - b);

// Level keys are normalized ("0.950" and "0.95" are one level).
const key = p => String(Number(p));
function bookAt(S) {
  const books = new Map();
  for (const e of events) {
    if (e.ts > S) break;
    if (e.type === 'book') {
      books.set(e.asset, {
        bids: new Map(e.bids.map(l => [key(l.price), Number(l.size)])),
        asks: new Map(e.asks.map(l => [key(l.price), Number(l.size)])),
      });
    } else if (e.type === 'pc') {
      const b = books.get(e.asset);
      if (!b) continue;
      const side = e.side === 'SELL' ? b.asks : b.bids;
      if (e.size > 0) side.set(key(e.price), e.size); else side.delete(key(e.price));
    }
  }
  return books;
}

// ── winners ─────────────────────────────────────────────────────────────────
async function resolvedWinners() {
  const ids = meta.markets.map(m => m.conditionId);
  const winners = new Set();
  let resolved = 0;
  for (let i = 0; i < ids.length; i += 20) {
    const q = ids.slice(i, i + 20).map(c => `condition_ids=${c}`).join('&');
    const seen = new Map();
    for (const closed of ['true', 'false']) {
      try {
        const r = await fetch(`${GAMMA}/markets?${q}&closed=${closed}&limit=100`, { headers: { 'User-Agent': 'curl/8.5.0' } });
        for (const m of r.ok ? await r.json() : []) seen.set(m.conditionId, m);
      } catch {}
    }
    for (const m of seen.values()) {
      const prices = JSON.parse(m.outcomePrices || '[]').map(Number);
      const tokens = JSON.parse(m.clobTokenIds || '[]');
      const wi = prices.findIndex(p => p >= 0.99);
      if (m.closed && wi >= 0 && prices.every(p => p >= 0.99 || p <= 0.01)) { resolved++; winners.add(tokens[wi]); }
    }
  }
  return { winners, resolved };
}

function provisionalWinners() {
  // Last recorded book: the token whose best bid is >= 0.90.
  const books = bookAt(Infinity), winners = new Set();
  for (const m of meta.markets) {
    for (const t of m.tokens) {
      const b = books.get(t.token);
      const bestBid = b && b.bids.size ? Math.max(...[...b.bids.keys()].map(Number)) : 0;
      if (bestBid >= 0.9) winners.add(t.token);
    }
  }
  return winners;
}

// ── pool at a server time ───────────────────────────────────────────────────
function pool(S, tokens) {
  const books = bookAt(S);
  const levels = [];
  for (const tok of tokens) {
    const b = books.get(tok);
    if (!b) continue;
    for (const [p, size] of b.asks) { const price = Number(p); if (price <= MAX_PRICE && size > 0) levels.push({ tok, price, size }); }
  }
  levels.sort((a, b) => a.price - b.price);
  const o = { cheapCost: 0, cheapProfit: 0, parProfit: 0, capProfit: 0, best: '-' };
  let capCost = 0;
  for (const l of levels) {
    if (l.price <= CHEAP_PRICE) { o.cheapCost += l.size * l.price; o.cheapProfit += l.size * (1 - l.price); }
    else o.parProfit += l.size * (1 - l.price);
    const room = WALLET_CAP - capCost;
    if (room > 0) { const sh = Math.min(l.size, room / l.price); capCost += sh * l.price; o.capProfit += sh * (1 - l.price); }
  }
  if (levels[0]) { const i = tokenInfo.get(levels[0].tok); o.best = `${levels[0].price} x ${Math.round(levels[0].size)} (${i.market.slug.slice(0, 40)} ${i.outcome})`; }
  return o;
}

(async () => {
  console.log(`# Release watch report: ${id} (T = ${meta.at}, ${meta.markets.length} markets)`);
  for (const s of sources.sources) {
    console.log(`  source ${s.name}: ${s.firstChange ? `${secs(s.firstChange.offsetMs)} (sent ${secs(s.firstChange.t0 - T)}), marker ${s.firstChange.marker ? 'yes' : 'NO'}` : 'no change'}; ${s.polls} polls, ${s.errors} errors${s.baseline && s.baseline.markerMatches ? ', marker already in baseline' : ''}`);
  }
  console.log(`  clock: receive - server ts min ${offsets[0]}ms, median ${offsets[Math.floor(offsets.length / 2)]}ms over ${offsets.length} msgs; REST /books rtt median ${book.restRttMs ? book.restRttMs.median : '?'}ms`);

  // Winners
  let winners, how;
  const override = readJson('winners.json');
  if (Array.isArray(override)) { winners = new Set(override); how = 'winners.json'; }
  else {
    const r = await resolvedWinners();
    if (r.resolved === meta.markets.length) { winners = r.winners; how = 'resolved on Gamma'; }
    else { winners = provisionalWinners(); how = `PROVISIONAL (best bid >= 0.90 at the end; ${r.resolved}/${meta.markets.length} resolved)`; }
  }
  console.log(`  winning tokens: ${winners.size} (${how})`);
  for (const tok of winners) { const i = tokenInfo.get(tok); if (i && i.outcome === 'Yes') console.log(`    YES ${i.market.question}`); }

  // Per event: its own detection time K and its winning tokens.
  const rtt = book.restRttMs && book.restRttMs.median ? book.restRttMs.median : 300;
  const report = [];
  for (const ev of meta.events) {
    const served = sources.sources.filter(s => s.firstChange && (!s.events || s.events.includes(ev))).sort((a, b) => a.firstChange.t1 - b.firstChange.t1);
    const K = served.length ? served[0].firstChange.t1 : null;
    const toks = [...winners].filter(t => tokenInfo.get(t) && tokenInfo.get(t).market.event === ev);
    console.log(`\n## ${ev}: ${toks.length} winning tokens, K = ${K ? secs(K - T) + ' via ' + served[0].name : 'NONE (no page change)'}`);
    const rows = [['before the release (T-1s)', T - 1000]];
    for (const L of LATENCIES_MS) rows.push([`knew at T, order +${L}ms`, T + L]);
    if (K) for (const L of [...LATENCIES_MS, rtt]) rows.push([`our K, order +${L}ms${L === rtt ? ' (rtt)' : ''}`, K + L]);
    let pre = null;
    console.log(`  ${''.padEnd(32)} ${'at'.padStart(8)}  asks <= ${CHEAP_PRICE}: profit (gone since T-1s) | ${CHEAP_PRICE}-${MAX_PRICE} | best $${WALLET_CAP} | best ask`);
    for (const [label, S] of rows) {
      const p = pool(S, toks);
      if (pre === null) pre = p.cheapProfit;
      report.push({ event: ev, label, at: S - T, K: K ? K - T : null, ...p });
      console.log(`  ${label.padEnd(32)} ${secs(S - T).padStart(8)}  ${usd(p.cheapProfit).padStart(7)} on ${usd(p.cheapCost).padStart(7)} (${usd(pre - p.cheapProfit)} gone) | ${usd(p.parProfit).padStart(5)} | ${usd(p.capProfit).padStart(5)} | ${p.best}`);
    }
  }

  // Who took it: trades on winning tokens around T (server time)
  const taken = events.filter(e => e.type === 'trade' && winners.has(e.asset) && e.ts >= T - 1000 && e.ts <= T + 60_000);
  const cheapBuys = taken.filter(e => e.side === 'BUY' && e.price <= CHEAP_PRICE);
  console.log(`\n  trades on winning tokens T-1s..T+60s: ${taken.length}; taker BUYs <= ${CHEAP_PRICE}: ${cheapBuys.length}, profit ${usd(cheapBuys.reduce((s, e) => s + e.size * (1 - e.price), 0))}`);
  for (const e of taken.slice(0, 12)) console.log(`    ${secs(e.ts - T)} ${e.side} ${e.price} x ${Math.round(e.size)} ${tokenInfo.get(e.asset).market.slug.slice(0, 40)} ${tokenInfo.get(e.asset).outcome}`);

  // Validation: rebuilt book vs REST snapshots
  let checked = 0, same = 0;
  for (const f of fs.readdirSync(dir).filter(x => /^books_.*\.json$/.test(x))) {
    const snap = readJson(f);
    for (const b of snap.books || []) {
      if (!winners.has(b.asset_id)) continue;
      const rebuilt = bookAt(Number(b.timestamp)).get(b.asset_id);
      const restAsk = (b.asks || []).map(l => Number(l.price)).sort((x, y) => x - y)[0];
      const wsAsk = rebuilt && rebuilt.asks.size ? Math.min(...[...rebuilt.asks.keys()].map(Number)) : undefined;
      checked++;
      if (restAsk === wsAsk) same++;
    }
  }
  console.log(`\n  validation: rebuilt best ask equals the REST snapshot for ${same}/${checked} winning-token snapshots`);
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ id, at: meta.at, winnersHow: how, winners: [...winners], rows: report, validation: { checked, same } }, null, 1));
})();
