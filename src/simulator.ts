/**
 * Periodically fetches current prices for all open simulated positions
 * and updates unrealized PNL. Two auto-close conditions:
 *   1. Price threshold: ≥0.93 (WIN) or ≤0.07 (LOSS) → status 'resolved' —
 *      only once the position is at least one price-update interval old, so an
 *      entry already near the threshold (e.g. a favorite bought at 0.95) isn't
 *      instantly booked as a guaranteed win/loss on the very next sweep.
 *   2. Max hold age: older than MAX_HOLD_DAYS → closed at current price, status 'expired'
 */
import { getMarketPrice } from './bullpen';
import { readStore, updateOpenTradePrices, resolveByPrice } from './store';
import { CONFIG } from './config';
import { SimulatedTrade } from './types';

// ── Cost simulation helpers ────────────────────────────────────────────────
// These model live-trading frictions so DRY_RUN PNL is comparable to what a
// real account would have netted:
//   - GAS_COST_PER_BUY: fixed Polygon gas paid on entry
//   - entry slippage:  SLIPPAGE_RATE × entryPrice × shares (fills at ask, not mid)
//   - exit slippage:   SLIPPAGE_RATE × exitPrice × shares (fills at bid, not mid)
// The raw realizedPnl field stays mid-to-mid so historical records are intact;
// costAdjustedPnl is the net figure after fees.
export function computeEntryCosts(entryPrice: number, shares: number): { gas: number; slippage: number } {
  return {
    gas:      CONFIG.GAS_COST_PER_BUY,
    slippage: CONFIG.SLIPPAGE_RATE * entryPrice * shares,
  };
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
  if (t.status === 'open') {
    const mark = t.currentPrice ?? t.entryPrice;
    const eSlipExit = CONFIG.SLIPPAGE_RATE * mark * shares;
    return (t.unrealizedPnl ?? 0) - gas - eSlip - eSlipExit;
  }
  const xSlip = t.exitSlippageCost ?? CONFIG.SLIPPAGE_RATE * (t.exitPrice ?? 0) * shares;
  return (t.realizedPnl ?? 0) - gas - eSlip - xSlip;
}

export function tradeTotalCosts(t: SimulatedTrade): number {
  const shares = t.simulatedShares;
  const gas    = t.entryGasCost      ?? CONFIG.GAS_COST_PER_BUY;
  const eSlip  = t.entrySlippageCost ?? CONFIG.SLIPPAGE_RATE * t.entryPrice * shares;
  if (t.status === 'open') {
    const mark = t.currentPrice ?? t.entryPrice;
    return gas + eSlip + CONFIG.SLIPPAGE_RATE * mark * shares;
  }
  const xSlip = t.exitSlippageCost ?? CONFIG.SLIPPAGE_RATE * (t.exitPrice ?? 0) * shares;
  return gas + eSlip + xSlip;
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
const PRICE_FETCH_CONCURRENCY = 10; // parallel price fetches per batch

let priceUpdateRunning = false;

export async function updatePrices(): Promise<void> {
  if (priceUpdateRunning) {
    console.log('[simulator] Price update already in progress — skipping this cycle');
    return;
  }
  priceUpdateRunning = true;

  try {
    const store = readStore();
    if (store.openTrades.length === 0) return;

    const startMs = Date.now();
    console.log(`[simulator] Refreshing prices for ${store.openTrades.length} open position(s)...`);

    // Build slug → outcomes map (fetch each slug once, distribute to all its outcome positions)
    const slugOutcomes = new Map<string, Set<string>>();
    for (const t of store.openTrades) {
      if (!slugOutcomes.has(t.marketSlug)) slugOutcomes.set(t.marketSlug, new Set());
      slugOutcomes.get(t.marketSlug)!.add(t.outcome);
    }
    const uniqueSlugs = [...slugOutcomes.entries()].filter(([slug]) => !deadMarkets.has(slug));

    const priceUpdates: Array<{ id: string; currentPrice: number; unrealizedPnl: number }> = [];
    const resolutions: Array<{ id: string; exitPrice: number }> = [];
    const staleResolutions: Array<{ id: string; exitPrice: number }> = [];
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
          const fails = (fetchFailureCount.get(slug) ?? 0) + 1;
          fetchFailureCount.set(slug, fails);
          if (fails >= DEAD_THRESHOLD && !deadMarkets.has(slug)) {
            deadMarkets.add(slug);
            // Expire all open positions for this dead market at their last known price.
            // Markets that return 404 from the Gamma API have almost certainly resolved
            // and been removed — we can't know the final price, so we exit at last price.
            const deadPositions = store.openTrades.filter(t => t.marketSlug === slug);
            if (deadPositions.length > 0) {
              staleResolutions.push(
                ...deadPositions.map(t => ({ id: t.id, exitPrice: t.currentPrice ?? t.entryPrice }))
              );
              console.log(`[simulator] ${slug} — ${fails} fetch failures, marking dead, expiring ${deadPositions.length} position(s) at last price`);
            } else {
              console.log(`[simulator] ${slug} — ${fails} fetch failures, marking dead (no open positions)`);
            }
          } else if (fails < DEAD_THRESHOLD) {
            console.error(`[simulator] Price fetch failed for ${slug} (${fails}/${DEAD_THRESHOLD}):`, err instanceof Error ? err.message : err);
          }
          return;
        }

        for (const outcome of outcomes) {
          const currentPrice = extractOutcomePrice(data, outcome);
          if (currentPrice === null) continue;

          const related = store.openTrades.filter(t => t.marketSlug === slug && t.outcome === outcome);
          for (const trade of related) {
            const unrealizedPnl = (currentPrice - trade.entryPrice) * trade.simulatedShares;
            const ageMs = nowMs - new Date(trade.timestamp).getTime();
            if (currentPrice >= CONFIG.RESOLVED_THRESHOLD && ageMs >= minResolveAgeMs) {
              resolutions.push({ id: trade.id, exitPrice: 1 });
            } else if (currentPrice <= 1 - CONFIG.RESOLVED_THRESHOLD && ageMs >= minResolveAgeMs) {
              resolutions.push({ id: trade.id, exitPrice: 0 });
            } else if (ageMs > maxAgeMs) {
              staleResolutions.push({ id: trade.id, exitPrice: currentPrice });
            } else {
              priceUpdates.push({ id: trade.id, currentPrice, unrealizedPnl });
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
    const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(`[simulator] Price update complete — ${uniqueSlugs.length} slugs checked in ${elapsedS}s, ${resolutions.length} resolved, ${staleResolutions.length} expired`);
  } finally {
    priceUpdateRunning = false;
  }
}
