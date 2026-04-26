/**
 * Pure filter predicates mirroring the inline logic in monitor.ts.
 *
 * These are kept as a separate, side-effect-free module so the financial /
 * trading filters can be unit-tested without spinning up the full polling
 * loop. monitor.ts is not refactored to call these helpers (the 74.9% WR
 * strategy logic is frozen) — they exist purely as a test scaffold and
 * documentation of the rules.
 *
 * If monitor.ts is ever refactored to use this module, the tests in
 * tests/filters.test.ts will catch any divergence.
 */
import { RawPriceResponse } from './bullpen';

export interface PriceLimits {
  minPrice: number;
  minPriceSports: number;
  maxPrice: number;
}

export type FilterReason =
  | 'ok'
  | 'category-excluded'
  | 'price-below-min'
  | 'price-below-min-sports'
  | 'price-above-max'
  | 'spread-too-wide';

/** A category is sports-like if it uses the MIN_PRICE_SPORTS floor. */
export function isSportsCategory(category: string): boolean {
  return category === 'sports' || category === 'esports';
}

/** Return the min-price floor that applies to this category. */
export function effectiveMinPrice(category: string, limits: PriceLimits): number {
  return isSportsCategory(category) ? limits.minPriceSports : limits.minPrice;
}

export function isCategoryExcluded(category: string, excludedCategories: readonly string[]): boolean {
  return excludedCategories.includes(category);
}

/**
 * Combined price/category check. Returns the specific failure reason or 'ok'.
 * Mirrors the BUY gate in monitor.ts (both real and shadow modes).
 */
export function checkBuyFilters(
  price: number,
  category: string,
  excludedCategories: readonly string[],
  limits: PriceLimits,
): FilterReason {
  if (isCategoryExcluded(category, excludedCategories)) return 'category-excluded';
  if (price > limits.maxPrice) return 'price-above-max';
  const floor = effectiveMinPrice(category, limits);
  if (price < floor) {
    return isSportsCategory(category) ? 'price-below-min-sports' : 'price-below-min';
  }
  return 'ok';
}

export function isSpreadOverLimit(spread: number | null, maxSpread: number): boolean {
  // null = unknown spread (API didn't return best_bid/best_ask/spread) → don't block
  return spread !== null && spread > maxSpread;
}

/**
 * Extract the spread for a given outcome from a RawPriceResponse.
 * Prefers the explicit `spread` field; falls back to best_ask - best_bid.
 * Returns null if the outcome is missing or neither path yields numbers.
 */
export function getOutcomeSpread(data: RawPriceResponse, outcome: string): number | null {
  if (!Array.isArray(data.outcomes)) return null;
  const entry = data.outcomes.find(o => o.outcome.toLowerCase() === outcome.toLowerCase());
  if (!entry) return null;
  if (typeof entry.spread === 'number') return entry.spread;
  if (typeof entry.best_ask === 'number' && typeof entry.best_bid === 'number') {
    return entry.best_ask - entry.best_bid;
  }
  return null;
}

export interface WatchlistEntry {
  marketSlug: string;
  copiedTraderSource?: 'leaderboard' | 'watchlist';
  timestamp: string; // ISO
}

/**
 * Counts watchlist BUYs on a given market within a rolling window.
 * Inspects both still-open and previously-closed trades — the existing
 * MAX_POSITIONS_PER_MARKET counts only concurrent positions, so sequential
 * BUY-SELL-BUY cycles on fast sports/tennis markets slip past it.
 */
export function countWatchlistEntriesInWindow(
  openTrades: ReadonlyArray<WatchlistEntry>,
  closedTrades: ReadonlyArray<WatchlistEntry>,
  marketSlug: string,
  nowMs: number,
  windowMs: number,
): number {
  const cutoff = nowMs - windowMs;
  let n = 0;
  for (const t of openTrades) {
    if (t.copiedTraderSource !== 'watchlist') continue;
    if (t.marketSlug !== marketSlug) continue;
    const tsMs = Date.parse(t.timestamp);
    if (Number.isNaN(tsMs)) continue;
    if (tsMs >= cutoff) n++;
  }
  for (const t of closedTrades) {
    if (t.copiedTraderSource !== 'watchlist') continue;
    if (t.marketSlug !== marketSlug) continue;
    const tsMs = Date.parse(t.timestamp);
    if (Number.isNaN(tsMs)) continue;
    if (tsMs >= cutoff) n++;
  }
  return n;
}
