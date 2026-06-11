import { describe, it, expect } from 'vitest';
import { detectCategory } from '../src/categories';

describe('detectCategory', () => {
  it('recognizes the soccer/esports league prefixes added 2026-06-11', () => {
    for (const s of [
      'fif-ksa-sen-2026-06-09-draw',     // FIFA WC qualifier
      'es2-mal-lpm-2026-06-10-lpm',      // Spanish Segunda
      'bra-vas-cam-2026-05-31-vas',      // Brazilian Serie A
      'bra2-juv-afc-2026-05-29-juv',     // Brazilian Serie B
      'chi-xin-hai-2026-05-30-xin',      // Chilean league
      'chi1-cdc-cdu-2026-05-29-cdc',     // Chilean Primera
      'sud-tig-aas-2026-05-28-draw',     // Sudani league
      'mls-nyr-nyc-2026-05-16-draw',     // MLS
      'dfb-stu-scf-2026-04-23-total-2pt5', // DFB-Pokal
    ]) expect(detectCategory(s), s).toBe('sports');
  });

  it('keeps geo/political slugs out of sports', () => {
    // NOTE: the Iran/Hormuz slugs land in 'other' (geopolitics regex has no
    // 'iran'/'hormuz' terms) — what matters here is they don't become sports.
    expect(detectCategory('us-x-iran-permanent-peace-deal-by-june-30-2026')).not.toBe('sports');
    expect(detectCategory('strait-of-hormuz-traffic-returns-to-normal-by-end-of-june')).not.toBe('sports');
    expect(detectCategory('will-keiko-fujimori-win-the-2026-peruvian-presidential-election')).toBe('politics');
  });

  it('regression: existing categories unaffected', () => {
    expect(detectCategory('nba-lal-bos-2026-01-01')).toBe('sports');
    expect(detectCategory('btc-above-100k-by-july')).toBe('crypto');
    expect(detectCategory('fed-rate-cut-september')).toBe('finance');
    expect(detectCategory('some-unmatched-market')).toBe('other');
  });
});
