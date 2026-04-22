import { describe, it, expect } from 'vitest';
import {
  isSportsCategory,
  effectiveMinPrice,
  isCategoryExcluded,
  checkBuyFilters,
  isSpreadOverLimit,
  getOutcomeSpread,
  PriceLimits,
} from '../src/filters';

// Production defaults at the time of writing — matches docker-compose.yml
const LIMITS: PriceLimits = { minPrice: 0.65, minPriceSports: 0.60, maxPrice: 0.88 };

describe('isSportsCategory', () => {
  it('treats sports and esports as sports-like', () => {
    expect(isSportsCategory('sports')).toBe(true);
    expect(isSportsCategory('esports')).toBe(true);
    expect(isSportsCategory('politics')).toBe(false);
    expect(isSportsCategory('crypto')).toBe(false);
  });
});

describe('effectiveMinPrice', () => {
  it('uses MIN_PRICE_SPORTS for sports and MIN_PRICE for everything else', () => {
    expect(effectiveMinPrice('sports',   LIMITS)).toBe(0.60);
    expect(effectiveMinPrice('esports',  LIMITS)).toBe(0.60);
    expect(effectiveMinPrice('politics', LIMITS)).toBe(0.65);
    expect(effectiveMinPrice('other',    LIMITS)).toBe(0.65);
  });
});

describe('isCategoryExcluded', () => {
  it('matches excluded category exactly', () => {
    expect(isCategoryExcluded('esports', ['esports'])).toBe(true);
    expect(isCategoryExcluded('sports',  ['esports'])).toBe(false);
    expect(isCategoryExcluded('sports',  [])).toBe(false);
  });
});

describe('checkBuyFilters', () => {
  it('blocks trades in an excluded category', () => {
    expect(checkBuyFilters(0.70, 'esports', ['esports'], LIMITS)).toBe('category-excluded');
  });

  it('blocks trades above MAX_PRICE', () => {
    expect(checkBuyFilters(0.90, 'politics', [], LIMITS)).toBe('price-above-max');
  });

  it('blocks non-sports trades below MIN_PRICE with price-below-min reason', () => {
    expect(checkBuyFilters(0.50, 'politics', [], LIMITS)).toBe('price-below-min');
    // 0.62 is above sports floor 0.60 but below main floor 0.65 — non-sports → blocked
    expect(checkBuyFilters(0.62, 'crypto',   [], LIMITS)).toBe('price-below-min');
  });

  it('uses MIN_PRICE_SPORTS for sports with price-below-min-sports reason', () => {
    // 0.55 is below the sports floor 0.60 → blocked for sports
    expect(checkBuyFilters(0.55, 'sports', [], LIMITS)).toBe('price-below-min-sports');
    // 0.62 is above sports floor (0.60) even though it's below MIN_PRICE (0.65) → OK
    expect(checkBuyFilters(0.62, 'sports', [], LIMITS)).toBe('ok');
  });

  it('passes a typical in-range politics trade', () => {
    expect(checkBuyFilters(0.75, 'politics', ['esports'], LIMITS)).toBe('ok');
  });

  it('category exclusion takes precedence over price checks', () => {
    // price is in range BUT category excluded
    expect(checkBuyFilters(0.75, 'esports', ['esports'], LIMITS)).toBe('category-excluded');
  });
});

describe('isSpreadOverLimit', () => {
  it('returns true when spread strictly exceeds MAX_SPREAD', () => {
    expect(isSpreadOverLimit(0.06, 0.05)).toBe(true);
  });
  it('returns false when spread is at or below MAX_SPREAD (inclusive)', () => {
    expect(isSpreadOverLimit(0.05, 0.05)).toBe(false);
    expect(isSpreadOverLimit(0.01, 0.05)).toBe(false);
  });
  it('returns false when spread is unknown (null) — matches monitor.ts behaviour', () => {
    expect(isSpreadOverLimit(null, 0.05)).toBe(false);
  });
});

describe('getOutcomeSpread', () => {
  it('prefers the explicit spread field', () => {
    const data = { outcomes: [{ outcome: 'Yes', spread: 0.03, best_bid: 0.70, best_ask: 0.80 }] } as any;
    expect(getOutcomeSpread(data, 'Yes')).toBe(0.03);
  });

  it('falls back to best_ask - best_bid when spread field absent', () => {
    const data = { outcomes: [{ outcome: 'Yes', best_bid: 0.70, best_ask: 0.76 }] } as any;
    expect(getOutcomeSpread(data, 'Yes')).toBeCloseTo(0.06, 10);
  });

  it('is case-insensitive on outcome match', () => {
    const data = { outcomes: [{ outcome: 'Yes', spread: 0.03 }] } as any;
    expect(getOutcomeSpread(data, 'YES')).toBe(0.03);
    expect(getOutcomeSpread(data, 'yes')).toBe(0.03);
  });

  it('returns null when outcomes is missing or outcome not found', () => {
    expect(getOutcomeSpread({} as any, 'Yes')).toBeNull();
    expect(getOutcomeSpread({ outcomes: [{ outcome: 'No', spread: 0.02 }] } as any, 'Yes')).toBeNull();
  });
});
