// Ad-hoc: entry_price_gap analysis since 2026-06-10. Not in git pipeline.
const Database = require('better-sqlite3');
const db = new Database(__dirname + '/../data/store.db', { readonly: true });

const SINCE = '2026-06-10';
const SLIP = 0.02;

// Pull from both open and closed (gap is recorded at BUY time on both).
const rows = db.prepare(`
  SELECT id, timestamp, copied_trader, entry_price, simulated_shares, simulated_amount,
         best_ask, best_bid, spread_at_entry, entry_price_gap, realized_pnl,
         entry_slippage_cost, exit_slippage_cost, entry_gas_cost, cost_adjusted_pnl,
         status, 'closed' AS src
  FROM closed_trades WHERE timestamp >= ?
  UNION ALL
  SELECT id, timestamp, copied_trader, entry_price, simulated_shares, simulated_amount,
         best_ask, best_bid, spread_at_entry, entry_price_gap, NULL, NULL, NULL,
         entry_gas_cost, NULL, status, 'open' AS src
  FROM open_trades WHERE timestamp >= ?
`).all(SINCE, SINCE);

const withGap = rows.filter(r => r.entry_price_gap != null);
const total = rows.length;

function pctile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.floor((s.length - 1) * p);
  return s[i];
}
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

const gaps = withGap.map(r => r.entry_price_gap);
const spreads = withGap.map(r => r.spread_at_entry).filter(x => x != null);

// distribution buckets on |gap| (gap can be negative if trader paid above ask)
const buckets = { '<0 (above ask)': 0, '0-0.01': 0, '0.01-0.03': 0, '0.03-0.05': 0, '0.05+': 0 };
for (const g of gaps) {
  if (g < 0) buckets['<0 (above ask)']++;
  else if (g < 0.01) buckets['0-0.01']++;
  else if (g < 0.03) buckets['0.01-0.03']++;
  else if (g < 0.05) buckets['0.03-0.05']++;
  else buckets['0.05+']++;
}

// fill rate: gap <= spread (limit at trader price sits inside book)
const withBoth = withGap.filter(r => r.spread_at_entry != null);
const fillable = withBoth.filter(r => r.entry_price_gap <= r.spread_at_entry);

// closed-only for PnL sim
const closed = withGap.filter(r => r.src === 'closed' && r.realized_pnl != null);
const sumRealized = closed.reduce((s, r) => s + r.realized_pnl, 0);
const sumEntrySlip = closed.reduce((s, r) => s + (r.entry_slippage_cost ?? 0), 0);
const sumExitSlip = closed.reduce((s, r) => s + (r.exit_slippage_cost ?? 0), 0);
const sumGas = closed.reduce((s, r) => s + (r.entry_gas_cost ?? 0), 0);
const sumCostAdj = closed.reduce((s, r) => s + (r.cost_adjusted_pnl ?? 0), 0);

// Counterfactual A: pay trader price exactly => drop entry slippage entirely.
const pnlTraderPrice = sumCostAdj + sumEntrySlip;
// Counterfactual B: pay REAL ask (gap*shares) instead of flat 2% model.
const sumRealAskCost = closed.reduce((s, r) => s + Math.max(0, r.entry_price_gap) * r.simulated_shares, 0);
const pnlRealAsk = sumCostAdj + sumEntrySlip - sumRealAskCost;

const out = {
  date_range: { since: SINCE, max_ts: rows.reduce((m, r) => r.timestamp > m ? r.timestamp : m, '') },
  counts: { total_rows: total, with_gap: withGap.length, closed_with_gap: closed.length,
            open_with_gap: withGap.length - closed.length },
  gap: { mean: mean(gaps), median: pctile(gaps, 0.5), p25: pctile(gaps, 0.25),
         p75: pctile(gaps, 0.75), min: Math.min(...gaps), max: Math.max(...gaps) },
  gap_distribution_pct: Object.fromEntries(
    Object.entries(buckets).map(([k, v]) => [k, +(100 * v / gaps.length).toFixed(1)])),
  spread: { mean: mean(spreads), median: pctile(spreads, 0.5), n: spreads.length },
  fill_rate: { n_with_both: withBoth.length, fillable: fillable.length,
               pct: +(100 * fillable.length / withBoth.length).toFixed(1) },
  pnl_sim_closed: {
    n: closed.length,
    realized_pnl: +sumRealized.toFixed(2),
    cost_adjusted_pnl_current: +sumCostAdj.toFixed(2),
    entry_slippage_total: +sumEntrySlip.toFixed(2),
    exit_slippage_total: +sumExitSlip.toFixed(2),
    pnl_if_paid_trader_price: +pnlTraderPrice.toFixed(2),
    real_ask_entry_cost_total: +sumRealAskCost.toFixed(2),
    pnl_if_paid_real_ask: +pnlRealAsk.toFixed(2),
  },
};
console.log(JSON.stringify(out, null, 2));
