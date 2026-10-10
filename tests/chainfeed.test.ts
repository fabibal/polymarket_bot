import { describe, it, expect } from 'vitest';
import { decodeOrderFilled, fillToActivity, makeSweeper, sweepReason, ChainLog, EXCHANGES } from '../src/chainfeed';

// Real OrderFilled logs of LowFreq-Events (0x2f633efb), fetched from Polygon
// receipts on 2026-10-05; expected values are the data-api fills of the same tx.
const BUY: ChainLog = {
  "address": "0xe2222d279d744050d28e00520010520000310f59",
  "topics": [
    "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee",
    "0x474d68321013335364eec8af4a02ce2b9051a6a9a8217560e48deb4387703361",
    "0x0000000000000000000000002f633efb75256a2f2445110c8978684ab8936643",
    "0x000000000000000000000000e2222d279d744050d28e00520010520000310f59"
  ],
  "data": "0x0000000000000000000000000000000000000000000000000000000000000000b9b78ab3d31d8be4522b7e0e7461d0c0204d6480e6e6f1c31612c1c65fb2e8f1000000000000000000000000000000000000000000000000000000000dfca0a0000000000000000000000000000000000000000000000000000000000f8e8b40000000000000000000000000000000000000000000000000000000000012115000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  "transactionHash": "0x350eaaf9013a5936f048f8bcdff15c682c103207ed7cb9f987463977302c42bb",
  "blockNumber": "0x5a99f42",
  "logIndex": "0x3d3"
};
const SELL: ChainLog = {
  "address": "0xe2222d279d744050d28e00520010520000310f59",
  "topics": [
    "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee",
    "0xdb0d2590416c4236cb9b36e34a62f5d408a6045634e9b643974dbd0d5691e163",
    "0x0000000000000000000000002f633efb75256a2f2445110c8978684ab8936643",
    "0x000000000000000000000000e2222d279d744050d28e00520010520000310f59"
  ],
  "data": "0x000000000000000000000000000000000000000000000000000000000000000158fc0c7874bd84c11739c3fff75307b5b9edf94e9f7a719cddf39d660be06054000000000000000000000000000000000000000000000000000000000f85d8b0000000000000000000000000000000000000000000000000000000000ec04cee000000000000000000000000000000000000000000000000000000000007824e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  "transactionHash": "0x1fc15de820020e2ed011a81752ee0a1a60dae9ae99be6daf03266eb50e91bf98",
  "blockNumber": "0x5a906fe",
  "logIndex": "0x9f"
};

describe('decodeOrderFilled', () => {
  it('BUY: maker pays USDC for tokens (data-api: 261 sh @ 0.8990804598)', () => {
    const f = decodeOrderFilled(BUY)!;
    expect(f.wallet).toBe('0x2f633efb75256a2f2445110c8978684ab8936643');
    expect(f.side).toBe('BUY');
    expect(f.tokenId).toBe('84002167289818084946834195019107495872273829708192582096244977447292806293745');
    expect(f.size).toBeCloseTo(261, 6);
    expect(f.price).toBeCloseTo(0.8990804598, 8);
    expect(f.tx).toBe(BUY.transactionHash);
    expect(f.blockNumber).toBe(parseInt(BUY.blockNumber, 16));
  });

  it('SELL: maker gives tokens for USDC (data-api: 260.43 sh @ 0.9502884844)', () => {
    const f = decodeOrderFilled(SELL)!;
    expect(f.side).toBe('SELL');
    expect(f.tokenId).toBe('40248862204095545824507770609491521282553259429991780219438297794719904718932');
    expect(f.size).toBeCloseTo(260.43, 6);
    expect(f.price).toBeCloseTo(0.9502884844, 8);
  });

  it('rejects removed logs, unknown contracts, other events and short data', () => {
    expect(decodeOrderFilled({ ...BUY, removed: true })).toBeNull();
    expect(decodeOrderFilled({ ...BUY, address: '0x000000000000000000000000000000000000dead' })).toBeNull();
    expect(decodeOrderFilled({ ...BUY, topics: ['0x' + '1'.repeat(64), ...BUY.topics.slice(1)] })).toBeNull();
    expect(decodeOrderFilled({ ...BUY, data: BUY.data.slice(0, 2 + 64 * 3) })).toBeNull();
    expect(EXCHANGES).toContain(BUY.address);
  });

  it('maps to the activity item shape the poll and RTDS produce', () => {
    const f = decodeOrderFilled(BUY)!;
    const item = fillToActivity(f, { slug: 'will-ism-services-pmi-be-between-56pt0-and-56pt9-in-september', title: 'ISM?', outcome: 'No' }, Date.parse('2026-10-05T14:00:02Z'));
    expect(item).toEqual({
      transaction_hash: BUY.transactionHash, timestamp: '2026-10-05T14:00:02.000Z',
      slug: 'will-ism-services-pmi-be-between-56pt0-and-56pt9-in-september', title: 'ISM?', outcome: 'No',
      side: 'BUY', type: 'TRADE', price: f.price, size: f.size, usdc_size: f.usdc,
    });
  });
});

// ── HTTPS sweep ─────────────────────────────────────────────────────────────
type Call = { ep: string; method: string; params: any[] };

/** Fake providers: `heads[ep]` is the head each endpoint reports, `fail[ep]` a message it throws. */
function fakeChain(heads: Record<string, number>, fail: Record<string, string> = {}, logs: ChainLog[] = []) {
  const calls: Call[] = [];
  const call = async (ep: string, method: string, params: unknown[]) => {
    calls.push({ ep, method, params: params as any[] });
    if (fail[ep]) throw new Error(fail[ep]);
    if (method === 'eth_blockNumber') return '0x' + heads[ep].toString(16);
    return logs;
  };
  const range = (i: number) => {
    const g = calls.filter(c => c.method === 'eth_getLogs')[i].params[0];
    return [parseInt(g.fromBlock, 16), parseInt(g.toBlock, 16)];
  };
  return { calls, call, range };
}

const TOPICS = ['0xabc', null, ['0x01']];
const mk = (c: ReturnType<typeof fakeChain>, endpoints = ['A', 'B'], onLogs: (l: ChainLog[], ep: string) => Promise<void> = async () => undefined) =>
  makeSweeper({ endpoints, call: c.call, getTopics: () => TOPICS, onLogs });

describe('makeSweeper', () => {
  it('reads the last few blocks first, then re-reads a small overlap each time', async () => {
    const heads = { A: 100 };
    const c = fakeChain(heads);
    const s = mk(c, ['A']);
    expect(await s.sweep()).toBe(true);
    expect(c.range(0)).toEqual([97, 100]);
    heads.A = 103;
    await s.sweep();
    expect(c.range(1)).toEqual([97, 103]);   // nothing between two sweeps is skipped
    heads.A = 105;
    await s.sweep();
    expect(c.range(2)).toEqual([100, 105]);
    const g = c.calls.filter(x => x.method === 'eth_getLogs')[0].params[0];
    expect(g.address).toEqual(EXCHANGES);
    expect(g.topics).toEqual(TOPICS);
  });

  it('hands the logs and the serving provider to onLogs', async () => {
    const got: Array<[number, string]> = [];
    const c = fakeChain({ A: 100 }, {}, [BUY, SELL]);
    await mk(c, ['A'], async (l, ep) => { got.push([l.length, ep]); }).sweep();
    expect(got).toEqual([[2, 'A']]);
  });

  it('falls back to the next provider and counts the failure by reason', async () => {
    const c = fakeChain({ B: 100 }, { A: 'invalid block range params' });
    const s = mk(c);
    expect(await s.sweep()).toBe(true);
    expect(c.calls.map(x => x.ep)).toEqual(['A', 'B', 'B']);
    expect(s.stats.ok).toBe(1);
    expect(s.stats.failed).toBe(0);
    expect(s.summary()).toBe('1 ok, 0 failed (A 0 ok/1 failed, B 1 ok/0 failed); errors: invalid block range x1');
    expect(s.summary()).toBe('0 ok, 0 failed');   // the window resets
  });

  it('fails only when every provider fails, and does not skip the gap afterwards', async () => {
    const heads = { A: 100 };
    const fail: Record<string, string> = {};
    const c = fakeChain(heads, fail);
    const s = mk(c, ['A']);
    await s.sweep();                                  // reads 97..100, next read starts at 97
    fail.A = 'timeout';
    heads.A = 110;
    expect(await s.sweep()).toBe(false);
    expect(s.stats.failed).toBe(1);
    delete fail.A;
    await s.sweep();
    expect(c.range(1)).toEqual([97, 110]);            // the whole outage is read
  });

  it('treats a provider whose head is behind the blocks already read as failed', async () => {
    const heads: Record<string, number> = { A: 100, B: 100 };
    const c = fakeChain(heads);
    const s = mk(c);
    await s.sweep();                                  // next read starts at 97
    heads.A = 90;                                     // lagging backend
    heads.B = 102;
    expect(await s.sweep()).toBe(true);
    expect(c.calls.slice(-3).map(x => x.ep)).toEqual(['A', 'B', 'B']);
    expect(c.range(1)).toEqual([97, 102]);
    expect(s.summary()).toContain('node behind x1');
  });

  it('caps the catch-up window after a very long outage', async () => {
    const heads = { A: 100 };
    const c = fakeChain(heads);
    const s = mk(c, ['A']);
    await s.sweep();
    heads.A = 5000;
    await s.sweep();
    expect(c.range(1)).toEqual([4401, 5000]);
  });

  it('does nothing without wallets', async () => {
    const c = fakeChain({ A: 100 });
    const s = makeSweeper({ endpoints: ['A'], call: c.call, getTopics: () => null, onLogs: async () => undefined });
    expect(await s.sweep()).toBe(false);
    expect(c.calls).toHaveLength(0);
  });
});

describe('sweepReason', () => {
  it('normalizes provider errors', () => {
    expect(sweepReason(new Error('timeout'))).toBe('timeout');
    expect(sweepReason(new Error('eth_getLogs timed out'))).toBe('timeout');
    expect(sweepReason(new Error('invalid block range params'))).toBe('invalid block range');
    expect(sweepReason(new Error('getaddrinfo EAI_AGAIN polygon.drpc.org'))).toBe('dns');
    expect(sweepReason(new Error('http 429'))).toBe('http 429');
    expect(sweepReason('weird')).toBe('weird');
  });
});
