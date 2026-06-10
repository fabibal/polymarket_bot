import { describe, it, expect } from 'vitest';
import { resolveRiskThreshold } from '../src/config';

describe('resolveRiskThreshold', () => {
  it('explicit absolute env var wins over everything', () => {
    expect(resolveRiskThreshold('-42', '5', 1000, 5, -50)).toBe(-42);
    expect(resolveRiskThreshold('-42', undefined, 0, 5, -50)).toBe(-42);
  });

  it('derives from % of wallet when no absolute is set', () => {
    expect(resolveRiskThreshold(undefined, '5', 1000, 5, -50)).toBe(-50);
    expect(resolveRiskThreshold(undefined, '3', 1000, 3, -30)).toBe(-30);
    expect(resolveRiskThreshold(undefined, '3', 2000, 3, -30)).toBe(-60); // scales with wallet
  });

  it('uses the default % when the pct env var is missing or junk', () => {
    expect(resolveRiskThreshold(undefined, undefined, 1000, 5, -50)).toBe(-50);
    expect(resolveRiskThreshold(undefined, 'abc', 1000, 5, -50)).toBe(-50);
    expect(resolveRiskThreshold('', '', 1000, 5, -50)).toBe(-50);
  });

  it('falls back to the fixed absolute when the wallet simulation is disabled', () => {
    expect(resolveRiskThreshold(undefined, '5', 0, 5, -50)).toBe(-50);
    expect(resolveRiskThreshold(undefined, undefined, 0, 3, -30)).toBe(-30);
  });
});
