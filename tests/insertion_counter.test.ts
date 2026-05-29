import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

vi.mock('../src/config', () => ({
  CONFIG: {
    DATA_FILE: ':memory:',
    DB_FILE: ':memory:',
    FORCE_EXCLUDE_CATEGORIES: [],
    GAS_COST_PER_BUY: 0,
    SLIPPAGE_RATE: 0.02,
  },
}));

import * as store from '../src/store';
import type { SimulatedTrade } from '../src/types';

let tmpFile: string;

function makeTrade(over: Partial<SimulatedTrade> = {}): SimulatedTrade {
  return {
    id: 't1',
    sourceTradeId: 'src1',
    timestamp: '2026-04-22T10:00:00.000Z',
    copiedTrader: '0xabc',
    copiedTraderRank: 1,
    marketSlug: 'foo-market',
    marketTitle: 'Foo?',
    outcome: 'Yes',
    side: 'buy',
    entryPrice: 0.70,
    simulatedAmount: 5,
    simulatedShares: 5 / 0.70,
    status: 'open',
    ...over,
  };
}

beforeEach(() => {
  tmpFile = path.join(
    os.tmpdir(),
    `pb-counter-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
});

afterEach(() => {
  store._closeDb();
  store._setDbPathForTests(null);
  for (const ext of ['', '-wal', '-shm']) {
    const p = tmpFile + ext;
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  }
});

describe('initInsertionCounter', () => {
  it('starts at 1 on a fresh empty DB', () => {
    store._setDbPathForTests(tmpFile);
    const next = store.initInsertionCounter();
    expect(next).toBe(1);
    expect(store._getInsertionCounter()).toBe(1);
  });

  it('resumes past existing real trade rows after a simulated restart', () => {
    store._setDbPathForTests(tmpFile);
    store.initInsertionCounter();
    store.addOpenTrade(makeTrade({ id: 'a1', sourceTradeId: 's1', copiedTrader: '0xa' }));
    store.addOpenTrade(makeTrade({ id: 'a2', sourceTradeId: 's2', copiedTrader: '0xb' }));
    store.addOpenTrade(makeTrade({ id: 'a3', sourceTradeId: 's3', copiedTrader: '0xc' }));
    expect(store._getInsertionCounter()).toBe(4);

    store._closeDb();
    store._setDbPathForTests(tmpFile);
    expect(store._getInsertionCounter()).toBe(0);

    const next = store.initInsertionCounter();
    expect(next).toBe(4);
    expect(store._getInsertionCounter()).toBe(4);
  });

  it('starts at MAX+1 when existing rows have insertion_order=100', () => {
    store._setDbPathForTests(tmpFile);
    store.initInsertionCounter();
    store.addOpenTrade(makeTrade({ id: 'x', sourceTradeId: 'sx', copiedTrader: '0xx' }));
    store._closeDb();

    const raw = new Database(tmpFile);
    raw.prepare('UPDATE open_trades SET insertion_order = 100 WHERE id = ?').run('x');
    raw.close();

    store._setDbPathForTests(tmpFile);
    const next = store.initInsertionCounter();
    expect(next).toBe(101);
    expect(store._getInsertionCounter()).toBe(101);
  });

  it('takes MAX across real and shadow trade tables (shadow higher than real)', () => {
    store._setDbPathForTests(tmpFile);
    store.initInsertionCounter();
    store.addOpenTrade(makeTrade({ id: 'r1', sourceTradeId: 'r1', copiedTrader: '0xa' }));
    store.addOpenTrade(makeTrade({ id: 'r2', sourceTradeId: 'r2', copiedTrader: '0xb' }));
    expect(store._getInsertionCounter()).toBe(3); // real rows took insertion_order 1,2
    store._closeDb();

    // Shadow tables are no longer written by the app (shadow polling removed
    // 2026-05-29), but initInsertionCounter must still scan them. Seed a shadow
    // row with a higher insertion_order directly to verify the MAX spans them.
    const raw = new Database(tmpFile);
    raw.prepare(
      `INSERT INTO shadow_open_trades
        (id, source_trade_id, timestamp, copied_trader, copied_trader_rank,
         market_slug, market_title, outcome, side, entry_price, simulated_amount,
         simulated_shares, status, insertion_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run('sh1', 'sh1', '2026-04-22T10:00:00.000Z', '0xc', 0,
          'foo-market', 'Foo?', 'Yes', 'buy', 0.7, 5, 7.14, 'open', 5);
    raw.close();

    store._setDbPathForTests(tmpFile);
    const next = store.initInsertionCounter();
    expect(next).toBe(6); // MAX(real=2, shadow=5) + 1
  });
});
