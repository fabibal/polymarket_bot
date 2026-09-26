import { describe, it, expect, beforeEach, vi } from 'vitest';

const { TRADER, activityFeed } = vi.hoisted(() => ({
  TRADER: '0x507e52ef5d8a82e1d0ffa00b0d04d4f10b53a1b1', // arbitrary watchlist addr
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
    MAX_WATCHLIST_ENTRY_WINDOW_MS: 43_200_000, // 12h
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
  getOrderbookDepth: vi.fn(async () => null), // depth gate bypassed
  getTraderPositionSize: vi.fn(async () => null), // sell-fraction lookup → not recorded
  getMarketFeeRate: vi.fn(async () => null), // fee config lookup → fallback rate
}));

import { pollTrader } from '../src/monitor';
import * as store from '../src/store';

const HOUR = 3_600_000;
const agoIso = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
let txSeq = 0;

function item(over: Record<string, unknown> = {}) {
  return {
    type: 'TRADE',
    side: 'BUY',
    price: 0.50,
    transaction_hash: '0xtx_' + (++txSeq),
    timestamp: agoIso(0),
    slug: 'fif-aaa-bbb-2026-06-10-draw', // match-style (ISO date in slug)
    title: 'AAA vs BBB Draw?',
    outcome: 'Yes',
    size: 10,
    ...over,
  };
}

async function poll() {
  return pollTrader(
    { address: TRADER },
    { tradeAmount: 5 },
  );
}

beforeEach(() => {
  store._setDbPathForTests(':memory:');
  activityFeed.mockReset();
});

describe('monitor: match-style lifetime entry cap (1 per slug)', () => {
  it('blocks a 2nd BUY on a match slug even when the 1st is outside the 12h window', async () => {
    // Feed is newest-first like the real API; monitor processes oldest-first.
    // 26h gap: the old rolling-window cap would have ALLOWED the re-entry.
    activityFeed.mockResolvedValue([
      item({ timestamp: agoIso(0) }),
      item({ timestamp: agoIso(26) }),
    ]);
    const n = await poll();
    expect(n).toBe(1); // only the first BUY copied
    expect(store.readStore().openTrades.length).toBe(1);
  });

  it('still blocks re-entry after the position was closed by a copy-SELL', async () => {
    // buy(26h ago) -> sell(2h ago) closes it -> buy(now) must NOT reopen.
    activityFeed.mockResolvedValue([
      item({ side: 'BUY',  timestamp: agoIso(0) }),
      item({ side: 'SELL', timestamp: agoIso(2), price: 0.60 }),
      item({ side: 'BUY',  timestamp: agoIso(26) }),
    ]);
    const n = await poll();
    expect(n).toBe(2); // first BUY + its SELL close
    const s = store.readStore();
    expect(s.openTrades.length).toBe(0);
    expect(s.closedTrades.length).toBe(1);
  });

  it('non-dated slugs keep the rolling-window behavior (re-entry allowed after window)', async () => {
    const slug = 'us-x-somewhere-peace-deal-by-june-30-2026';
    activityFeed.mockResolvedValue([
      item({ slug, timestamp: agoIso(0) }),
      item({ slug, timestamp: agoIso(26) }), // outside 12h window
    ]);
    const n = await poll();
    expect(n).toBe(2); // both copied — window cap does not see the 26h-old entry
    expect(store.readStore().openTrades.length).toBe(2);
  });

  it('non-dated slugs still enforce the in-window cap of 2', async () => {
    const slug = 'us-x-somewhere-peace-deal-by-june-30-2026';
    activityFeed.mockResolvedValue([
      item({ slug, timestamp: agoIso(1) }),
      item({ slug, timestamp: agoIso(2) }),
      item({ slug, timestamp: agoIso(3) }),
    ]);
    const n = await poll();
    expect(n).toBe(2); // third in-window BUY blocked
    expect(store.readStore().openTrades.length).toBe(2);
  });
});
