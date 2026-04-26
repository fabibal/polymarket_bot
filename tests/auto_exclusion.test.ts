import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/config', () => ({
  CONFIG: {
    DATA_FILE: ':memory:',
    DB_FILE: ':memory:',
    FORCE_EXCLUDE_CATEGORIES: ['esports'],
    GAS_COST_PER_BUY: 0,
    SLIPPAGE_RATE: 0.02,
    AUTO_EXCLUDE_WIN_RATE_THRESHOLD: 0.42,
    AUTO_EXCLUDE_MIN_TRADES: 3,
  },
}));

import * as store from '../src/store';
import { checkAutoExclusion } from '../src/leaderboard';
import { SimulatedTrade, LeaderboardTrader } from '../src/types';
import type { RawFalconTrader } from '../src/bullpen';

function makeClosed(over: Partial<SimulatedTrade> & { copiedTrader: string }): SimulatedTrade {
  return {
    id: 'tid-' + Math.random().toString(36).slice(2, 8),
    sourceTradeId: 'src-' + Math.random().toString(36).slice(2, 8),
    timestamp: '2026-04-23T10:00:00.000Z',
    copiedTraderRank: 5,
    marketSlug: 'mkt-foo',
    marketTitle: 'Foo?',
    outcome: 'Yes',
    side: 'buy',
    entryPrice: 0.70,
    simulatedAmount: 5,
    simulatedShares: 5 / 0.70,
    status: 'resolved',
    ...over,
  };
}

// Seed a set of resolved trades directly via the shadow or real resolve path.
function seedTrades(
  addr: string,
  kind: 'real' | 'shadow',
  wins: number,
  losses: number,
): void {
  const add  = kind === 'real' ? store.addOpenTrade       : store.addShadowOpenTrade;
  const resolve = kind === 'real' ? store.resolveByPrice : store.resolveShadowByPrice;
  const ids: Array<{ id: string; exitPrice: number }> = [];
  for (let i = 0; i < wins; i++) {
    const t = makeClosed({
      copiedTrader: addr,
      id: `${kind}-w-${addr.slice(2, 6)}-${i}`,
      sourceTradeId: `${kind}-src-w-${addr.slice(2, 6)}-${i}`,
      entryPrice: 0.70,
      simulatedShares: 5 / 0.70,
      status: 'open',
    });
    add(t);
    ids.push({ id: t.id, exitPrice: 1.0 });
  }
  for (let i = 0; i < losses; i++) {
    const t = makeClosed({
      copiedTrader: addr,
      id: `${kind}-l-${addr.slice(2, 6)}-${i}`,
      sourceTradeId: `${kind}-src-l-${addr.slice(2, 6)}-${i}`,
      entryPrice: 0.70,
      simulatedShares: 5 / 0.70,
      status: 'open',
    });
    add(t);
    ids.push({ id: t.id, exitPrice: 0.0 });
  }
  resolve(ids);
}

const emptyFalcon = new Map<string, RawFalconTrader>();

beforeEach(() => {
  store._setDbPathForTests(':memory:');
});

describe('checkAutoExclusion: shadow-sample fallback', () => {
  it('uses shadow WR when trader has no real closed trades (new exclusion)', () => {
    const addr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    seedTrades(addr, 'shadow', 1, 9); // 10% shadow WR, below 42%
    const traders: LeaderboardTrader[] = [{ rank: 1, address: addr, username: null, weeklyPnl: 0 }];

    checkAutoExclusion(traders, emptyFalcon);

    expect(store.readStore().autoExcludedTraders).toContain(addr);
  });

  it('does not auto-exclude when shadow WR passes threshold', () => {
    const addr = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    seedTrades(addr, 'shadow', 8, 2); // 80% shadow WR
    const traders: LeaderboardTrader[] = [{ rank: 2, address: addr, username: null, weeklyPnl: 0 }];

    checkAutoExclusion(traders, emptyFalcon);

    expect(store.readStore().autoExcludedTraders).not.toContain(addr);
  });

  it('recovers a ghost-excluded trader using shadow WR when real history is empty', () => {
    const addr = '0xcccccccccccccccccccccccccccccccccccccccc';
    // Pre-existing auto-exclusion, no real trades, strong shadow record.
    store.setAutoExclusion(addr, true);
    expect(store.readStore().autoExcludedTraders).toContain(addr);
    seedTrades(addr, 'shadow', 7, 1); // 87.5% shadow WR

    checkAutoExclusion([], emptyFalcon);

    expect(store.readStore().autoExcludedTraders).not.toContain(addr);
  });

  it('prefers real WR over shadow when both samples are sufficient', () => {
    const addr = '0xdddddddddddddddddddddddddddddddddddddddd';
    // Real: 0W/3L (0% — FAIL). Shadow: 3W/0L (100% — PASS).
    // Real should win → auto-exclude.
    seedTrades(addr, 'real',   0, 3);
    seedTrades(addr, 'shadow', 3, 0);
    const traders: LeaderboardTrader[] = [{ rank: 3, address: addr, username: null, weeklyPnl: 0 }];

    checkAutoExclusion(traders, emptyFalcon);

    expect(store.readStore().autoExcludedTraders).toContain(addr);
  });

  it('counts gross-positive but net-negative trades as losses (slippage erodes thin edges)', () => {
    // entry=0.95, exit=0.97 → gross +$0.105, but slippage ~$0.20 → net -$0.097.
    // All 4 trades are gross winners but net losers — must not pass the gate.
    const addr = '0xfafafafafafafafafafafafafafafafafafafafa';
    const ids: Array<{ id: string; exitPrice: number }> = [];
    for (let i = 0; i < 4; i++) {
      const t = makeClosed({
        copiedTrader: addr,
        id: `thin-${i}`,
        sourceTradeId: `thin-src-${i}`,
        entryPrice: 0.95,
        simulatedShares: 5 / 0.95,
        status: 'open',
      });
      store.addShadowOpenTrade(t);
      ids.push({ id: t.id, exitPrice: 0.97 });
    }
    store.resolveShadowByPrice(ids);

    // Sanity: gross PnL is positive on all 4, but cost-adjusted is negative.
    const closed = store.readStore().shadowClosedTrades?.filter(c => c.copiedTrader === addr) ?? [];
    expect(closed).toHaveLength(4);
    expect(closed.every(c => (c.realizedPnl ?? 0) > 0)).toBe(true);
    expect(closed.every(c => (c.costAdjustedPnl ?? 0) <= 0)).toBe(true);

    const traders: LeaderboardTrader[] = [{ rank: 5, address: addr, username: null, weeklyPnl: 0 }];
    checkAutoExclusion(traders, emptyFalcon);

    // 0% net WR < 42% threshold → must be auto-excluded.
    expect(store.readStore().autoExcludedTraders).toContain(addr);
  });

  it('counts cost-positive trades as wins (sanity: existing behavior preserved)', () => {
    // entry=0.70, exit=1.00 → gross +$2.14, slippage ~$0.24 → net +$1.90 (still a win).
    const addr = '0xfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfbfb';
    seedTrades(addr, 'shadow', 4, 0); // 4 wins, 0 losses, all binary-resolved

    const closed = store.readStore().shadowClosedTrades?.filter(c => c.copiedTrader === addr) ?? [];
    expect(closed).toHaveLength(4);
    expect(closed.every(c => (c.costAdjustedPnl ?? 0) > 0)).toBe(true);

    const traders: LeaderboardTrader[] = [{ rank: 6, address: addr, username: null, weeklyPnl: 0 }];
    checkAutoExclusion(traders, emptyFalcon);

    // 100% net WR >= 42% threshold → must NOT be auto-excluded.
    expect(store.readStore().autoExcludedTraders ?? []).not.toContain(addr);
  });

  it('does nothing when neither real nor shadow has >= AUTO_EXCLUDE_MIN_TRADES', () => {
    const addr = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    seedTrades(addr, 'shadow', 1, 1); // only 2 trades — below min 3
    const traders: LeaderboardTrader[] = [{ rank: 4, address: addr, username: null, weeklyPnl: 0 }];

    checkAutoExclusion(traders, emptyFalcon);

    const s = store.readStore();
    expect(s.autoExcludedTraders).not.toContain(addr);
  });
});
