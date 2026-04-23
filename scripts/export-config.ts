/**
 * Phase-2 cutover migrator: extracts config-only fields from a legacy
 * trades.json and writes them into a fresh store.db. Operational state
 * (open/closed trades, dedup IDs, history, caches) is intentionally not
 * migrated — per the Phase-1 scoping, stats reset on cutover.
 *
 * Usage:
 *   npx ts-node scripts/export-config.ts <trades.json> <store.db>
 *
 * Refuses to overwrite an existing target DB. Run against a copy.
 */
import fs from 'fs';
import path from 'path';
import { TradesStore, WatchlistTrader, LeaderboardFilters } from '../src/types';
import { _setDbPathForTests, readStore, writeStore, _closeDb } from '../src/store';

const DEFAULT_FILTERS: LeaderboardFilters = {
  categories: [], minWinRate: 0, minTrades: 0, minSharpe: 0, minRoi: 0,
};

function usage(): never {
  console.error('Usage: ts-node scripts/export-config.ts <trades.json> <store.db>');
  process.exit(2);
}

function main(): void {
  const [, , srcArg, dstArg] = process.argv;
  if (!srcArg || !dstArg) usage();

  const src = path.resolve(srcArg);
  const dst = path.resolve(dstArg);

  if (!fs.existsSync(src)) {
    console.error(`[migrate] source not found: ${src}`);
    process.exit(1);
  }
  if (fs.existsSync(dst)) {
    console.error(`[migrate] target DB already exists: ${dst}`);
    console.error('[migrate] refusing to overwrite. Delete it first if you really want to re-migrate.');
    process.exit(1);
  }

  // Parse legacy store.
  const raw = fs.readFileSync(src, 'utf-8');
  const legacy = JSON.parse(raw) as Partial<TradesStore> & {
    leaderboardFilters?: LeaderboardFilters & { category?: string };
  };

  // ── Preserved fields ────────────────────────────────────────────────────
  const excludedTraders: string[]      = Array.isArray(legacy.excludedTraders)     ? [...legacy.excludedTraders]     : [];
  const autoExcluded: string[]         = Array.isArray(legacy.autoExcludedTraders) ? [...legacy.autoExcludedTraders] : [];
  const excludedCategories: string[]   = Array.isArray(legacy.excludedCategories)  ? [...legacy.excludedCategories]  : [];

  if (!Array.isArray(legacy.watchlistTraders) || legacy.watchlistTraders.length === 0) {
    console.error('[migrate] source has no watchlistTraders — refusing to migrate.');
    console.error('[migrate] this would leave the new DB with seeded defaults instead of your actual watchlist.');
    process.exit(1);
  }
  const watchlistTraders: WatchlistTrader[] = legacy.watchlistTraders.map(w => ({
    address:     (w.address ?? '').toLowerCase(),
    label:       w.label,
    addedAt:     w.addedAt ?? new Date(0).toISOString(),
    copyEnabled: typeof w.copyEnabled === 'boolean' ? w.copyEnabled : true,
    copyAmount:  typeof w.copyAmount  === 'number' && w.copyAmount > 0 ? w.copyAmount : 5,
    falconWinRate: w.falconWinRate,
    falconRoi:     w.falconRoi,
    falconSharpe:  w.falconSharpe,
  }));

  // leaderboardFilters: handle legacy single-category migration just in case.
  let leaderboardFilters: LeaderboardFilters = { ...DEFAULT_FILTERS };
  if (legacy.leaderboardFilters) {
    const f = legacy.leaderboardFilters;
    if (!Array.isArray(f.categories) && f.category) {
      leaderboardFilters = {
        ...DEFAULT_FILTERS,
        categories: f.category && f.category !== 'all' ? [f.category] : [],
        minWinRate: f.minWinRate ?? 0,
        minTrades:  f.minTrades  ?? 0,
        minSharpe:  f.minSharpe  ?? 0,
        minRoi:     f.minRoi     ?? 0,
      };
    } else {
      leaderboardFilters = { ...DEFAULT_FILTERS, ...f };
    }
  }

  // ── Build minimal snapshot ──────────────────────────────────────────────
  // Everything except the preserved fields starts empty.
  const snapshot: TradesStore = {
    trackedTraders: [],
    excludedTraders,
    autoExcludedTraders: autoExcluded,
    excludedCategories,
    leaderboardFilters,
    openTrades: [],
    closedTrades: [],
    processedTradeIds: [],
    traderLastSeen: {},
    traderLastOnLeaderboard: {},
    traderHistory: {},
    lastLeaderboardUpdate: new Date(0).toISOString(),
    watchlistTraders,
    traderFalconCache: {},
    shadowOpenTrades: [],
    shadowClosedTrades: [],
    processedShadowIds: [],
    shadowLastSeen: {},
  };

  // ── Write ───────────────────────────────────────────────────────────────
  _setDbPathForTests(dst);         // points store at target; triggers schema + seed
  readStore();                     // forces DB init
  writeStore(snapshot);            // DELETE+INSERT replaces seeded watchlist with imported
  _closeDb();

  // ── Report ──────────────────────────────────────────────────────────────
  const enabled = watchlistTraders.filter(w => w.copyEnabled).length;
  const totalCopy = watchlistTraders.reduce((a, w) => a + w.copyAmount, 0);
  console.log('[migrate] done.');
  console.log(`[migrate]   source:           ${src}`);
  console.log(`[migrate]   target:           ${dst} (${(fs.statSync(dst).size / 1024).toFixed(1)} KB)`);
  console.log(`[migrate]   excludedTraders:      ${excludedTraders.length} (${autoExcluded.length} auto-excluded)`);
  console.log(`[migrate]   excludedCategories:   ${excludedCategories.length} [${excludedCategories.join(', ') || '-'}]`);
  console.log(`[migrate]   watchlistTraders:     ${watchlistTraders.length} (${enabled} enabled, $${totalCopy.toFixed(2)} total copyAmount)`);
  console.log(`[migrate]   leaderboardFilters:   categories=[${leaderboardFilters.categories.join(', ') || '-'}] minWinRate=${leaderboardFilters.minWinRate} minTrades=${leaderboardFilters.minTrades} minSharpe=${leaderboardFilters.minSharpe} minRoi=${leaderboardFilters.minRoi}`);
}

main();
