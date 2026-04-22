export interface LeaderboardTrader {
  rank: number;
  address: string;
  username?: string;
  weeklyPnl: number;
  totalVolume?: number;
  inactive?: boolean;   // true if no activity detected in last 30 days
  falconWinRate?: number;   // Falcon API win rate (0–1 fraction)
  falconRoi?: number;       // Falcon API ROI (percentage, e.g. 150 = 150%)
  falconSharpe?: number;    // Falcon API Sharpe ratio
  trackedSince?: string;    // ISO timestamp of when this trader first entered trackedTraders
}

export interface ActivityTrade {
  id: string;
  timestamp: string;
  marketSlug: string;
  marketTitle: string;
  outcome: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
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
}

export interface SimulatedTrade {
  id: string;
  sourceTradeId: string;
  timestamp: string;
  copiedTrader: string;
  copiedTraderRank: number;
  copiedTraderUsername?: string;
  copiedTraderSource?: 'leaderboard' | 'watchlist';
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

export interface LeaderboardFilters {
  categories: string[];  // empty = no filter; e.g. ['sports', 'crypto'] = match any
  minWinRate: number;    // 0–1 fraction (0 = disabled)
  minTrades: number;     // min trades in last 30d (0 = disabled)
  minSharpe: number;     // min Falcon Sharpe ratio (0 = disabled)
  minRoi: number;        // min Falcon ROI percentage (0 = disabled)
}

export interface LeaderboardStats {
  candidatesChecked: number;
  passedFilters: number;
  trackedCount: number;
  filters: LeaderboardFilters;
  updatedAt: string;
}

export interface TradesStore {
  trackedTraders: LeaderboardTrader[];
  excludedTraders: string[];           // wallet addresses excluded from polling
  autoExcludedTraders: string[];       // subset of excludedTraders added by auto-exclusion logic
  excludedCategories: string[];        // market categories excluded from BUY simulation
  leaderboardFilters: LeaderboardFilters;
  lastLeaderboardStats?: LeaderboardStats;
  openTrades: SimulatedTrade[];
  closedTrades: SimulatedTrade[];
  processedTradeIds: string[];
  traderLastSeen: Record<string, string>;
  traderLastOnLeaderboard: Record<string, string>; // when each address was last seen in top-50 candidates
  traderHistory: Record<string, TraderHistory>;  // accumulated raw activity per trader
  lastLeaderboardUpdate: string;
  watchlistTraders: WatchlistTrader[];
  traderFalconCache: Record<string, { winRate?: number; updatedAt: string }>;
  // Shadow tracking for excluded traders: observe without copying.
  shadowOpenTrades?: SimulatedTrade[];
  shadowClosedTrades?: SimulatedTrade[];
  processedShadowIds?: string[];
  shadowLastSeen?: Record<string, string>;
}

export interface ShadowTraderStats {
  address: string;
  username?: string;
  openCount: number;
  wins: number;
  losses: number;
  pnl: number;
  lastSeen?: string;
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
  trackedTraders: number;
  lastLeaderboardUpdate: string;
  lastUpdated: string;
  // Cost-adjusted figures (gas + entry/exit slippage subtracted) — projected
  // net PNL if the same signals were traded live.
  totalRealizedPnlAdjusted: number;
  totalUnrealizedPnlAdjusted: number;
  totalPnlAdjusted: number;
  totalTradingCosts: number;
}
