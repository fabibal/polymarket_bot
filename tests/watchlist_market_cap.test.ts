import { describe, it, expect } from 'vitest';
import { countWatchlistEntriesInWindow, isMatchStyleSlug, type WatchlistEntry } from '../src/filters';

const WINDOW_MS = 43_200_000; // 12h
const NOW = Date.parse('2026-04-25T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;

function entry(over: Partial<WatchlistEntry> = {}): WatchlistEntry {
  return {
    marketSlug: 'dfb-stu-scf-2026-04-23-total-2pt5',
    copiedTraderSource: 'watchlist',
    timestamp: ago(0),
    ...over,
  };
}

describe('countWatchlistEntriesInWindow', () => {
  it('counts open + closed watchlist entries inside window — 2 reaches cap so 3rd would block', () => {
    const open   = [entry({ timestamp: ago(1 * HOUR) })];
    const closed = [entry({ timestamp: ago(2 * HOUR) })];
    const n = countWatchlistEntriesInWindow(open, closed, 'dfb-stu-scf-2026-04-23-total-2pt5', NOW, WINDOW_MS);
    expect(n).toBe(2);
    expect(n >= 2).toBe(true); // cap=2 → next BUY skipped
  });

  it('ignores entries older than the window', () => {
    const closed = [
      entry({ timestamp: ago(13 * HOUR) }),
      entry({ timestamp: ago(20 * HOUR) }),
    ];
    const n = countWatchlistEntriesInWindow([], closed, 'dfb-stu-scf-2026-04-23-total-2pt5', NOW, WINDOW_MS);
    expect(n).toBe(0);
  });

  it('does not count leaderboard-source trades (control)', () => {
    const open = [
      entry({ copiedTraderSource: 'leaderboard', timestamp: ago(1 * HOUR) }),
      entry({ copiedTraderSource: 'leaderboard', timestamp: ago(2 * HOUR) }),
    ];
    const n = countWatchlistEntriesInWindow(open, [], 'dfb-stu-scf-2026-04-23-total-2pt5', NOW, WINDOW_MS);
    expect(n).toBe(0);
  });

  it('does not count entries on a different market slug', () => {
    const open = [entry({ marketSlug: 'epl-other', timestamp: ago(1 * HOUR) })];
    const n = countWatchlistEntriesInWindow(open, [], 'dfb-stu-scf-2026-04-23-total-2pt5', NOW, WINDOW_MS);
    expect(n).toBe(0);
  });

  it('windowMs=Infinity counts entries of any age (lifetime cap)', () => {
    const closed = [
      entry({ timestamp: ago(13 * HOUR) }),  // outside the 12h window
      entry({ timestamp: ago(30 * 24 * HOUR) }), // a month old
    ];
    const n = countWatchlistEntriesInWindow([], closed, 'dfb-stu-scf-2026-04-23-total-2pt5', NOW, Number.POSITIVE_INFINITY);
    expect(n).toBe(2);
  });
});

describe('isMatchStyleSlug', () => {
  it('matches dated match slugs', () => {
    for (const s of [
      'fif-ksa-sen-2026-06-09-draw',
      'es2-mal-lpm-2026-06-10-lpm',
      'bra2-juv-afc-2026-05-29-juv',
      'chi-xin-hai-2026-05-30-xin',
      'dfb-stu-scf-2026-04-23-total-2pt5',
      'mls-nyr-nyc-2026-05-16-draw',
      'nba-lal-bos-2026-12-31', // date at end of slug
    ]) expect(isMatchStyleSlug(s), s).toBe(true);
  });

  it('does not match long-lived geo/political slugs', () => {
    for (const s of [
      'us-x-iran-permanent-peace-deal-by-june-30-2026-837-641-896-8',
      'strait-of-hormuz-traffic-returns-to-normal-by-end-of-june',
      'will-the-us-invade-iran-before-2027',
      'will-keiko-fujimori-win-the-2026-peruvian-presidential-election',
      'us-announces-new-iran-agreementceasefire-extension-by-june-30',
    ]) expect(isMatchStyleSlug(s), s).toBe(false);
  });

  it('rejects id-suffix runs that are not plausible dates', () => {
    // month 83 / day 99 etc. — numeric dedup suffixes must not false-positive
    expect(isMatchStyleSlug('deal-by-june-30-2026-83-64')).toBe(false);
    expect(isMatchStyleSlug('deal-2026-13-01-extension')).toBe(false); // month 13
    expect(isMatchStyleSlug('deal-2026-00-10-extension')).toBe(false); // month 00
    expect(isMatchStyleSlug('deal-2026-06-32-extension')).toBe(false); // day 32
    expect(isMatchStyleSlug('deal-2026-06-00-extension')).toBe(false); // day 00
  });
});
