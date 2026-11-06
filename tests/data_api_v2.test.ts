import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

type Reply = { status?: number; body?: unknown };
const { replies, urls } = vi.hoisted(() => ({ replies: [] as Reply[], urls: [] as string[] }));

// Each https.get() records its URL and pops the next queued reply.
vi.mock('https', () => ({
  default: {
    get: (url: string, _opts: unknown, cb: (res: unknown) => void) => {
      urls.push(url);
      const next = replies.shift()!;
      const req = { on: () => req, destroy: () => {} };
      queueMicrotask(() => {
        const res = {
          statusCode: next.status ?? 200,
          on: (ev: string, fn: (c?: Buffer) => void) => {
            if (ev === 'data') fn(Buffer.from(JSON.stringify(next.body)));
            if (ev === 'end') fn();
            return res;
          },
        };
        cb(res);
      });
      return req;
    },
  },
}));

import { getTraderActivity, getTraderPositionSize, mapPositionV2, nextCursorV2, unwrapV2 } from '../src/bullpen';

const ADDR = '0x2f633efb75256a2f2445110c8978684ab8936643';
const row = (ts: number, hash: string) => ({
  proxy_wallet: ADDR, timestamp: ts, condition_id: '0xabc', type: 'TRADE', size: 100, usdc_size: 95.2375,
  transaction_hash: hash, price: 0.95, token_id: '1', side: 'BUY', outcome_index: 0,
  title: 'T', slug: 'sg-quarterly', outcome: 'Yes',
});

beforeEach(() => { replies.length = 0; urls.length = 0; });

describe('data-api v2 helpers', () => {
  it('unwrapV2 / nextCursorV2 read the envelope', () => {
    expect(unwrapV2({ data: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(unwrapV2([{ a: 1 }])).toEqual([]);
    expect(nextCursorV2({ pagination: { has_more: true, next_cursor: 'c1' } })).toBe('c1');
    expect(nextCursorV2({ pagination: { has_more: false, next_cursor: 'c1' } })).toBeNull();
    expect(nextCursorV2({ data: [] })).toBeNull();
  });

  it('mapPositionV2 exposes the v1 names the frontend reads', () => {
    const p = mapPositionV2({
      current_size: 500, avg_price: 0.83, entry_cost_usdc: 415, current_value: 462.5,
      current_price: 0.925, unrealized_pnl: 47.5, realized_pnl: 0, title: 'X', outcome: 'Yes',
    });
    expect(p).toMatchObject({
      size: 500, avgPrice: 0.83, initialValue: 415, currentValue: 462.5,
      curPrice: 0.925, cashPnl: 47.5, unrealizedPnl: 47.5, title: 'X', outcome: 'Yes',
    });
  });
});

describe('getTraderActivity (v2)', () => {
  it('maps snake_case rows and pages by cursor, never by offset', async () => {
    replies.push(
      { body: { data: [row(1793920000, '0xh1'), row(1793919000, '0xh2')], pagination: { has_more: true, next_cursor: 'CUR1' } } },
      { body: { data: [row(1793918000, '0xh3')], pagination: { has_more: false, next_cursor: '' } } },
    );
    const items = await getTraderActivity(ADDR, 100, new Date(1793900000 * 1000).toISOString());
    expect(items.map(i => i.transaction_hash)).toEqual(['0xh1', '0xh2', '0xh3']);
    expect(items[0]).toMatchObject({
      slug: 'sg-quarterly', outcome: 'Yes', side: 'BUY', type: 'TRADE', price: 0.95, size: 100, usdc_size: 95.2375,
    });
    expect(urls[0]).toContain('/v2/activity?user=' + ADDR);
    expect(urls[0]).not.toContain('offset');
    expect(urls[0]).not.toContain('cursor');
    expect(urls[1]).toContain('cursor=CUR1');
    expect(urls[1]).not.toContain('offset');
  });

  it('stops paging once it reaches items older than the cursor timestamp', async () => {
    replies.push({ body: { data: [row(1793920000, '0xnew'), row(1793800000, '0xold')], pagination: { has_more: true, next_cursor: 'CUR1' } } });
    const items = await getTraderActivity(ADDR, 100, new Date(1793900000 * 1000).toISOString());
    expect(items.map(i => i.transaction_hash)).toEqual(['0xnew']);
    expect(urls).toHaveLength(1);
  });

  it('throws on HTTP 410 and on a body without a data array (cursor active)', async () => {
    const since = new Date(1793900000 * 1000).toISOString();
    replies.push({ status: 410, body: { error: 'Data API v1 has been retired' } });
    await expect(getTraderActivity(ADDR, 100, since)).rejects.toThrow(/410/);
    replies.push({ body: [row(1793920000, '0xv1shape')] }); // v1-shaped array = wrong API
    await expect(getTraderActivity(ADDR, 100, since)).rejects.toThrow(/Unexpected v2/);
  });
});

describe('getTraderPositionSize (v2)', () => {
  const gamma = { body: [{ conditionId: '0xcond' }] };

  it('filters by condition and reads current_size for the outcome', async () => {
    replies.push(gamma, { body: { data: [{ outcome: 'No', current_size: 3 }, { outcome: 'Yes', current_size: 12.5 }] } });
    expect(await getTraderPositionSize(ADDR, 'slug', 'yes')).toBe(12.5);
    expect(urls[1]).toContain('/v2/positions?user=' + ADDR);
    expect(urls[1]).toContain('condition=0xcond');
    expect(urls[1]).not.toContain('market=');
  });

  it('returns 0 when no row exists and null when the response is not a v2 envelope', async () => {
    replies.push(gamma, { body: { data: [] } });
    expect(await getTraderPositionSize(ADDR, 'slug', 'Yes')).toBe(0);
    replies.push(gamma, { body: [] });
    expect(await getTraderPositionSize(ADDR, 'slug', 'Yes')).toBeNull();
  });
});
