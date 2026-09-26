import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted so the vi.mock factories below (which are hoisted to top-of-file) can
// reference them without a "cannot access before initialization" error.
const { LONGSHOT_TRADER, OTHER_TRADER, activityFeed } = vi.hoisted(() => ({
  LONGSHOT_TRADER: '0x12d6cccfc7470a3f4bafc53599a4779cbf2cf2a8',
  OTHER_TRADER:    '0x8a6c6811e8937f9e8afc1b9249fa540262c30b3f',
  activityFeed:    vi.fn(),
}));

vi.mock('../src/config', () => ({
  CONFIG: {
    DB_FILE: ':memory:',
    TRADE_AMOUNT: 5,
    ACTIVITY_LIMIT: 100,
    GAS_COST_PER_BUY: 0,
    SLIPPAGE_RATE: 0.02,
    MAX_WATCHLIST_ENTRIES_PER_MARKET: 2,
    MAX_WATCHLIST_ENTRY_WINDOW_MS: 43_200_000,
    SIMULATED_WALLET_SIZE: 0,
    WALLET_CAP_UTILIZATION: 0.80,
    DEPTH_GATE_MIN_DEPTH_5: 500,
    LONGSHOT_FILTER_TRADER: LONGSHOT_TRADER,
    LONGSHOT_FILTER_MAX_PRICE: 0.10,
  },
}));

// Mock the Bullpen network layer: getTraderActivity returns a scripted feed,
// getOrderbookDepth returns null (depth gate bypassed) so non-longshot copies open.
vi.mock('../src/bullpen', () => ({
  getTraderActivity: (...args: unknown[]) => activityFeed(...args),
  getOrderbookDepth: vi.fn(async () => null),
  getTraderPositionSize: vi.fn(async () => null), // sell-fraction lookup → not recorded
  getMarketFeeRate: vi.fn(async () => null), // fee config lookup → fallback rate
}));

import { pollTrader } from '../src/monitor';
import * as store from '../src/store';

const recent = () => new Date(Date.now() - 60_000).toISOString();

function buy(over: Record<string, unknown> = {}) {
  return {
    type: 'TRADE',
    side: 'BUY',
    price: 0.05,
    transaction_hash: '0xtx_' + Math.random().toString(16).slice(2),
    timestamp: recent(),
    slug: 'some-geopolitics-market',
    title: 'Some Geopolitics Market?',
    outcome: 'Yes',
    size: 100,
    ...over,
  };
}

beforeEach(() => {
  store._setDbPathForTests(':memory:');
  activityFeed.mockReset();
});

describe('store: skipped_trades record layer', () => {
  it('addSkippedTrade persists and getSkippedTradeStats aggregates by reason', () => {
    store.addSkippedTrade({
      sourceTradeId: 'src1', timestamp: recent(), copiedTrader: LONGSHOT_TRADER,
      marketSlug: 'm1', marketTitle: 'M1?', outcome: 'Yes',
      entryPrice: 0.05, simulatedAmount: 5, simulatedShares: 100,
      skipReason: 'longshot_filter_0x12d6',
    });
    store.addSkippedTrade({
      sourceTradeId: 'src2', timestamp: recent(), copiedTrader: LONGSHOT_TRADER,
      marketSlug: 'm2', marketTitle: 'M2?', outcome: 'No',
      entryPrice: 0.08, simulatedAmount: 5, simulatedShares: 62.5,
      skipReason: 'longshot_filter_0x12d6',
    });

    const scoped = store.getSkippedTradeStats('longshot_filter_0x12d6');
    expect(scoped.count).toBe(2);
    expect(scoped.notional).toBe(10);

    const other = store.getSkippedTradeStats('some_other_reason');
    expect(other.count).toBe(0);
    expect(other.notional).toBe(0);
  });
});

describe('monitor: per-trader longshot carve-out (0x12d6)', () => {
  it('skips a <$0.10 BUY from 0x12d6, records it, and opens no position', async () => {
    activityFeed.mockResolvedValue([buy({ price: 0.05 })]);

    const n = await pollTrader(
      { address: LONGSHOT_TRADER },
      { tradeAmount: 5 },
    );

    expect(n).toBe(0); // no simulated trade created
    expect(store.readStore().openTrades.length).toBe(0);

    const skipped = store.getSkippedTradeStats('longshot_filter_0x12d6');
    expect(skipped.count).toBe(1);
    expect(skipped.notional).toBe(5);
  });

  it('copies a >=$0.10 BUY from 0x12d6 normally (threshold boundary)', async () => {
    activityFeed.mockResolvedValue([buy({ price: 0.50 })]);

    const n = await pollTrader(
      { address: LONGSHOT_TRADER },
      { tradeAmount: 5 },
    );

    expect(n).toBe(1);
    expect(store.readStore().openTrades.length).toBe(1);
    expect(store.getSkippedTradeStats('longshot_filter_0x12d6').count).toBe(0);
  });

  it('does NOT filter a <$0.10 BUY from a different trader (per-trader scope)', async () => {
    activityFeed.mockResolvedValue([buy({ price: 0.05 })]);

    const n = await pollTrader(
      { address: OTHER_TRADER },
      { tradeAmount: 5 },
    );

    expect(n).toBe(1);
    expect(store.readStore().openTrades.length).toBe(1);
    expect(store.getSkippedTradeStats('longshot_filter_0x12d6').count).toBe(0);
  });
});
