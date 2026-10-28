import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import zlib from 'zlib';
import { spawnSync } from 'child_process';
const { parseRelease, selectTokens } = require('../scripts/release_watch_parsers');
const { createReplay, validateSnapshots, signalsFromSources, simulatePortfolio } = require('../scripts/release_watch_model');
const { observeSource, getJson, runSources } = require('../scripts/release_watch');
const { releaseConfig } = require('../scripts/release_watch_config');
const { evaluate, confirmedResolution, summaryLine } = require('../scripts/release_watch_report');
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures/release-watch', name + '.html'), 'utf8');
const T = Date.parse('2026-10-29T12:30:00Z');
const specs: Record<string, any> = {
  cpi: { month: 'September', year: 2026, releaseDate: '2026-10-14' },
  jobs: { month: 'September', year: 2026, releaseDate: '2026-10-02' },
  jolts: { month: 'August', year: 2026, releaseDate: '2026-09-30' },
  pce: { month: 'August', year: 2026, releaseDate: '2026-09-30' },
  gdp: { quarter: 2, year: 2026, releaseDate: '2026-07-30' },
  fed: { releaseDate: '2026-09-16' },
};
const parse = (name: string, html = fixture(name), overrides = {}) => parseRelease(html, { parser: name, ...specs[name], ...overrides });

describe('release knowledge from official historical fixtures', () => {
  it.each([
    ['cpi', { cpi_mom: 0.6, cpi_yoy: 3.7, core_cpi_mom: 0.3, core_cpi_yoy: 2.6 }],
    ['jobs', { jobs: 29000, unemployment: 4.2 }],
    ['jolts', { jolts: 7079000 }],
    ['pce', { core_pce_mom: 0.2, core_pce_yoy: 3.0 }],
    ['gdp', { gdp: 1.5 }],
    ['fed', { fed_bps: 25, dissent: 0 }],
  ])('parses %s with correct units and precision', (name, values) => {
    const got = parse(name as string);
    expect(got.periodValid).toBe(true);
    expect(Object.fromEntries(Object.entries(got.values).map(([k, v]: any) => [k, v.value]))).toEqual(values);
  });
  it.each(['cpi', 'jobs', 'pce', 'gdp', 'fed'])('rejects %s with the wrong release date', name => {
    expect(parse(name, fixture(name), { releaseDate: '2026-11-10' }).values).toEqual({});
  });
  it.each(['cpi', 'jobs', 'jolts', 'pce'])('rejects %s with next-period text in a footer', name => {
    const html = fixture(name) + '<footer>October 2026; 2026 M10 Results; November 10, 2026</footer>';
    expect(parse(name, html, { month: 'October', releaseDate: '2026-11-10' }).values).toEqual({});
  });
  it('does not confuse a PCE headline, spending increase or previous-month value with core PCE', () => {
    const html = fixture('pce').replace(/Excluding food and energy/g, 'Unrelated statistic');
    expect(parse('pce', html).values).toEqual({});
  });
  it('retains the sign of declining CPI and payrolls', () => {
    expect(parse('cpi', fixture('cpi').replace('increased 0.6 percent', 'decreased 0.6 percent')).values.cpi_mom.value).toBe(-0.6);
    expect(parse('jobs', fixture('jobs').replace('(+29,000)', '(-29,000)')).values.jobs.value).toBe(-29000);
  });
  it('does not guess dissent from names when the numeric vote is absent', () => {
    const html = fixture('fed').replace('12 – 0 vote', 'an unspecified vote');
    expect(parse('fed', html).values.dissent).toBeUndefined();
  });
  it('treats feeds and the generic BEA index as discovery only', () => {
    const cfg = releaseConfig('gdp-pce-2026-10-29');
    expect(cfg.sources.find((s: any) => s.name === 'bea-releases-bust').events).toEqual([]);
    expect(parseRelease(fixture('pce'), null).values).toEqual({});
  });
  it('does not credit an unrelated page change or marker before verified numeric knowledge', () => {
    const state: any = { polls: 0, errors: 0, events: ['pce'], firstValidated: {}, conflicts: [], baseline: { h: 'old' } };
    const rel = { eventMetrics: { pce: 'core_pce_mom' } };
    observeSource(state, { t0: T - 4100, t1: T - 4000, parsedAt: T - 4000, st: 200, h: 'new', mk: false, parsed: { periodValid: false, values: {} } }, rel, T);
    expect(state.firstChange).toBeTruthy();
    expect(state.firstValidated).toEqual({});
    const parsed = { periodValid: true, values: { core_pce_mom: { value: 0.3 } } };
    observeSource(state, { t0: T+1000, t1: T+1900, parsedAt: T+2000, st: 200, h: 'release', mk: true, parsed }, rel, T);
    expect(state.firstValidated.pce.at).toBe(T+2000);
  });
});

const market = (event: string, token: string, groupItemTitle = '0.3%') => ({ event, slug: event, conditionId: event, question: event,
  groupItemTitle, description: 'Exact value, higher range bracket at boundaries.', tick: 0.01, feeRate: 0.05, minOrderSize: 5,
  acceptingOrders: true, closed: false, tokens: [{ token, outcome: 'Yes' }, { token: token+'n', outcome: 'No' }] });
function data() {
  const markets = [market('gdp','a'),market('pce','b')];
  const meta = { schemaVersion:2, release:'test', runId:'run1', at:new Date(T).toISOString(), events:['gdp','pce'], eventMetrics:{gdp:'gdp',pce:'core_pce_mom'}, markets };
  const full = (token:string, size='1600', price='0.5', at=T-1000) => ({ r:at+10, epoch:1, d:JSON.stringify({event_type:'book',asset_id:token,timestamp:String(at),bids:[{price:'0.4',size:'10'}],asks:[{price,size}]}) });
  const records: any[] = [{type:'open',r:T-2000,epoch:1}, ...['a','an','b','bn'].map(t=>full(t)),{r:T+10000,d:'PONG'}];
  const signals = [{event:'gdp',at:T,metric:'gdp',value:0.3,tokens:['a']},{event:'pce',at:T,metric:'core_pce_mom',value:0.3,tokens:['b']}];
  const sources = { schemaVersion:2, release:'test',runId:'run1',quality:{ok:true},sources:signals.map(s=>({name:s.event,firstValidated:{[s.event]:s}})) };
  const snapshots=[{label:'p1',books:['a','an','b','bn'].map(t=>({asset_id:t,timestamp:String(T+1000),bids:[{price:'0.4',size:'10'}],asks:[{price:'0.5',size:'1600'}]}))}];
  const book={schemaVersion:2,release:'test',runId:'run1',quality:{ok:true},snapshots:[{label:'p1',ok:true}]};
  return {meta, records, signals, sources, snapshots, book, full};
}

describe('book integrity and hypothetical execution', () => {
  it('rejects the old best-price-only false positive when size or deeper levels differ', () => {
    const d=data();d.snapshots[0].books[0].asks[0].size='1';d.snapshots[0].books[2].asks[0].size='1';
    const v=validateSnapshots(createReplay(d.records),d.snapshots,['a','an','b','bn']);
    expect(v.bestAskSame).toBe(4);expect(v.fullSame).toBe(2);expect(v.ok).toBe(false);
    const r=evaluate(d.meta,d.sources,d.book,d.records,d.snapshots,null);
    expect(r.status).toBe('INVALID');expect(r.scenarios.every((s:any)=>s.netIfCorrect===null&&s.confirmedNet===null)).toBe(true);
  });
  it('excludes one disagreeing market instead of blanking the whole run', () => {
    const clean=data(), d=data();d.snapshots[0].books[0].asks[0].size='1';
    const v=validateSnapshots(createReplay(d.records),d.snapshots,['a','an','b','bn']);
    expect(v.fullSame).toBe(3);expect(v.ok).toBe(false);
    const r=evaluate(d.meta,d.sources,d.book,d.records,d.snapshots,null);
    expect(r.status).not.toBe('INVALID');expect(r.quality.ok).toBe(true);
    expect(r.quality.warnings).toHaveLength(1);expect(r.validation.excludedTokens.sort()).toEqual(['a','an']);
    const ok=r.scenarios.filter((s:any)=>s.valid);expect(ok.length).toBeGreaterThan(0);
    expect(ok.every((s:any)=>s.fills.every((f:any)=>!['a','an'].includes(f.token)))).toBe(true);
    // Without the exclusion the same capture does buy the excluded token.
    const base=evaluate(clean.meta,clean.sources,clean.book,clean.records,clean.snapshots,null);
    expect(base.scenarios.some((s:any)=>s.fills.some((f:any)=>f.token==='a'))).toBe(true);
    expect(summaryLine(r)).toMatch(/book check 3\/4 \(2 tokens excluded\)/);
  });
  it('still invalidates when the REST snapshot is missing a token', () => {
    const d=data();d.snapshots[0].books=d.snapshots[0].books.filter((b:any)=>b.asset_id!=='b');
    const r=evaluate(d.meta,d.sources,d.book,d.records,d.snapshots,null);
    expect(r.status).toBe('INVALID');expect(r.quality.issues).toContain('full-depth REST/WS validation failed');
  });
  it('cannot report an empty REST and missing WS book as a successful empty-book match', () => {
    const d=data();d.snapshots[0].books[0].asks=[];
    expect(validateSnapshots(createReplay([]),d.snapshots,['a','an','b','bn']).ok).toBe(false);
  });
  it('validates unchanged books whose last-change timestamp predates subscription', () => {
    const d=data();
    for(const b of d.snapshots[0].books)b.timestamp=String(T-50000);
    (d.snapshots[0] as any).chunks=[{t0:T+500,t1:T+700,ok:true,tokenIds:['a','an','b','bn']}];
    const v=validateSnapshots(createReplay(d.records),d.snapshots,['a','an','b','bn']);
    expect(v.fullSame).toBe(4);expect(v.ok).toBe(true);
  });
  it('invalidates a disconnected book and waits for a new complete snapshot for each token', () => {
    const d=data();d.records.push({r:T+100,type:'close',epoch:1},{r:T+200,type:'open',epoch:2});
    const r=createReplay(d.records);
    expect(r.at(T+150).healthy).toBe(false);expect(r.at(T+250).books.size).toBe(0);
    const s=simulatePortfolio(d.meta,d.signals,r,{latencyMs:500,fillFraction:1});
    expect(s.valid).toBe(false);expect(s.netIfCorrect).toBeNull();
  });
  it('invalidates a silently dead connection even when its last book looked profitable', () => {
    const d=data();expect(createReplay(d.records).at(T+31000).healthy).toBe(false);
  });
  it('shares the $800 budget between simultaneous events and includes all fees', () => {
    const d=data(), s=simulatePortfolio(d.meta,d.signals,createReplay(d.records),{latencyMs:250,fillFraction:1});
    expect(s.valid).toBe(true);expect(s.spent).toBeLessThanOrEqual(800.000001);expect(s.fees).toBeGreaterThan(0);
    expect(s.netIfCorrect).toBeLessThan(800);expect(s.spent+s.unspent).toBeCloseTo(800,6);
  });
  it('allocates to cheaper levels across markets before expensive depth in the first market', () => {
    const d=data();
    d.meta.markets.forEach(m=>m.feeRate=0);
    d.records=d.records.filter(r=>!r.d?.includes('"asset_id":"a"'));
    const a=d.full('a','100','0.5');const payload=JSON.parse(a.d);payload.asks.push({price:'0.9',size:'1000'});a.d=JSON.stringify(payload);d.records.push(a);
    const s=simulatePortfolio(d.meta,d.signals,createReplay(d.records),{latencyMs:250,fillFraction:1});
    expect(s.fills.some((f:any)=>f.price===0.9)).toBe(false);
    expect(s.spent).toBeCloseTo(800,5);
  });
  it('does not buy a cheap token that only appeared after the decision', () => {
    const d=data();d.records=d.records.filter(r=>!r.d?.includes('"asset_id":"a"'));
    d.records.push(d.full('a','100','0.5',T+100));
    const s=simulatePortfolio(d.meta,[d.signals[0]],createReplay(d.records),{latencyMs:500,fillFraction:1});
    expect(s.fills).toHaveLength(0);expect(s.valid).toBe(false);
  });
  it('honors the chosen price limit when competing orders remove the cheap offers', () => {
    const d=data();d.records.push(d.full('a','1600','0.99',T+100),d.full('b','1600','0.99',T+100));
    const s=simulatePortfolio(d.meta,d.signals,createReplay(d.records),{latencyMs:500,fillFraction:1});
    expect(s.valid).toBe(true);expect(s.fills).toHaveLength(0);expect(s.spent).toBe(0);
  });
  it('models FAK partial fills and FOK cancellation without inventing missing quantity', () => {
    const d=data(), r=createReplay(d.records);
    const fak=simulatePortfolio(d.meta,d.signals,r,{latencyMs:250,fillFraction:0.25,orderType:'FAK'});
    const fok=simulatePortfolio(d.meta,d.signals,r,{latencyMs:250,fillFraction:0.25,orderType:'FOK'});
    expect(fak.spent).toBeGreaterThan(0);expect(fak.spent).toBeLessThan(800);
    expect(fok.spent).toBe(0);
  });
  it('does not use uncertain or absent fee metadata as a zero fee', () => {
    const d=data();(d.meta.markets[0] as any).feeRate=null;
    expect(simulatePortfolio(d.meta,d.signals,createReplay(d.records),{latencyMs:0,fillFraction:1}).valid).toBe(false);
  });
  it('honors the minimum order size', () => {
    const d=data();d.meta.markets.forEach(m=>m.minOrderSize=2000);
    expect(simulatePortfolio(d.meta,d.signals,createReplay(d.records),{latencyMs:0,fillFraction:1}).spent).toBe(0);
  });
  it('chooses from parsed values and books, not hindsight winners; a wrong signal loses money', () => {
    const d=data();
    const resolution={schemaVersion:2,release:'test',runId:'run1',markets:d.meta.markets.map(m=>({conditionId:m.conditionId,payouts:{[m.tokens[0].token]:0,[m.tokens[1].token]:1}}))};
    const r=evaluate(d.meta,d.sources,d.book,d.records,d.snapshots,resolution);
    expect(r.status).toBe('RESOLVED_SIMULATION');
    expect(r.scenarios[0].confirmedNet).toBeLessThan(0);
    expect(r.scenarios[0].fills[0].token).toBe('a');
  });
  it('never equates 0.99/0.01 quotes or closed-only status with a resolved payout', () => {
    expect(confirmedResolution({closed:true,outcomePrices:'["1","0"]',clobTokenIds:'["a","an"]'})).toBeNull();
    expect(confirmedResolution({closed:true,umaResolutionStatus:'resolved',outcomePrices:'["0.99","0.01"]',clobTokenIds:'["a","an"]'})).toBeNull();
    expect(confirmedResolution({closed:true,umaResolutionStatus:'resolved',outcomePrices:'["1","0"]',clobTokenIds:'["a","an"]'})).toEqual({a:1,an:0});
  });
  it('runs the offline CLI against a separate run directory without overwriting the legacy report', () => {
    const d=data(), root=fs.mkdtempSync(path.join(os.tmpdir(),'release-watch-report-'));
    const dir=path.join(root,'test','run1');fs.mkdirSync(dir,{recursive:true});
    try {
      const files:any={'meta.json':d.meta,'sources_summary.json':d.sources,'book_summary.json':d.book,'books_p1.json':d.snapshots[0]};
      for(const [name,body] of Object.entries(files))fs.writeFileSync(path.join(dir,name),JSON.stringify(body));
      fs.writeFileSync(path.join(root,'test','latest'),'run1\n');
      fs.writeFileSync(path.join(dir,'ws.jsonl'),d.records.map(r=>JSON.stringify(r)).join('\n'));
      fs.writeFileSync(path.join(dir,'report.json'),'legacy sentinel');
      const proc=spawnSync(process.execPath,[path.resolve('scripts/release_watch_report.js'),'test','--offline'],{env:{...process.env,RELEASE_WATCH_OUT:root},encoding:'utf8'});
      expect(proc.status,proc.stderr).toBe(0);
      const report=JSON.parse(fs.readFileSync(path.join(dir,'report-v2.json'),'utf8'));
      expect(report.status).toBe('PENDING_RESOLUTION');
      expect(report.scenarios.every((s:any)=>s.confirmedNet===null)).toBe(true);
      expect(fs.readFileSync(path.join(dir,'report.json'),'utf8')).toBe('legacy sentinel');
    } finally { fs.rmSync(root,{recursive:true,force:true}); }
  });
  it('does not fabricate K from an old hash-only capture', () => {
    const d=data();d.sources.sources=[{name:'index',firstChange:{t1:T-4000}}] as any;
    expect(signalsFromSources(d.meta,d.sources).signals).toHaveLength(0);
  });
  it('throws after repeated rate limits instead of silently producing undefined', async () => {
    const fetcher=vi.fn(async()=>({ok:false,status:429}));
    await expect(getJson('https://example.invalid',{},1,fetcher)).rejects.toThrow('429');
  });
});

describe('source capture end to end on a local HTTP fixture', () => {
  it('persists the exact numeric evidence and uses parsed time after the release', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'release-watch-source-'));
    let target=Infinity;
    const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(Date.now()>=target?fixture('cpi'):'<html>old unrelated page</html>');});
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    try {
      const address=server.address() as any;target=Date.now()+100;
      const rel={at:new Date(target).toISOString(),events:['cpi'],eventMetrics:{cpi:'core_cpi_mom'},hot:[-1,1],end:0.3,
        sources:[{name:'local',url:`http://127.0.0.1:${address.port}`,hotMs:20,events:['cpi'],parse:{parser:'cpi',...specs.cpi},marker:/SEPTEMBER 2026/}]};
      expect(await runSources('test','run',rel,target,dir)).toBe(0);
      const summary=JSON.parse(fs.readFileSync(path.join(dir,'sources_summary.json'),'utf8'));
      const first=summary.sources[0].firstValidated.cpi;
      expect(first.value).toBe(0.3);expect(first.at).toBeGreaterThanOrEqual(target);
      expect(zlib.gunzipSync(fs.readFileSync(path.join(dir,first.bodyFile))).toString()).toBe(fixture('cpi'));
      expect(summary.quality.ok).toBe(true);
    } finally { server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(dir,{recursive:true,force:true}); }
  });
});

describe('market rules', () => {
  it('resolves exact boundaries to the higher bracket when specified in the rules', () => {
    const markets=[market('jobs','a','-25k to 0'),market('jobs','b','0 to 25k')];
    expect(selectTokens(markets,'jobs',0)).toEqual(['an','b']);
    expect(selectTokens(markets,'jobs',-1)).toEqual(['a','bn']);
  });
  it('rejects overlapping/ambiguous brackets and unknown labels', () => {
    expect(()=>selectTokens([market('pce','a','0.3%'),market('pce','b','0.3%')],'core_pce_mom',0.3)).toThrow();
    expect(()=>selectTokens([market('pce','a','other')],'core_pce_mom',0.3)).toThrow();
  });
});
