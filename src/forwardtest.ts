/**
 * Forward test of the copy-enabled traders against their backtest.
 *
 * scripts/backtest_mirror.js (live copy model "A", measured cost x1, current
 * per-market taker fees) gives each trader a per-MARKET PnL distribution:
 * markets are its bootstrap unit because the lots within a market are
 * correlated. The live copy ledger is compared on the same unit, so a market
 * counts once all of its copied lots are closed. After m settled markets the
 * backtest predicts m * mean, with a 90% band of +-1.645 * sd * sqrt(m).
 */
import type { SimulatedTrade } from './types';

export interface ForwardTestPlan {
  address: string;
  label: string;
  startedAt: string;      // copying switched on
  marketMean: number;     // backtest $ per market
  marketSd: number;       // backtest sd of $ per market
  marketsPerDay: number;  // backtest pace (approximate: markets / active days)
  backtestNote: string;
}

// First look at the three LowFreq traders (see docs/decisions.md).
export const FORWARD_TEST_REVIEW_DATE = '2026-10-17';

// Backtests run 2026-09-26 over each trader's history to that day. Active days
// are approximate: Politics from 2026-02-01 (237 d), Tennis from 2026-05-01 (148 d).
export const FORWARD_TESTS: ForwardTestPlan[] = [
  {
    address: '0x2f633efb75256a2f2445110c8978684ab8936643',
    label: 'LowFreq-Events-0926',
    startedAt: '2026-09-26T15:08:47Z',
    marketMean: 1.197, marketSd: 7.531, marketsPerDay: 834 / 365,
    backtestNote: '12 months: 834 markets, +$998 (90% CI +$665..+$1,381)',
  },
  {
    address: '0x17b6db364608de19e1de27792d69335101970be9',
    label: 'LowFreq-Politics-0926',
    startedAt: '2026-09-26T15:08:47Z',
    marketMean: 2.246, marketSd: 8.249, marketsPerDay: 122 / 237,
    backtestNote: 'Feb-Sep 2026: 122 markets, +$274 (90% CI +$131..+$425)',
  },
  {
    address: '0xb7aba0e44edb6773c3b3a8308aae8a24781fa2d1',
    label: 'LowFreq-Tennis-0926',
    startedAt: '2026-09-26T15:08:47Z',
    marketMean: 0.705, marketSd: 5.587, marketsPerDay: 189 / 148,
    backtestNote: 'May-Sep 2026: 189 markets, +$133 (90% CI +$8..+$260)',
  },
];

const Z90 = 1.645;
// Below this many settled markets the band is too wide to call anything.
export const MIN_MARKETS_FOR_VERDICT = 10;

export type ForwardStatus = 'no-trades' | 'early' | 'below' | 'within' | 'above';

export interface ForwardTestResult {
  address: string;
  label: string;
  startedAt: string;
  daysElapsed: number;
  lots: number;
  openLots: number;
  settledMarkets: number;
  openMarkets: number;
  actualPnl: number;         // settled markets, cost-adjusted
  unrealizedPnl: number;     // open lots, cost-adjusted at the current mark
  expectedPnl: number;
  bandLow: number;
  bandHigh: number;
  z: number | null;
  status: ForwardStatus;
  targetMarkets: number;     // markets for the backtest edge to clear its own noise
  targetEta: string;         // start + targetMarkets at the backtest pace
  reviewDate: string;
  marketMean: number;
  marketSd: number;
  backtestNote: string;
}

/**
 * `trades` = the trader's copy-ledger lots (open and closed); lots opened
 * before plan.startedAt are ignored. `pnlOf` is the cost-adjusted PnL of a lot
 * (tradeCostAdjustedPnl in the bot).
 */
export function evaluateForwardTest(
  plan: ForwardTestPlan,
  trades: SimulatedTrade[],
  nowMs: number,
  pnlOf: (t: SimulatedTrade) => number,
): ForwardTestResult {
  const startMs = Date.parse(plan.startedAt);
  const lots = trades.filter(t => Date.parse(t.timestamp) >= startMs);
  const byMarket = new Map<string, { pnl: number; open: number }>();
  let unrealizedPnl = 0;
  for (const t of lots) {
    const m = byMarket.get(t.marketSlug) ?? { pnl: 0, open: 0 };
    if (t.status === 'open') { m.open++; unrealizedPnl += pnlOf(t); } else m.pnl += pnlOf(t);
    byMarket.set(t.marketSlug, m);
  }
  let settledMarkets = 0, openMarkets = 0, actualPnl = 0;
  for (const m of byMarket.values()) {
    if (m.open > 0) openMarkets++;
    else { settledMarkets++; actualPnl += m.pnl; }
  }

  const expectedPnl = settledMarkets * plan.marketMean;
  const halfBand = Z90 * plan.marketSd * Math.sqrt(settledMarkets);
  const bandLow = expectedPnl - halfBand;
  const bandHigh = expectedPnl + halfBand;
  const z = settledMarkets > 0 && plan.marketSd > 0
    ? (actualPnl - expectedPnl) / (plan.marketSd * Math.sqrt(settledMarkets))
    : null;

  let status: ForwardStatus;
  if (lots.length === 0) status = 'no-trades';
  else if (settledMarkets < MIN_MARKETS_FOR_VERDICT) status = 'early';
  else if (actualPnl < bandLow) status = 'below';
  else if (actualPnl > bandHigh) status = 'above';
  else status = 'within';

  const targetMarkets = plan.marketMean > 0
    ? Math.ceil((Z90 * plan.marketSd / plan.marketMean) ** 2)
    : Number.POSITIVE_INFINITY;
  const targetEta = new Date(startMs + (targetMarkets / plan.marketsPerDay) * 86_400_000).toISOString();

  return {
    address: plan.address,
    label: plan.label,
    startedAt: new Date(startMs).toISOString(),
    daysElapsed: Math.max(0, (nowMs - startMs) / 86_400_000),
    lots: lots.length,
    openLots: lots.filter(t => t.status === 'open').length,
    settledMarkets,
    openMarkets,
    actualPnl,
    unrealizedPnl,
    expectedPnl,
    bandLow,
    bandHigh,
    z,
    status,
    targetMarkets,
    targetEta,
    reviewDate: FORWARD_TEST_REVIEW_DATE,
    marketMean: plan.marketMean,
    marketSd: plan.marketSd,
    backtestNote: plan.backtestNote,
  };
}

// ── Live-readiness checklist ────────────────────────────────────────────────
// The steps agreed on 2026-09-26 before any real-money test. The automatic
// items come from the forward test; the build items flip to true here when the
// work exists. DRY_RUN itself only changes on an explicit instruction.
export const READINESS_BUILD_STATUS = {
  orders: false,   // live order placement: buy, sell, redeem, fill readback
  limits: false,   // max order, max open, daily loss stop, dashboard kill switch
  account: false,  // deposit, approvals, one manual $1 buy + sell
};

export const MIN_FORWARD_DAYS = 21;
export const MIN_MARKETS_ON_TRACK = 30;

export interface ReadinessItem {
  key: string;
  label: string;
  done: boolean;
  detail: string;
  auto: boolean;
}

export function buildReadiness(results: ForwardTestResult[], nowMs: number): ReadinessItem[] {
  const startMs = results.length > 0
    ? Math.min(...results.map(r => Date.parse(r.startedAt)))
    : nowMs;
  const days = Math.max(0, (nowMs - startMs) / 86_400_000);
  const onTrack = results.filter(r => r.settledMarkets >= MIN_MARKETS_ON_TRACK && (r.status === 'within' || r.status === 'above'));
  const best = [...results].sort((a, b) => b.settledMarkets - a.settledMarkets)[0];
  return [
    {
      key: 'forward-days',
      label: `At least ${MIN_FORWARD_DAYS} days of forward test`,
      done: days >= MIN_FORWARD_DAYS,
      detail: `${Math.floor(days)} / ${MIN_FORWARD_DAYS} days`,
      auto: true,
    },
    {
      key: 'trader-on-track',
      label: `A trader within or above its backtest band after ${MIN_MARKETS_ON_TRACK}+ settled markets`,
      done: onTrack.length > 0,
      detail: onTrack.length > 0
        ? onTrack.map(r => r.label).join(', ')
        : best ? `best so far: ${best.label}, ${best.settledMarkets} / ${MIN_MARKETS_ON_TRACK} markets` : 'no forward test running',
      auto: true,
    },
    {
      key: 'orders',
      label: 'Live order placement (buy, sell, redeem, fill readback)',
      done: READINESS_BUILD_STATUS.orders,
      detail: READINESS_BUILD_STATUS.orders ? 'built' : 'not built',
      auto: false,
    },
    {
      key: 'limits',
      label: 'Safety limits (max order, max open, daily loss stop, kill switch)',
      done: READINESS_BUILD_STATUS.limits,
      detail: READINESS_BUILD_STATUS.limits ? 'built' : 'not built',
      auto: false,
    },
    {
      key: 'account',
      label: 'Account ready (deposit, approvals, one manual $1 buy + sell)',
      done: READINESS_BUILD_STATUS.account,
      detail: READINESS_BUILD_STATUS.account ? 'done' : 'not done',
      auto: false,
    },
  ];
}
