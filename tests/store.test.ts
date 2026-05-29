import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/config', () => ({
  CONFIG: {
    DATA_FILE: ':memory:',
    DB_FILE: ':memory:',
    FORCE_EXCLUDE_CATEGORIES: ['esports'],
    GAS_COST_PER_BUY: 0,
    SLIPPAGE_RATE: 0.02,
  },
}));

import * as store from '../src/store';
import { SimulatedTrade } from '../src/types';

function makeTrade(over: Partial<SimulatedTrade> = {}): SimulatedTrade {
  return {
    id: 't1',
    sourceTradeId: 'src1',
    timestamp: '2026-04-22T10:00:00.000Z',
    copiedTrader: '0xabc',
    copiedTraderRank: 1,
    marketSlug: 'foo-market',
    marketTitle: 'Foo?',
    outcome: 'Yes',
    side: 'buy',
    entryPrice: 0.70,
    simulatedAmount: 5,
    simulatedShares: 5 / 0.70,
    status: 'open',
    ...over,
  };
}

beforeEach(() => {
  store._setDbPathForTests(':memory:');
});

describe('store: fresh DB bootstrap', () => {
  it('seeds 5 watchlist defaults when empty', () => {
    const s = store.readStore();
    expect(s.watchlistTraders.length).toBe(5);
    expect(s.watchlistTraders.map(w => w.address)).toContain('0x8a6c6811e8937f9e8afc1b9249fa540262c30b3f');
    expect(s.watchlistTraders.find(w => w.label === 'DrPufferfish')?.copyEnabled).toBe(false);
  });

  it('seeds default leaderboardFilters', () => {
    const s = store.readStore();
    expect(s.leaderboardFilters.categories).toEqual([]);
    expect(s.leaderboardFilters.minWinRate).toBe(0);
  });

  it('does not re-seed watchlist after it has rows', () => {
    const s1 = store.readStore();
    store.setWatchlistCopyEnabled(s1.watchlistTraders[0].address, false);
    store._resetStoreCache();
    const s2 = store.readStore();
    expect(s2.watchlistTraders.length).toBe(5);
    expect(s2.watchlistTraders.find(w => w.address === s1.watchlistTraders[0].address)?.copyEnabled).toBe(false);
  });
});

describe('store: FIFO close ordering', () => {
  it('closeOpenTrade removes the oldest matching open trade first', () => {
    const older = makeTrade({ id: 't-old', sourceTradeId: 'src-old', timestamp: '2026-04-22T10:00:00.000Z', entryPrice: 0.70, simulatedShares: 5 / 0.70 });
    const newer = makeTrade({ id: 't-new', sourceTradeId: 'src-new', timestamp: '2026-04-22T11:00:00.000Z', entryPrice: 0.75, simulatedShares: 5 / 0.75 });
    store.addOpenTrade(older);
    store.addOpenTrade(newer);
    expect(store.readStore().openTrades.length).toBe(2);

    const closed = store.closeOpenTrade('0xabc', 'foo-market', 'Yes', 0.80);
    expect(closed).toBe(true);

    const s = store.readStore();
    expect(s.openTrades.length).toBe(1);
    expect(s.openTrades[0].id).toBe('t-new');
    expect(s.closedTrades.length).toBe(1);
    expect(s.closedTrades[0].id).toBe('t-old');
    expect(s.closedTrades[0].exitPrice).toBe(0.80);
    expect(s.closedTrades[0].realizedPnl).toBeCloseTo((0.80 - 0.70) * (5 / 0.70), 10);
  });

  it('FIFO ordering survives reload from disk via snapshot round-trip', () => {
    store.addOpenTrade(makeTrade({ id: 't-a', sourceTradeId: 'src-a', timestamp: '2026-04-22T09:00:00.000Z' }));
    store.addOpenTrade(makeTrade({ id: 't-b', sourceTradeId: 'src-b', timestamp: '2026-04-22T10:00:00.000Z' }));
    store._resetStoreCache();
    const s = store.readStore();
    expect(s.openTrades.map(t => t.id)).toEqual(['t-a', 't-b']);
  });
});

describe('store: processed-id dedup and cap', () => {
  it('markProcessed is idempotent', () => {
    store.markProcessed('x1');
    store.markProcessed('x1');
    expect(store.readStore().processedTradeIds.filter(i => i === 'x1').length).toBe(1);
  });
});

describe('store: watchlist CRUD persists through reload', () => {
  it('add/update/remove survive cache drop', () => {
    store.addWatchlistTrader('0xDEADBEEF000000000000000000000000000DEAD1', 'TestGuy');
    store.setWatchlistCopyAmount('0xdeadbeef000000000000000000000000000dead1', 12.5);
    store.setWatchlistCopyEnabled('0xdeadbeef000000000000000000000000000dead1', false);
    store._resetStoreCache();
    const s = store.readStore();
    const w = s.watchlistTraders.find(x => x.address === '0xdeadbeef000000000000000000000000000dead1');
    expect(w).toBeDefined();
    expect(w?.copyAmount).toBe(12.5);
    expect(w?.copyEnabled).toBe(false);

    store.removeWatchlistTrader('0xdeadbeef000000000000000000000000000dead1');
    store._resetStoreCache();
    const s2 = store.readStore();
    expect(s2.watchlistTraders.find(x => x.address === '0xdeadbeef000000000000000000000000000dead1')).toBeUndefined();
  });
});

describe('store: writeStore full-snapshot round-trip', () => {
  it('in-memory mutations via snapshot are persisted by writeStore', () => {
    const s = store.readStore();
    s.openTrades.push(makeTrade({ id: 'ws1', sourceTradeId: 'ws1src' }));
    s.excludedCategories.push('testcat');
    s.traderFalconCache['0xfoo'] = { winRate: 0.66, updatedAt: '2026-04-22T12:00:00.000Z' };
    store.writeStore(s);

    store._resetStoreCache();
    const reloaded = store.readStore();
    expect(reloaded.openTrades.find(t => t.id === 'ws1')).toBeDefined();
    expect(reloaded.excludedCategories).toContain('testcat');
    expect(reloaded.traderFalconCache['0xfoo']?.winRate).toBe(0.66);
  });
});

describe('store: trader history append + cap', () => {
  it('dedupes by transaction_hash and respects side split', () => {
    store.appendTraderHistory('0xhist', [
      { transaction_hash: 'h1', timestamp: '2026-04-20T00:00:00Z', slug: 'm', side: 'BUY',  type: 'TRADE' },
      { transaction_hash: 'h1', timestamp: '2026-04-20T00:00:00Z', slug: 'm', side: 'BUY',  type: 'TRADE' }, // dup
      { transaction_hash: 'h2', timestamp: '2026-04-21T00:00:00Z', slug: 'm', side: 'SELL', type: 'TRADE' },
      { transaction_hash: 'h3', timestamp: '2026-04-22T00:00:00Z', slug: 'm', side: 'BUY',  type: 'REDEEM' }, // filtered
    ]);
    store._resetStoreCache();
    const s = store.readStore();
    const h = s.traderHistory['0xhist'];
    expect(h.buys.length).toBe(1);
    expect(h.sells.length).toBe(1);
    expect(h.buys[0].transaction_hash).toBe('h1');
    expect(h.sells[0].transaction_hash).toBe('h2');
  });
});
