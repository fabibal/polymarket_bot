import { describe, it, expect } from 'vitest';
import {
  evaluateForwardTest, buildReadiness, ForwardTestPlan, MIN_MARKETS_FOR_VERDICT, MIN_FORWARD_DAYS,
} from '../src/forwardtest';
import { SimulatedTrade } from '../src/types';

const PLAN: ForwardTestPlan = {
  address: '0xabc',
  label: 'Test-Trader',
  startedAt: '2026-09-26T15:00:00Z',
  marketMean: 1,
  marketSd: 5,
  marketsPerDay: 2,
  backtestNote: 'test',
};
const START = Date.parse(PLAN.startedAt);
const pnlOf = (t: SimulatedTrade) => t.costAdjustedPnl ?? 0;

let seq = 0;
function lot(slug: string, pnl: number, status: SimulatedTrade['status'] = 'resolved', ts = '2026-09-27T00:00:00Z'): SimulatedTrade {
  return {
    id: 'l' + (++seq), sourceTradeId: 's' + seq, timestamp: ts, copiedTrader: PLAN.address,
    copiedTraderRank: 0, copiedTraderSource: 'watchlist', marketSlug: slug, marketTitle: slug,
    outcome: 'Yes', side: 'buy', entryPrice: 0.5, simulatedAmount: 5, simulatedShares: 10,
    status, costAdjustedPnl: pnl,
  };
}

describe('evaluateForwardTest', () => {
  it('counts a market only when all its lots are closed; open lots go to unrealized', () => {
    const r = evaluateForwardTest(PLAN, [
      lot('m1', 2), lot('m1', 1),          // settled, +3
      lot('m2', -1), lot('m2', 4, 'open'), // one lot still open -> not settled
      lot('m3', 0.5, 'expired'),           // settled
    ], START + 86_400_000, pnlOf);
    expect(r.lots).toBe(5);
    expect(r.openLots).toBe(1);
    expect(r.settledMarkets).toBe(2);
    expect(r.openMarkets).toBe(1);
    expect(r.actualPnl).toBeCloseTo(3.5, 10);
    expect(r.unrealizedPnl).toBeCloseTo(4, 10);
    expect(r.expectedPnl).toBeCloseTo(2, 10);
    expect(r.bandLow).toBeCloseTo(2 - 1.645 * 5 * Math.SQRT2, 10);
    expect(r.status).toBe('early');
  });

  it('ignores lots opened before the plan started', () => {
    const r = evaluateForwardTest(PLAN, [lot('old', 100, 'resolved', '2026-09-20T00:00:00Z')], START, pnlOf);
    expect(r.lots).toBe(0);
    expect(r.status).toBe('no-trades');
  });

  it('calls below / within / above against the 90% band once enough markets settled', () => {
    const n = MIN_MARKETS_FOR_VERDICT + 6; // 16 markets: expected 16, half band 1.645*5*4 = 32.9
    const mk = (each: number) => Array.from({ length: n }, (_, i) => lot('m' + i, each));
    expect(evaluateForwardTest(PLAN, mk(1), START, pnlOf).status).toBe('within');
    expect(evaluateForwardTest(PLAN, mk(-2), START, pnlOf).status).toBe('below');  // -32 < 16 - 32.9
    expect(evaluateForwardTest(PLAN, mk(4), START, pnlOf).status).toBe('above');   // 64 > 48.9
    const z = evaluateForwardTest(PLAN, mk(-2), START, pnlOf).z!;
    expect(z).toBeCloseTo((-32 - 16) / (5 * 4), 10);
  });

  it('target = markets for the backtest edge to clear 1.645 sd, ETA at the backtest pace', () => {
    const r = evaluateForwardTest(PLAN, [], START, pnlOf);
    expect(r.targetMarkets).toBe(Math.ceil((1.645 * 5 / 1) ** 2)); // 68
    expect(Date.parse(r.targetEta)).toBe(START + (68 / 2) * 86_400_000);
  });
});

describe('buildReadiness', () => {
  it('forward-days and trader-on-track are automatic; build items start not done', () => {
    const early = evaluateForwardTest(PLAN, [lot('m1', 1)], START, pnlOf);
    const items = buildReadiness([early], START + 5 * 86_400_000);
    const byKey = Object.fromEntries(items.map(i => [i.key, i]));
    expect(byKey['forward-days'].done).toBe(false);
    expect(byKey['forward-days'].detail).toBe(`5 / ${MIN_FORWARD_DAYS} days`);
    expect(byKey['trader-on-track'].done).toBe(false);
    expect(byKey['orders'].done).toBe(false);
    expect(byKey['limits'].auto).toBe(false);
  });

  it('a trader inside its band after 30+ settled markets satisfies trader-on-track', () => {
    const lots = Array.from({ length: 30 }, (_, i) => lot('m' + i, 1));
    const r = evaluateForwardTest(PLAN, lots, START, pnlOf);
    const items = buildReadiness([r], START + MIN_FORWARD_DAYS * 86_400_000);
    expect(items.find(i => i.key === 'trader-on-track')!.done).toBe(true);
    expect(items.find(i => i.key === 'forward-days')!.done).toBe(true);
  });
});
