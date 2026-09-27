import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/config', () => ({
  CONFIG: {
    DB_FILE: ':memory:',
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

  it('can add straight to observation (copy disabled from the first moment)', () => {
    store.addWatchlistTrader('0xDEADBEEF000000000000000000000000000DEAD2', 'ObsGuy', false);
    expect(store.readStore().watchlistTraders.find(x => x.address === '0xdeadbeef000000000000000000000000000dead2')?.copyEnabled).toBe(false);
    store._resetStoreCache();
    expect(store.readStore().watchlistTraders.find(x => x.address === '0xdeadbeef000000000000000000000000000dead2')?.copyEnabled).toBe(false);
  });
});

describe('store: writeStore persists cleanup-state prunes', () => {
  it('persists a processedTradeIds prune; trade tables come from targeted writes', () => {
    store.markProcessed('p1');
    store.markProcessed('p2');
    store.addOpenTrade(makeTrade({ id: 'ws1', sourceTradeId: 'ws1src' }));

    const s = store.readStore();
    s.processedTradeIds = s.processedTradeIds.filter(id => id !== 'p1');
    store.writeStore(s);

    store._resetStoreCache();
    const reloaded = store.readStore();
    expect(reloaded.processedTradeIds).not.toContain('p1');
    expect(reloaded.processedTradeIds).toContain('p2');
    // The open trade was persisted by addOpenTrade's targeted write —
    // writeStore no longer touches the trade tables.
    expect(reloaded.openTrades.find(t => t.id === 'ws1')).toBeDefined();
  });
});

describe('store: runDailyCleanup traderHistory 90d prune', () => {
  it('drops entries older than 90 days, keeps fresh ones', () => {
    const oldTs   = new Date(Date.now() - 91 * 86_400_000).toISOString();
    const freshTs = new Date(Date.now() -  1 * 86_400_000).toISOString();
    store.appendTraderHistory('0xhist90', [
      { transaction_hash: 'old1', timestamp: oldTs,   slug: 'm', side: 'BUY', type: 'TRADE' },
      { transaction_hash: 'new1', timestamp: freshTs, slug: 'm', side: 'BUY', type: 'TRADE' },
    ]);
    store.runDailyCleanup();
    store._resetStoreCache();
    const h = store.readStore().traderHistory['0xhist90'];
    expect(h.buys.map(b => b.transaction_hash)).toEqual(['new1']);
  });

  it('removes a trader whose history is entirely older than 90 days', () => {
    const oldTs = new Date(Date.now() - 120 * 86_400_000).toISOString();
    store.appendTraderHistory('0xgone', [
      { transaction_hash: 'o1', timestamp: oldTs, slug: 'm', side: 'SELL', type: 'TRADE' },
    ]);
    store.runDailyCleanup();
    store._resetStoreCache();
    expect(store.readStore().traderHistory['0xgone']).toBeUndefined();
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

describe('store: GROUP D research columns', () => {
  it('sourceNotional and entryPriceGap persist through open → close → reload', () => {
    const t = makeTrade({ id: 'rd-1', sourceTradeId: 'rd-src-1' });
    t.sourceNotional = 1234.56;
    t.entryPriceGap = 0.025;
    store.addOpenTrade(t);

    store._resetStoreCache();
    let s = store.readStore();
    const open = s.openTrades.find(x => x.id === 'rd-1')!;
    expect(open.sourceNotional).toBeCloseTo(1234.56, 10);
    expect(open.entryPriceGap).toBeCloseTo(0.025, 10);

    store.closeOpenTrade('0xabc', 'foo-market', 'Yes', 0.90);
    store._resetStoreCache();
    s = store.readStore();
    const closed = s.closedTrades.find(x => x.id === 'rd-1')!;
    expect(closed.sourceNotional).toBeCloseTo(1234.56, 10);
    expect(closed.entryPriceGap).toBeCloseTo(0.025, 10);
  });

  it('trades without research fields persist as null and reload as undefined', () => {
    store.addOpenTrade(makeTrade({ id: 'rd-2', sourceTradeId: 'rd-src-2' }));
    store._resetStoreCache();
    const open = store.readStore().openTrades.find(x => x.id === 'rd-2')!;
    expect(open.sourceNotional).toBeUndefined();
    expect(open.entryPriceGap).toBeUndefined();
  });
});

describe('store: copy timing columns', () => {
  it('copiedAt and copySource persist through open -> close -> reload', () => {
    store.addOpenTrade(makeTrade({ id: 'ct-1', sourceTradeId: 'ct-src-1', copiedAt: '2026-09-27T10:00:01.500Z', copySource: 'rtds' }));
    store._resetStoreCache();
    const open = store.readStore().openTrades.find(x => x.id === 'ct-1')!;
    expect(open.copiedAt).toBe('2026-09-27T10:00:01.500Z');
    expect(open.copySource).toBe('rtds');
    store.closeOpenTrade('0xabc', 'foo-market', 'Yes', 0.90);
    store._resetStoreCache();
    const closed = store.readStore().closedTrades.find(x => x.id === 'ct-1')!;
    expect(closed.copiedAt).toBe('2026-09-27T10:00:01.500Z');
    expect(closed.copySource).toBe('rtds');
  });
});
