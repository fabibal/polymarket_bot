import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the config module so the financial-math tests aren't coupled to
// whatever the live env vars happen to be. Values chosen to match the
// production docker-compose.yml at the time of writing.
vi.mock('../src/config', () => ({
  CONFIG: {
    GAS_COST_PER_BUY: 0,
    SLIPPAGE_RATE: 0.02,
    RESOLVED_THRESHOLD: 0.93,
  },
}));

import {
  computeEntryCosts, tradeCostAdjustedPnl, tradeTotalCosts, costBreakdown,
  decideThresholdResolution, isMarketResolved, snapDelistExitPrice, decideDelistExit, isRateLimitError,
} from '../src/simulator';
import { SimulatedTrade } from '../src/types';
import { takerFeeCost } from '../src/fees';
import { RawPriceResponse } from '../src/bullpen';

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

  it('uses gap × shares when a gap is supplied (gap-based taker cost)', () => {
    const { slippage } = computeEntryCosts(0.10, 50, 0.01); // 1-cent gap
    expect(slippage).toBeCloseTo(0.01 * 50, 10); // 0.50, vs flat-2% would be 0.10
  });

  it('floors negative gap at 0 (no phantom credit from stale snapshot)', () => {
    const { slippage } = computeEntryCosts(0.10, 50, -0.02);
    expect(slippage).toBe(0);
  });

  it('falls back to flat SLIPPAGE_RATE when gap is null/undefined', () => {
    expect(computeEntryCosts(0.70, 10, null).slippage).toBeCloseTo(0.02 * 0.70 * 10, 10);
    expect(computeEntryCosts(0.70, 10).slippage).toBeCloseTo(0.02 * 0.70 * 10, 10);
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

  it('open trade: also subtracts the entry fee and a projected exit fee at the mark', () => {
    const t = makeOpenTrade({ feeRate: 0.04, entryFeeCost: 0.1 });
    const shares = t.simulatedShares;
    const expected = t.unrealizedPnl!
      - 0.02 * 0.70 * shares - 0.02 * 0.80 * shares
      - 0.1 - shares * 0.04 * 0.80 * 0.20;
    expect(tradeCostAdjustedPnl(t)).toBeCloseTo(expected, 10);
  });

  it('closed trade: subtracts stored entry + exit fees', () => {
    const t = makeClosedTrade({ feeRate: 0.05, entryFeeCost: 0.1, exitFeeCost: 0.2 });
    const shares = t.simulatedShares;
    const expected = t.realizedPnl! - 0.02 * 0.70 * shares - 0.02 * 0.90 * shares - 0.1 - 0.2;
    expect(tradeCostAdjustedPnl(t)).toBeCloseTo(expected, 10);
  });
});

describe('takerFeeCost', () => {
  it('matches the docs table: 100 shares at 0.50 with rate 0.04 costs $1.00', () => {
    expect(takerFeeCost(0.04, 0.5, 100)).toBeCloseTo(1.0, 10);
  });
  it('is zero for 0/1 resolution payouts and fee-free markets', () => {
    expect(takerFeeCost(0.05, 1, 100)).toBe(0);
    expect(takerFeeCost(0.05, 0, 100)).toBe(0);
    expect(takerFeeCost(0, 0.5, 100)).toBe(0);
    expect(takerFeeCost(undefined, 0.5, 100)).toBe(0);
  });
});

describe('isMarketResolved', () => {
  function priceResponse(closed: boolean, prices: Array<number | null>): RawPriceResponse {
    return {
      closed,
      outcomes: prices.map((p, i) => ({
        outcome: i === 0 ? 'Yes' : 'No',
        midpoint: p,
        last_trade: null,
        best_bid: null,
        best_ask: null,
        spread: null,
      })),
    };
  }

  it('true when closed and all outcome prices pinned to 0/1', () => {
    expect(isMarketResolved(priceResponse(true, [1, 0]))).toBe(true);
    expect(isMarketResolved(priceResponse(true, [0.001, 0.999]))).toBe(true);
  });

  it('false when not closed, even with pinned prices', () => {
    expect(isMarketResolved(priceResponse(false, [1, 0]))).toBe(false);
  });

  it('false when closed but prices are not final', () => {
    expect(isMarketResolved(priceResponse(true, [0.93, 0.07]))).toBe(false);
    expect(isMarketResolved(priceResponse(true, [1, 0.5]))).toBe(false);
  });

  it('false when closed but a price is missing', () => {
    expect(isMarketResolved(priceResponse(true, [1, null]))).toBe(false);
    expect(isMarketResolved({ closed: true, outcomes: [] })).toBe(false);
  });
});

describe('decideThresholdResolution', () => {
  const base = { ageMs: 600_000, minResolveAgeMs: 300_000, marketResolved: false };

  it('mid-market price: update, no resolution', () => {
    expect(decideThresholdResolution({ ...base, entryPrice: 0.5, currentPrice: 0.6 }))
      .toEqual({ action: 'update' });
  });

  it('after-entry cross with Gamma confirmation: resolve at final outcome', () => {
    expect(decideThresholdResolution({ ...base, entryPrice: 0.5, currentPrice: 1, marketResolved: true }))
      .toEqual({ action: 'resolve', exitPrice: 1, confirmed: true });
    expect(decideThresholdResolution({ ...base, entryPrice: 0.5, currentPrice: 0, marketResolved: true }))
      .toEqual({ action: 'resolve', exitPrice: 0, confirmed: true });
  });

  it('after-entry cross without confirmation: price-proxy fallback', () => {
    expect(decideThresholdResolution({ ...base, entryPrice: 0.5, currentPrice: 0.95 }))
      .toEqual({ action: 'resolve', exitPrice: 1, confirmed: false });
    expect(decideThresholdResolution({ ...base, entryPrice: 0.5, currentPrice: 0.05 }))
      .toEqual({ action: 'resolve', exitPrice: 0, confirmed: false });
  });

  it('entry already beyond threshold: NEVER price-proxy resolved (the 0x12d6 longshot artifact)', () => {
    // longshot bought at 0.03, market still trades 0.03 — previously insta-booked as a $5 loss
    expect(decideThresholdResolution({ ...base, entryPrice: 0.03, currentPrice: 0.03 }))
      .toEqual({ action: 'hold' });
    // favorite bought at 0.95, market still at 0.95 — previously insta-booked as a win
    expect(decideThresholdResolution({ ...base, entryPrice: 0.95, currentPrice: 0.96 }))
      .toEqual({ action: 'hold' });
  });

  it('entry beyond threshold WITH Gamma confirmation: resolves at final outcome', () => {
    expect(decideThresholdResolution({ ...base, entryPrice: 0.03, currentPrice: 1, marketResolved: true }))
      .toEqual({ action: 'resolve', exitPrice: 1, confirmed: true });
    expect(decideThresholdResolution({ ...base, entryPrice: 0.03, currentPrice: 0, marketResolved: true }))
      .toEqual({ action: 'resolve', exitPrice: 0, confirmed: true });
  });

  it('after-entry cross younger than one price-update interval: update (no proxy resolve yet)', () => {
    expect(decideThresholdResolution({ ...base, entryPrice: 0.5, currentPrice: 0.95, ageMs: 60_000 }))
      .toEqual({ action: 'update' });
  });

  it('confirmed resolution ignores the age gate', () => {
    expect(decideThresholdResolution({ ...base, entryPrice: 0.5, currentPrice: 1, ageMs: 1_000, marketResolved: true }))
      .toEqual({ action: 'resolve', exitPrice: 1, confirmed: true });
  });
});

describe('snapDelistExitPrice', () => {
  it('snaps decided-looking last prices to the actual payout', () => {
    expect(snapDelistExitPrice(0.93)).toBe(1);
    expect(snapDelistExitPrice(0.97)).toBe(1);
    expect(snapDelistExitPrice(1)).toBe(1);
    expect(snapDelistExitPrice(0.07)).toBe(0);
    expect(snapDelistExitPrice(0.02)).toBe(0);
    expect(snapDelistExitPrice(0)).toBe(0);
  });

  it('leaves mid prices unchanged (outcome unknowable from a delisting)', () => {
    expect(snapDelistExitPrice(0.5)).toBe(0.5);
    expect(snapDelistExitPrice(0.929)).toBe(0.929);
    expect(snapDelistExitPrice(0.071)).toBe(0.071);
  });
});

describe('decideDelistExit', () => {
  const resolvedMarket: RawPriceResponse = {
    slug: 'foo', closed: true,
    outcomes: [
      { outcome: 'Yes', midpoint: 1, last_trade: null },
      { outcome: 'No',  midpoint: 0, last_trade: null },
    ],
  };

  it('books the Gamma-confirmed payout per outcome, regardless of last price', () => {
    // Winner whose last live price was mid-range — previously expired at 0.55.
    expect(decideDelistExit(resolvedMarket, 'Yes', 0.55))
      .toEqual({ exitPrice: 1, status: 'resolved', confirmed: true });
    expect(decideDelistExit(resolvedMarket, 'No', 0.45))
      .toEqual({ exitPrice: 0, status: 'resolved', confirmed: true });
    // Case-insensitive outcome match.
    expect(decideDelistExit(resolvedMarket, 'yes', 0.10))
      .toEqual({ exitPrice: 1, status: 'resolved', confirmed: true });
  });

  it('falls back to price snap when Gamma did not confirm', () => {
    expect(decideDelistExit(null, 'Yes', 0.97))
      .toEqual({ exitPrice: 1, status: 'resolved', confirmed: false });
    expect(decideDelistExit(null, 'Yes', 0.03))
      .toEqual({ exitPrice: 0, status: 'resolved', confirmed: false });
    expect(decideDelistExit(null, 'Yes', 0.5))
      .toEqual({ exitPrice: 0.5, status: 'expired', confirmed: false });
  });

  it('falls back to price snap when the position outcome is missing from the Gamma payload', () => {
    expect(decideDelistExit(resolvedMarket, 'Draw', 0.5))
      .toEqual({ exitPrice: 0.5, status: 'expired', confirmed: false });
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

describe('isRateLimitError', () => {
  it('flags HTTP 429 so the sweep never counts it toward marking a market dead', () => {
    expect(isRateLimitError(new Error('HTTP 429 from https://gamma-api.polymarket.com/markets?slug=x'))).toBe(true);
  });
  it('leaves real failures (404, network) to the dead-market threshold', () => {
    expect(isRateLimitError(new Error('HTTP 404 from https://gamma-api.polymarket.com/markets?slug=x'))).toBe(false);
    expect(isRateLimitError(new Error('No market found for slug: x'))).toBe(false);
    expect(isRateLimitError('HTTP 429')).toBe(false);
  });
});

describe('costBreakdown', () => {
  it('gross minus every cost equals the summed cost-adjusted PnL; open trades are skipped', () => {
    const a = makeClosedTrade();
    const b = makeClosedTrade({ id: 'c2', feeRate: 0.05, entryFeeCost: 0.1, exitFeeCost: 0.05, entrySlippageCost: 0.07 });
    const r = costBreakdown([a, b, makeOpenTrade()]);
    expect(r.trades).toBe(2);
    expect(r.gross).toBeCloseTo((a.realizedPnl ?? 0) + (b.realizedPnl ?? 0), 10);
    expect(r.fees).toBeCloseTo(0.15, 10);
    expect(r.gross - r.entrySlippage - r.exitSlippage - r.fees - r.gas).toBeCloseTo(r.net, 10);
    expect(r.net).toBeCloseTo(tradeCostAdjustedPnl(a) + tradeCostAdjustedPnl(b), 10);
  });
});
