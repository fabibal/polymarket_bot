// Scheduled releases; UTC. Discovery sources never supply trading knowledge.
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

function releaseConfig(id) {
  const base = id && id.startsWith('test-') ? testRelease(id) : RELEASES[id];
  if (!base) throw new Error('unknown release id: ' + id);
  const rel = { ...DEFAULTS, ...base, sources: base.sources.map(s => ({ ...s, events: [] })), eventMetrics: {} };
  const date = rel.at && rel.at.slice(0, 10);
  const period = id.startsWith('cpi-') || id.startsWith('jobs-') ? {month:'October',year:2026} : {month:'September',year:2026};
  const assign = (event, metric) => { rel.eventMetrics[event] = metric; };
  if (id.startsWith('fomc-')) {
    assign(rel.events[0], 'fed_bps'); assign(rel.events[1], 'dissent');
    for (const s of rel.sources.filter(s => s.name.startsWith('fed-statement'))) s.parse = { parser:'fed', releaseDate:date };
  } else if (id.startsWith('gdp-pce-')) {
    assign(rel.events[0], 'gdp'); assign(rel.events[1], 'core_pce_mom'); assign(rel.events[2], 'core_pce_yoy');
    // Product pages/indexes may update before the actual figures are available.
    // Poll the dated PIO release directly; also follow the current GDP release
    // link from the product page (BEA's headline/URL format varies).
    rel.sources.push({name:'bea-pio-release',url:'https://www.bea.gov/news/2026/personal-income-and-outlays-september-2026',hotMs:600,marker:/Personal Income and Outlays, September 2026/,parse:{parser:'pce',...period,releaseDate:date}});
    rel.sources.push({name:'bea-pio-release-bust',url:'https://www.bea.gov/news/2026/personal-income-and-outlays-september-2026',bust:true,hotMs:600,marker:/Personal Income and Outlays, September 2026/,parse:{parser:'pce',...period,releaseDate:date}});
    rel.sources.push({name:'bea-gdp-release',url:'https://www.bea.gov/news/2026/gdp-advance-estimate-3rd-quarter-2026',bust:true,hotMs:600,marker:/3rd Quarter 2026/,parse:{parser:'gdp',quarter:3,year:2026,releaseDate:date}});
    for (const s of rel.sources.filter(s => s.name.startsWith('bea-gdp'))) {
      s.follow = 'gdp'; s.parse = {parser:'gdp',quarter:3,year:2026,releaseDate:date};
    }
  } else if (id.startsWith('jolts-')) {
    assign(rel.events[0], 'jolts');
    rel.sources.push({name:'bls-jolts-table',url:'https://www.bls.gov/news.release/jolts.t01.htm',hotMs:300,marker:/2026 M09 Results/,parse:{parser:'jolts',...period,releaseDate:date}});
  } else if (id.startsWith('jobs-')) {
    assign(rel.events[0], 'jobs'); assign(rel.events[1], 'unemployment');
    rel.sources[0].parse = {parser:'jobs',...period,releaseDate:date};
  } else if (id.startsWith('cpi-')) {
    ['cpi_yoy','cpi_mom','core_cpi_mom','core_cpi_yoy'].forEach((m,i)=>assign(rel.events[i],m));
    rel.sources[0].parse = {parser:'cpi',...period,releaseDate:date};
    rel.sources.push({name:'bls-cpi-archive',url:'https://www.bls.gov/news.release/archives/cpi_11102026.htm',hotMs:400,marker:/2026 M10 Results/,parse:{parser:'cpi',...period,releaseDate:date}});
  }
  for (const s of rel.sources) {
    const metrics = {fed:['fed_bps','dissent'],gdp:['gdp'],pce:['core_pce_mom','core_pce_yoy'],jolts:['jolts'],jobs:['jobs','unemployment'],cpi:['cpi_yoy','cpi_mom','core_cpi_mom','core_cpi_yoy']}[s.parse?.parser] || [];
    s.events = rel.events.filter(e => metrics.includes(rel.eventMetrics[e]));
  }
  return rel;
}
module.exports = { releaseConfig, RELEASES, DEFAULTS };
