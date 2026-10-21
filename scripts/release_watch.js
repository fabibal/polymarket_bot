/**
 * No-money release measurement. Use release-watch.sh <id>; each invocation owns
 * a separate <id>/<run-id> directory. Schema 2 records knowledge, payloads,
 * connection epochs and full books. No signing, orders or account access.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { releaseConfig } = require('./release_watch_config');
const { parseRelease, text: htmlText, VERSION } = require('./release_watch_parsers');
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const PAGE_UA = 'release-watch/1.0 (personal research; polling official release pages)';
const REQUEST_TIMEOUT_MS = 4000;
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));
const median = xs => xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null;
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const normalize = body => body.replace(/<script\b[^]*?<\/script>|<style\b[^]*?<\/style>|<!--[^]*?-->/gi, '').replace(/\s+/g, ' ');
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

async function getJson(url, init = {}, attempts = 3, fetcher = fetch) {
  let error;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetcher(url, { ...init, headers: { 'User-Agent': PAGE_UA, ...init.headers }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { error = e; if (i + 1 < attempts) await sleep(300 * (i + 1)); }
  }
  throw error; // including repeated 429s; never silently return undefined
}

async function fetchPage(src) {
  const t0 = Date.now();
  let url = src.url;
  try {
    const read = async u => {
      const r = await fetch(src.bust ? `${u}${u.includes('?') ? '&' : '?'}_=${Date.now()}` : u,
        { headers: { 'User-Agent': PAGE_UA }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const body = await r.text();
      return { r, body };
    };
    let { r, body } = await read(url);
    if (r.status === 200 && src.follow === 'gdp') {
      const links = [...body.matchAll(/href=["']([^"']*\/news\/\d{4}\/[^"']*)["']/gi)].map(m => m[1]);
      const link = links.find(s => /gdp|gross-domestic-product/i.test(s));
      if (link) {
        const next = new URL(link, src.url);
        if (next.origin !== 'https://www.bea.gov') throw new Error('unexpected GDP source origin');
        url = next.href;
        ({ r, body } = await read(url));
      }
    }
    const receivedAt = Date.now();
    const parsed = r.status === 200 ? parseRelease(body, src.parse) : { periodValid: false, values: {}, errors: [] };
    return { t0, t1: receivedAt, parsedAt: Date.now(), st: r.status, url, h: hash(normalize(body)), len: body.length,
      mk: !!src.marker?.test(normalize(body)), parsed, age: r.headers.get('age'), lm: r.headers.get('last-modified'),
      cache: r.headers.get('cf-cache-status') || r.headers.get('x-cache'), body };
  } catch (e) { return { t0, t1: Date.now(), st: 0, err: String(e).slice(0, 160) }; }
}

function observeSource(s, r, rel, T, baseline = false) {
  s.polls++;
  if (r.st !== 200) { if (r.st !== 404) s.errors++; return; }
  const hit = { t0: r.t0, t1: r.t1, at: r.parsedAt, offsetMs: r.t1 - T, marker: r.mk, h: r.h, bodyFile: r.bodyFile, url: r.url };
  if (!baseline && r.h !== s.baseline?.h && !s.firstChange) s.firstChange = hit;
  if (r.mk && !s.firstMarker) s.firstMarker = hit;
  if (!r.parsed?.periodValid || r.parsedAt < T) return;
  for (const event of s.events) {
    const metric = rel.eventMetrics[event], value = r.parsed.values[metric];
    if (!value) continue;
    if (!s.firstValidated[event]) s.firstValidated[event] = { ...hit, metric, ...value, at: r.parsedAt };
    else if (s.firstValidated[event].value !== value.value && !s.conflicts.some(c => c.event === event && c.value === value.value)) {
      s.conflicts.push({ event, metric, at: r.parsedAt, value: value.value, h: r.h });
    }
  }
}

async function watchSource(src, rel, T, dir, log) {
  const s = { name: src.name, events: src.events, parser: src.parse || null, polls: 0, errors: 0,
    baseline: null, firstChange: null, firstMarker: null, firstValidated: {}, conflicts: [] };
  const bodies = path.join(dir, 'bodies', src.name);
  fs.mkdirSync(bodies, { recursive: true });
  const capture = async baseline => {
    const r = await fetchPage(src);
    if (r.body !== undefined) {
      r.bodyFile = `bodies/${src.name}/${r.h}.html.gz`;
      if (!fs.existsSync(path.join(dir, r.bodyFile))) fs.writeFileSync(path.join(dir, r.bodyFile), zlib.gzipSync(r.body));
    }
    if (baseline) s.baseline = { st: r.st, h: r.h, markerMatches: r.mk, t1: r.t1 };
    observeSource(s, r, rel, T, baseline);
    log.write(JSON.stringify({ src: src.name, phase: baseline ? 'baseline' : 'poll', ...r, body: undefined }) + '\n');
  };
  await capture(true);
  const pending = new Set();
  while (Date.now() < T + rel.end * 1000) {
    const now = Date.now(), hot = now >= T + rel.hot[0] * 1000 && now <= T + rel.hot[1] * 1000;
    if (pending.size < (hot ? 2 : 1)) {
      const p = capture(false).finally(() => pending.delete(p));
      pending.add(p);
    }
    await sleep(hot ? src.hotMs : now < T ? 2000 : 1000);
  }
  await Promise.all(pending);
  return s;
}

async function runSources(id, runId, rel, T, dir) {
  const startedAt = Date.now();
  const log = fs.createWriteStream(path.join(dir, 'sources.jsonl'), { flags: 'wx' });
  log.on('error', e => { console.error(e); process.exitCode = 1; });
  const results = await Promise.all(rel.sources.map(src => watchSource(src, rel, T, dir, log)));
  await new Promise((resolve, reject) => log.end(e => e ? reject(e) : resolve()));
  const missing = rel.events.filter(e => !results.some(s => s.firstValidated[e]));
  const issues = [...(startedAt >= T ? ['sources started after release'] : []), ...missing.map(e => `unvalidated: ${e}`)];
  if (!results.some(s => s.polls > s.errors)) issues.push('no successful source responses');
  const summary = { schemaVersion: 2, parserVersion: VERSION, part: 'sources', release: id, runId, at: rel.at,
    startedAt, finishedAt: Date.now(), eventMetrics: rel.eventMetrics, sources: results, quality: { ok: !issues.length, issues } };
  writeJson(path.join(dir, 'sources_summary.json'), summary);
  console.log(`TG sources ${issues.length ? 'INVALID' : 'OK'}: verified ${rel.events.length - missing.length}/${rel.events.length}; ` +
    results.filter(s => Object.keys(s.firstValidated).length).map(s => `${s.name} ${Object.values(s.firstValidated).map(v => `${v.metric}=${v.value} @+${((v.at-T)/1000).toFixed(3)}s`).join(',')}`).join('; '));
  return issues.length ? 3 : 0;
}

async function resolveMarkets(rel) {
  const lists = await Promise.all(rel.events.map(async slug => {
    const ev = await getJson(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
    if (!Array.isArray(ev) || ev.length !== 1 || !ev[0].markets?.length) throw new Error(`event missing/ambiguous: ${slug}`);
    return ev[0].markets.map(m => {
      const outcomes = JSON.parse(m.outcomes || '[]'), tokens = JSON.parse(m.clobTokenIds || '[]');
      if (outcomes.length !== 2 || tokens.length !== 2) throw new Error(`invalid binary market: ${m.slug}`);
      const rate = m.feesEnabled === false ? 0 : Number(m.feeSchedule?.rate ?? NaN);
      const exponent = Number(m.feeSchedule?.exponent ?? 1);
      return { event: slug, slug: m.slug, question: m.question, description: m.description, groupItemTitle: m.groupItemTitle,
        conditionId: m.conditionId, negRisk: !!m.negRisk, tick: Number(m.orderPriceMinTickSize) || null,
        minOrderSize: Number(m.orderMinSize) || null, feeRate: Number.isFinite(rate) && (exponent === 1 || rate === 0) ? rate : null,
        feeExponent: exponent, feeSource: 'Gamma at capture', acceptingOrders: m.acceptingOrders === true, closed: !!m.closed,
        tokens: tokens.map((token, i) => ({ token, outcome: outcomes[i] })) };
    });
  }));
  return lists.flat();
}

async function snapshot(label, tokens, dir) {
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 50) chunks.push(tokens.slice(i, i + 50));
  const parts = await Promise.all(chunks.map(async c => {
    const t0 = Date.now();
    try {
      const books = await getJson(`${CLOB}/books`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c.map(t => ({ token_id: t }))) }, 1);
      const ids = new Set(Array.isArray(books) ? books.map(b => b.asset_id) : []);
      const ok = Array.isArray(books) && books.length === c.length && c.every(t => ids.has(t));
      return { t0, t1: Date.now(), tokenIds: c, ok, books: Array.isArray(books) ? books : [] };
    } catch (e) { return { t0, t1: Date.now(), tokenIds: c, ok: false, err: String(e).slice(0, 160), books: [] }; }
  }));
  writeJson(path.join(dir, `books_${label}.json`), { label, chunks: parts.map(({ books, ...p }) => p), books: parts.flatMap(p => p.books) });
  return parts;
}

async function runBook(id, runId, rel, T, dir) {
  const WebSocket = require('ws');
  const startedAt = Date.now(), markets = await resolveMarkets(rel);
  const tokens = [...new Set(markets.flatMap(m => m.tokens.map(t => t.token)))];
  writeJson(path.join(dir, 'meta.json'), { schemaVersion: 2, release: id, runId, at: rel.at, startedAt, events: rel.events, eventMetrics: rel.eventMetrics, markets });
  const wsLog = fs.createWriteStream(path.join(dir, 'ws.jsonl'), { flags: 'wx' });
  wsLog.on('error', e => { console.error(e); process.exitCode = 1; });
  const stats = { msgs: 0, byType: {}, reconnects: 0, errors: 0, staleConnections: 0 };
  const write = x => wsLog.write(JSON.stringify({ r: Date.now(), ...x }) + '\n');
  let ws, reconnectTimer, epoch = 0, lastReceive = 0, stopping = false;
  const seen = new Set();
  const connect = () => {
    if (stopping) return;
    const conn = ++epoch, socket = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market', { handshakeTimeout: REQUEST_TIMEOUT_MS });
    ws = socket;
    socket.on('open', () => {
      lastReceive = Date.now(); write({ type: 'open', epoch: conn });
      socket.send(JSON.stringify({ assets_ids: tokens, type: 'market' }));
    });
    socket.on('message', buf => {
      if (stopping) return;
      lastReceive = Date.now(); const d = buf.toString();
      write({ epoch: conn, d }); // includes PONG: liveness without market changes
      if (d === 'PONG') return;
      stats.msgs++;
      try { for (const m of [JSON.parse(d)].flat()) {
        stats.byType[m.event_type || '?'] = (stats.byType[m.event_type || '?'] || 0) + 1;
        if (m.event_type === 'book') seen.add(m.asset_id);
      } } catch { stats.errors++; }
    });
    socket.on('error', e => { stats.errors++; write({ type: 'error', epoch: conn, message: String(e).slice(0, 120) }); });
    socket.on('close', () => {
      if (stopping) return;
      write({ type: 'close', epoch: conn }); stats.reconnects++;
      reconnectTimer = setTimeout(connect, 1000);
    });
  };
  connect();
  const ping = setInterval(() => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastReceive > 20_000) { stats.staleConnections++; write({ type: 'stale', epoch }); ws.terminate(); }
    else ws.send('PING');
  }, 5000);
  const snaps = await Promise.all(rel.snapshots.map(async off => {
    const at = T + off * 1000, label = off < 0 ? `m${-off}` : `p${off}`;
    if (at < Date.now() - 1000) return { label, ok: false, err: 'missed scheduled snapshot', rtt: [] };
    await sleep(at - Date.now());
    const parts = await snapshot(label, tokens, dir);
    return { label, ok: parts.every(p => p.ok), rtt: parts.filter(p => p.ok).map(p => p.t1 - p.t0) };
  }));
  await sleep(T + rel.bookEnd * 1000 - Date.now());
  stopping = true; clearInterval(ping); clearTimeout(reconnectTimer);
  write({ type: 'stop', epoch }); ws?.terminate();
  await new Promise((resolve, reject) => wsLog.end(e => e ? reject(e) : resolve()));
  const issues = [];
  if (!stats.msgs || tokens.some(t => !seen.has(t))) issues.push('missing full WS books');
  if (snaps.some(s => !s.ok)) issues.push('missing/failed REST snapshots');
  if (startedAt >= T) issues.push('book capture started after release');
  const rtts = snaps.flatMap(s => s.rtt);
  const summary = { schemaVersion: 2, part: 'book', release: id, runId, startedAt, finishedAt: Date.now(), markets: markets.length,
    tokens: tokens.length, ws: stats, snapshots: snaps, restRttMs: { median: median(rtts), max: rtts.length ? Math.max(...rtts) : null },
    quality: { ok: !issues.length, issues }, latencyNote: 'Read RTT only, NOT order acceptance/matching latency' };
  writeJson(path.join(dir, 'book_summary.json'), summary);
  console.log(`TG book ${issues.length ? 'INVALID' : 'OK'}: ${tokens.length} tokens, ${stats.msgs} msgs, REST ${snaps.filter(s => s.ok).length}/${snaps.length}, reconnects ${stats.reconnects}; read RTT ${median(rtts)}ms`);
  return issues.length ? 3 : 0;
}

async function main() {
  const [id, part] = process.argv.slice(2), runId = process.env.RW_RUN_ID;
  if (!/^[a-z0-9_-]+$/.test(id || '') || !/^[a-zA-Z0-9_-]+$/.test(runId || '') || !['sources', 'book'].includes(part)) throw new Error('use release-watch.sh <id> (RW_RUN_ID required for direct capture)');
  const rel = releaseConfig(id), T = Date.parse(rel.at);
  if (!Number.isFinite(T) || Date.now() > T + rel.bookEnd * 1000) throw new Error('invalid/expired release time');
  const dir = path.join(process.env.RELEASE_WATCH_OUT || '/out', id, runId);
  fs.mkdirSync(dir, { recursive: true });
  return part === 'sources' ? runSources(id, runId, rel, T, dir) : runBook(id, runId, rel, T, dir);
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(e => { console.error(e); console.log(`TG FAILED: ${String(e).slice(0, 180)}`); process.exitCode = 1; });
module.exports = { getJson, fetchPage, observeSource, resolveMarkets, snapshot, runSources, runBook };
