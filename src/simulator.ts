/**
 * Periodically fetches current prices for all open simulated positions
 * and updates unrealized PNL. Two auto-close conditions:
 *   1. Resolution (status 'resolved') when price is ≥0.93 (WIN) or ≤0.07 (LOSS):
 *      - Gamma-confirmed: market `closed` with all outcome prices pinned to 0/1
 *        → book the actual final outcome immediately.
 *      - Entry already beyond the threshold (e.g. a 0.03 longshot or a 0.95
 *        favorite): NEVER resolved by price proxy — the price can't distinguish
 *        "still where it started" from "decided". Held until Gamma confirms,
 *        a copy-SELL closes it, or max-hold expiry. (Before 2026-06-10 these
 *        were insta-booked as total wins/losses while the market was still
 *        live, corrupting longshot statistics.)
 *      - Entry crossed the threshold after open: price-proxy resolve (legacy
 *        behavior) once at least one price-update interval old — Gamma rarely
 *        shows sports markets as resolved before delisting them, so requiring
 *        confirmation there would misbook winners as 'expired' at last price.
 *        Each proxy resolve is logged clearly for auditability.
 *   2. Max hold age: older than MAX_HOLD_DAYS → closed at current price, status 'expired'
 */
import { getMarketPrice, RawPriceResponse } from './bullpen';
import {
  readStore, updateOpenTradePrices, resolveByPrice,
  updateObservationTradePrices, resolveObservationByPrice,
} from './store';
import { CONFIG } from './config';
import { takerFeeCost } from './fees';
import { SimulatedTrade } from './types';

// ── Cost simulation helpers ────────────────────────────────────────────────
// These model live-trading frictions so DRY_RUN PNL is comparable to what a
// real account would have netted:
//   - GAS_COST_PER_BUY: fixed Polygon gas paid on entry
//   - entry slippage:  SLIPPAGE_RATE × entryPrice × shares (fills at ask, not mid)
//   - exit slippage:   SLIPPAGE_RATE × exitPrice × shares (fills at bid, not mid)
// The raw realizedPnl field stays mid-to-mid so historical records are intact;
// costAdjustedPnl is the net figure after fees.
export function computeEntryCosts(
  entryPrice: number,
  shares: number,
  gap?: number | null,
): { gas: number; slippage: number } {
  // Gap-based entry slippage when the real ask/trader-price gap is known
  // (watchlist BUYs carrying an orderbook snapshot): models the actual taker
  // cost of lifting the ask = (best_ask - trader_price) × shares. Floor at 0 —
  // a negative gap (stale snapshot, ask below the trader's booked price) must
  // not credit phantom profit. Falls back to flat SLIPPAGE_RATE × notional when
  // no snapshot exists (depth fetch failed, or the raw observation ledger).
  // The flat 2% model understated real cost ~2x on cheap outcomes (gap is
  // absolute cents; 2% is relative) — see docs/decisions.md 2026-06-19.
  const slippage = gap != null
    ? Math.max(0, gap) * shares
    : CONFIG.SLIPPAGE_RATE * entryPrice * shares;
  return { gas: CONFIG.GAS_COST_PER_BUY, slippage };
}

/**
 * Total cost-adjusted PNL for a trade (open or closed). Falls back to
 * recomputing from price/shares when stored cost fields are missing
 * (historical trades written before cost simulation was added).
 */
export function tradeCostAdjustedPnl(t: SimulatedTrade): number {
  const shares = t.simulatedShares;
  const gas    = t.entryGasCost      ?? CONFIG.GAS_COST_PER_BUY;
  const eSlip  = t.entrySlippageCost ?? CONFIG.SLIPPAGE_RATE * t.entryPrice * shares;
  const eFee   = t.entryFeeCost ?? 0;
  if (t.status === 'open') {
    const mark = t.currentPrice ?? t.entryPrice;
    const eSlipExit = CONFIG.SLIPPAGE_RATE * mark * shares;
    return (t.unrealizedPnl ?? 0) - gas - eSlip - eSlipExit - eFee - takerFeeCost(t.feeRate, mark, shares);
  }
  const xSlip = t.exitSlippageCost ?? CONFIG.SLIPPAGE_RATE * (t.exitPrice ?? 0) * shares;
  const xFee  = t.exitFeeCost ?? takerFeeCost(t.feeRate, t.exitPrice ?? 0, shares);
  return (t.realizedPnl ?? 0) - gas - eSlip - xSlip - eFee - xFee;
}

export function tradeTotalCosts(t: SimulatedTrade): number {
  const shares = t.simulatedShares;
  const gas    = t.entryGasCost      ?? CONFIG.GAS_COST_PER_BUY;
  const eSlip  = t.entrySlippageCost ?? CONFIG.SLIPPAGE_RATE * t.entryPrice * shares;
  const eFee   = t.entryFeeCost ?? 0;
  if (t.status === 'open') {
    const mark = t.currentPrice ?? t.entryPrice;
    return gas + eSlip + CONFIG.SLIPPAGE_RATE * mark * shares + eFee + takerFeeCost(t.feeRate, mark, shares);
  }
  const xSlip = t.exitSlippageCost ?? CONFIG.SLIPPAGE_RATE * (t.exitPrice ?? 0) * shares;
  return gas + eSlip + xSlip + eFee + (t.exitFeeCost ?? takerFeeCost(t.feeRate, t.exitPrice ?? 0, shares));
}

// ── Threshold-resolution decision ──────────────────────────────────────────

// A market is confirmed resolved when Gamma marks it closed AND every outcome
// price is pinned to 0/1 — outcomePrices stay at market levels until actual
// resolution, so pinned prices on a closed market mean the outcome is final.
const FINAL_PRICE_EPS = 0.005;
export function isMarketResolved(data: RawPriceResponse): boolean {
  if (data.closed !== true) return false;
  if (!Array.isArray(data.outcomes) || data.outcomes.length === 0) return false;
  return data.outcomes.every(o => {
    const p = o.midpoint ?? o.last_trade;
    return typeof p === 'number' && (p <= FINAL_PRICE_EPS || p >= 1 - FINAL_PRICE_EPS);
  });
}

export type ResolveDecision =
  | { action: 'resolve'; exitPrice: 0 | 1; confirmed: boolean }
  | { action: 'hold' }     // beyond-threshold entry, unconfirmed — keep open, mark to market
  | { action: 'update' };  // not at threshold (or too young to proxy-resolve)

export function decideThresholdResolution(args: {
  entryPrice: number;
  currentPrice: number;
  ageMs: number;
  minResolveAgeMs: number;
  marketResolved: boolean;
}): ResolveDecision {
  const T = CONFIG.RESOLVED_THRESHOLD;
  const crossedHigh = args.currentPrice >= T;
  const crossedLow  = args.currentPrice <= 1 - T;
  if (!crossedHigh && !crossedLow) return { action: 'update' };

  // Gamma-confirmed resolution: book the final outcome regardless of entry
  // price or position age — the market is genuinely over.
  if (args.marketResolved) return { action: 'resolve', exitPrice: crossedHigh ? 1 : 0, confirmed: true };

  // Entry already beyond the threshold: the price proxy carries no information
  // (the market sitting at 0.03 does not mean a 0.03 entry has lost).
  if (args.entryPrice >= T || args.entryPrice <= 1 - T) return { action: 'hold' };

  // Crossed after entry but not yet one full price-update interval old.
  if (args.ageMs < args.minResolveAgeMs) return { action: 'update' };

  // Legacy price-proxy fallback for after-entry crossers.
  return { action: 'resolve', exitPrice: crossedHigh ? 1 : 0, confirmed: false };
}

/**
 * Exit price for a position whose market got DELISTED from Gamma (FIX 1,
 * 2026-06-10). Delisting is the resolution event for sports markets that never
 * show closed:true, so a decided-looking last price snaps to the actual payout:
 * ≥0.93 → 1.00 (winner, previously clipped by ~the spread and mislabeled
 * 'expired'), ≤0.07 → 0.00, otherwise the last fetched price (unknown outcome).
 * Deliberately NOT applied to the max-hold (7d) expiry of still-listed markets:
 * a live market sitting at 0.95 is not resolved (e.g. the Fujimori election
 * market traded 0.935 for weeks while open) — there, last price is the honest
 * mark-to-market exit a real wallet could take.
 */
export function snapDelistExitPrice(lastPrice: number): number {
  // 1e-9 epsilon: 1 - 0.93 is 0.069999... in floats, and 0.07 is a real tick
  // that must snap to 0 per the ≤0.07 rule.
  if (lastPrice >= CONFIG.RESOLVED_THRESHOLD) return 1;
  if (lastPrice <= 1 - CONFIG.RESOLVED_THRESHOLD + 1e-9) return 0;
  return lastPrice;
}

/**
 * Exit decision for a position on a DELISTED market (2026-06-11). Preferred
 * path: the caller re-queries Gamma with `closed=true` (delisted resolved
 * markets stay retrievable there) and passes the market in when
 * isMarketResolved confirms it — the position's outcome books its actual
 * pinned payout (status 'resolved', even when the last live price was
 * mid-range and would previously have been guessed wrong). Fallback when
 * Gamma doesn't confirm: legacy last-price inference via snapDelistExitPrice
 * (decided-looking prices snap to 1/0 as 'resolved', mid prices exit
 * 'expired' at last price).
 */
export function decideDelistExit(
  resolvedMarket: RawPriceResponse | null,
  outcome: string,
  lastPrice: number,
): { exitPrice: number; status: 'resolved' | 'expired'; confirmed: boolean } {
  if (resolvedMarket) {
    const p = extractOutcomePrice(resolvedMarket, outcome);
    if (p !== null) return { exitPrice: p >= 0.5 ? 1 : 0, status: 'resolved', confirmed: true };
  }
  const snap = snapDelistExitPrice(lastPrice);
  const decided = snap !== lastPrice || lastPrice === 0 || lastPrice === 1;
  return { exitPrice: snap, status: decided ? 'resolved' : 'expired', confirmed: false };
}

// Log-once dedup for hold/proxy lines — beyond-threshold longshots would
// otherwise re-log on every 5-min sweep for days.
const loggedResolutionKeys = new Set<string>();
function logResolutionOnce(key: string, msg: string): void {
  if (loggedResolutionKeys.has(key)) return;
  if (loggedResolutionKeys.size > 2000) loggedResolutionKeys.clear();
  loggedResolutionKeys.add(key);
  console.log(msg);
}

function extractOutcomePrice(data: ReturnType<typeof getMarketPrice> extends Promise<infer T> ? T : never, outcome: string): number | null {
  if (!Array.isArray(data.outcomes)) return null;

  const entry = data.outcomes.find(o => o.outcome.toLowerCase() === outcome.toLowerCase());
  if (!entry) return null;

  // Prefer midpoint (live order book mid), fall back to last traded price
  const price = entry.midpoint ?? entry.last_trade;
  return typeof price === 'number' ? price : null;
}

// In-memory dead market tracking — resets on restart, which is fine
// (a few retries on boot is acceptable vs persisting to disk)
const fetchFailureCount = new Map<string, number>();
const deadMarkets       = new Set<string>();
const DEAD_THRESHOLD    = 3;
// Parallel price fetches per batch. Gamma accepted ~15 req/s on 2026-09-26:
// 10 (~80 req/s) drew 76-153 HTTP 429s per ~450-slug sweep, 4 (~20 req/s)
// still 68-112. 2 (~10 req/s) leaves headroom for the copy path's Gamma calls;
// a sweep then takes ~45s of its 5-minute interval.
const PRICE_FETCH_CONCURRENCY = 2;

// HTTP 429 means we were too fast, not that the market is gone.
export function isRateLimitError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('HTTP 429');
}

let priceUpdateRunning = false;

export async function updatePrices(): Promise<void> {
  if (priceUpdateRunning) {
    console.log('[simulator] Price update already in progress — skipping this cycle');
    return;
  }
  priceUpdateRunning = true;

  try {
    const store = readStore();
    // Observation positions (copy-disabled forward test) ride the same sweep.
    // Cache is open-only by invariant, so no status filter is needed here.
    const obsOpen = store.observationOpenTrades ?? [];
    if (store.openTrades.length === 0 && obsOpen.length === 0) return;

    const startMs = Date.now();
    console.log(`[simulator] Refreshing prices for ${store.openTrades.length} open position(s) + ${obsOpen.length} observation...`);

    // Build slug → outcomes map (fetch each slug once, distribute to all its outcome positions)
    const slugOutcomes = new Map<string, Set<string>>();
    for (const t of [...store.openTrades, ...obsOpen]) {
      if (!slugOutcomes.has(t.marketSlug)) slugOutcomes.set(t.marketSlug, new Set());
      slugOutcomes.get(t.marketSlug)!.add(t.outcome);
    }
    const uniqueSlugs = [...slugOutcomes.entries()].filter(([slug]) => !deadMarkets.has(slug));

    const priceUpdates: Array<{ id: string; currentPrice: number; unrealizedPnl: number }> = [];
    const resolutions: Array<{ id: string; exitPrice: number }> = [];
    const staleResolutions: Array<{ id: string; exitPrice: number }> = [];
    const obsPriceUpdates: Array<{ id: string; currentPrice: number; unrealizedPnl: number }> = [];
    const obsResolutions: Array<{ id: string; exitPrice: number }> = [];
    const obsStaleResolutions: Array<{ id: string; exitPrice: number }> = [];
    let rateLimited = 0; // slugs skipped this sweep on HTTP 429 (retried next sweep)
    const maxAgeMs = CONFIG.MAX_HOLD_DAYS * 86_400_000;
    // Threshold resolution requires the position to have lived through at least
    // one full price-update cycle. Without this, an entry at/near the threshold
    // (watchlist has no MAX_PRICE filter) was resolved at exitPrice 1/0 on the
    // first sweep after open, booking a guaranteed win/loss the real market
    // hadn't decided yet and biasing the go-live statistics.
    const minResolveAgeMs = CONFIG.PRICE_UPDATE_INTERVAL_MS;
    const nowMs = Date.now();

    // Process in concurrent batches to reduce total wall-clock time.
    // Each slug is fetched exactly once — its price data is shared across all outcome positions.
    // Node.js is single-threaded so array pushes are safe with Promise.all.
    for (let i = 0; i < uniqueSlugs.length; i += PRICE_FETCH_CONCURRENCY) {
      const batch = uniqueSlugs.slice(i, i + PRICE_FETCH_CONCURRENCY);
      await Promise.all(batch.map(async ([slug, outcomes]) => {
        if (deadMarkets.has(slug)) return; // re-check inside async in case another item in batch just marked it

        let data;
        try {
          data = await getMarketPrice(slug);
          fetchFailureCount.delete(slug); // reset on success
        } catch (err) {
          // Never count a 429 toward the dead threshold: three rate-limited
          // sweeps used to "kill" live markets and expire their positions at a
          // stale price. The slug is simply retried next sweep.
          if (isRateLimitError(err)) { rateLimited++; return; }
          const fails = (fetchFailureCount.get(slug) ?? 0) + 1;
          fetchFailureCount.set(slug, fails);
          if (fails >= DEAD_THRESHOLD && !deadMarkets.has(slug)) {
            deadMarkets.add(slug);
            // Expire all open positions for this dead market at their last known price.
            // Markets that return 404 from the Gamma API have almost certainly resolved
            // and been removed — we can't know the final price, so we exit at last price.
            const deadPositions = store.openTrades.filter(t => t.marketSlug === slug);
            const deadObs = obsOpen.filter(t => t.marketSlug === slug);
            if (deadPositions.length > 0 || deadObs.length > 0) {
              // Delisting = resolution. Ask Gamma directly with closed=true
              // (delisted resolved markets vanish from the default query but
              // stay retrievable with the closed filter) and book each
              // outcome's ACTUAL payout when confirmed. Only when Gamma
              // doesn't confirm fall back to last-price inference: snap
              // decided-looking prices to 1/0 as 'resolved', mid prices keep
              // the last-price 'expired' exit (outcome unknowable from here).
              let resolvedMarket: RawPriceResponse | null = null;
              try {
                const closedData = await getMarketPrice(slug, true);
                if (isMarketResolved(closedData)) resolvedMarket = closedData;
              } catch { /* not in Gamma even with closed=true — price fallback below */ }

              let confirmed = 0, snapped = 0, expired = 0;
              for (const [trades, res, stale] of [
                [deadPositions, resolutions, staleResolutions],
                [deadObs, obsResolutions, obsStaleResolutions],
              ] as const) {
                for (const t of trades) {
                  const last = t.currentPrice ?? t.entryPrice;
                  const exit = decideDelistExit(resolvedMarket, t.outcome, last);
                  if (exit.status === 'resolved') {
                    res.push({ id: t.id, exitPrice: exit.exitPrice });
                    exit.confirmed ? confirmed++ : snapped++;
                  } else {
                    stale.push({ id: t.id, exitPrice: exit.exitPrice });
                    expired++;
                  }
                }
              }
              console.log(`[simulator] ${slug} — ${fails} fetch failures, marking dead: ${confirmed} resolved at Gamma-confirmed payout, ${snapped} resolved at snapped payout, ${expired} expired at last price`);
            } else {
              console.log(`[simulator] ${slug} — ${fails} fetch failures, marking dead (no open positions)`);
            }
          } else if (fails < DEAD_THRESHOLD) {
            console.error(`[simulator] Price fetch failed for ${slug} (${fails}/${DEAD_THRESHOLD}):`, err instanceof Error ? err.message : err);
          }
          return;
        }

        const marketResolved = isMarketResolved(data);
        for (const outcome of outcomes) {
          const currentPrice = extractOutcomePrice(data, outcome);
          if (currentPrice === null) continue;

          // Same decision logic for real copies and observation positions —
          // only the sink arrays (and thus the target tables) differ.
          const groups: Array<{
            trades: SimulatedTrade[];
            upd: typeof priceUpdates; res: typeof resolutions; stale: typeof staleResolutions;
          }> = [
            { trades: store.openTrades.filter(t => t.marketSlug === slug && t.outcome === outcome),
              upd: priceUpdates, res: resolutions, stale: staleResolutions },
            { trades: obsOpen.filter(t => t.marketSlug === slug && t.outcome === outcome),
              upd: obsPriceUpdates, res: obsResolutions, stale: obsStaleResolutions },
          ];
          for (const g of groups) for (const trade of g.trades) {
            const unrealizedPnl = (currentPrice - trade.entryPrice) * trade.simulatedShares;
            const ageMs = nowMs - new Date(trade.timestamp).getTime();
            const decision = decideThresholdResolution({
              entryPrice: trade.entryPrice, currentPrice, ageMs, minResolveAgeMs, marketResolved,
            });
            if (decision.action === 'resolve') {
              if (!decision.confirmed) {
                logResolutionOnce(`proxy:${slug}:${outcome}`,
                  `[simulator] ${slug} ${outcome} — price-proxy resolve at ${currentPrice.toFixed(3)} (Gamma does not show market resolved)`);
              }
              g.res.push({ id: trade.id, exitPrice: decision.exitPrice });
            } else {
              if (decision.action === 'hold') {
                logResolutionOnce(`hold:${slug}:${outcome}`,
                  `[simulator] ${slug} ${outcome} at ${currentPrice.toFixed(3)} — entry ${trade.entryPrice.toFixed(3)} already beyond threshold, holding until Gamma confirms resolution`);
              }
              if (ageMs > maxAgeMs) {
                g.stale.push({ id: trade.id, exitPrice: currentPrice });
              } else {
                g.upd.push({ id: trade.id, currentPrice, unrealizedPnl });
              }
            }
          }
        }
      }));
    }

    if (priceUpdates.length) updateOpenTradePrices(priceUpdates);
    if (resolutions.length) {
      resolveByPrice(resolutions);
      console.log(`[simulator] Auto-resolved ${resolutions.length} trade(s) by price threshold`);
    }
    if (staleResolutions.length) {
      resolveByPrice(staleResolutions, 'expired');
      console.log(`[simulator] Expired ${staleResolutions.length} position(s) (age>${CONFIG.MAX_HOLD_DAYS}d or dead market)`);
    }
    if (obsPriceUpdates.length) updateObservationTradePrices(obsPriceUpdates);
    if (obsResolutions.length) {
      resolveObservationByPrice(obsResolutions);
      console.log(`[simulator] Auto-resolved ${obsResolutions.length} observation trade(s) by price threshold`);
    }
    if (obsStaleResolutions.length) {
      resolveObservationByPrice(obsStaleResolutions, 'expired');
      console.log(`[simulator] Expired ${obsStaleResolutions.length} observation position(s)`);
    }
    const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(`[simulator] Price update complete — ${uniqueSlugs.length} slugs checked in ${elapsedS}s, ${resolutions.length}+${obsResolutions.length} resolved, ${staleResolutions.length}+${obsStaleResolutions.length} expired${rateLimited ? `, ${rateLimited} rate-limited (retry next sweep)` : ''}`);
  } finally {
    priceUpdateRunning = false;
  }
}
