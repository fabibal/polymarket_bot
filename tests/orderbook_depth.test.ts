import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Reply = { status?: number; body?: unknown; error?: Error };
const { replies } = vi.hoisted(() => ({ replies: [] as Reply[] }));

// Each https.get() pops the next queued reply.
vi.mock('https', () => ({
  default: {
    get: (_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      const next = replies.shift()!;
      const handlers: Record<string, (e: Error) => void> = {};
      const req = {
        on: (ev: string, fn: (e: Error) => void) => { handlers[ev] = fn; return req; },
        destroy: () => {},
      };
      queueMicrotask(() => {
        if (next.error) { handlers.error?.(next.error); return; }
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

import { getOrderbookDepth } from '../src/bullpen';

const GAMMA_OK: Reply = { body: [{ outcomes: '["Yes","No"]', clobTokenIds: '["tok-yes","tok-no"]' }] };

describe('getOrderbookDepth failure logging', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { replies.length = 0; log = vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => log.mockRestore());

  const logged = () => log.mock.calls.map(c => String(c[0])).join('\n');

  it('logs gamma: no market for slug', async () => {
    replies.push({ body: [] });
    expect(await getOrderbookDepth('m', 'Yes')).toBeNull();
    expect(logged()).toContain('[depth] m Yes — gamma: no market for slug');
  });

  it('logs an unmatched outcome with the outcomes Gamma returned', async () => {
    replies.push(GAMMA_OK);
    expect(await getOrderbookDepth('m', 'Maybe')).toBeNull();
    expect(logged()).toContain('gamma: outcome not matched (outcomes=["Yes","No"], tokens=2)');
  });

  it('reports an empty ask side as data (noAsks), not as a failure', async () => {
    replies.push(GAMMA_OK, { body: { asks: [], bids: [{ price: '0.5', size: '10' }, { price: '0.4', size: '5' }] } });
    expect(await getOrderbookDepth('m', 'Yes')).toEqual({
      bestAsk: 0, bestBid: 0.5, spread: 0, askDepth5: 0, askDepth10: 0, noAsks: true,
    });
    expect(log).not.toHaveBeenCalled();
  });

  it('still logs an empty bid side as a failure (a buy is possible, the exit is not priced)', async () => {
    replies.push(GAMMA_OK, { body: { asks: [{ price: '0.6', size: '10' }], bids: [] } });
    expect(await getOrderbookDepth('m', 'Yes')).toBeNull();
    expect(logged()).toContain('clob: empty book side (asks=1, bids=0)');
  });

  it('logs the HTTP error message', async () => {
    replies.push({ status: 429, body: {} });
    expect(await getOrderbookDepth('m', 'Yes')).toBeNull();
    expect(logged()).toContain('error: HTTP 429');
  });

  it('returns the depth and logs nothing on success', async () => {
    replies.push(GAMMA_OK, {
      body: {
        asks: [{ price: '0.6', size: '1000' }, { price: '0.5', size: '100' }],
        bids: [{ price: '0.4', size: '50' }],
      },
    });
    const d = await getOrderbookDepth('m', 'Yes');
    expect(d).toMatchObject({ bestAsk: 0.5, bestBid: 0.4, askDepth5: 50 });
    expect(log).not.toHaveBeenCalled();
  });
});
