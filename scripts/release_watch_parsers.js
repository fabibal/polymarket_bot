// Deterministic release readers. Unknown wording/period/precision is NO SIGNAL.
// These produce research signals only; they never sign or submit an order.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const VERSION = 'release-parser-v2';
function text(html) {
  return html.replace(/<!--[^]*?-->|<script\b[^]*?<\/script>|<style\b[^]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;|\u00a0/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&ndash;|&mdash;|[–—−]/g, '-').replace(/\s+/g, ' ').trim();
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const num = s => Number(s.replace(/,/g, ''));
const dateText = iso => { const [y, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
function cells(row, tag) { return [...row.matchAll(new RegExp(`<${tag}\\b([^>]*)>([^]*?)<\\/${tag}>`, 'gi'))].map(m => ({ attrs: m[1], text: text(m[2]) })); }
function attr(attrs, name) { return attrs.match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'))?.[1]; }

function parseRelease(html, spec) {
  const out = { parserVersion: VERSION, periodValid: false, values: {}, errors: [] };
  if (!spec || !spec.parser) return out; // feeds / indexes are discovery only
  const all = text(html), month = spec.month, year = spec.year;
  const add = (key, value, evidence, low, high) => {
    if (!Number.isFinite(value) || value < low || value > high) return;
    if (out.values[key] && out.values[key].value !== value) { delete out.values[key]; out.errors.push(`conflicting ${key}`); return; }
    if (!out.errors.includes(`conflicting ${key}`)) out.values[key] = { value, evidence, unit: key === 'jobs' || key === 'jolts' ? 'people' : key === 'dissent' ? 'votes' : key === 'fed_bps' ? 'bps' : 'percent' };
  };
  const change = (s, key, low = -50, high = 100) => {
    const m = s.match(/\b(increased|rose|advanced|decreased|declined|fell)\s+(?:by\s+)?(-?\d+(?:\.\d+)?)\s+percent\b/i);
    if (m) add(key, (/decreased|declined|fell/i.test(m[1]) ? -1 : 1) * num(m[2]), s, low, high);
    else if (/\b(?:was|were|remained) unchanged\b/i.test(s)) add(key, 0, s, low, high);
  };
  if (['cpi', 'jobs'].includes(spec.parser)) {
    const pre = html.match(/<pre\b[^>]*>([^]*?)<\/pre>/i)?.[1];
    if (!pre) { out.errors.push('missing release body'); return out; }
    const body = text(pre);
    const heading = `${spec.parser === 'cpi' ? 'CONSUMER PRICE INDEX' : 'THE EMPLOYMENT SITUATION'} - ${month} ${year}`;
    const pos = body.toLowerCase().indexOf(heading.toLowerCase());
    if (pos < 0 || !body.slice(0, pos).includes(dateText(spec.releaseDate))) return out;
    out.periodValid = true;
    const content = body.slice(pos + heading.length);
    if (spec.parser === 'cpi') {
      const sentences = content.match(/[^]*?(?:\.(?=\s+[A-Z(])|$)/g) || [];
      for (const s of sentences) {
        if (new RegExp(`Consumer Price Index for All Urban Consumers[^]*?in ${month}\\b`, 'i').test(s)) change(s, 'cpi_mom');
        if (/Over the last 12 months, the all items index/i.test(s)) change(s, 'cpi_yoy');
        if (new RegExp(`(?:The index for|The) all items less food and energy(?: index)?[^]*?in ${month}\\b`, 'i').test(s) && !/over the year|12 months/i.test(s)) change(s, 'core_cpi_mom');
        if (/The all items less food and energy index[^]*?(?:over the year|12 months)/i.test(s)) change(s, 'core_cpi_yoy');
      }
    } else {
      // Only the first paragraph: excludes revisions and other population groups.
      const intro = content.split('This news release presents')[0];
      const p = intro.match(/nonfarm payroll employment[^]*?\(([+-]?[\d,]+)\)/i)
        || intro.match(/nonfarm payroll employment\s+(increased|rose|decreased|declined|fell)\s+(?:by\s+)?([\d,]+)/i);
      if (p) add('jobs', p.length === 2 ? num(p[1]) : num(p[2]) * (/decreased|declined|fell/i.test(p[1]) ? -1 : 1), p[0], -10_000_000, 10_000_000);
      const u = intro.match(/unemployment rate[^]*?(\d+\.\d) percent/i);
      if (u) add('unemployment', num(u[1]), u[0], 0, 100);
    }
  } else if (spec.parser === 'jolts') {
    // Table 1, SA levels in thousands. Never use the rounded headline in millions.
    if (!new RegExp(`${year} M${String(MONTHS.indexOf(month) + 1).padStart(2, '0')} Results`).test(all)) return out;
    const table = [...html.matchAll(/<table\b[^>]*>([^]*?)<\/table>/gi)].map(m => m[1]).find(t => /Table 1\. Job openings levels and rates[^]*?seasonally adjusted/i.test(text(t)));
    if (!table) return out;
    const hs = cells(table, 'th');
    const level = hs.find(h => h.text === 'Levels (in thousands)');
    const levelId = level && attr(level.attrs, 'id');
    const header = hs.filter(h => levelId && attr(h.attrs, 'headers') === levelId && new RegExp(`^${esc(month.slice(0, 3))}[^ ]* ${year}(?:\\(|$)`, 'i').test(h.text.replace(/ \(/g, '(')));
    if (header.length !== 1) return out;
    const headerId = attr(header[0].attrs, 'id');
    const row = [...table.matchAll(/<tr\b[^>]*>([^]*?)<\/tr>/gi)].map(m => m[1]).find(r => cells(r, 'th').some(c => c.text === 'Total'));
    const value = row && cells(row, 'td').find(c => (attr(c.attrs, 'headers') || '').split(' ').includes(headerId));
    if (value && /^[\d,]+$/.test(value.text)) { out.periodValid = true; add('jolts', num(value.text) * 1000, `${header[0].text}: ${value.text} thousand, SA total`, 0, 100_000_000); }
  } else if (spec.parser === 'pce') {
    const heading = [...html.matchAll(/<h1\b[^>]*>([^]*?)<\/h1>/gi)].map(m => text(m[1]));
    if (!heading.includes(`Personal Income and Outlays, ${month} ${year}`) || !all.includes(dateText(spec.releaseDate))) return out;
    out.periodValid = true;
    const paragraphs = [...html.matchAll(/<p\b[^>]*>([^]*?)<\/p>/gi)].map(m => text(m[1]));
    for (const p of paragraphs) {
      const core = p.match(/Excluding food and energy, the PCE price index[^]*$/i)?.[0];
      if (!core) continue;
      if (/From the preceding month/i.test(p)) change(core, 'core_pce_mom');
      if (/From the same month one year ago/i.test(p)) change(core, 'core_pce_yoy');
    }
  } else if (spec.parser === 'gdp') {
    // A product-page link mentioning the next release is insufficient. Require
    // the current advance-estimate narrative and its explicitly named quarter.
    const m = all.match(new RegExp(`Real gross domestic product[^]*?(increased|decreased) at an annual rate of (-?\\d+(?:\\.\\d+)?) percent in the (?:${spec.quarter === 3 ? 'third' : spec.quarter === 2 ? 'second' : spec.quarter === 1 ? 'first' : 'fourth'} quarter)(?: of)? ${year}[^]*?(?:advance|initial) estimate`, 'i'));
    if (m && all.includes(dateText(spec.releaseDate))) { out.periodValid = true; add('gdp', num(m[2]) * (/decreased/i.test(m[1]) ? -1 : 1), m[0], -100, 100); }
  } else if (spec.parser === 'fed') {
    // Require the statement's own date, not the link to next month's meeting.
    const date = html.match(/<time\b[^>]*>([^]*?)<\/time>/i)?.[1]
      || html.match(/<p\b[^>]*class=["']article__time["'][^>]*>([^]*?)<\/p>/i)?.[1];
    if (text(date || '') !== dateText(spec.releaseDate)) return out;
    const decision = all.match(/The Committee decided to[^]*?target range for the federal funds rate[^]*?(?:percent|unchanged)[^.]*\./i)?.[0];
    if (!decision) return out;
    out.periodValid = true;
    if (/\bmaintain\b/i.test(decision)) add('fed_bps', 0, decision, -1000, 1000);
    else {
      const m = decision.match(/\b(raise|increase|lower|reduce)\b[^]*?\bby\s+(?:(\d+)\s*[- ]\s*)?(\d+)\/(\d+) percentage point/i);
      const d = decision.match(/\b(raise|increase|lower|reduce)\b[^]*?\bby\s+(\d+(?:\.\d+)?) percentage point/i);
      if (m) add('fed_bps', ((Number(m[2]) || 0) + Number(m[3]) / Number(m[4])) * 100 * (/lower|reduce/i.test(m[1]) ? -1 : 1), decision, -1000, 1000);
      else if (d) add('fed_bps', Number(d[2]) * 100 * (/lower|reduce/i.test(d[1]) ? -1 : 1), decision, -1000, 1000);
    }
    // The current statement format explicitly gives the vote. Do not guess a
    // count from names, commas or dissents about other policy instruments.
    const vote = all.match(/approved the following statement for release by a (\d+)\s*-\s*(\d+) vote/i);
    if (vote && Number(vote[1]) + Number(vote[2]) <= 12 && Number(vote[1]) > 0) add('dissent', Number(vote[2]), vote[0], 0, 12);
  }
  return out;
}

function bracket(market, metric) {
  let s = text(market.groupItemTitle || '').replace(/\s+/g, ' ').trim();
  if (!s) throw new Error('missing bracket label');
  if (metric === 'fed_bps') {
    if (!/upper bound[^]*?nearest 25/i.test(market.description || '')) throw new Error('unreviewed Fed rounding rule');
    if (/^No change$/i.test(s)) return v => v === 0;
    const m = s.match(/^(\d+)(\+)? bps (decrease|increase)$/i);
    if (!m) throw new Error('unsupported Fed bracket');
    return v => { const rounded = Math.sign(v) * Math.ceil(Math.abs(v) / 25) * 25; return (m[3] === 'decrease' ? rounded < 0 : rounded > 0) && (m[2] ? Math.abs(rounded) >= Number(m[1]) : Math.abs(rounded) === Number(m[1])); };
  }
  s = s.replace(/%/g, '').replace(/≤/g, '<=').replace(/≥/g, '>=');
  const amount = x => { const m = x.trim().match(/^(-?\d+(?:\.\d+)?)([kM])?$/); if (!m) throw new Error('invalid bracket number'); return Number(m[1]) * (m[2] === 'k' ? 1000 : m[2] === 'M' ? 1_000_000 : 1); };
  const range = s.match(/^(-?\d+(?:\.\d+)?[kM]?)\s*(?:to|-)\s*(-?\d+(?:\.\d+)?[kM]?)$/);
  if (range) {
    if (!/higher range bracket/i.test(market.description || '')) throw new Error('unreviewed range boundary');
    const lo = amount(range[1]), hi = amount(range[2]);
    if (!(hi > lo)) throw new Error('invalid range');
    return v => v >= lo && v < hi;
  }
  const bound = s.match(/^(<=|>=|<|>)?(-?\d+(?:\.\d+)?[kM]?)(\+)?$/);
  if (!bound || (bound[1] && bound[3])) throw new Error('unsupported bracket');
  const n = amount(bound[2]), op = bound[3] ? '>=' : bound[1] || '=';
  return v => op === '<=' ? v <= n : op === '>=' ? v >= n : op === '<' ? v < n : op === '>' ? v > n : Math.abs(v - n) < 1e-8;
}

function selectTokens(markets, metric, value) {
  if (!Number.isFinite(value) || !markets.length) throw new Error('no verified value/markets');
  const matches = markets.map(m => bracket(m, metric)(value));
  if (matches.filter(Boolean).length !== 1) throw new Error('brackets do not identify exactly one YES');
  return markets.map((m, i) => {
    const token = m.tokens.find(t => t.outcome.toLowerCase() === (matches[i] ? 'yes' : 'no'));
    if (!token) throw new Error('missing outcome token');
    return token.token;
  });
}
module.exports = { parseRelease, selectTokens, bracket, text, VERSION };
