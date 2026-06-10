import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/config', () => ({
  CONFIG: {
    DB_FILE: ':memory:',
    GAS_COST_PER_BUY: 0,
    SLIPPAGE_RATE: 0,
    RESOLVED_THRESHOLD: 0.93,
    TRADER_DECAY_THRESHOLD_30D: -50,
    TRADER_DECAY_THRESHOLD_7D: -30,
    DAILY_LOSS_CIRCUIT_BREAKER: -30,
  },
}));

import * as store from '../src/store';
import {
  checkTraderDecay, checkCircuitBreaker, isCircuitBreakerActive,
  resetCircuitBreaker, getCircuitBreakerStatus, BREAKER_META_KEY,
} from '../src/risk';
import { SimulatedTrade } from '../src/types';

// Seeded copy-enabled default trader (see WATCHLIST_DEFAULTS).
const TRADER = '0x8a6c6811e8937f9e8afc1b9249fa540262c30b3f';

function openTrade(over: Partial<SimulatedTrade> = {}): SimulatedTrade {
  return {
    id: Math.random().toString(36).slice(2),
    sourceTradeId: Math.random().toString(36).slice(2),
    timestamp: new Date(Date.now() - 3_600_000).toISOString(),
    copiedTrader: TRADER,
    copiedTraderRank: 0,
    copiedTraderSource: 'watchlist',
    marketSlug: 'ks-market',
    marketTitle: 'KS?',
    outcome: 'Yes',
    side: 'buy',
    entryPrice: 0.5,
    simulatedAmount: 5,
    simulatedShares: 10,
    status: 'open',
    entryGasCost: 0,
    entrySlippageCost: 0,
    ...over,
  };
}

/** Open + immediately close a full $5 loser for TRADER (closedAt = now). */
function bookLoss() {
  const t = openTrade();
  store.addOpenTrade(t);
  store.resolveByPrice([{ id: t.id, exitPrice: 0 }]); // realized -$5, cost-adj -$5 (zero slippage in mock)
}

beforeEach(() => {
  store._setDbPathForTests(':memory:');
});

describe('store: auto-disable + meta helpers', () => {
  it('autoDisableWatchlistTrader flips copy_enabled and records reason; manual enable clears it', () => {
    expect(store.autoDisableWatchlistTrader(TRADER, '30d net -$60')).toBe(true);
    store._resetStoreCache();
    let w = store.readStore().watchlistTraders.find(x => x.address === TRADER)!;
    expect(w.copyEnabled).toBe(false);
    expect(w.autoDisabledReason).toBe('30d net -$60');
    expect(w.autoDisabledAt).toBeTruthy();

    store.setWatchlistCopyEnabled(TRADER, true);
    store._resetStoreCache();
    w = store.readStore().watchlistTraders.find(x => x.address === TRADER)!;
    expect(w.copyEnabled).toBe(true);
    expect(w.autoDisabledAt).toBeUndefined();
    expect(w.autoDisabledReason).toBeUndefined();
  });

  it('meta helpers round-trip and delete', () => {
    expect(store.getMetaValue('k')).toBeNull();
    store.setMetaValue('k', 'v1');
    expect(store.getMetaValue('k')).toBe('v1');
    store.setMetaValue('k', 'v2');
    expect(store.getMetaValue('k')).toBe('v2');
    store.deleteMetaValue('k');
    expect(store.getMetaValue('k')).toBeNull();
  });
});

describe('risk: trader decay kill switch (30d OR 7d window)', () => {
  it('disables via the 30d window when net is below -50 (30d takes precedence in the reason)', async () => {
    for (let i = 0; i < 11; i++) bookLoss(); // ≈ -$55 < -$50 (and < -$30 in 7d)
    const disabled = await checkTraderDecay();
    expect(disabled).toEqual([TRADER]);
    const w = store.readStore().watchlistTraders.find(x => x.address === TRADER)!;
    expect(w.copyEnabled).toBe(false);
    expect(w.autoDisabledReason).toContain('30d net');
    expect(w.autoDisabledReason).toContain('below decay threshold');
  });

  it('disables via the 7d window when recent bleed crosses -30 but 30d is still above -50', async () => {
    for (let i = 0; i < 7; i++) bookLoss(); // ≈ -$35: 30d fine (-35 > -50), 7d trips (-35 < -30)
    const disabled = await checkTraderDecay();
    expect(disabled).toEqual([TRADER]);
    const w = store.readStore().watchlistTraders.find(x => x.address === TRADER)!;
    expect(w.autoDisabledReason).toContain('7d net');
  });

  it('does not fire above both thresholds and never re-fires on already-disabled traders', async () => {
    for (let i = 0; i < 5; i++) bookLoss(); // ≈ -$25: above -30 (7d) and -50 (30d)
    expect(await checkTraderDecay()).toEqual([]);
    for (let i = 0; i < 2; i++) bookLoss(); // now ≈ -$35 → 7d trigger
    expect(await checkTraderDecay()).toEqual([TRADER]);
    expect(await checkTraderDecay()).toEqual([]); // disabled traders are skipped
  });
});

describe('risk: daily-loss circuit breaker', () => {
  it('trips below the 24h threshold, stays active, and resets manually', async () => {
    for (let i = 0; i < 7; i++) bookLoss(); // ≈ -$35 < -$30
    expect(isCircuitBreakerActive()).toBe(false);
    expect(await checkCircuitBreaker()).toBe(true);
    expect(store.getMetaValue(BREAKER_META_KEY)).toBeTruthy();
    expect(isCircuitBreakerActive()).toBe(true);

    const st = getCircuitBreakerStatus();
    expect(st.active).toBe(true);
    expect(st.net24h).toBeCloseTo(-35, 5);
    expect(st.threshold).toBe(-30);

    resetCircuitBreaker();
    expect(isCircuitBreakerActive()).toBe(false);
    expect(store.getMetaValue(BREAKER_META_KEY)).toBeNull();
  });

  it('does not trip above the threshold', async () => {
    for (let i = 0; i < 5; i++) bookLoss(); // ≈ -$25
    expect(await checkCircuitBreaker()).toBe(false);
    expect(isCircuitBreakerActive()).toBe(false);
  });

  it('an expired pause auto-resumes', () => {
    store.setMetaValue(BREAKER_META_KEY, new Date(Date.now() - 1000).toISOString());
    expect(isCircuitBreakerActive()).toBe(false);            // expired → cleared
    expect(store.getMetaValue(BREAKER_META_KEY)).toBeNull(); // meta cleaned up
  });
});
