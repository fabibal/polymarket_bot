import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/config', () => ({
  CONFIG: {
    DB_FILE: ':memory:',
    GAS_COST_PER_BUY: 0,
    SLIPPAGE_RATE: 0,           // zero so window sums are exact in assertions
    RESOLVED_THRESHOLD: 0.93,
    TRADER_DECAY_THRESHOLD_30D: -50,
    DAILY_LOSS_CIRCUIT_BREAKER: -30,
  },
}));

import { rollingNetForTrader, rollingNetTotal, evaluateCircuitBreaker, BREAKER_PAUSE_MS } from '../src/risk';
import { SimulatedTrade } from '../src/types';

const NOW = Date.parse('2026-06-10T12:00:00.000Z');
const DAY = 86_400_000;

function closedTrade(over: Partial<SimulatedTrade> = {}): SimulatedTrade {
  return {
    id: Math.random().toString(36).slice(2),
    sourceTradeId: 'src',
    timestamp: new Date(NOW - 2 * DAY).toISOString(),
    copiedTrader: '0xaaa',
    copiedTraderRank: 0,
    marketSlug: 'm',
    marketTitle: 'M',
    outcome: 'Yes',
    side: 'buy',
    entryPrice: 0.5,
    simulatedAmount: 5,
    simulatedShares: 10,
    status: 'resolved',
    exitPrice: 0,
    realizedPnl: -5,
    costAdjustedPnl: -5,
    closedAt: new Date(NOW - DAY).toISOString(),
    entryGasCost: 0,
    entrySlippageCost: 0,
    exitSlippageCost: 0,
    ...over,
  };
}

describe('rollingNetForTrader', () => {
  it('sums cost-adjusted PnL inside the window for the right trader only', () => {
    const trades = [
      closedTrade({ costAdjustedPnl: -5, realizedPnl: -5 }),
      closedTrade({ costAdjustedPnl: 3, realizedPnl: 3 }),
      closedTrade({ copiedTrader: '0xbbb', costAdjustedPnl: -100, realizedPnl: -100 }),
    ];
    expect(rollingNetForTrader(trades, '0xaaa', 30 * DAY, NOW)).toBeCloseTo(-2, 10);
  });

  it('excludes trades closed before the window and open trades', () => {
    const trades = [
      closedTrade({ closedAt: new Date(NOW - 31 * DAY).toISOString(), costAdjustedPnl: -500, realizedPnl: -500 }),
      closedTrade({ status: 'open', closedAt: undefined, costAdjustedPnl: -500 } as Partial<SimulatedTrade>),
      closedTrade({ costAdjustedPnl: -7, realizedPnl: -7 }),
    ];
    expect(rollingNetForTrader(trades, '0xaaa', 30 * DAY, NOW)).toBeCloseTo(-7, 10);
  });
});

describe('rollingNetTotal', () => {
  it('sums across all traders inside the window', () => {
    const trades = [
      closedTrade({ costAdjustedPnl: -20, realizedPnl: -20 }),
      closedTrade({ copiedTrader: '0xbbb', costAdjustedPnl: -15, realizedPnl: -15 }),
      closedTrade({ closedAt: new Date(NOW - 25 * 3_600_000).toISOString(), costAdjustedPnl: -99, realizedPnl: -99 }), // 25h ago — outside 24h
    ];
    expect(rollingNetTotal(trades, DAY, NOW)).toBeCloseTo(-35, 10);
  });
});

describe('evaluateCircuitBreaker', () => {
  it('does nothing while net is above the threshold', () => {
    expect(evaluateCircuitBreaker({ net24h: -29.99, threshold: -30, activeUntilMs: null, nowMs: NOW }))
      .toEqual({ action: 'none' });
    expect(evaluateCircuitBreaker({ net24h: 10, threshold: -30, activeUntilMs: null, nowMs: NOW }))
      .toEqual({ action: 'none' });
  });

  it('trips when 24h net drops below the threshold', () => {
    expect(evaluateCircuitBreaker({ net24h: -30.01, threshold: -30, activeUntilMs: null, nowMs: NOW }))
      .toEqual({ action: 'trip', pauseUntilMs: NOW + BREAKER_PAUSE_MS });
  });

  it('reports active while a pause is in effect (no double-trip)', () => {
    expect(evaluateCircuitBreaker({ net24h: -100, threshold: -30, activeUntilMs: NOW + 1000, nowMs: NOW }))
      .toEqual({ action: 'active', untilMs: NOW + 1000 });
  });

  it('re-trips after an expired pause if still bleeding', () => {
    expect(evaluateCircuitBreaker({ net24h: -100, threshold: -30, activeUntilMs: NOW - 1, nowMs: NOW }))
      .toEqual({ action: 'trip', pauseUntilMs: NOW + BREAKER_PAUSE_MS });
  });
});
