import { SimulatedTrade } from './types';
import { tradeCostAdjustedPnl } from './simulator';

// Evidence of an entry book is not proof of a real fill or of settlement.
// Backfilled books describe a later time and must never validate old entries.
export function hasEntryBook(t: SimulatedTrade): boolean {
  return t.depthBackfilled === false && Number.isFinite(t.bestAsk) &&
    (t.bestAsk ?? 0) > 0 && (t.bestAsk ?? 1) < 1 &&
    Number.isFinite(t.askDepth5) && (t.askDepth5 ?? 0) > 0;
}

export function executionEvidence(open: SimulatedTrade[], closed: SimulatedTrade[]) {
  const documented = closed.filter(hasEntryBook);
  const unknown = closed.filter(t => !hasEntryBook(t));
  const openDocumented = open.filter(hasEntryBook);
  return {
    closedWithEntryBook: documented.length,
    closedWithoutEntryBook: unknown.length,
    bookBackedClosedNetPnl: documented.reduce((s, t) => s + tradeCostAdjustedPnl(t), 0),
    unverifiedClosedNetPnl: unknown.reduce((s, t) => s + tradeCostAdjustedPnl(t), 0),
    openWithEntryBook: openDocumented.length,
    openWithoutEntryBook: open.length - openDocumented.length,
    bookBackedOpenNetPnl: openDocumented.reduce((s, t) => s + tradeCostAdjustedPnl(t), 0),
  };
}
