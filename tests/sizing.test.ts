import { describe, it, expect } from 'vitest';
import { computeDynamicTradeAmount } from '../src/filters';

const CFG = { enabled: true, min: 5, max: 25 };

describe('computeDynamicTradeAmount', () => {
  it('disabled: always returns the base amount, depth ignored', () => {
    expect(computeDynamicTradeAmount(100_000, 5, { ...CFG, enabled: false })).toBe(5);
    expect(computeDynamicTradeAmount(null, 7.5, { ...CFG, enabled: false })).toBe(7.5);
  });

  it('enabled with unknown/invalid depth: falls back to the base amount', () => {
    expect(computeDynamicTradeAmount(null, 5, CFG)).toBe(5);
    expect(computeDynamicTradeAmount(undefined, 5, CFG)).toBe(5);
    expect(computeDynamicTradeAmount(0, 5, CFG)).toBe(5);
    expect(computeDynamicTradeAmount(NaN, 5, CFG)).toBe(5);
  });

  it('sizes at 1% of ask_depth_5 between the bounds', () => {
    expect(computeDynamicTradeAmount(1_000, 5, CFG)).toBe(10);   // 1% of $1000
    expect(computeDynamicTradeAmount(1_850, 5, CFG)).toBe(18.5); // 1% of $1850
  });

  it('clamps to the $5 floor on thin books', () => {
    // depth-gate minimum ($500) → 1% = $5 = exactly the floor
    expect(computeDynamicTradeAmount(500, 5, CFG)).toBe(5);
    expect(computeDynamicTradeAmount(120, 5, CFG)).toBe(5);
  });

  it('clamps to MAX_TRADE_AMOUNT on deep books', () => {
    expect(computeDynamicTradeAmount(2_500, 5, CFG)).toBe(25);
    expect(computeDynamicTradeAmount(500_000, 5, CFG)).toBe(25);
  });
});
