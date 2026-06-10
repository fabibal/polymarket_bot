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
    expect(s.observationTrades.length).toBe(1);
    expect(s.observationTrades[0].copiedTraderSource).toBe('observation');
    expect(s.observationTrades[0].status).toBe('open');
  });

  it('closeObservationTrade closes FIFO-oldest match with cost-adjusted PnL, in place', () => {
    store.addObservationTrade(makeObsTrade({ id: 'o-old', sourceTradeId: 's-old', entryPrice: 0.50, simulatedShares: 10 }));
    store.addObservationTrade(makeObsTrade({ id: 'o-new', sourceTradeId: 's-new', timestamp: '2026-06-10T11:00:00.000Z', entryPrice: 0.55, simulatedShares: 5 / 0.55 }));

    const ok = store.closeObservationTrade('0xobs', 'obs-market', 'Yes', 0.80);
    expect(ok).toBe(true);

    store._resetStoreCache();
    const s = store.readStore();
    expect(s.observationTrades.length).toBe(2); // single table — row mutates, no move
    const closed = s.observationTrades.find(t => t.id === 'o-old')!;
    expect(closed.status).toBe('resolved');
    expect(closed.exitPrice).toBe(0.80);
    expect(closed.realizedPnl).toBeCloseTo((0.80 - 0.50) * 10, 10);
    // costAdjustedPnl = realized - gas - entrySlip - exitSlip(0.02 * 0.80 * 10)
    expect(closed.costAdjustedPnl).toBeCloseTo(3 - 0 - 0.02 * 0.50 * 10 - 0.02 * 0.80 * 10, 10);
    expect(s.observationTrades.find(t => t.id === 'o-new')!.status).toBe('open');
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
    const s = store.readStore();
    const a = s.observationTrades.find(t => t.id === 'o-a')!;
    const b = s.observationTrades.find(t => t.id === 'o-b')!;
    expect(a.status).toBe('resolved');
    expect(a.realizedPnl).toBeCloseTo((1 - 0.50) * 10, 10);
    expect(b.status).toBe('expired');
    expect(b.exitPrice).toBe(0.60);
  });

  it('observation trades never enter openTrades (wallet cap unaffected)', () => {
    store.addObservationTrade(makeObsTrade());
    const s = store.readStore();
    expect(s.openTrades.length).toBe(0);
    expect(s.observationTrades.length).toBe(1);
  });
});
