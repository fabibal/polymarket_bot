// Ad-hoc full trader review. Not in git pipeline. Run via node:20-alpine.
const Database = require('better-sqlite3');
const db = new Database(__dirname + '/../data/store.db', { readonly: true });

const NOW = Date.now();
const DAY = 86_400_000;
const SLIP = 0.02, GAS = 0;          // CONFIG defaults
const KILL = -50;                     // TRADER_DECAY_THRESHOLD_30D (5% of $1000)

// faithful replica of tradeCostAdjustedPnl for CLOSED rows
const cadj = r => {
  const sh = r.simulated_shares;
  const gas = r.entry_gas_cost ?? GAS;
  const eS = r.entry_slippage_cost ?? SLIP * r.entry_price * sh;
  const xS = r.exit_slippage_cost ?? SLIP * (r.exit_price ?? 0) * sh;
  return (r.realized_pnl ?? 0) - gas - eS - xS;
};

const wl = db.prepare(`SELECT address, label, copy_enabled, copy_amount, added_at,
  falcon_win_rate, falcon_roi, falcon_sharpe FROM watchlist_traders`).all();

// closedRows: settled positions (have realized_pnl/closed_at). openRows: live.
function compute(closedRows, openRows) {
  const all = [...closedRows, ...openRows];
  const inWin = (r, d) => {
    if (!r.closed_at) return false;
    const ts = new Date(r.closed_at).getTime();
    return !isNaN(ts) && ts >= NOW - d * DAY && ts <= NOW;
  };
  const net = d => closedRows.filter(r => inWin(r, d)).reduce((s, r) => s + cadj(r), 0);
  const net30 = net(30), net7 = net(7);

  const wins = closedRows.filter(r => (r.realized_pnl ?? 0) > 0);
  const losses = closedRows.filter(r => (r.realized_pnl ?? 0) < 0);
  const grossWin = wins.reduce((s, r) => s + r.realized_pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r.realized_pnl, 0));

  const ts = all.map(r => new Date(r.timestamp).getTime()).filter(x => !isNaN(x)).sort((a, b) => a - b);
  const spanDays = ts.length > 1 ? (ts[ts.length - 1] - ts[0]) / DAY : 0;
  const distinct = new Set(all.map(r => r.market_slug + '|' + r.outcome)).size;
  const recent = [...new Set(all.filter(r => new Date(r.timestamp).getTime() >= NOW - 7 * DAY)
    .map(r => r.market_title))].slice(0, 12);
  const openDistinct = [...new Set(openRows.map(r => r.market_title))];

  return {
    n_closed: closedRows.length, n_open: openRows.length, n_total_legs: all.length,
    distinct_slug_outcome: distinct,
    first_seen: ts.length ? new Date(ts[0]).toISOString().slice(0, 10) : null,
    last_seen: ts.length ? new Date(ts[ts.length - 1]).toISOString().slice(0, 10) : null,
    active_span_days: +spanDays.toFixed(1),
    win_rate_pct: closedRows.length ? +(100 * wins.length / closedRows.length).toFixed(1) : null,
    profit_factor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 'Inf' : null),
    realized_net_all: +closedRows.reduce((s, r) => s + (r.realized_pnl ?? 0), 0).toFixed(2),
    cost_adj_net_all: +closedRows.reduce((s, r) => s + cadj(r), 0).toFixed(2),
    net7d_cadj: +net7.toFixed(2), net30d_cadj: +net30.toFixed(2),
    dist_to_killswitch: +(net30 - KILL).toFixed(2),
    recent_markets_7d: recent,
    open_count: openRows.length, open_distinct_markets: openDistinct.length,
    open_sample: openDistinct.slice(0, 6),
  };
}

const qClosed = db.prepare(`SELECT * FROM closed_trades WHERE copied_trader=?`);
const qOpen = db.prepare(`SELECT * FROM open_trades WHERE copied_trader=?`);
const qObs = db.prepare(`SELECT * FROM observation_trades WHERE copied_trader=?`);

const out = { now: new Date(NOW).toISOString(), kill_threshold_30d: KILL, traders: [] };
for (const t of wl) {
  const obsAll = qObs.all(t.address);
  out.traders.push({
    label: t.label, address: t.address,
    copy_enabled: !!t.copy_enabled, copy_amount: t.copy_amount, added_at: t.added_at,
    falcon: { wr: t.falcon_win_rate, roi: t.falcon_roi, sharpe: t.falcon_sharpe },
    copy_ledger: compute(qClosed.all(t.address), qOpen.all(t.address)),
    obs_ledger: compute(obsAll.filter(r => r.status !== 'open'), obsAll.filter(r => r.status === 'open')),
  });
}
console.log(JSON.stringify(out, null, 2));
