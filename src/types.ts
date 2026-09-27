export interface ActivityTrade {
  id: string;
  timestamp: string;
  marketSlug: string;
  marketTitle: string;
  outcome: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;        // token amount
  usdcSize?: number;   // USD notional of the trader's own fill, when the API provides it
}

export interface WatchlistTrader {
  address: string;        // lowercase
  label?: string;         // optional user-set label
  addedAt: string;        // ISO timestamp
  copyEnabled: boolean;   // whether to simulate trades from this trader
  copyAmount: number;     // per-trader simulated trade size in USD (default 5)
  falconWinRate?: number; // 0–1 fraction
  falconRoi?: number;     // percentage (e.g. 18.6)
  falconSharpe?: number;
  // Set by the per-trader decay kill switch when it auto-disables copying.
  // Cleared when the operator manually re-enables via the dashboard.
  autoDisabledAt?: string;
  autoDisabledReason?: string;
}

export interface SimulatedTrade {
  id: string;
  sourceTradeId: string;
  timestamp: string;
  copiedTrader: string;
  copiedTraderRank: number;
  copiedTraderUsername?: string;
  // 'leaderboard' appears only on historical rows (leaderboard copying removed 2026-05-29).
  copiedTraderSource?: 'leaderboard' | 'watchlist' | 'observation';
  marketSlug: string;
  marketTitle: string;
  outcome: string;
  side: 'buy' | 'sell';
  entryPrice: number;
  simulatedAmount: number;
  simulatedShares: number;
  currentPrice?: number;
  unrealizedPnl?: number;
  status: 'open' | 'resolved' | 'expired';
  exitPrice?: number;
  realizedPnl?: number;
  closedAt?: string;
  holdingPeriodMs?: number;
  // Cost simulation (DRY_RUN realism for live-trading projections).
  // entryGasCost + entrySlippageCost are set at BUY creation; exitSlippageCost
  // and costAdjustedPnl are filled when the trade closes.
  entryGasCost?: number;
  entrySlippageCost?: number;
  exitSlippageCost?: number;
  costAdjustedPnl?: number;
  // Polymarket taker fee (2026-09-26): the market's fee rate captured at BUY
  // time (Gamma feeSchedule.rate, 0 when fees are disabled) and the fee on each
  // copy leg; both legs are included in costAdjustedPnl.
  feeRate?: number;
  entryFeeCost?: number;
  exitFeeCost?: number;
  // Research fields (GROUP D, 2026-06-10), set on watchlist BUYs at copy time:
  // sourceNotional = the trader's OWN bet size in USD (usdc_size, falling back
  // to price*size) — enables conviction-weighted sizing analysis;
  // entryPriceGap = best_ask - trader's fill price — measures what taker
  // execution would cost vs a maker limit at the trader's price.
  sourceNotional?: number;
  entryPriceGap?: number;
  // Set on copy-SELL closes (2026-06-11): fraction of the trader's OWN position
  // their SELL represents (soldTokens / (remaining + soldTokens) via the
  // data-api /positions snapshot at copy time). We always close 100% of ours,
  // so values < 1 quantify the partial-sell mismatch. Unset when the position
  // lookup failed or the close wasn't a copy-SELL (threshold/expiry/delist).
  sourceSellFraction?: number;
  // Copy timing (2026-09-27), set on watchlist BUYs: when the bot opened the
  // copy and which path delivered the trader's fill. copiedAt - timestamp is
  // the copy latency, including the depth and fee lookups before the entry.
  copiedAt?: string;
  copySource?: 'poll' | 'rtds';
  // Orderbook snapshot at fill time. Populated for watchlist BUYs via CLOB
  // /book; depthBackfilled=true if filled in after the fact from current state.
  bestAsk?: number;
  bestBid?: number;
  askDepth5?: number;
  askDepth10?: number;
  spreadAtEntry?: number;
  depthBackfilled?: boolean;
}

export interface TraderHistoryEntry {
  transaction_hash: string;
  timestamp: string;
  slug: string;
  title?: string;
  outcome?: string;
  side: string;    // 'BUY' | 'SELL'
  type: string;    // 'TRADE' | 'REDEEM' | ...
  price?: number;
  size?: number;
}

export interface TraderHistory {
  buys: TraderHistoryEntry[];
  sells: TraderHistoryEntry[];
  lastFetched: string;
  trades?: TraderHistoryEntry[];  // legacy — migrated to buys/sells on first read
}

export interface TradesStore {
  openTrades: SimulatedTrade[];
  closedTrades: SimulatedTrade[];
  processedTradeIds: string[];
  traderLastSeen: Record<string, string>;
  traderHistory: Record<string, TraderHistory>;  // accumulated raw activity per trader
  watchlistTraders: WatchlistTrader[];
  // Forward-test ledger for copy-disabled watchlist traders. Single table,
  // full open/close lifecycle in place (status open → resolved/expired).
  // Never copied live; excluded from wallet cap and all entry gates.
  //
  // IN-MEMORY: open rows ONLY. The closed tail (resolved/expired) grows
  // without bound and loading it all cost ~450MB of heap — the bot OOM-looped
  // on boot once it passed ~300k rows. Consumers that need closed rows must
  // aggregate them in SQL (store.observationStats) or stream them from SQLite
  // via store.iterateObservationTrades().
  observationOpenTrades: SimulatedTrade[];
}

export interface DashboardStats {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  winners: number;
  losers: number;
  winRate: number;
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  totalPnl: number;
  totalSimulatedAmount: number;
  lastUpdated: string;
  // Cost-adjusted figures (gas + entry/exit slippage subtracted) — projected
  // net PNL if the same signals were traded live.
  totalRealizedPnlAdjusted: number;
  totalUnrealizedPnlAdjusted: number;
  totalPnlAdjusted: number;
  totalTradingCosts: number;
}
