import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the config module so the financial-math tests aren't coupled to
// whatever the live env vars happen to be. Values chosen to match the
// production docker-compose.yml at the time of writing.
vi.mock('../src/config', () => ({
  CONFIG: {
    GAS_COST_PER_BUY: 0,
    SLIPPAGE_RATE: 0.02,
  },
}));

import { computeEntryCosts, tradeCostAdjustedPnl, tradeTotalCosts } from '../src/simulator';
import { SimulatedTrade } from '../src/types';

function makeOpenTrade(overrides: Partial<SimulatedTrade> = {}): SimulatedTrade {
  return {
    id: 'open-1',
    sourceTradeId: 'hash1',
    timestamp: '2026-04-22T00:00:00.000Z',
    copiedTrader: '0xabc',
    copiedTraderRank: 1,
    marketSlug: 'foo',
    marketTitle: 'Foo',
    outcome: 'Yes',
    side: 'buy',
    entryPrice: 0.70,
    simulatedAmount: 5,
    simulatedShares: 5 / 0.70,
    currentPrice: 0.80,
    unrealizedPnl: (0.80 - 0.70) * (5 / 0.70),
    status: 'open',
    entryGasCost: 0,
    entrySlippageCost: 0.02 * 0.70 * (5 / 0.70),
    ...overrides,
  } as SimulatedTrade;
}

function makeClosedTrade(overrides: Partial<SimulatedTrade> = {}): SimulatedTrade {
  return {
    ...makeOpenTrade(),
    id: 'closed-1',
    status: 'resolved',
    exitPrice: 0.90,
    closedAt: '2026-04-22T12:00:00.000Z',
    realizedPnl: (0.90 - 0.70) * (5 / 0.70),
    exitSlippageCost: 0.02 * 0.90 * (5 / 0.70),
    ...overrides,
  } as SimulatedTrade;
}

describe('computeEntryCosts', () => {
  it('returns SLIPPAGE_RATE × price × shares as slippage', () => {
    const { gas, slippage } = computeEntryCosts(0.70, 10);
    expect(gas).toBe(0);
    expect(slippage).toBeCloseTo(0.02 * 0.70 * 10, 10); // 0.14
  });

  it('slippage scales linearly with shares', () => {
    const a = computeEntryCosts(0.50, 20).slippage;
    const b = computeEntryCosts(0.50, 40).slippage;
    expect(b).toBeCloseTo(a * 2, 10);
  });
});

describe('tradeCostAdjustedPnl', () => {
  it('open trade: subtracts entry + projected-exit slippage from unrealizedPnl', () => {
    const t = makeOpenTrade(); // entry 0.70, mark 0.80, shares ≈ 7.143
    const shares = t.simulatedShares;
    const expected = t.unrealizedPnl!
      - 0                              // gas
      - 0.02 * 0.70 * shares           // entry slippage
      - 0.02 * 0.80 * shares;          // projected exit slippage at current mark
    expect(tradeCostAdjustedPnl(t)).toBeCloseTo(expected, 10);
  });

  it('open trade without currentPrice falls back to entryPrice for projected exit slippage', () => {
    const t = makeOpenTrade({ currentPrice: undefined, unrealizedPnl: 0 });
    const shares = t.simulatedShares;
    const expected = 0 - 0 - 0.02 * 0.70 * shares - 0.02 * 0.70 * shares;
    expect(tradeCostAdjustedPnl(t)).toBeCloseTo(expected, 10);
  });

  it('closed trade: subtracts gas + entry + exit slippage from realizedPnl', () => {
    const t = makeClosedTrade(); // entry 0.70, exit 0.90, shares ≈ 7.143
    const shares = t.simulatedShares;
    const expected = t.realizedPnl!
      - 0
      - 0.02 * 0.70 * shares
      - 0.02 * 0.90 * shares;
    expect(tradeCostAdjustedPnl(t)).toBeCloseTo(expected, 10);
  });

  it('closed trade: recomputes costs from entry/exit prices when stored cost fields are missing (legacy)', () => {
    const t = makeClosedTrade({ entryGasCost: undefined, entrySlippageCost: undefined, exitSlippageCost: undefined });
    const shares = t.simulatedShares;
    const expected = t.realizedPnl!
      - 0
      - 0.02 * 0.70 * shares
      - 0.02 * 0.90 * shares;
    expect(tradeCostAdjustedPnl(t)).toBeCloseTo(expected, 10);
  });
});

describe('tradeTotalCosts', () => {
  it('open trade: gas + entry slippage + projected exit slippage at current mark', () => {
    const t = makeOpenTrade();
    const shares = t.simulatedShares;
    const expected = 0 + 0.02 * 0.70 * shares + 0.02 * 0.80 * shares;
    expect(tradeTotalCosts(t)).toBeCloseTo(expected, 10);
  });

  it('closed trade: gas + entry slippage + realised exit slippage', () => {
    const t = makeClosedTrade();
    const shares = t.simulatedShares;
    const expected = 0 + 0.02 * 0.70 * shares + 0.02 * 0.90 * shares;
    expect(tradeTotalCosts(t)).toBeCloseTo(expected, 10);
  });
});
