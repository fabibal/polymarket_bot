import { describe, it, expect } from 'vitest';
import { countWatchlistEntriesInWindow, type WatchlistEntry } from '../src/filters';

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
});
