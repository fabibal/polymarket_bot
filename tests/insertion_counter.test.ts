import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

vi.mock('../src/config', () => ({
  CONFIG: {
    DB_FILE: ':memory:',
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
});
