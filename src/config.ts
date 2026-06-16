/**
 * Risk-threshold resolution (FIX 3, 2026-06-10): explicit absolute env var wins;
 * otherwise derive from a %-of-wallet env var (so thresholds scale with
 * SIMULATED_WALLET_SIZE and stay sane if DYNAMIC_SIZING multiplies trade sizes);
 * if the wallet simulation is disabled (size 0), fall back to a fixed absolute.
 * Returns a negative dollar threshold.
 */
export function resolveRiskThreshold(
  absRaw: string | undefined,
  pctRaw: string | undefined,
  walletSize: number,
  defaultPct: number,
  defaultAbs: number,
): number {
  if (absRaw != null && absRaw !== '' && Number.isFinite(parseFloat(absRaw))) return parseFloat(absRaw);
  if (walletSize > 0) {
    const pct = pctRaw != null && pctRaw !== '' && Number.isFinite(parseFloat(pctRaw))
      ? parseFloat(pctRaw) : defaultPct;
    return -(pct / 100) * walletSize;
  }
  return defaultAbs;
}

const WALLET_SIZE = parseFloat(process.env.SIMULATED_WALLET_SIZE ?? '0');

// Daily-loss circuit breaker kill value: DAILY_LOSS_CIRCUIT_BREAKER=off (or
// false/disabled/none) disables the breaker entirely — no trip, no pause, the
// meta key is ignored. INTENTIONALLY DISABLED 2026-06-11: a single bad day
// doesn't predict future performance; the per-trader decay kill switches cover
// the real risk. Re-enable by setting the env var to a number (absolute $) or
// removing it (falls back to DAILY_LOSS_CIRCUIT_BREAKER_PCT of wallet).
const BREAKER_RAW = (process.env.DAILY_LOSS_CIRCUIT_BREAKER ?? '').trim().toLowerCase();
const BREAKER_DISABLED = ['off', 'false', 'disabled', 'none'].includes(BREAKER_RAW);

export const CONFIG = {
  DRY_RUN: true,
  TRADE_AMOUNT: 5, // $5 per simulated trade
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10),
  PRICE_UPDATE_INTERVAL_MS: parseInt(process.env.PRICE_UPDATE_INTERVAL_MS ?? '300000', 10),
  ACTIVITY_LIMIT: 100,
  PORT: parseInt(process.env.PORT ?? '8080', 10),
  DB_FILE: process.env.DB_FILE ?? './data/store.db',
  // If price crosses this threshold treat the market as resolved
  RESOLVED_THRESHOLD: 0.93,
  // Auto-close positions older than this many days at current price (status: expired)
  MAX_HOLD_DAYS: 7,
  // Per-market entry cap within a rolling window — counts both open and closed
  // watchlist entries on the slug, so rapid BUY-SELL-BUY cycles on fast
  // sports/tennis markets can't stack 3-4 entries on the same losing market.
  MAX_WATCHLIST_ENTRIES_PER_MARKET: parseInt(process.env.MAX_WATCHLIST_ENTRIES_PER_MARKET ?? '2', 10),
  MAX_WATCHLIST_ENTRY_WINDOW_MS: parseInt(process.env.MAX_WATCHLIST_ENTRY_WINDOW_MS ?? '43200000', 10),
  // Entry filters removed 2026-05-29 (watchlist-only): MIN_PRICE, MAX_PRICE, MAX_SPREAD,
  // MIN_PRICE_SPORTS, FORCE_EXCLUDE_CATEGORIES, MAX_POSITIONS_PER_MARKET[_SPORTS],
  // MAX_TOTAL_OPEN_POSITIONS, MIN_TRADER_SAMPLE, MIN_TRADER_SHADOW_SAMPLE. Watchlist
  // trades bypass all of them by design — see CLAUDE.md "Key rules".
  // Cost-simulation constants — used to project live-trading PNL from DRY_RUN trades.
  // Polymarket charges NO fees on sports markets (only 15-min crypto). Gas on Polygon is negligible.
  // 2% slippage each side (entry at ask, exit at bid) still applies.
  GAS_COST_PER_BUY: parseFloat(process.env.GAS_COST_PER_BUY ?? '0'),
  SLIPPAGE_RATE:    parseFloat(process.env.SLIPPAGE_RATE    ?? '0.02'),
  // Simulated wallet cap — when >0, stop opening new BUYs
  // once sum(simulatedAmount) on open trades reaches SIMULATED_WALLET_SIZE * WALLET_CAP_UTILIZATION.
  // 0 disables the check. Buffer keeps headroom for slippage/price drift in a real wallet.
  SIMULATED_WALLET_SIZE: parseFloat(process.env.SIMULATED_WALLET_SIZE ?? '0'),
  WALLET_CAP_UTILIZATION: parseFloat(process.env.WALLET_CAP_UTILIZATION ?? '0.80'),
  // Watchlist-only depth gate: skip BUY when CLOB ask_depth_5 (USD available within
  // 5% of best ask) is below this floor. Added 2026-05-27 — protects against thin
  // books where a $5-15 copy would itself move the market, and improves statistical
  // validity of the watchlist edge by removing low-liquidity tail trades. Non-blocking
  // on depth-fetch failure (copy proceeds when orderbook unavailable).
  DEPTH_GATE_MIN_DEPTH_5: parseFloat(process.env.DEPTH_GATE_MIN_DEPTH_5 ?? '500'),
  // Per-trader longshot carve-out (added 2026-06-09) — a NARROW exception to the
  // "watchlist bypasses all filters" rule, scoped to ONE trader. When a BUY comes
  // from LONGSHOT_FILTER_TRADER at entry price < LONGSHOT_FILTER_MAX_PRICE, skip the
  // copy and record it in skipped_trades (record-only, for monitoring). See CLAUDE.md.
  LONGSHOT_FILTER_TRADER: (process.env.LONGSHOT_FILTER_TRADER ?? '0x12d6cccfc7470a3f4bafc53599a4779cbf2cf2a8').toLowerCase(),
  LONGSHOT_FILTER_MAX_PRICE: parseFloat(process.env.LONGSHOT_FILTER_MAX_PRICE ?? '0.10'),
  // Dynamic position sizing (added 2026-06-10, OFF by default — flip manually when
  // ready to test): instead of a flat per-trader copyAmount, size each watchlist BUY
  // as 1% of CLOB ask_depth_5, clamped to [MIN_TRADE_AMOUNT, MAX_TRADE_AMOUNT].
  // Falls back to the per-trader copyAmount when depth is unavailable.
  DYNAMIC_SIZING: (process.env.DYNAMIC_SIZING ?? 'false').toLowerCase() === 'true',
  MIN_TRADE_AMOUNT: parseFloat(process.env.MIN_TRADE_AMOUNT ?? '5'),
  MAX_TRADE_AMOUNT: parseFloat(process.env.MAX_TRADE_AMOUNT ?? '25'),
  // Per-trader kill switch (added 2026-06-10): when a copy-enabled watchlist trader's
  // rolling 30d cost-adjusted net PnL drops below the threshold, copying is
  // auto-disabled (the trader keeps accruing observation forward-test data) and a
  // Telegram alert fires. (The 7d window was removed 2026-06-15 — too tight for
  // sports traders, false-tripped on a single bad weekend during a seasonal trough.)
  // Threshold: absolute env var wins; otherwise % of SIMULATED_WALLET_SIZE
  // (TRADER_DECAY_THRESHOLD_PCT_30D=5).
  TRADER_DECAY_THRESHOLD_30D: resolveRiskThreshold(
    process.env.TRADER_DECAY_THRESHOLD_30D, process.env.TRADER_DECAY_THRESHOLD_PCT_30D,
    WALLET_SIZE, 5, -50),
  // Account-wide circuit breaker (added 2026-06-10): when total cost-adjusted realized
  // PnL over the last 24h drops below this, ALL copying pauses for 24h (cursors still
  // advance; missed trades are NOT copied late on resume). Auto-resumes after 24h;
  // manual reset via dashboard POST /api/breaker/reset. Threshold: absolute env var
  // wins; otherwise DAILY_LOSS_CIRCUIT_BREAKER_PCT=3 % of SIMULATED_WALLET_SIZE.
  DAILY_LOSS_BREAKER_ENABLED: !BREAKER_DISABLED,
  DAILY_LOSS_CIRCUIT_BREAKER: resolveRiskThreshold(
    BREAKER_DISABLED ? undefined : process.env.DAILY_LOSS_CIRCUIT_BREAKER,
    process.env.DAILY_LOSS_CIRCUIT_BREAKER_PCT,
    WALLET_SIZE, 3, -30),
  // Falcon (Polymarket Analytics) API key — optional, used by the weekly macro-scan Falcon enrichment
  POLYMARKET_ANALYTICS_API_KEY: process.env.POLYMARKET_ANALYTICS_API_KEY ?? '',
};
