/**
 * Release watch (2026-10-20): measures how fast this server learns a scheduled
 * macro release (BLS / BEA / Fed pages) and what the Polymarket order book
 * offered at that moment. It answers "could we buy the confirmed bracket
 * seconds after the release ourselves?" (docs/decisions.md "Release-watch
 * measurement"). It places no orders and does not touch the bot.
 *
 * Two parts, started together by scripts/release-watch.sh about 3 min before T:
 *   sources  host network: the route a live version would read the pages on
 *            (they are not geo-blocked). Polls every source, fast in the hot
 *            window around T, and logs each response. A release is detected
 *            when the normalized page hash differs from the baseline; the
 *            marker regex is only a sanity check, warned about if the
 *            baseline already matches it.
 *   book     gluetun namespace (Polymarket is geo-blocked). Resolves the
 *            events' markets on Gamma, logs every CLOB websocket message
 *            (server ts + receive time) and takes timed REST /books
 *            snapshots around T; their round trip approximates the order
 *            latency.
 *
 *   docker run --rm -u 1000:1000 --network host \
 *     -v "$PWD":/app:ro -v <out>:/out node:20-alpine \
 *     node /app/scripts/release_watch.js <release-id> sources
 *   docker run --rm -u 1000:1000 --network container:gluetun \
 *     -v "$PWD":/app:ro -v <out>:/out node:20-alpine \
 *     node /app/scripts/release_watch.js <release-id> book
 *
 * Output: /out/<release-id>/ (sources.jsonl, sources_summary.json, baseline and
 * first changed page bodies, meta.json, ws.jsonl, books_<label>.json,
 * book_summary.json), plus "TG <text>" and "SUMMARY <json>" lines on stdout for
 * the wrapper. Evaluate with scripts/release_watch_report.js.
 *
 * Release "test-<date>" is for dry runs: RW_AT (ISO time), RW_EVENTS (event
 * slugs, comma-separated) and RW_EXTRA_SOURCE (one more URL) come from env.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUT_ROOT = process.env.RELEASE_WATCH_OUT || '/out';
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
// BLS answers 403 to generic and browser user agents from this host and the
// VPN, and 200 to a descriptive one (tested 2026-10-20).
const PAGE_UA = 'release-watch/1.0 (personal research; polling official release pages)';
const API_UA = 'curl/8.5.0';

// ── Releases (times from the markets' rules; UTC) ───────────────────────────
// hot: [from, to] seconds around T polled at each source's hotMs; slower
// outside it. end / bookEnd: seconds after T when each part stops.
const DEFAULTS = { hot: [-5, 25], end: 120, bookEnd: 180, snapshots: [-120, -10, 1, 3, 10, 30] };
const RELEASES = {
  // Rehearsal: the rate decision is low-margin, the dissent count is not.
  'fomc-2026-10-28': {
    at: '2026-10-28T18:00:00Z',
    events: ['fed-decision-in-october-20260617190323537', 'how-many-dissent-at-the-october-fed-meeting'],
    sources: [
      // The 404 page's menu already says "Federal Open Market Committee"; the decision sentence is statement-only.
      { name: 'fed-statement', url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm', hotMs: 400, marker: /target range for the federal funds rate/i },
      { name: 'fed-statement-bust', url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm', bust: true, hotMs: 400, marker: /target range for the federal funds rate/i },
      { name: 'fed-rss', url: 'https://www.federalreserve.gov/feeds/press_monetary.xml', hotMs: 400, marker: /monetary20261028a/ },
    ],
  },
  'gdp-pce-2026-10-29': {
    at: '2026-10-29T12:30:00Z',
    events: ['us-gdp-growth-in-q3-2026-20260730144539767', 'core-pce-mom-september-2026', 'core-pce-yoy-september-2026'],
    // events: which markets a page resolves (the report times each event by its
    // own pages); a source without it serves every event of the release.
    sources: [
      { name: 'bea-gdp', url: 'https://www.bea.gov/data/gdp/gross-domestic-product', hotMs: 600, marker: /3rd Quarter 2026/, events: ['us-gdp-growth-in-q3-2026-20260730144539767'] },
      { name: 'bea-gdp-bust', url: 'https://www.bea.gov/data/gdp/gross-domestic-product', bust: true, hotMs: 600, marker: /3rd Quarter 2026/, events: ['us-gdp-growth-in-q3-2026-20260730144539767'] },
      { name: 'bea-pce', url: 'https://www.bea.gov/data/personal-consumption-expenditures-price-index', hotMs: 600, marker: /September 2026/, events: ['core-pce-mom-september-2026', 'core-pce-yoy-september-2026'] },
      { name: 'bea-pce-bust', url: 'https://www.bea.gov/data/personal-consumption-expenditures-price-index', bust: true, hotMs: 600, marker: /September 2026/, events: ['core-pce-mom-september-2026', 'core-pce-yoy-september-2026'] },
      { name: 'bea-releases-bust', url: 'https://www.bea.gov/news/current-releases', bust: true, hotMs: 600, marker: /3rd Quarter 2026/ },
    ],
  },
  // Extra BLS latency sample; the JOLTS race itself is 0-5 s and small.
  'jolts-2026-11-03': {
    at: '2026-11-03T15:00:00Z',
    events: ['jolts-job-openings-september-2026'],
    sources: [
      { name: 'bls-jolts', url: 'https://www.bls.gov/news.release/jolts.nr0.htm', hotMs: 250, marker: /2026 M09 Results/ },
    ],
  },
  'jobs-2026-11-06': {
    at: '2026-11-06T13:30:00Z',
    events: ['how-many-jobs-added-in-october-2026', 'october-unemployment-rate-2026'],
    sources: [
      { name: 'bls-empsit', url: 'https://www.bls.gov/news.release/empsit.nr0.htm', hotMs: 250, marker: /2026 M10 Results/ },
    ],
  },
  'cpi-2026-11-10': {
    at: '2026-11-10T13:30:00Z',
    events: ['october-inflation-us-annual', 'october-inflation-us-monthly', 'core-cpi-mom-october-2026', 'core-cpi-yoy-october-2026'],
    sources: [
      { name: 'bls-cpi', url: 'https://www.bls.gov/news.release/cpi.nr0.htm', hotMs: 300, marker: /2026 M10 Results/ },
      // Atom feed; each entry links the release archive, e.g. cpi_10142026.htm.
      { name: 'bls-cpi-rss', url: 'https://www.bls.gov/feed/cpi.rss', hotMs: 300, marker: /cpi_11102026/ },
    ],
  },
};

function testRelease(id) {
  const sources = [
    { name: 'bls-cpi', url: 'https://www.bls.gov/news.release/cpi.nr0.htm', hotMs: 2000, marker: /2026 M10 Results/ },
    { name: 'fed-rss', url: 'https://www.federalreserve.gov/feeds/press_monetary.xml', hotMs: 2000, marker: /28 Oct 2026/ },
  ];
  if (process.env.RW_EXTRA_SOURCE) sources.push({ name: 'extra', url: process.env.RW_EXTRA_SOURCE, hotMs: 250, marker: /released/ });
  return {
    at: process.env.RW_AT,
    events: (process.env.RW_EVENTS || '').split(',').filter(Boolean),
    sources, hot: [-3, 10], end: 25, bookEnd: 40, snapshots: [-10, 1, 3, 10],
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sleepUntil = t => sleep(Math.max(0, t - Date.now()));
const sha = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const normalize = body => body
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\s+/g, ' ');
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const secs = ms => (ms >= 0 ? '+' : '') + (ms / 1000).toFixed(2) + 's';

// ── sources part ────────────────────────────────────────────────────────────
async function fetchPage(src) {
  const url = src.bust ? `${src.url}${src.url.includes('?') ? '&' : '?'}_=${Date.now()}` : src.url;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': PAGE_UA, Accept: '*/*' }, redirect: 'follow' });
    const body = await r.text();
    const norm = normalize(body);
    return {
      t0, t1: Date.now(), st: r.status, len: body.length, h: sha(norm), mk: src.marker.test(norm),
      age: r.headers.get('age'), lm: r.headers.get('last-modified'),
      cache: r.headers.get('cf-cache-status') || r.headers.get('x-cache'), body,
    };
  } catch (e) {
    return { t0, t1: Date.now(), st: 0, err: String(e).slice(0, 160) };
  }
}

async function watchSource(src, rel, T, dir, log) {
  const s = { name: src.name, url: src.url, bust: !!src.bust, events: src.events || null, polls: 0, errors: 0, baseline: null, firstChange: null, firstMarker: null, changes: 0 };
  let base = null;
  for (let i = 0; i < 3 && !base; i++) {
    const b = await fetchPage(src);
    log.write(JSON.stringify({ src: src.name, phase: 'baseline', ...b, body: undefined }) + '\n');
    if (b.st) base = b; else await sleep(2000);
  }
  if (!base) { s.errors++; s.baseline = { error: 'no baseline response' }; return s; }
  s.baseline = { st: base.st, h: base.h, len: base.len, markerMatches: base.mk };
  fs.writeFileSync(path.join(dir, `${src.name}.baseline.html`), base.body);
  if (base.mk) console.log(`WARN ${src.name}: the baseline already matches the marker; detection relies on the hash`);

  const stopAt = T + rel.end * 1000;
  let inflight = 0;
  const seen = new Set([base.h]);
  const handle = r => {
    s.polls++;
    log.write(JSON.stringify({ src: src.name, ...r, body: undefined }) + '\n');
    if (!r.st || (r.st !== 200 && r.st !== base.st)) { s.errors++; return; }
    // Changed = a new 200 body, or a 200 where the baseline was not (Fed 404 -> 200).
    const changed = r.st === 200 && (r.h !== base.h || base.st !== 200);
    if (!changed) return;
    if (r.t1 < T + rel.hot[0] * 1000) {
      // Unrelated edit before the hot window (no release comes out that early):
      // take it as the new baseline so it can't pose as the release.
      s.preChanges = (s.preChanges || 0) + 1;
      if (s.preChanges <= 2) fs.writeFileSync(path.join(dir, `${src.name}.prechange${s.preChanges}.html`), r.body);
      console.log(`WARN ${src.name}: page changed ${secs(r.t1 - T)} before T; re-baselined`);
      base = r;
      seen.add(r.h);
      return;
    }
    if (!seen.has(r.h)) {
      seen.add(r.h);
      s.changes++;
      if (s.changes <= 2) fs.writeFileSync(path.join(dir, `${src.name}.change${s.changes}.html`), r.body);
    }
    const hit = { t0: r.t0, t1: r.t1, offsetMs: r.t1 - T, st: r.st, marker: r.mk, h: r.h };
    if (!s.firstChange || r.t1 < s.firstChange.t1) s.firstChange = hit;
    if (r.mk && (!s.firstMarker || r.t1 < s.firstMarker.t1)) s.firstMarker = hit;
  };
  while (Date.now() < stopAt) {
    const now = Date.now();
    // After detection keep polling 20 s (does the page flap back?), then stop.
    if (s.firstChange && now > s.firstChange.t1 + 20_000 && now > T + rel.hot[1] * 1000) break;
    const hot = now >= T + rel.hot[0] * 1000 && now <= T + rel.hot[1] * 1000;
    const interval = hot ? src.hotMs : (now < T ? 2000 : 1000);
    if (inflight < (hot ? 2 : 1)) {
      inflight++;
      fetchPage(src).then(r => { inflight--; handle(r); });
    }
    await sleep(interval);
  }
  while (inflight > 0) await sleep(50);
  return s;
}

async function runSources(id, rel, T, dir) {
  const log = fs.createWriteStream(path.join(dir, 'sources.jsonl'), { flags: 'a' });
  const results = await Promise.all(rel.sources.map(src => watchSource(src, rel, T, dir, log)));
  await new Promise(r => log.end(r));
  const summary = { part: 'sources', release: id, at: rel.at, sources: results };
  fs.writeFileSync(path.join(dir, 'sources_summary.json'), JSON.stringify(summary, null, 1));
  const tg = results.map(s => {
    if (!s.baseline || s.baseline.error) return `${s.name} NO BASELINE`;
    const det = s.firstChange ? `${secs(s.firstChange.offsetMs)} marker=${s.firstChange.marker ? 'yes' : 'no'}` : 'none';
    return `${s.name} ${det}${s.errors ? ` (${s.errors} err/${s.polls})` : ''}${s.baseline.markerMatches ? ' [marker already in baseline]' : ''}`;
  });
  console.log('TG sources: ' + tg.join(', '));
  console.log('SUMMARY ' + JSON.stringify({ part: 'sources', release: id, detected: results.filter(s => s.firstChange).length, of: results.length }));
}

// ── book part ───────────────────────────────────────────────────────────────
async function getJson(url, init = {}) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { ...init, headers: { 'User-Agent': API_UA, Accept: 'application/json', ...(init.headers || {}) } });
      if (r.status === 429) { await sleep(1500); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === 3) throw e;
      await sleep(1000);
    }
  }
}

async function resolveMarkets(events) {
  const markets = [];
  for (const slug of events) {
    let ev = await getJson(`${GAMMA}/events?slug=${slug}`);
    if (!Array.isArray(ev) || !ev.length) ev = await getJson(`${GAMMA}/events?slug=${slug}&closed=true`);
    if (!Array.isArray(ev) || !ev.length) { console.log(`WARN event not found: ${slug}`); continue; }
    for (const m of ev[0].markets || []) {
      const outcomes = JSON.parse(m.outcomes || '[]');
      const tokens = JSON.parse(m.clobTokenIds || '[]');
      markets.push({
        event: slug, slug: m.slug, question: m.question, conditionId: m.conditionId, negRisk: !!m.negRisk,
        tick: Number(m.orderPriceMinTickSize) || null, closed: !!m.closed,
        tokens: tokens.map((t, i) => ({ token: t, outcome: outcomes[i] })),
      });
    }
  }
  return markets;
}

async function snapshot(label, tokens, dir) {
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 50) chunks.push(tokens.slice(i, i + 50));
  const parts = await Promise.all(chunks.map(async c => {
    const t0 = Date.now();
    try {
      const books = await getJson(`${CLOB}/books`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c.map(t => ({ token_id: t }))) });
      return { t0, t1: Date.now(), ok: Array.isArray(books), books: Array.isArray(books) ? books : [] };
    } catch (e) {
      return { t0, t1: Date.now(), ok: false, err: String(e).slice(0, 160), books: [] };
    }
  }));
  fs.writeFileSync(path.join(dir, `books_${label}.json`), JSON.stringify({ label, chunks: parts.map(p => ({ t0: p.t0, t1: p.t1, ok: p.ok, err: p.err })), books: parts.flatMap(p => p.books) }));
  return parts;
}

async function runBook(id, rel, T, dir) {
  const WebSocket = require('/app/node_modules/ws');
  const markets = await resolveMarkets(rel.events);
  const tokens = markets.flatMap(m => m.tokens.map(t => t.token));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ release: id, at: rel.at, events: rel.events, markets }, null, 1));
  if (!tokens.length) throw new Error('no tokens resolved');

  // Clock check: /time is whole seconds, so this only bounds the offset to ~1 s;
  // the report also uses min(receive - server ts) of the websocket messages.
  const clock = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    try { const r = await fetch(`${CLOB}/time`, { headers: { 'User-Agent': API_UA } }); clock.push({ t0, t1: Date.now(), server: Number(await r.text()) }); } catch {}
  }
  fs.writeFileSync(path.join(dir, 'clock.json'), JSON.stringify(clock));

  const wsLog = fs.createWriteStream(path.join(dir, 'ws.jsonl'), { flags: 'a' });
  const stats = { msgs: 0, byType: {}, reconnects: 0, errors: 0 };
  const stopAt = T + rel.bookEnd * 1000;
  let ws = null, pinger = null, stopping = false;
  const connect = () => {
    ws = new WebSocket(CLOB_WS);
    ws.on('open', () => ws.send(JSON.stringify({ assets_ids: tokens, type: 'market' })));
    ws.on('message', buf => {
      const r = Date.now();
      const d = buf.toString();
      if (d === 'PONG') return;
      stats.msgs++;
      wsLog.write(JSON.stringify({ r, d }) + '\n');
      try {
        const j = JSON.parse(d);
        for (const m of Array.isArray(j) ? j : [j]) stats.byType[m.event_type || '?'] = (stats.byType[m.event_type || '?'] || 0) + 1;
      } catch {}
    });
    ws.on('error', e => { stats.errors++; console.log(`WARN ws error: ${String(e).slice(0, 120)}`); });
    ws.on('close', () => { if (!stopping) { stats.reconnects++; setTimeout(connect, 1000); } });
  };
  connect();
  pinger = setInterval(() => { try { ws.send('PING'); } catch {} }, 10_000);

  const snaps = [];
  for (const off of rel.snapshots) {
    const at = T + off * 1000;
    if (at < Date.now() - 1000) continue;     // started too late for this one
    await sleepUntil(at);
    const label = off < 0 ? `m${-off}` : `p${off}`;
    const parts = await snapshot(label, tokens, dir);
    snaps.push({ label, ok: parts.every(p => p.ok), rtt: parts.map(p => p.t1 - p.t0) });
  }
  await sleepUntil(stopAt);
  stopping = true;
  clearInterval(pinger);
  try { ws.close(); } catch {}
  await new Promise(r => wsLog.end(r));

  const rtts = snaps.flatMap(s => s.rtt);
  const summary = { part: 'book', release: id, markets: markets.length, tokens: tokens.length, ws: stats, snapshots: snaps, restRttMs: { median: median(rtts), max: rtts.length ? Math.max(...rtts) : null } };
  fs.writeFileSync(path.join(dir, 'book_summary.json'), JSON.stringify(summary, null, 1));
  const okSnaps = snaps.filter(s => s.ok).length;
  console.log(`TG book: ${tokens.length} tokens, ${stats.msgs} ws msgs, ${stats.reconnects} reconnects, REST ${okSnaps}/${snaps.length} ok, rtt ${summary.restRttMs.median}ms`);
  console.log('SUMMARY ' + JSON.stringify({ part: 'book', release: id, tokens: tokens.length, wsMsgs: stats.msgs, restOk: okSnaps, rest: snaps.length }));
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  const [id, part] = process.argv.slice(2);
  const rel = id && id.startsWith('test-') ? testRelease(id) : RELEASES[id];
  if (!rel || !rel.at || !['sources', 'book'].includes(part)) {
    console.error(`usage: release_watch.js <${Object.keys(RELEASES).join('|')}|test-YYYY-MM-DD> <sources|book>`);
    process.exit(2);
  }
  const cfg = { ...DEFAULTS, ...rel };
  const T = Date.parse(cfg.at);
  if (Date.now() > T + cfg.bookEnd * 1000) { console.error(`release ${id} at ${cfg.at} is over`); process.exit(2); }
  const dir = path.join(OUT_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (part === 'sources') await runSources(id, cfg, T, dir);
    else await runBook(id, cfg, T, dir);
    process.exit(0);
  } catch (e) {
    console.log(`TG ${part}: FAILED ${String(e).slice(0, 160)}`);
    console.error(e);
    process.exit(1);
  }
})();
