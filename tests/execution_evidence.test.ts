import { describe, expect, it } from 'vitest';
import { executionEvidence, hasEntryBook } from '../src/execution_evidence';
import { SimulatedTrade } from '../src/types';
const t = (extra: Partial<SimulatedTrade>) => ({ status: 'closed', realizedPnl: 2, simulatedShares: 10,
  entryPrice: 0.5, entryGasCost: 0, entrySlippageCost: 1, exitSlippageCost: 0, ...extra }) as SimulatedTrade;
describe('entry evidence in simulated performance', () => {
  it('excludes missing and later-backfilled books without deleting historical PnL', () => {
    const snapshot = { bestAsk: 0.5, askDepth5: 1000 };
    const closed = [t({...snapshot,depthBackfilled:false}),t({}),t({...snapshot,depthBackfilled:true})];
    const s=executionEvidence([],closed);
    expect(s.closedWithEntryBook).toBe(1);
    expect(s.closedWithoutEntryBook).toBe(2);
    expect(s.bookBackedClosedNetPnl).toBe(1);
    expect(s.unverifiedClosedNetPnl).toBe(2);
    expect(closed).toHaveLength(3);
  });
  it('does not accept invalid prices or empty depth as entry evidence', () => {
    expect(hasEntryBook(t({bestAsk:0,askDepth5:1000,depthBackfilled:false}))).toBe(false);
    expect(hasEntryBook(t({bestAsk:0.5,askDepth5:0,depthBackfilled:false}))).toBe(false);
  });
});
