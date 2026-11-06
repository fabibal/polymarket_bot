import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { V2, rowsOf, nextCursor, withCursor, collect, v1Activity, v1Position, v1Leaderboard } =
  require('../scripts/dataapi_v2.js');

const page = (rows: unknown[], next?: string) =>
  ({ data: rows, pagination: { limit: rows.length, has_more: !!next, next_cursor: next ?? '' } });

describe('scripts/dataapi_v2 envelope helpers', () => {
  it('targets the v2 base', () => {
    expect(V2).toBe('https://data-api.polymarket.com/v2');
  });

  it('rowsOf rejects a v1-shaped array and a missing data field', () => {
    expect(rowsOf({ data: [1, 2] })).toEqual([1, 2]);
    expect(() => rowsOf([{ a: 1 }])).toThrow(/v2/);
    expect(() => rowsOf(null)).toThrow(/v2/);
  });

  it('nextCursor only returns a cursor while has_more is true', () => {
    expect(nextCursor(page([1], 'c1'))).toBe('c1');
    expect(nextCursor(page([1]))).toBeNull();
    expect(nextCursor({ data: [] })).toBeNull();
  });

  it('withCursor appends an encoded cursor to a query string', () => {
    expect(withCursor('https://x/y?limit=5', null)).toBe('https://x/y?limit=5');
    expect(withCursor('https://x/y?limit=5', 'a+b=')).toBe('https://x/y?limit=5&cursor=a%2Bb%3D');
  });
});

describe('collect', () => {
  it('follows cursors to the end and never sends an offset', async () => {
    const urls: string[] = [];
    const bodies = [page([1, 2], 'c1'), page([3, 4], 'c2'), page([5])];
    const out = await collect(async (u: string) => { urls.push(u); return bodies.shift(); }, 'https://x/a?limit=2');
    expect(out).toEqual({ rows: [1, 2, 3, 4, 5], more: false });
    expect(urls).toEqual(['https://x/a?limit=2', 'https://x/a?limit=2&cursor=c1', 'https://x/a?limit=2&cursor=c2']);
    expect(urls.join()).not.toContain('offset');
  });

  it('stops at maxRows and reports that more pages existed', async () => {
    const bodies = [page([1, 2], 'c1'), page([3, 4], 'c2'), page([5])];
    const out = await collect(async () => bodies.shift(), 'https://x/a?limit=2', { maxRows: 3 });
    expect(out).toEqual({ rows: [1, 2, 3, 4], more: true });
  });

  it('stops when the stop predicate fires on a page', async () => {
    const bodies = [page([9, 8], 'c1'), page([7, 6], 'c2'), page([5])];
    const out = await collect(async () => bodies.shift(), 'https://x/a?limit=2', { stop: (p: number[]) => p[p.length - 1] < 9 });
    expect(out.rows).toEqual([9, 8]);
    expect(out.more).toBe(true);
  });

  it('propagates a fetch error and a wrong-shaped body', async () => {
    await expect(collect(async () => { throw new Error('HTTP 410'); }, 'https://x/a?limit=1')).rejects.toThrow(/410/);
    await expect(collect(async () => [{ a: 1 }], 'https://x/a?limit=1')).rejects.toThrow(/v2/);
  });
});

describe('v1 adapters keep the old field names next to the v2 ones', () => {
  it('v1Activity', () => {
    const r = v1Activity({
      proxy_wallet: '0xabc', condition_id: '0xcid', transaction_hash: '0xh', usdc_size: 95.2, token_id: '7',
      outcome_index: 1, event_slug: 'ev', timestamp: 5, side: 'BUY', type: 'TRADE', price: 0.9, size: 100,
    });
    expect(r).toMatchObject({
      proxyWallet: '0xabc', conditionId: '0xcid', transactionHash: '0xh', usdcSize: 95.2, asset: '7',
      outcomeIndex: 1, eventSlug: 'ev', timestamp: 5, side: 'BUY', type: 'TRADE', price: 0.9, size: 100,
      transaction_hash: '0xh',
    });
  });

  it('v1Position maps held and closed rows', () => {
    const held = v1Position({ current_size: 12, avg_price: 0.4, entry_cost_usdc: 4.8, current_value: 0, unrealized_pnl: -4.8, realized_pnl: 0, status: 'REDEEMABLE', last_event_at: 99 });
    expect(held).toMatchObject({ size: 12, avgPrice: 0.4, initialValue: 4.8, currentValue: 0, cashPnl: -4.8, realizedPnl: 0 });
    const closed = v1Position({ current_size: 0, realized_pnl: 19.5, last_event_at: 1785175425, status: 'CLOSED' });
    expect(closed).toMatchObject({ realizedPnl: 19.5, timestamp: 1785175425, size: 0 });
  });

  it('v1Leaderboard maps user_id / volume to proxyWallet / vol', () => {
    expect(v1Leaderboard({ rank: 1, user_id: '0xdead', pnl: 5, volume: 50, user_name: 'n' }))
      .toMatchObject({ proxyWallet: '0xdead', vol: 50, userName: 'n', pnl: 5 });
  });
});
