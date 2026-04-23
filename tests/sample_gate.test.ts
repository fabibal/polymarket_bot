import { describe, it, expect } from 'vitest';
import { hasSufficientSample } from '../src/monitor';

describe('hasSufficientSample', () => {
  it('unlocks via real closed trades when real >= realThreshold', () => {
    const g = hasSufficientSample(5, 0, 5, 20);
    expect(g.passes).toBe(true);
    expect(g.via).toBe('real');
  });

  it('unlocks via shadow closed trades when real is short but shadow >= shadowThreshold', () => {
    const g = hasSufficientSample(0, 20, 5, 20);
    expect(g.passes).toBe(true);
    expect(g.via).toBe('shadow');
  });

  it('blocks when both counts are below their thresholds', () => {
    const g = hasSufficientSample(2, 10, 5, 20);
    expect(g.passes).toBe(false);
    expect(g.via).toBeNull();
  });

  it('prefers real over shadow when both would unlock', () => {
    const g = hasSufficientSample(10, 50, 5, 20);
    expect(g.via).toBe('real');
  });
});
