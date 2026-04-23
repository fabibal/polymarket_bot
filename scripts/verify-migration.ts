/**
 * Post-migration sanity check: loads the target DB via the store module
 * and compares preserved fields against the source JSON. Read-only.
 *
 * Usage:
 *   npx ts-node scripts/verify-migration.ts <trades.json> <store.db>
 */
import fs from 'fs';
import path from 'path';
import { TradesStore } from '../src/types';
import { _setDbPathForTests, readStore, _closeDb } from '../src/store';

function main(): void {
  const [, , srcArg, dstArg] = process.argv;
  if (!srcArg || !dstArg) { console.error('Usage: ts-node scripts/verify-migration.ts <trades.json> <store.db>'); process.exit(2); }
  const src = path.resolve(srcArg);
  const dst = path.resolve(dstArg);
  const legacy = JSON.parse(fs.readFileSync(src, 'utf-8')) as Partial<TradesStore>;

  _setDbPathForTests(dst);
  const s = readStore();
  _closeDb();

  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

  const srcExc = new Set(legacy.excludedTraders ?? []);
  const dbExc  = new Set(s.excludedTraders);
  checks.push({ name: 'excludedTraders', ok: srcExc.size === dbExc.size && [...srcExc].every(x => dbExc.has(x)),
    detail: `src=${srcExc.size} db=${dbExc.size}` });

  const srcAuto = new Set(legacy.autoExcludedTraders ?? []);
  const dbAuto  = new Set(s.autoExcludedTraders);
  checks.push({ name: 'autoExcludedTraders', ok: srcAuto.size === dbAuto.size && [...srcAuto].every(x => dbAuto.has(x)),
    detail: `src=${srcAuto.size} db=${dbAuto.size}` });

  // excludedCategories: DB value includes FORCE_EXCLUDE_CATEGORIES merge from readStore.
  const srcCat = new Set(legacy.excludedCategories ?? []);
  const dbCat  = new Set(s.excludedCategories);
  const catOk = [...srcCat].every(c => dbCat.has(c));
  checks.push({ name: 'excludedCategories ⊇ source', ok: catOk, detail: `src=[${[...srcCat].join(',')}] db=[${[...dbCat].join(',')}]` });

  const srcWl = legacy.watchlistTraders ?? [];
  const dbWl  = s.watchlistTraders;
  const wlByAddr = new Map(dbWl.map(w => [w.address, w]));
  let wlMismatch = 0;
  for (const w of srcWl) {
    const db = wlByAddr.get((w.address ?? '').toLowerCase());
    if (!db) { wlMismatch++; continue; }
    if (db.copyEnabled !== w.copyEnabled) wlMismatch++;
    else if (Math.abs((db.copyAmount ?? 0) - (w.copyAmount ?? 0)) > 1e-9) wlMismatch++;
  }
  checks.push({ name: 'watchlistTraders (addr+copyEnabled+copyAmount)', ok: srcWl.length === dbWl.length && wlMismatch === 0,
    detail: `src=${srcWl.length} db=${dbWl.length} mismatches=${wlMismatch}` });

  const srcLF = (legacy as any).leaderboardFilters ?? {};
  const dbLF  = s.leaderboardFilters;
  const lfOk = (dbLF.minWinRate === (srcLF.minWinRate ?? 0))
            && (dbLF.minTrades  === (srcLF.minTrades  ?? 0))
            && (dbLF.minSharpe  === (srcLF.minSharpe  ?? 0))
            && (dbLF.minRoi     === (srcLF.minRoi     ?? 0));
  checks.push({ name: 'leaderboardFilters (thresholds)', ok: lfOk, detail: JSON.stringify(dbLF) });

  // Operational state must be empty.
  checks.push({ name: 'openTrades empty',         ok: s.openTrades.length === 0,        detail: `count=${s.openTrades.length}` });
  checks.push({ name: 'closedTrades empty',       ok: s.closedTrades.length === 0,      detail: `count=${s.closedTrades.length}` });
  checks.push({ name: 'processedTradeIds empty',  ok: s.processedTradeIds.length === 0, detail: `count=${s.processedTradeIds.length}` });
  checks.push({ name: 'traderHistory empty',      ok: Object.keys(s.traderHistory).length === 0, detail: `keys=${Object.keys(s.traderHistory).length}` });
  checks.push({ name: 'traderFalconCache empty',  ok: Object.keys(s.traderFalconCache).length === 0, detail: `keys=${Object.keys(s.traderFalconCache).length}` });

  let allOk = true;
  for (const c of checks) { if (!c.ok) allOk = false; console.log(`${c.ok ? 'OK ' : 'FAIL'}  ${c.name}  ${c.detail ?? ''}`); }
  process.exit(allOk ? 0 : 1);
}

main();
