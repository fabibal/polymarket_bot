// Offline book replay and bounded hypothetical execution. All prices used for
// choosing orders were received by the decision time; future books only limit
// those already chosen orders. No settlement prices participate in selection.
const { selectTokens } = require('./release_watch_parsers');
const key = p => String(Number(p));
function levels(xs) {
  if (!Array.isArray(xs)) throw new Error('missing book side');
  const out = new Map();
  for (const l of xs) {
    const p = Number(l.price), q = Number(l.size);
    if (!Number.isFinite(p) || p <= 0 || p >= 1 || !Number.isFinite(q) || q < 0 || out.has(key(p))) throw new Error('invalid/duplicate book level');
    if (q > 0) out.set(key(p), q);
  }
  return out;
}
function sameLevels(a, b) {
  return a.size === b.size && [...a].every(([p, q]) => b.has(p) && Math.abs(b.get(p) - q) <= 1e-8);
}
function createReplay(records) {
  const parsed = [], offsets = [], issues = [];
  let sequence = 0, epochStart = 0;
  for (const rec of records) {
    if (!Number.isFinite(rec.r)) { issues.push('invalid receive timestamp'); continue; }
    if (rec.type) {
      if (rec.type === 'open') epochStart = rec.r;
      parsed.push({ ts: rec.r, r: rec.r, type: rec.type, epoch: rec.epoch, sequence: sequence++ }); continue;
    }
    if (rec.d === 'PONG') { parsed.push({ ts: rec.r, r: rec.r, type: 'heartbeat', sequence: sequence++ }); continue; }
    let msgs;
    try { msgs = [JSON.parse(rec.d)].flat(); } catch { issues.push('malformed WS payload'); continue; }
    for (const m of msgs) {
      const ts = Number(m.timestamp);
      if (!Number.isFinite(ts) || ts <= 0) { issues.push('missing WS timestamp'); continue; }
      // A book timestamp is its last change, potentially minutes before the
      // initial snapshot was sent. It is not a transport latency sample.
      if (m.event_type !== 'book') offsets.push(rec.r - ts);
      // Initial snapshots may have a last-update timestamp before subscription.
      const base = { ts: Math.max(ts, epochStart), r: rec.r, epoch: rec.epoch, sequence: sequence++ };
      if (m.event_type === 'book') parsed.push({ ...base, type: 'book', asset: m.asset_id, bids: m.bids, asks: m.asks });
      else if (m.event_type === 'price_change') {
        for (const p of m.price_changes || []) parsed.push({ ...base, type: 'pc', asset: p.asset_id, side: p.side, price: p.price, size: p.size });
      } else if (m.event_type === 'tick_size_change') parsed.push({ ...base, type: 'tick', asset: m.asset_id, tick: Number(m.new_tick_size) });
      else parsed.push({ ...base, type: 'activity' });
    }
  }
  const received = [...parsed].sort((a,b) => a.r-b.r || a.sequence-b.sequence);
  const server = [...parsed].sort((a,b) => a.ts-b.ts || a.sequence-b.sequence);
  const hasLifecycle = records.some(r => r.type === 'open');
  function at(S, clock = 'server') {
    const books = new Map(); let connected = !hasLifecycle, lastReceive = -Infinity, epoch;
    for (const e of clock === 'receive' ? received : server) {
      if ((clock === 'receive' ? e.r : e.ts) > S) break;
      if (e.type === 'open') { books.clear(); connected = true; epoch = e.epoch; lastReceive = e.r; continue; }
      if (['close','error','stale','stop'].includes(e.type)) { books.clear(); connected = false; continue; }
      if (e.epoch != null && epoch != null && e.epoch !== epoch) continue;
      // In server-time replay never count a future-received packet as a
      // heartbeat proving the connection was live earlier.
      if (e.r <= S) lastReceive = Math.max(lastReceive, e.r);
      if (!connected) continue;
      if (e.type === 'book') {
        try { books.set(e.asset, { asks: levels(e.asks), bids: levels(e.bids), epoch }); }
        catch { books.delete(e.asset); }
      } else if (e.type === 'pc') {
        const b = books.get(e.asset), p = Number(e.price), q = Number(e.size);
        if (!b) continue;
        if (!['BUY','SELL'].includes(e.side) || !(p>0 && p<1) || !Number.isFinite(q) || q<0) { books.delete(e.asset); continue; }
        const side = e.side === 'SELL' ? b.asks : b.bids;
        if (q === 0) side.delete(key(p)); else side.set(key(p), q);
      } else if (e.type === 'tick' && books.has(e.asset)) books.get(e.asset).tick = e.tick;
    }
    return { books, healthy: connected && (!hasLifecycle || S-lastReceive <= 20_000) };
  }
  const timesBetween = (from,to,asset) => server.filter(e => e.ts>=from && e.ts<=to && (!e.asset || e.asset===asset)).map(e=>e.ts);
  return { at, offsets, issues, hasLifecycle, timesBetween };
}

function validateSnapshots(replay, snapshots, expectedTokens) {
  const mismatches = []; let checked = 0, bestAskSame = 0, fullSame = 0;
  for (const snap of snapshots) {
    const seen = new Set();
    for (const rest of snap.books || []) {
      if (!expectedTokens.includes(rest.asset_id) || seen.has(rest.asset_id)) { mismatches.push({ label:snap.label, token:rest.asset_id, reason:'unexpected/duplicate token' }); continue; }
      seen.add(rest.asset_id); checked++;
      try {
        const asks = levels(rest.asks), bids = levels(rest.bids);
        const chunk = snap.chunks?.find(c=>c.tokenIds?.includes(rest.asset_id)) || (snap.chunks?.length===1?snap.chunks[0]:null);
        // REST's book timestamp is last-change time, not snapshot-generation
        // time. For captured requests compare full states possible during the
        // bounded HTTP interval; legacy fixtures without timing use as-of ts.
        const times = chunk ? [chunk.t0,chunk.t1,...replay.timesBetween(chunk.t0,chunk.t1,rest.asset_id)] : [Number(rest.timestamp)];
        const states = times.map(t=>replay.at(t)).filter(s=>s.healthy).map(s=>s.books.get(rest.asset_id)).filter(Boolean);
        if (states.some(b=>Math.min(...asks.keys())===Math.min(...b.asks.keys()))) bestAskSame++;
        if (states.some(b=>sameLevels(asks,b.asks)&&sameLevels(bids,b.bids))) fullSame++;
        else mismatches.push({ label:snap.label, token:rest.asset_id, reason:states.length?'depth mismatch':'no healthy WS baseline' });
      } catch (e) { mismatches.push({ label:snap.label, token:rest.asset_id, reason:String(e) }); }
    }
    for (const t of expectedTokens) if (!seen.has(t)) mismatches.push({ label:snap.label, token:t, reason:'missing REST token' });
  }
  return { checked, bestAskSame, fullSame, ok: checked > 0 && !mismatches.length, mismatches };
}

function signalsFromSources(meta, sources) {
  const signals = [], issues = [];
  for (const event of meta.events) {
    const candidates = sources.sources.flatMap(s => s.firstValidated?.[event] ? [{ ...s.firstValidated[event], source:s.name }] : []).sort((a,b)=>a.at-b.at);
    const first = candidates[0], metric = meta.eventMetrics?.[event];
    if (!first || !metric || first.metric !== metric || !Number.isFinite(first.at) || first.at < Date.parse(meta.at)) { issues.push(`${event}: no validated knowledge`); continue; }
    try {
      const tokens = selectTokens(meta.markets.filter(m => m.event === event), metric, first.value);
      const conflict = candidates.some(c => c.value !== first.value) || sources.sources.some(s => s.conflicts?.some(c => c.event === event));
      signals.push({ event, ...first, tokens, conflict });
      if (conflict) issues.push(`${event}: conflicting source values (first signal retained for audit)`);
    } catch (e) { issues.push(`${event}: ${e.message}`); }
  }
  return { signals, issues };
}

const feePerShare = (price, rate) => price * (1-price) * rate;
// excluded: tokens whose REST/WS book check disagreed. They are never bought (understates, never inflates).
function simulatePortfolio(meta, signals, replay, { latencyMs, fillFraction, budget = 800, maxPrice = 0.99, orderType = 'FAK', excluded = [] }) {
  const excludedSet = new Set(excluded);
  if (!(budget>0) || !(fillFraction>=0 && fillFraction<=1) || !(latencyMs>=0) || !(maxPrice>0 && maxPrice<1) || !['FAK','FOK'].includes(orderType)) throw new Error('invalid simulation assumptions');
  const info = new Map(meta.markets.flatMap(m=>m.tokens.map(t=>[t.token,m])));
  const queue = [], fills = [], skips = [], reasons = [];
  const consumed = new Map();
  let cash = budget, reserved = 0;
  // Orders for simultaneously available signals share one decision and wallet.
  for (const at of [...new Set(signals.map(s=>s.at))]) queue.push({ kind:'decision', at, signals:signals.filter(s=>s.at===at) });
  queue.sort((a,b)=>a.at-b.at);
  while (queue.length) {
    const task = queue.shift();
    const state = replay.at(task.at, task.kind === 'decision' ? 'receive' : 'server');
    if (!state.healthy) { reasons.push(`WS gap at ${task.kind} ${task.at}`); if(task.kind==='arrival') reserved-=task.reserve; continue; }
    if (task.kind === 'decision') {
      const candidates = [];
      for (const signal of task.signals) for (const token of signal.tokens) {
        if (excludedSet.has(token)) continue;
        const m = info.get(token), b = state.books.get(token);
        if (!b) { reasons.push(`no complete decision book: ${token}`); continue; }
        const tick = b.tick || m.tick;
        if (m.feeRate == null || !(m.feeRate>=0 && m.feeRate<=1) || !(m.minOrderSize>0) || !(tick>0) || !m.acceptingOrders || m.closed) { reasons.push(`unknown/untradeable metadata: ${m.slug}`); continue; }
        const asks = [...b.asks].map(([p,q])=>({price:Number(p),size:q})).filter(l=>l.price<=maxPrice).sort((a,b)=>a.price-b.price);
        if (asks.length) candidates.push({ signal, token, m, asks, tick });
      }
      const offers = candidates.flatMap(c => c.asks.map(l => ({ ...l, candidate:c,
        unit:l.price+feePerShare(l.price,c.m.feeRate) }))).sort((a,b)=>a.unit-b.unit || a.candidate.token.localeCompare(b.candidate.token));
      const plans = new Map();
      for (const offer of offers) {
        const c=offer.candidate, previous=plans.get(c.token) || {quantity:0,limit:0,reserve:0};
        if (Math.abs(offer.price/c.tick-Math.round(offer.price/c.tick))>1e-6) { reasons.push(`off-tick price: ${c.token}`); continue; }
        // Raising an order's limit also raises the reserve for shares selected
        // at cheaper levels. Never allocate that reserve to another market.
        const reprice=previous.quantity*offer.unit-previous.reserve;
        const room=cash-reserved-reprice;
        if(room<=0) continue;
        const add=Math.floor(Math.min(offer.size,room/offer.unit)*1e6)/1e6;
        if(add<=0)continue;
        const quantity=previous.quantity+add, reserve=quantity*offer.unit;
        reserved+=reserve-previous.reserve;
        plans.set(c.token,{c,quantity,limit:offer.price,reserve});
      }
      for(const p of plans.values()) {
        if(p.quantity<p.c.m.minOrderSize) { reserved-=p.reserve; skips.push({token:p.c.token,reason:'minimum order size / cash'});continue; }
        queue.push({kind:'arrival',at:task.at+latencyMs,decisionAt:task.at,event:p.c.signal.event,token:p.c.token,
          m:p.c.m,quantity:p.quantity,limit:p.limit,reserve:p.reserve});
      }
      queue.sort((a,b)=>a.at-b.at || (a.kind==='arrival'?-1:1));
    } else {
      reserved-=task.reserve;
      const b = state.books.get(task.token);
      if (!b) { reasons.push(`no complete arrival book: ${task.token}`); continue; }
      const tick = b.tick || task.m.tick;
      if (Math.abs(task.limit/tick-Math.round(task.limit/tick))>1e-6) { skips.push({token:task.token,reason:'tick changed'}); continue; }
      let remaining=task.quantity; const planned=[];
      for (const [p,size] of [...b.asks].sort((a,b)=>Number(a[0])-Number(b[0]))) {
        const price=Number(p); if(price>task.limit) break;
        const k=`${task.token}:${p}`;
        const available=Math.max(0,size*fillFraction-(consumed.get(k)||0));
        const q=Math.min(available,remaining);
        if(q>0) { planned.push({price,shares:q,k}); remaining-=q; }
        if(remaining<=1e-8) break;
      }
      if(orderType==='FOK' && remaining>1e-6) { skips.push({token:task.token,reason:'FOK not fully available'}); continue; }
      for(const l of planned) {
        const cost=l.price*l.shares, fee=feePerShare(l.price,task.m.feeRate)*l.shares;
        if(cost+fee>cash-reserved+1e-6) throw new Error('wallet accounting invariant');
        cash-=cost+fee; consumed.set(l.k,(consumed.get(l.k)||0)+l.shares);
        fills.push({event:task.event,token:task.token,decisionAt:task.decisionAt,arrivalAt:task.at,price:l.price,shares:l.shares,cost,fee,netIfCorrect:l.shares-cost-fee});
      }
    }
  }
  const total = k => fills.reduce((s,f)=>s+f[k],0);
  return { latencyMs, fillFraction, orderType, maxPrice, budget, spent:total('cost')+total('fee'), fees:total('fee'), unspent:cash,
    netIfCorrect: reasons.length ? null : total('netIfCorrect'), valid:!reasons.length, reasons:[...new Set(reasons)], fills, skips,
    bands: { below90: fills.filter(f=>f.price<0.9).reduce((s,f)=>s+f.netIfCorrect,0), from90to99:fills.filter(f=>f.price>=0.9).reduce((s,f)=>s+f.netIfCorrect,0) } };
}
module.exports = { levels, createReplay, validateSnapshots, signalsFromSources, simulatePortfolio, feePerShare };
