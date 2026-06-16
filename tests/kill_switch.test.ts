import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/config', () => ({
  CONFIG: {
    DB_FILE: ':memory:',
    GAS_COST_PER_BUY: 0,
    SLIPPAGE_RATE: 0,
    RESOLVED_THRESHOLD: 0.93,
    TRADER_DECAY_THRESHOLD_30D: -50,
    DAILY_LOSS_BREAKER_ENABLED: true,
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

describe('risk: trader decay kill switch (30d window)', () => {
  it('disables via the 30d window when net is below -50', async () => {
    for (let i = 0; i < 11; i++) bookLoss(); // ≈ -$55 < -$50
    const disabled = await checkTraderDecay();
    expect(disabled).toEqual([TRADER]);
    const w = store.readStore().watchlistTraders.find(x => x.address === TRADER)!;
    expect(w.copyEnabled).toBe(false);
    expect(w.autoDisabledReason).toContain('30d net');
    expect(w.autoDisabledReason).toContain('below decay threshold');
  });

  it('does not fire above the threshold and never re-fires on already-disabled traders', async () => {
    for (let i = 0; i < 7; i++) bookLoss(); // ≈ -$35: above -50, no fire
    expect(await checkTraderDecay()).toEqual([]);
    for (let i = 0; i < 4; i++) bookLoss(); // now ≈ -$55 → 30d trigger
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

  it('DAILY_LOSS_BREAKER_ENABLED=false: never trips, ignores a stale active pause', async () => {
    const { CONFIG } = await import('../src/config');
    (CONFIG as any).DAILY_LOSS_BREAKER_ENABLED = false;
    try {
      for (let i = 0; i < 7; i++) bookLoss(); // ≈ -$35 < -$30 — would trip if enabled
      expect(await checkCircuitBreaker()).toBe(false);
      expect(store.getMetaValue(BREAKER_META_KEY)).toBeNull();

      // A pause left over from before disabling must not suspend copying.
      store.setMetaValue(BREAKER_META_KEY, new Date(Date.now() + 3_600_000).toISOString());
      expect(isCircuitBreakerActive()).toBe(false);
      const st = getCircuitBreakerStatus();
      expect(st.enabled).toBe(false);
      expect(st.active).toBe(false);
    } finally {
      (CONFIG as any).DAILY_LOSS_BREAKER_ENABLED = true;
    }
  });
});
