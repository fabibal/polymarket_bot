import { describe, it, expect, beforeEach, vi } from 'vitest';

const { TRADER, activityFeed } = vi.hoisted(() => ({
  TRADER: '0x2f633efb75256a2f2445110c8978684ab8936643',
  activityFeed: vi.fn(),
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
  getOrderbookDepth: vi.fn(async () => null),
  getTraderPositionSize: vi.fn(async () => null),
  getMarketFeeRate: vi.fn(async () => null),
}));

import { pollTrader, processRealtimeTrade } from '../src/monitor';
import { rtdsPayloadToActivity, countFeedMessage, getRtdsStatus, _resetFeedStatusForTests } from '../src/rtds';
import * as store from '../src/store';

let txSeq = 0;
function item(over: Record<string, unknown> = {}) {
  return {
    type: 'TRADE',
    side: 'BUY',
    price: 0.50,
    transaction_hash: '0xrt_' + (++txSeq),
    timestamp: new Date().toISOString(),
    slug: 'will-something-happen', // non-dated: cap is 2 per 12h, so a failed dedup would show as 2 copies
    title: 'Will something happen?',
    outcome: 'Yes',
    size: 10,
    ...over,
  };
}
const opts = { tradeAmount: 5 };

beforeEach(() => {
  store._setDbPathForTests(':memory:');
  activityFeed.mockReset();
});

describe('rtdsPayloadToActivity', () => {
  it('normalizes an RTDS payload exactly like the data-api poll (seconds -> ISO, TRADE type)', () => {
    const got = rtdsPayloadToActivity({
      proxyWallet: '0xABC', transactionHash: '0xhash', timestamp: 1790452532,
      slug: 's', title: 't', outcome: 'Up', side: 'BUY', price: 0.55, size: 2.22,
    });
    expect(got).toEqual({
      transaction_hash: '0xhash', timestamp: new Date(1790452532 * 1000).toISOString(),
      slug: 's', title: 't', outcome: 'Up', side: 'BUY', type: 'TRADE', price: 0.55, size: 2.22, usdc_size: undefined,
    });
  });

  it('rejects payloads without a wallet, tx hash or timestamp', () => {
    expect(rtdsPayloadToActivity({ transactionHash: '0x1', timestamp: 1 })).toBeNull();
    expect(rtdsPayloadToActivity({ proxyWallet: '0x1', timestamp: 1 })).toBeNull();
    expect(rtdsPayloadToActivity({ proxyWallet: '0x1', transactionHash: '0x1' })).toBeNull();
  });
});

describe('monitor: RTDS push path', () => {
  it('copies a pushed trade once; the later poll of the same tx is deduped', async () => {
    const t = item();
    expect(await processRealtimeTrade({ address: TRADER }, t, opts)).toBe(1);
    activityFeed.mockResolvedValue([t]);
    expect(await pollTrader({ address: TRADER }, opts)).toBe(0);
    expect(store.readStore().openTrades.length).toBe(1);
  });

  it('never moves the data-api cursor, so the poll still backfills a trade the socket missed', async () => {
    const pushed = item();
    const missed = item();
    await processRealtimeTrade({ address: TRADER }, pushed, opts);
    expect(store.readStore().traderLastSeen[TRADER]).toBeUndefined();
    activityFeed.mockResolvedValue([pushed, missed]); // newest-first like the API
    expect(await pollTrader({ address: TRADER }, opts)).toBe(1);
    expect(store.readStore().openTrades.length).toBe(2);
  });

  it('copies once when the push and a poll process the same tx concurrently', async () => {
    const t = item();
    activityFeed.mockResolvedValue([t]);
    const [a, b] = await Promise.all([
      processRealtimeTrade({ address: TRADER }, t, opts),
      pollTrader({ address: TRADER }, opts),
    ]);
    expect(a + b).toBe(1);
    expect(store.readStore().openTrades.length).toBe(1);
  });
});

describe('copy source', () => {
  it('records which path delivered the copy', async () => {
    await processRealtimeTrade({ address: TRADER }, item(), opts);
    activityFeed.mockResolvedValue([item()]);
    await pollTrader({ address: TRADER }, opts);
    const src = store.readStore().openTrades.map(t => t.copySource).sort();
    expect(src).toEqual(['poll', 'rtds']);
    expect(store.readStore().openTrades.every(t => typeof t.copiedAt === 'string')).toBe(true);
  });
});

describe('feed status', () => {
  it('msgs/sec is the mean over the last minute; older buckets drop out', () => {
    _resetFeedStatusForTests();
    const t0 = Date.parse('2026-09-27T00:00:00Z');
    for (let s = 0; s < 60; s++) for (let k = 0; k < 30; k++) countFeedMessage(t0 + s * 1000 + k);
    expect(getRtdsStatus(t0 + 59_500).msgsPerSec).toBeCloseTo(30, 10);
    // 30s later only the last 30 seconds of traffic are inside the window
    expect(getRtdsStatus(t0 + 89_500).msgsPerSec).toBeCloseTo(15, 10);
    expect(getRtdsStatus(t0 + 89_500).lastMessageAgoMs).toBe(89_500 - 59_029);
  });
});
