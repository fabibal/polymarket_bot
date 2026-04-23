export const CONFIG = {
  DRY_RUN: true,
  TRADE_AMOUNT: 5, // $5 per simulated trade
  LEADERBOARD_LIMIT: 10,
  LEADERBOARD_REFRESH_MS: parseInt(process.env.LEADERBOARD_REFRESH_MS ?? '300000', 10),
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10),
  PRICE_UPDATE_INTERVAL_MS: parseInt(process.env.PRICE_UPDATE_INTERVAL_MS ?? '300000', 10),
  ACTIVITY_LIMIT: 10,
  PORT: parseInt(process.env.PORT ?? '8080', 10),
  DATA_FILE: process.env.DATA_FILE ?? './data/trades.json',
  DB_FILE: process.env.DB_FILE ?? './data/store.db',
  // If price crosses this threshold treat the market as resolved
  RESOLVED_THRESHOLD: 0.93,
  // Auto-close positions older than this many days at current price (status: expired)
  MAX_HOLD_DAYS: 7,
  // Max open positions per market slug — prevents accumulating copies of the same market
  MAX_POSITIONS_PER_MARKET: parseInt(process.env.MAX_POSITIONS_PER_MARKET ?? '5', 10),
  // Sports/esports-specific cap — tighter limit to prevent single-trader sports domination
  MAX_POSITIONS_PER_MARKET_SPORTS: parseInt(process.env.MAX_POSITIONS_PER_MARKET_SPORTS ?? '1', 10),
  // Auto-exclusion: exclude traders whose 7-day win rate drops below this (0 = disabled)
  AUTO_EXCLUDE_WIN_RATE_THRESHOLD: parseFloat(process.env.AUTO_EXCLUDE_WIN_RATE_THRESHOLD ?? '0'),
  AUTO_EXCLUDE_MIN_TRADES: 3, // minimum closed trades in 7d window before auto-exclusion triggers
  // Trade entry filters
  MIN_PRICE: parseFloat(process.env.MIN_PRICE ?? '0.05'),
  MAX_PRICE: parseFloat(process.env.MAX_PRICE ?? '0.95'),
  MAX_SPREAD: parseFloat(process.env.MAX_SPREAD ?? '0.05'),
  // Categories force-excluded at startup (merged into store.excludedCategories on load).
  // Historical data: esports had 74% raw win rate but -$0.43/trade cost-adjusted.
  FORCE_EXCLUDE_CATEGORIES: (process.env.FORCE_EXCLUDE_CATEGORIES ?? 'esports')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // Sports-specific minimum entry price — higher threshold to avoid copying underdog sports bets.
  // At <0.60 entry prices, sports trades historically have <43% win rate and deeply negative EV.
  MIN_PRICE_SPORTS: parseFloat(process.env.MIN_PRICE_SPORTS ?? '0.60'),
  // Global cap on open positions — new BUYs are skipped when this limit is reached
  MAX_TOTAL_OPEN_POSITIONS: parseInt(process.env.MAX_TOTAL_OPEN_POSITIONS ?? '500', 10),
  // Minimum closed-trade sample size before a leaderboard trader's signals are copied.
  // Watchlist traders bypass this gate.
  MIN_TRADER_SAMPLE: parseInt(process.env.MIN_TRADER_SAMPLE ?? '5', 10),
  // Cost-simulation constants — used to project live-trading PNL from DRY_RUN trades.
  // Polymarket charges NO fees on sports markets (only 15-min crypto). Gas on Polygon is negligible.
  // 2% slippage each side (entry at ask, exit at bid) still applies.
  GAS_COST_PER_BUY: parseFloat(process.env.GAS_COST_PER_BUY ?? '0'),
  SLIPPAGE_RATE:    parseFloat(process.env.SLIPPAGE_RATE    ?? '0.02'),
  // Falcon (Polymarket Analytics) API key — optional, enables Falcon leaderboard enrichment
  FALCON_API_KEY: process.env.FALCON_API_KEY ?? '',
};
