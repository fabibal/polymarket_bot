/**
 * No-money report: node scripts/release_watch_report.js <release-id> [run-id] [--offline]
 * RELEASE_WATCH_OUT defaults to /out. Omit run-id to read <id>/latest; legacy
 * captures remain readable as INVALID diagnostics. Writes report-v2.json only.
 * --offline requires an existing resolution-v2.json for confirmed PnL; absent
 * resolution never falls back to best bid, 0.99 prices or winners.json.
 */
const fs = require('fs');
const path = require('path');
const { getJson } = require('./release_watch');
const { createReplay, validateSnapshots, signalsFromSources, simulatePortfolio } = require('./release_watch_model');
const readJson = (dir, file, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(dir,file),'utf8')); } catch { return fallback; } };
const dollars = n => n == null ? 'N/A' : `$${n.toFixed(2)}`;
function confirmedResolution(m) {
  if (!m.closed || m.umaResolutionStatus !== 'resolved') return null;
  let prices, tokens;
  try { prices=JSON.parse(m.outcomePrices); tokens=JSON.parse(m.clobTokenIds); } catch { return null; }
  if (prices.length!==2 || tokens.length!==2 || prices.filter(p=>Number(p)===1).length!==1 || prices.filter(p=>Number(p)===0).length!==1) return null;
  return Object.fromEntries(tokens.map((t,i)=>[t,Number(prices[i])]));
}
async function resolvePayouts(meta) {
  const payouts={}, markets=[], errors=[];
  const ids=[...new Set(meta.markets.map(m=>m.conditionId))];
  for(let i=0;i<ids.length;i+=20) {
    const batch=ids.slice(i,i+20), q=batch.map(c=>`condition_ids=${encodeURIComponent(c)}`).join('&');
    try {
      const data=await getJson(`https://gamma-api.polymarket.com/markets?${q}&closed=true&limit=100`);
      if(!Array.isArray(data)) throw Error('invalid Gamma response');
      for(const m of data) {
        if(!batch.includes(m.conditionId)) continue;
        const expected=meta.markets.find(x=>x.conditionId===m.conditionId);
        const result=confirmedResolution(m);
        if(result && expected.tokens.every(t=>t.token in result)) { Object.assign(payouts,result); markets.push({conditionId:m.conditionId,payouts:result}); }
      }
    } catch(e) { errors.push(String(e)); }
  }
  return {schemaVersion:2,release:meta.release,runId:meta.runId,checkedAt:Date.now(),source:'Gamma closed + umaResolutionStatus=resolved + exact 1/0',payouts,markets,errors};
}
function evaluate(meta, sources, book, records, snapshots, resolution) {
  const replay=createReplay(records), tokens=meta.markets.flatMap(m=>m.tokens.map(t=>t.token));
  const validation=validateSnapshots(replay,snapshots,tokens);
  const {signals,issues:signalIssues}=signalsFromSources(meta,sources);
  const issues=[...replay.issues,...signalIssues];
  if(meta.schemaVersion!==2 || sources.schemaVersion!==2 || book.schemaVersion!==2 || !replay.hasLifecycle) issues.push('legacy/incomplete capture: no verifiable connection/knowledge history');
  if(meta.runId!==sources.runId || meta.runId!==book.runId || meta.release!==sources.release || meta.release!==book.release) issues.push('capture identity mismatch');
  if(!sources.quality?.ok) issues.push(...(sources.quality?.issues||['source quality missing']));
  if(!book.quality?.ok) issues.push(...(book.quality?.issues||['book quality missing']));
  if(!validation.ok) issues.push('full-depth REST/WS validation failed');
  if(!book.snapshots?.length || book.snapshots.some(s=>!s.ok || !snapshots.some(x=>x.label===s.label))) issues.push('snapshot files incomplete');
  if(new Set(tokens).size!==tokens.length) issues.push('duplicate token identity across events');
  const payoutByToken={};
  if(resolution?.schemaVersion===2 && resolution.runId===meta.runId && resolution.release===meta.release) {
    for(const m of resolution.markets||[]) {
      const expected=meta.markets.find(x=>x.conditionId===m.conditionId);
      if(expected && expected.tokens.every(t=>[0,1].includes(m.payouts?.[t.token])) && expected.tokens.reduce((s,t)=>s+m.payouts[t.token],0)===1) Object.assign(payoutByToken,m.payouts);
    }
  }
  const resolved=meta.markets.filter(m=>m.tokens.every(t=>t.token in payoutByToken)).length;
  const scenarios=[];
  // Explicit sensitivity assumptions, NOT observed execution probabilities.
  // The read RTT stays a diagnostic and is never promoted to order latency.
  for(const latencyMs of [0,250,500,1000,2000,5000]) for(const fillFraction of [1,0.5,0.25]) for(const maxPrice of [0.90,0.95,0.99]) {
    const s=simulatePortfolio(meta,signals,replay,{latencyMs,fillFraction,maxPrice,budget:800,orderType:'FAK'});
    s.valid=s.valid&&!issues.length;
    if(!s.valid) s.netIfCorrect=null;
    s.confirmedNet=s.valid&&resolved===meta.markets.length ? s.fills.reduce((sum,f)=>sum+f.shares*payoutByToken[f.token]-f.cost-f.fee,0) : null;
    scenarios.push(s);
  }
  // A FOK comparison demonstrates the effect of requiring full orders.
  for(const latencyMs of [250,1000,5000]) {
    const s=simulatePortfolio(meta,signals,replay,{latencyMs,fillFraction:0.5,maxPrice:0.99,budget:800,orderType:'FOK'});
    s.valid=s.valid&&!issues.length;if(!s.valid)s.netIfCorrect=null;
    s.confirmedNet=s.valid&&resolved===meta.markets.length ? s.fills.reduce((sum,f)=>sum+f.shares*payoutByToken[f.token]-f.cost-f.fee,0) : null;
    scenarios.push(s);
  }
  const offsets=replay.offsets.sort((a,b)=>a-b);
  const validScenarios=scenarios.filter(s=>s.valid).length;
  if(!validScenarios) issues.push('no scenario has complete decision/arrival data');
  return {schemaVersion:2,release:meta.release,runId:meta.runId,at:meta.at,createdAt:Date.now(),
    status:issues.length?'INVALID':validScenarios<scenarios.length?'PARTIAL_DATA':resolved===meta.markets.length?'RESOLVED_SIMULATION':'PENDING_RESOLUTION',
    quality:{ok:!issues.length,issues:[...new Set(issues)]},validation,signals,resolution:{resolved,total:meta.markets.length,errors:resolution?.errors||[]},
    coverage:{validScenarios,totalScenarios:scenarios.length},
    clock:{minReceiveMinusServerMs:offsets[0],medianReceiveMinusServerMs:offsets[Math.floor(offsets.length/2)],readRttMs:book.restRttMs,
      assumption:'Host and exchange clocks assumed aligned. Receive-server differences include network transit, not a measured clock offset. Latency sensitivity is not a measured execution SLA.'},
    assumptions:{budget:800,sharedAcrossEvents:true,fillFractions:[1,0.5,0.25],fees:'captured per-market Gamma rate; unknown excludes evaluation',
      settlement:'No cash reuse until resolution. ConfirmedNet is simulated PnL with confirmed payouts, never actual fills.',
      selection:'First validated numeric signal, received book at decision, fixed limit at hypothetical arrival. No future-winner/price selection.',
      limitations:['No submitted orders: fill fractions are scenarios, not calibrated probabilities.','Independent future books cannot fully model competitors reacting to our orders.','Fixed server, redemption and funding costs excluded.','Three or four releases test feasibility, not durable profitability.']},scenarios};
}
async function main() {
  const args=process.argv.slice(2), offline=args.includes('--offline'), positional=args.filter(a=>!a.startsWith('--'));
  const [id,requestedRun]=positional;
  if(!/^[a-z0-9_-]+$/.test(id||'') || requestedRun&&!/^[a-zA-Z0-9_-]+$/.test(requestedRun)) throw Error('usage: release_watch_report.js <id> [run-id] [--offline]');
  const root=path.join(process.env.RELEASE_WATCH_OUT||'/out',id);
  const latest=fs.existsSync(path.join(root,'latest'))?fs.readFileSync(path.join(root,'latest'),'utf8').trim():null;
  const run=requestedRun||latest;
  if(run&&!/^[a-zA-Z0-9_-]+$/.test(run))throw Error('invalid latest run');
  const dir=run?path.join(root,run):root;
  const meta=readJson(dir,'meta.json');if(!meta)throw Error('missing capture metadata');
  const sources=readJson(dir,'sources_summary.json',{sources:[]}), book=readJson(dir,'book_summary.json',{});
  const records=[];
  for(const line of fs.readFileSync(path.join(dir,'ws.jsonl'),'utf8').split('\n')) {
    if(!line)continue;
    try{records.push(JSON.parse(line));}catch{records.push({malformed:true});}
  }
  const snapshots=fs.readdirSync(dir).filter(f=>/^books_.*\.json$/.test(f)).map(f=>readJson(dir,f,{label:f,books:[]}));
  let resolution=readJson(dir,'resolution-v2.json');
  if(!offline){resolution=await resolvePayouts(meta);fs.writeFileSync(path.join(dir,'resolution-v2.json'),JSON.stringify(resolution,null,2));}
  const report=evaluate(meta,sources,book,records,snapshots,resolution);
  fs.writeFileSync(path.join(dir,'report-v2.json'),JSON.stringify(report,null,2));
  console.log(`${id} / ${run||'legacy'}: ${report.status}`);
  console.log(`Full book validation ${report.validation.fullSame}/${report.validation.checked}; best ask only ${report.validation.bestAskSame}/${report.validation.checked}`);
  for(const issue of report.quality.issues)console.log(`INVALID: ${issue}`);
  for(const s of report.signals)console.log(`Signal ${s.event}: ${s.metric}=${s.value}, K=+${((s.at-Date.parse(meta.at))/1000).toFixed(3)}s (${s.source})`);
  console.log('One shared $800 wallet including fees. Fill fractions and latency are assumptions. No orders submitted.');
  console.log('delay_ms fill_fraction max_price type spent fees net_if_signal_correct confirmed_simulated_net');
  for(const s of report.scenarios)console.log(`${s.latencyMs} ${s.fillFraction} ${s.maxPrice} ${s.orderType} ${dollars(s.spent)} ${dollars(s.fees)} ${dollars(s.netIfCorrect)} ${dollars(s.confirmedNet)}${s.valid?'':' INVALID'}`);
  return report.quality.ok?0:3;
}
if(require.main===module)main().then(code=>{process.exitCode=code;}).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={evaluate,confirmedResolution,resolvePayouts};
