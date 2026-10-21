import { describe, it, expect, beforeEach, vi } from 'vitest';

const { TRADER, activityFeed, depth } = vi.hoisted(() => ({
  TRADER: '0x507e52ef5d8a82e1d0ffa00b0d04d4f10b53a1b1', // arbitrary watchlist addr
  activityFeed: vi.fn(),
  depth: vi.fn(),
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
    LONGSHOT_FILTER_TRADER: '0x12d6cccfc7470a3f4bafc53599a4779cbf2cf2a8',
    LONGSHOT_FILTER_MAX_PRICE: 0.10,
    DYNAMIC_SIZING: false,
    MIN_TRADE_AMOUNT: 5,
    MAX_TRADE_AMOUNT: 25,
  },
}));

vi.mock('../src/bullpen', () => ({
  getTraderActivity: (...args: unknown[]) => activityFeed(...args),
  getOrderbookDepth: (...args: unknown[]) => depth(...args),
  getTraderPositionSize: vi.fn(async () => null),
  getMarketFeeRate: vi.fn(async () => null),
}));

import { pollTrader } from '../src/monitor';
import * as store from '../src/store';

let txSeq = 0;
const buy = (over: Record<string, unknown> = {}) => ({
  type: 'TRADE', side: 'BUY', price: 0.98,
  transaction_hash: '0xtx_' + (++txSeq), timestamp: new Date().toISOString(),
  slug: 'efx-quarterly-earnings-eps-10-20-2026-2pt23', title: 'EFX beat?', outcome: 'Yes', size: 10,
  ...over,
});
const poll = () => pollTrader({ address: TRADER }, { tradeAmount: 5 });

beforeEach(() => {
  store._setDbPathForTests(':memory:');
  activityFeed.mockReset();
  depth.mockReset();
});

describe('monitor: no sellers in the book', () => {
  it('skips a BUY when the ask side is empty (a real buy cannot fill)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    depth.mockResolvedValue({ bestAsk: 0, bestBid: 0.97, spread: 0, askDepth5: 0, askDepth10: 0, noAsks: true });
    activityFeed.mockResolvedValue([buy()]);
    expect(await poll()).toBe(0);
    expect(store.readStore().openTrades.length).toBe(0);
    expect(log.mock.calls.map(c => String(c[0])).join('\n')).toContain('no_asks: nobody is selling Yes (best bid $0.97)');
    log.mockRestore();
  });

  it('does not retry the skipped fill on the next poll', async () => {
    depth.mockResolvedValue({ bestAsk: 0, bestBid: 0.97, spread: 0, askDepth5: 0, askDepth10: 0, noAsks: true });
    const fill = buy();
    activityFeed.mockResolvedValue([fill]);
    await poll();
    depth.mockResolvedValue({ bestAsk: 0.98, bestBid: 0.97, spread: 0.01, askDepth5: 900, askDepth10: 900 });
    expect(await poll()).toBe(0);
    expect(store.readStore().openTrades.length).toBe(0);
  });

  it('does not invent a fill when the book cannot be read', async () => {
    depth.mockResolvedValue(null);
    activityFeed.mockResolvedValue([buy()]);
    expect(await poll()).toBe(0);
    expect(store.readStore().openTrades.length).toBe(0);
  });

  it('does not retry an unreadable-book signal at its stale price', async () => {
    depth.mockResolvedValue(null);
    activityFeed.mockResolvedValue([buy()]);
    await poll();
    depth.mockResolvedValue({ bestAsk: 0.98, bestBid: 0.97, spread: 0.01, askDepth5: 900, askDepth10: 900 });
    expect(await poll()).toBe(0);
    expect(store.readStore().openTrades).toHaveLength(0);
  });

  it('still copies when there are sellers and enough depth', async () => {
    depth.mockResolvedValue({ bestAsk: 0.98, bestBid: 0.97, spread: 0.01, askDepth5: 900, askDepth10: 900 });
    activityFeed.mockResolvedValue([buy()]);
    expect(await poll()).toBe(1);
  });
});
