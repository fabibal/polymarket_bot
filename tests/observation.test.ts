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

function makeObsTrade(over: Partial<SimulatedTrade> = {}): SimulatedTrade {
  return {
    id: 'o1',
    sourceTradeId: 'osrc1',
    timestamp: '2026-06-10T10:00:00.000Z',
    copiedTrader: '0xobs',
    copiedTraderRank: 0,
    copiedTraderSource: 'observation',
    marketSlug: 'obs-market',
    marketTitle: 'Obs?',
    outcome: 'Yes',
    side: 'buy',
    entryPrice: 0.50,
    simulatedAmount: 5,
    simulatedShares: 5 / 0.50,
    status: 'open',
    entryGasCost: 0,
    entrySlippageCost: 0.02 * 0.50 * (5 / 0.50),
    ...over,
  };
}

beforeEach(() => {
  store._setDbPathForTests(':memory:');
});

describe('observation ledger: lifecycle', () => {
  it('addObservationTrade persists and survives a cache reload', () => {
    store.addObservationTrade(makeObsTrade());
    store._resetStoreCache();
    const s = store.readStore();
    expect(s.observationOpenTrades.length).toBe(1);
    expect(s.observationOpenTrades[0].copiedTraderSource).toBe('observation');
    expect(s.observationOpenTrades[0].status).toBe('open');
  });

  it('closeObservationTrade closes FIFO-oldest match with cost-adjusted PnL, in place', () => {
    store.addObservationTrade(makeObsTrade({ id: 'o-old', sourceTradeId: 's-old', entryPrice: 0.50, simulatedShares: 10 }));
    store.addObservationTrade(makeObsTrade({ id: 'o-new', sourceTradeId: 's-new', timestamp: '2026-06-10T11:00:00.000Z', entryPrice: 0.55, simulatedShares: 5 / 0.55 }));

    const ok = store.closeObservationTrade('0xobs', 'obs-market', 'Yes', 0.80);
    expect(ok).toBe(true);

    store._resetStoreCache();
    const s = store.readStore();
    // Single table — the row mutates in place, so both rows are still on disk.
    const all = [...store.iterateObservationTrades()];
    expect(all.length).toBe(2);
    // ...but the in-memory cache keeps open rows only.
    expect(s.observationOpenTrades.map(t => t.id)).toEqual(['o-new']);

    const closed = all.find(t => t.id === 'o-old')!;
    expect(closed.status).toBe('resolved');
    expect(closed.exitPrice).toBe(0.80);
    expect(closed.realizedPnl).toBeCloseTo((0.80 - 0.50) * 10, 10);
    // costAdjustedPnl = realized - gas - entrySlip - exitSlip(0.02 * 0.80 * 10)
    expect(closed.costAdjustedPnl).toBeCloseTo(3 - 0 - 0.02 * 0.50 * 10 - 0.02 * 0.80 * 10, 10);
    expect(all.find(t => t.id === 'o-new')!.status).toBe('open');
  });

  it('closing drops the row from the open cache without a reload (no closed-tail growth)', () => {
    store.addObservationTrade(makeObsTrade({ id: 'o-1', sourceTradeId: 's-1' }));
    store.addObservationTrade(makeObsTrade({ id: 'o-2', sourceTradeId: 's-2', outcome: 'No' }));
    const s = store.readStore();
    expect(s.observationOpenTrades.length).toBe(2);

    // FIFO close and price-driven resolve must both evict from the live cache,
    // not just on the next reload — the cache is what the OOM fix bounds.
    store.closeObservationTrade('0xobs', 'obs-market', 'Yes', 0.80);
    expect(s.observationOpenTrades.map(t => t.id)).toEqual(['o-2']);

    store.resolveObservationByPrice([{ id: 'o-2', exitPrice: 0.9 }]);
    expect(store.readStore().observationOpenTrades).toEqual([]);
    expect([...store.iterateObservationTrades()].length).toBe(2);
  });

  it('closeObservationTrade returns false with no open match (already closed or wrong outcome)', () => {
    store.addObservationTrade(makeObsTrade());
    expect(store.closeObservationTrade('0xobs', 'obs-market', 'No', 0.80)).toBe(false);
    expect(store.closeObservationTrade('0xobs', 'obs-market', 'Yes', 0.80)).toBe(true);
    expect(store.closeObservationTrade('0xobs', 'obs-market', 'Yes', 0.80)).toBe(false);
  });

  it('resolveObservationByPrice books exits and updateObservationTradePrices marks open rows', () => {
    store.addObservationTrade(makeObsTrade({ id: 'o-a', sourceTradeId: 's-a' }));
    store.addObservationTrade(makeObsTrade({ id: 'o-b', sourceTradeId: 's-b', outcome: 'No' }));

    store.updateObservationTradePrices([{ id: 'o-b', currentPrice: 0.60, unrealizedPnl: 1 }]);
    store.resolveObservationByPrice([{ id: 'o-a', exitPrice: 1 }]);
    store.resolveObservationByPrice([{ id: 'o-b', exitPrice: 0.60 }], 'expired');

    store._resetStoreCache();
    const all = [...store.iterateObservationTrades()];
    const a = all.find(t => t.id === 'o-a')!;
    const b = all.find(t => t.id === 'o-b')!;
    expect(a.status).toBe('resolved');
    expect(a.realizedPnl).toBeCloseTo((1 - 0.50) * 10, 10);
    expect(b.status).toBe('expired');
    expect(b.exitPrice).toBe(0.60);
  });

  it('observation trades never enter openTrades (wallet cap unaffected)', () => {
    store.addObservationTrade(makeObsTrade());
    const s = store.readStore();
    expect(s.openTrades.length).toBe(0);
    expect(s.observationOpenTrades.length).toBe(1);
  });

  it('sourceNotional persists and reloads on observation trades (FIX 4)', () => {
    store.addObservationTrade(makeObsTrade({ id: 'o-n', sourceTradeId: 's-n', sourceNotional: 789.12 }));
    store.addObservationTrade(makeObsTrade({ id: 'o-no', sourceTradeId: 's-no' }));
    store._resetStoreCache();
    const s = store.readStore();
    expect(s.observationOpenTrades.find(t => t.id === 'o-n')!.sourceNotional).toBeCloseTo(789.12, 10);
    expect(s.observationOpenTrades.find(t => t.id === 'o-no')!.sourceNotional).toBeUndefined();
  });
});

describe('observation ledger: observationClosedStats (SQL aggregate)', () => {
  it('matches the per-row cost-adjusted PnL, honours the since cut-off and skips open rows', () => {
    store.addObservationTrade(makeObsTrade({ id: 'w', sourceTradeId: 'sw', marketSlug: 'mw', timestamp: '2026-09-27T01:00:00.000Z' }));
    store.addObservationTrade(makeObsTrade({ id: 'l', sourceTradeId: 'sl', marketSlug: 'ml', timestamp: '2026-09-27T02:00:00.000Z' }));
    store.addObservationTrade(makeObsTrade({ id: 'old', sourceTradeId: 'so', marketSlug: 'mo', timestamp: '2026-09-20T00:00:00.000Z' }));
    store.addObservationTrade(makeObsTrade({ id: 'open', sourceTradeId: 'sp', marketSlug: 'mp', timestamp: '2026-09-27T03:00:00.000Z' }));
    store.closeObservationTrade('0xobs', 'mw', 'Yes', 0.80);
    store.closeObservationTrade('0xobs', 'ml', 'Yes', 0.20);
    store.closeObservationTrade('0xobs', 'mo', 'Yes', 0.90);
    const rows = [...store.iterateObservationTrades()].filter(t => t.status !== 'open' && t.timestamp >= '2026-09-26T21:00:00.000Z');
    const expectedNet = rows.reduce((s, t) => s + (t.costAdjustedPnl ?? 0), 0);
    const r = store.observationClosedStats('0xobs', '2026-09-26T21:00:00.000Z');
    expect(r.closedCount).toBe(2);
    expect(r.winners).toBe(1);
    expect(r.netPnl).toBeCloseTo(expectedNet, 10);
    expect(r.grossWin - r.grossLoss).toBeCloseTo(expectedNet, 10);
    expect(r.firstTrade).toBe('2026-09-27T01:00:00.000Z');
    expect(r.lastTrade).toBe('2026-09-27T02:00:00.000Z');
    expect(store.observationClosedStats('0xnobody', '2026-01-01T00:00:00.000Z').closedCount).toBe(0);
    expect(store.observationRowCount()).toBe(4);
  });
});
