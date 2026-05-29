export const CONFIG = {
  DRY_RUN: true,
  TRADE_AMOUNT: 5, // $5 per simulated trade
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10),
  PRICE_UPDATE_INTERVAL_MS: parseInt(process.env.PRICE_UPDATE_INTERVAL_MS ?? '300000', 10),
  ACTIVITY_LIMIT: 100,
  PORT: parseInt(process.env.PORT ?? '8080', 10),
  DATA_FILE: process.env.DATA_FILE ?? './data/trades.json',
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
  // Simulated wallet cap — when >0, stop opening new BUYs (both watchlist and leaderboard)
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
  // Falcon (Polymarket Analytics) API key — optional, enables Falcon leaderboard enrichment
  FALCON_API_KEY: process.env.FALCON_API_KEY ?? '',
};
