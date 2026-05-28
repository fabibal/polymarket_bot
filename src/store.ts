/**
 * SQLite-backed trades store. Same public API as the previous JSON store:
 * readStore() returns a full in-memory snapshot of type TradesStore, and
 * writeStore(store) persists that snapshot transactionally. Hot-path
 * mutations (addOpenTrade, closeOpenTrade, resolveByPrice, markProcessed,
 * and their shadow siblings) do direct SQL writes and mirror the in-memory
 * cache so callers observing the snapshot stay consistent.
 *
 * Crash-safety: WAL mode. Atomicity: per-mutation transactions.
 *
 * Migration scope (Phase 1): only config-like rows are preserved on cutover
 * from the old JSON format; operational state (open/closed trades, dedup
 * IDs, history, caches) starts empty. The legacy-format runtime migrations
 * that lived in the old readStore() have been removed.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import {
  TradesStore, SimulatedTrade, LeaderboardTrader, WatchlistTrader,
  TraderHistoryEntry, LeaderboardFilters, LeaderboardStats,
} from './types';
import { CONFIG } from './config';

const DEFAULT_FILTERS: LeaderboardFilters = { categories: [], minWinRate: 0, minTrades: 0, minSharpe: 0, minRoi: 0 };

const WATCHLIST_DEFAULTS: WatchlistTrader[] = [
  { address: '0x8a6c6811e8937f9e8afc1b9249fa540262c30b3f', label: 'MultiSport-Analytics', addedAt: new Date(0).toISOString(), copyEnabled: true,  copyAmount: 5 },
  { address: '0x8a3ab8120807bd64a3de48695110e390fa2ceb9a', label: 'SharpSports',          addedAt: new Date(0).toISOString(), copyEnabled: true,  copyAmount: 5 },
  { address: '0xdb27bf2ac5d428a9c63dbc914611036855a6c56e', label: 'DrPufferfish',         addedAt: new Date(0).toISOString(), copyEnabled: false, copyAmount: 5 },
  { address: '0xa4eb52229991c074bc560f825bf2776d77acd010', label: 'GeoPolitics-Expert',   addedAt: new Date(0).toISOString(), copyEnabled: true,  copyAmount: 5 },
  { address: '0x959afc4649fb9ed03c0205070fa114eec4f97b64', label: 'NBA-Specialist',       addedAt: new Date(0).toISOString(), copyEnabled: true,  copyAmount: 5 },
];

const EMPTY_STORE = (): TradesStore => ({
  trackedTraders: [],
  excludedTraders: [],
  autoExcludedTraders: [],
  excludedCategories: [],
  leaderboardFilters: { ...DEFAULT_FILTERS },
  openTrades: [],
  closedTrades: [],
  processedTradeIds: [],
  traderLastSeen: {},
  traderLastOnLeaderboard: {},
  traderHistory: {},
  lastLeaderboardUpdate: new Date(0).toISOString(),
  watchlistTraders: [],
  traderFalconCache: {},
  shadowOpenTrades: [],
  shadowClosedTrades: [],
  processedShadowIds: [],
  shadowLastSeen: {},
});

const PROCESSED_IDS_CAP = 100_000;
const PROCESSED_IDS_WARN = 80_000;
const SHADOW_IDS_CAP = 50_000;
const SIDE_CAP = 100;

// ── Schema ──────────────────────────────────────────────────────────────────
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracked_traders (
  address          TEXT PRIMARY KEY,
  rank             INTEGER NOT NULL,
  username         TEXT,
  weekly_pnl       REAL NOT NULL,
  total_volume     REAL,
  inactive         INTEGER,
  falcon_win_rate  REAL,
  falcon_roi       REAL,
  falcon_sharpe    REAL,
  tracked_since    TEXT
);

CREATE TABLE IF NOT EXISTS excluded_traders (
  address TEXT PRIMARY KEY,
  auto    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS excluded_categories (
  category TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS watchlist_traders (
  address          TEXT PRIMARY KEY,
  label            TEXT,
  added_at         TEXT NOT NULL,
  copy_enabled     INTEGER NOT NULL DEFAULT 1,
  copy_amount      REAL NOT NULL DEFAULT 5,
  falcon_win_rate  REAL,
  falcon_roi       REAL,
  falcon_sharpe    REAL
);

CREATE TABLE IF NOT EXISTS open_trades (
  id                        TEXT PRIMARY KEY,
  source_trade_id           TEXT NOT NULL,
  timestamp                 TEXT NOT NULL,
  copied_trader             TEXT NOT NULL,
  copied_trader_rank        INTEGER NOT NULL,
  copied_trader_username    TEXT,
  copied_trader_source      TEXT,
  market_slug               TEXT NOT NULL,
  market_title              TEXT NOT NULL,
  outcome                   TEXT NOT NULL,
  side                      TEXT NOT NULL,
  entry_price               REAL NOT NULL,
  simulated_amount          REAL NOT NULL,
  simulated_shares          REAL NOT NULL,
  current_price             REAL,
  unrealized_pnl            REAL,
  status                    TEXT NOT NULL,
  entry_gas_cost            REAL,
  entry_slippage_cost       REAL,
  insertion_order           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_open_fifo
  ON open_trades (copied_trader, market_slug, outcome, insertion_order);

CREATE TABLE IF NOT EXISTS closed_trades (
  id                        TEXT PRIMARY KEY,
  source_trade_id           TEXT NOT NULL,
  timestamp                 TEXT NOT NULL,
  copied_trader             TEXT NOT NULL,
  copied_trader_rank        INTEGER NOT NULL,
  copied_trader_username    TEXT,
  copied_trader_source      TEXT,
  market_slug               TEXT NOT NULL,
  market_title              TEXT NOT NULL,
  outcome                   TEXT NOT NULL,
  side                      TEXT NOT NULL,
  entry_price               REAL NOT NULL,
  simulated_amount          REAL NOT NULL,
  simulated_shares          REAL NOT NULL,
  current_price             REAL,
  unrealized_pnl            REAL,
  status                    TEXT NOT NULL,
  exit_price                REAL,
  realized_pnl              REAL,
  closed_at                 TEXT,
  holding_period_ms         INTEGER,
  entry_gas_cost            REAL,
  entry_slippage_cost       REAL,
  exit_slippage_cost        REAL,
  cost_adjusted_pnl         REAL,
  insertion_order           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_closed_closed_at ON closed_trades (closed_at);

CREATE TABLE IF NOT EXISTS processed_trade_ids (
  id           TEXT PRIMARY KEY,
  added_order  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_processed_order ON processed_trade_ids (added_order);

CREATE TABLE IF NOT EXISTS shadow_open_trades (
  id                        TEXT PRIMARY KEY,
  source_trade_id           TEXT NOT NULL,
  timestamp                 TEXT NOT NULL,
  copied_trader             TEXT NOT NULL,
  copied_trader_rank        INTEGER NOT NULL,
  copied_trader_username    TEXT,
  copied_trader_source      TEXT,
  market_slug               TEXT NOT NULL,
  market_title              TEXT NOT NULL,
  outcome                   TEXT NOT NULL,
  side                      TEXT NOT NULL,
  entry_price               REAL NOT NULL,
  simulated_amount          REAL NOT NULL,
  simulated_shares          REAL NOT NULL,
  current_price             REAL,
  unrealized_pnl            REAL,
  status                    TEXT NOT NULL,
  entry_gas_cost            REAL,
  entry_slippage_cost       REAL,
  insertion_order           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shadow_open_fifo
  ON shadow_open_trades (copied_trader, market_slug, outcome, insertion_order);

CREATE TABLE IF NOT EXISTS shadow_closed_trades (
  id                        TEXT PRIMARY KEY,
  source_trade_id           TEXT NOT NULL,
  timestamp                 TEXT NOT NULL,
  copied_trader             TEXT NOT NULL,
  copied_trader_rank        INTEGER NOT NULL,
  copied_trader_username    TEXT,
  copied_trader_source      TEXT,
  market_slug               TEXT NOT NULL,
  market_title              TEXT NOT NULL,
  outcome                   TEXT NOT NULL,
  side                      TEXT NOT NULL,
  entry_price               REAL NOT NULL,
  simulated_amount          REAL NOT NULL,
  simulated_shares          REAL NOT NULL,
  current_price             REAL,
  unrealized_pnl            REAL,
  status                    TEXT NOT NULL,
  exit_price                REAL,
  realized_pnl              REAL,
  closed_at                 TEXT,
  holding_period_ms         INTEGER,
  entry_gas_cost            REAL,
  entry_slippage_cost       REAL,
  exit_slippage_cost        REAL,
  cost_adjusted_pnl         REAL,
  insertion_order           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shadow_closed_at ON shadow_closed_trades (closed_at);

CREATE TABLE IF NOT EXISTS processed_shadow_ids (
  id           TEXT PRIMARY KEY,
  added_order  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_processed_shadow_order ON processed_shadow_ids (added_order);

CREATE TABLE IF NOT EXISTS trader_last_seen (
  address   TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trader_last_on_leaderboard (
  address   TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shadow_last_seen (
  address   TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trader_history (
  address          TEXT NOT NULL,
  side             TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  timestamp        TEXT NOT NULL,
  slug             TEXT NOT NULL,
  title            TEXT,
  outcome          TEXT,
  type             TEXT NOT NULL,
  price            REAL,
  size             REAL,
  PRIMARY KEY (address, side, transaction_hash)
);
CREATE INDEX IF NOT EXISTS idx_history_ts ON trader_history (address, side, timestamp DESC);

CREATE TABLE IF NOT EXISTS trader_history_meta (
  address      TEXT PRIMARY KEY,
  last_fetched TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trader_falcon_cache (
  address    TEXT PRIMARY KEY,
  win_rate   REAL,
  updated_at TEXT NOT NULL
);
`;

// ── DB lifecycle ────────────────────────────────────────────────────────────
let db: Db | null = null;
let dbPathOverride: string | null = null;
let cachedStore: TradesStore | null = null;
let isDirty = false;
let flushTimer: NodeJS.Timeout | null = null;
let insertionCounter = 0; // monotonic counter for FIFO ordering in-session

function getDb(): Db {
  if (db) return db;
  const dbPath = dbPathOverride ?? CONFIG.DB_FILE;
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const d = new Database(dbPath);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  d.exec(SCHEMA);
  // Truncate stale WAL on startup; saw 44MB WAL alongside 41MB db on 2026-05-28.
  try { d.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* non-fatal */ }
  migrateDepthColumns(d);
  seedIfFresh(d);
  _initInsertionCounterFromDb(d);
  db = d;
  return d;
}

// Resume the insertion counter past any existing rows so a warm DB preserves
// FIFO ordering across restarts. Without this, post-restart trades would carry
// insertion_order=1,2,3... and sort as "older" than pre-restart rows in the
// thousands, breaking BUY-SELL pairing in closeOpenTrade.
function _initInsertionCounterFromDb(d: Db): void {
  const row = d.prepare(
    `SELECT MAX(ord) AS m FROM (
       SELECT MAX(insertion_order) AS ord FROM open_trades
       UNION ALL SELECT MAX(insertion_order) FROM closed_trades
       UNION ALL SELECT MAX(insertion_order) FROM shadow_open_trades
       UNION ALL SELECT MAX(insertion_order) FROM shadow_closed_trades
     )`
  ).get() as { m: number | null };
  insertionCounter = (row?.m ?? 0) + 1;
  console.log(`[store] Initialized insertionCounter to ${insertionCounter} (from existing data)`);
}

/**
 * Public startup hook: opens the DB if needed and resumes the insertion
 * counter past any existing rows. Idempotent — first call performs the init
 * and logs; subsequent calls are no-ops because getDb() caches the connection.
 * Returns the next insertion_order value that will be assigned.
 */
export function initInsertionCounter(): number {
  getDb();
  return insertionCounter;
}

const DEPTH_COLS: Array<[string, string]> = [
  ['best_ask',         'REAL'],
  ['best_bid',         'REAL'],
  ['ask_depth_5',      'REAL'],
  ['ask_depth_10',     'REAL'],
  ['spread_at_entry',  'REAL'],
  ['depth_backfilled', 'INTEGER'],
];

function migrateDepthColumns(d: Db): void {
  const tables = ['open_trades', 'closed_trades', 'shadow_open_trades', 'shadow_closed_trades'];
  for (const t of tables) {
    const existing = new Set(
      (d.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(r => r.name)
    );
    for (const [col, type] of DEPTH_COLS) {
      if (!existing.has(col)) d.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${type}`);
    }
  }
}

function seedIfFresh(d: Db): void {
  const row = d.prepare('SELECT COUNT(*) AS c FROM watchlist_traders').get() as { c: number };
  if (row.c === 0) {
    const stmt = d.prepare(
      `INSERT INTO watchlist_traders (address, label, added_at, copy_enabled, copy_amount)
       VALUES (?, ?, ?, ?, ?)`
    );
    const tx = d.transaction(() => {
      for (const w of WATCHLIST_DEFAULTS) {
        stmt.run(w.address, w.label ?? null, w.addedAt, w.copyEnabled ? 1 : 0, w.copyAmount);
      }
    });
    tx();
  }
  // leaderboardFilters singleton
  const f = d.prepare(`SELECT value FROM meta WHERE key = 'leaderboardFilters'`).get() as { value: string } | undefined;
  if (!f) {
    d.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`).run('leaderboardFilters', JSON.stringify(DEFAULT_FILTERS));
  }
}

/** Test hook: point the store at a fresh DB (file path or ':memory:'). */
export function _setDbPathForTests(p: string | null): void {
  if (db) { db.close(); db = null; }
  dbPathOverride = p;
  cachedStore = null;
  isDirty = false;
  insertionCounter = 0;
}

/** Test hook: read the current in-memory insertion counter. */
export function _getInsertionCounter(): number {
  return insertionCounter;
}

/** Test hook: drop the in-memory snapshot cache. */
export function _resetStoreCache(): void {
  cachedStore = null;
  isDirty = false;
}

/** Close the DB. Intended for shutdown paths and tests. */
export function _closeDb(): void {
  if (db) { db.close(); db = null; }
}

// ── Row <-> object mappers ──────────────────────────────────────────────────
type TradeRow = {
  id: string; source_trade_id: string; timestamp: string;
  copied_trader: string; copied_trader_rank: number;
  copied_trader_username: string | null; copied_trader_source: string | null;
  market_slug: string; market_title: string; outcome: string; side: string;
  entry_price: number; simulated_amount: number; simulated_shares: number;
  current_price: number | null; unrealized_pnl: number | null; status: string;
  entry_gas_cost: number | null; entry_slippage_cost: number | null;
  exit_price?: number | null; realized_pnl?: number | null;
  closed_at?: string | null; holding_period_ms?: number | null;
  exit_slippage_cost?: number | null; cost_adjusted_pnl?: number | null;
  best_ask?: number | null; best_bid?: number | null;
  ask_depth_5?: number | null; ask_depth_10?: number | null;
  spread_at_entry?: number | null; depth_backfilled?: number | null;
  insertion_order: number;
};

function rowToTrade(r: TradeRow): SimulatedTrade {
  const t: SimulatedTrade = {
    id: r.id,
    sourceTradeId: r.source_trade_id,
    timestamp: r.timestamp,
    copiedTrader: r.copied_trader,
    copiedTraderRank: r.copied_trader_rank,
    marketSlug: r.market_slug,
    marketTitle: r.market_title,
    outcome: r.outcome,
    side: r.side as 'buy' | 'sell',
    entryPrice: r.entry_price,
    simulatedAmount: r.simulated_amount,
    simulatedShares: r.simulated_shares,
    status: r.status as 'open' | 'resolved' | 'expired',
  };
  if (r.copied_trader_username != null) t.copiedTraderUsername = r.copied_trader_username;
  if (r.copied_trader_source   != null) t.copiedTraderSource   = r.copied_trader_source as 'leaderboard' | 'watchlist';
  if (r.current_price          != null) t.currentPrice         = r.current_price;
  if (r.unrealized_pnl         != null) t.unrealizedPnl        = r.unrealized_pnl;
  if (r.entry_gas_cost         != null) t.entryGasCost         = r.entry_gas_cost;
  if (r.entry_slippage_cost    != null) t.entrySlippageCost    = r.entry_slippage_cost;
  if (r.exit_price             != null) t.exitPrice            = r.exit_price;
  if (r.realized_pnl           != null) t.realizedPnl          = r.realized_pnl;
  if (r.closed_at              != null) t.closedAt             = r.closed_at;
  if (r.holding_period_ms      != null) t.holdingPeriodMs      = r.holding_period_ms;
  if (r.exit_slippage_cost     != null) t.exitSlippageCost     = r.exit_slippage_cost;
  if (r.cost_adjusted_pnl      != null) t.costAdjustedPnl      = r.cost_adjusted_pnl;
  if (r.best_ask               != null) t.bestAsk              = r.best_ask;
  if (r.best_bid               != null) t.bestBid              = r.best_bid;
  if (r.ask_depth_5            != null) t.askDepth5            = r.ask_depth_5;
  if (r.ask_depth_10           != null) t.askDepth10           = r.ask_depth_10;
  if (r.spread_at_entry        != null) t.spreadAtEntry        = r.spread_at_entry;
  if (r.depth_backfilled       != null) t.depthBackfilled      = !!r.depth_backfilled;
  return t;
}

const DEPTH_VALS = (t: SimulatedTrade) => [
  t.bestAsk ?? null, t.bestBid ?? null,
  t.askDepth5 ?? null, t.askDepth10 ?? null,
  t.spreadAtEntry ?? null,
  t.depthBackfilled == null ? null : (t.depthBackfilled ? 1 : 0),
];

function openTradeRowParams(t: SimulatedTrade, order: number): any[] {
  return [
    t.id, t.sourceTradeId, t.timestamp, t.copiedTrader, t.copiedTraderRank,
    t.copiedTraderUsername ?? null, t.copiedTraderSource ?? null,
    t.marketSlug, t.marketTitle, t.outcome, t.side,
    t.entryPrice, t.simulatedAmount, t.simulatedShares,
    t.currentPrice ?? null, t.unrealizedPnl ?? null, t.status,
    t.entryGasCost ?? null, t.entrySlippageCost ?? null,
    ...DEPTH_VALS(t),
    order,
  ];
}

function closedTradeRowParams(t: SimulatedTrade, order: number): any[] {
  return [
    t.id, t.sourceTradeId, t.timestamp, t.copiedTrader, t.copiedTraderRank,
    t.copiedTraderUsername ?? null, t.copiedTraderSource ?? null,
    t.marketSlug, t.marketTitle, t.outcome, t.side,
    t.entryPrice, t.simulatedAmount, t.simulatedShares,
    t.currentPrice ?? null, t.unrealizedPnl ?? null, t.status,
    t.exitPrice ?? null, t.realizedPnl ?? null, t.closedAt ?? null,
    t.holdingPeriodMs ?? null,
    t.entryGasCost ?? null, t.entrySlippageCost ?? null,
    t.exitSlippageCost ?? null, t.costAdjustedPnl ?? null,
    ...DEPTH_VALS(t),
    order,
  ];
}

const DEPTH_COL_NAMES = 'best_ask, best_bid, ask_depth_5, ask_depth_10, spread_at_entry, depth_backfilled';

const OPEN_INSERT_COLS = `(id, source_trade_id, timestamp, copied_trader, copied_trader_rank,
  copied_trader_username, copied_trader_source, market_slug, market_title, outcome, side,
  entry_price, simulated_amount, simulated_shares, current_price, unrealized_pnl, status,
  entry_gas_cost, entry_slippage_cost, ${DEPTH_COL_NAMES}, insertion_order)`;
const OPEN_INSERT_PLACEHOLDERS = '(' + new Array(26).fill('?').join(',') + ')';

const CLOSED_INSERT_COLS = `(id, source_trade_id, timestamp, copied_trader, copied_trader_rank,
  copied_trader_username, copied_trader_source, market_slug, market_title, outcome, side,
  entry_price, simulated_amount, simulated_shares, current_price, unrealized_pnl, status,
  exit_price, realized_pnl, closed_at, holding_period_ms,
  entry_gas_cost, entry_slippage_cost, exit_slippage_cost, cost_adjusted_pnl, ${DEPTH_COL_NAMES}, insertion_order)`;
const CLOSED_INSERT_PLACEHOLDERS = '(' + new Array(32).fill('?').join(',') + ')';

// ── Snapshot load ───────────────────────────────────────────────────────────
function loadSnapshot(): TradesStore {
  const d = getDb();
  const s = EMPTY_STORE();

  s.trackedTraders = (d.prepare('SELECT * FROM tracked_traders ORDER BY rank ASC').all() as any[]).map(r => {
    const t: LeaderboardTrader = {
      rank: r.rank, address: r.address,
      weeklyPnl: r.weekly_pnl,
    };
    if (r.username        != null) t.username       = r.username;
    if (r.total_volume    != null) t.totalVolume    = r.total_volume;
    if (r.inactive        != null) t.inactive       = !!r.inactive;
    if (r.falcon_win_rate != null) t.falconWinRate  = r.falcon_win_rate;
    if (r.falcon_roi      != null) t.falconRoi      = r.falcon_roi;
    if (r.falcon_sharpe   != null) t.falconSharpe   = r.falcon_sharpe;
    if (r.tracked_since   != null) t.trackedSince   = r.tracked_since;
    return t;
  });

  const exc = d.prepare('SELECT address, auto FROM excluded_traders').all() as Array<{ address: string; auto: number }>;
  s.excludedTraders     = exc.map(r => r.address);
  s.autoExcludedTraders = exc.filter(r => r.auto === 1).map(r => r.address);

  s.excludedCategories = (d.prepare('SELECT category FROM excluded_categories').all() as Array<{ category: string }>).map(r => r.category);
  for (const c of CONFIG.FORCE_EXCLUDE_CATEGORIES) if (!s.excludedCategories.includes(c)) s.excludedCategories.push(c);

  s.watchlistTraders = (d.prepare('SELECT * FROM watchlist_traders ORDER BY added_at ASC').all() as any[]).map(r => {
    const w: WatchlistTrader = {
      address: r.address, addedAt: r.added_at,
      copyEnabled: r.copy_enabled === 1,
      copyAmount: r.copy_amount,
    };
    if (r.label != null) w.label = r.label;
    if (r.falcon_win_rate != null) w.falconWinRate = r.falcon_win_rate;
    if (r.falcon_roi      != null) w.falconRoi     = r.falcon_roi;
    if (r.falcon_sharpe   != null) w.falconSharpe  = r.falcon_sharpe;
    return w;
  });

  s.openTrades     = (d.prepare('SELECT * FROM open_trades     ORDER BY insertion_order ASC').all() as TradeRow[]).map(rowToTrade);
  s.closedTrades   = (d.prepare('SELECT * FROM closed_trades   ORDER BY insertion_order ASC').all() as TradeRow[]).map(rowToTrade);
  s.shadowOpenTrades   = (d.prepare('SELECT * FROM shadow_open_trades   ORDER BY insertion_order ASC').all() as TradeRow[]).map(rowToTrade);
  s.shadowClosedTrades = (d.prepare('SELECT * FROM shadow_closed_trades ORDER BY insertion_order ASC').all() as TradeRow[]).map(rowToTrade);

  s.processedTradeIds  = (d.prepare('SELECT id FROM processed_trade_ids  ORDER BY added_order ASC').all() as Array<{ id: string }>).map(r => r.id);
  s.processedShadowIds = (d.prepare('SELECT id FROM processed_shadow_ids ORDER BY added_order ASC').all() as Array<{ id: string }>).map(r => r.id);

  s.traderLastSeen          = Object.fromEntries((d.prepare('SELECT address, timestamp FROM trader_last_seen').all() as Array<{ address: string; timestamp: string }>).map(r => [r.address, r.timestamp]));
  s.traderLastOnLeaderboard = Object.fromEntries((d.prepare('SELECT address, timestamp FROM trader_last_on_leaderboard').all() as Array<{ address: string; timestamp: string }>).map(r => [r.address, r.timestamp]));
  s.shadowLastSeen          = Object.fromEntries((d.prepare('SELECT address, timestamp FROM shadow_last_seen').all() as Array<{ address: string; timestamp: string }>).map(r => [r.address, r.timestamp]));

  // trader_history: group by address + side
  const histRows = d.prepare('SELECT address, side, transaction_hash, timestamp, slug, title, outcome, type, price, size FROM trader_history ORDER BY timestamp DESC').all() as Array<{
    address: string; side: string; transaction_hash: string; timestamp: string;
    slug: string; title: string | null; outcome: string | null; type: string;
    price: number | null; size: number | null;
  }>;
  const metaRows = d.prepare('SELECT address, last_fetched FROM trader_history_meta').all() as Array<{ address: string; last_fetched: string }>;
  const metaMap = new Map(metaRows.map(r => [r.address, r.last_fetched]));
  for (const r of histRows) {
    const h = s.traderHistory[r.address] ??= { buys: [], sells: [], lastFetched: metaMap.get(r.address) ?? '' };
    const entry: TraderHistoryEntry = {
      transaction_hash: r.transaction_hash, timestamp: r.timestamp, slug: r.slug,
      side: r.side, type: r.type,
    };
    if (r.title   != null) entry.title   = r.title;
    if (r.outcome != null) entry.outcome = r.outcome;
    if (r.price   != null) entry.price   = r.price;
    if (r.size    != null) entry.size    = r.size;
    if (r.side === 'SELL') h.sells.push(entry); else h.buys.push(entry);
  }
  // Addresses with meta but no rows still need an entry.
  for (const r of metaRows) {
    if (!s.traderHistory[r.address]) s.traderHistory[r.address] = { buys: [], sells: [], lastFetched: r.last_fetched };
  }

  s.traderFalconCache = Object.fromEntries(
    (d.prepare('SELECT address, win_rate, updated_at FROM trader_falcon_cache').all() as Array<{ address: string; win_rate: number | null; updated_at: string }>)
      .map(r => [r.address, { winRate: r.win_rate ?? undefined, updatedAt: r.updated_at }])
  );

  const fr = d.prepare(`SELECT value FROM meta WHERE key = 'leaderboardFilters'`).get() as { value: string } | undefined;
  if (fr) try { s.leaderboardFilters = { ...DEFAULT_FILTERS, ...JSON.parse(fr.value) }; } catch {}

  const lu = d.prepare(`SELECT value FROM meta WHERE key = 'lastLeaderboardUpdate'`).get() as { value: string } | undefined;
  if (lu) s.lastLeaderboardUpdate = lu.value;

  const ls = d.prepare(`SELECT value FROM meta WHERE key = 'lastLeaderboardStats'`).get() as { value: string } | undefined;
  if (ls) try { s.lastLeaderboardStats = JSON.parse(ls.value); } catch {}

  return s;
}

// ── Snapshot persist (full rewrite in one transaction) ──────────────────────
function persistSnapshot(store: TradesStore): void {
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM tracked_traders').run();
    const tt = d.prepare(
      `INSERT INTO tracked_traders (address, rank, username, weekly_pnl, total_volume, inactive,
         falcon_win_rate, falcon_roi, falcon_sharpe, tracked_since) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const t of store.trackedTraders) {
      tt.run(
        t.address, t.rank, t.username ?? null, t.weeklyPnl,
        t.totalVolume ?? null, t.inactive == null ? null : (t.inactive ? 1 : 0),
        t.falconWinRate ?? null, t.falconRoi ?? null, t.falconSharpe ?? null,
        t.trackedSince ?? null,
      );
    }

    d.prepare('DELETE FROM excluded_traders').run();
    const ex = d.prepare('INSERT INTO excluded_traders (address, auto) VALUES (?,?)');
    const autoSet = new Set(store.autoExcludedTraders ?? []);
    for (const a of store.excludedTraders) ex.run(a, autoSet.has(a) ? 1 : 0);

    d.prepare('DELETE FROM excluded_categories').run();
    const ec = d.prepare('INSERT INTO excluded_categories (category) VALUES (?)');
    // De-dupe forced categories that may already be present.
    const seenCat = new Set<string>();
    for (const c of store.excludedCategories) if (!seenCat.has(c)) { ec.run(c); seenCat.add(c); }

    d.prepare('DELETE FROM watchlist_traders').run();
    const wt = d.prepare(
      `INSERT INTO watchlist_traders (address, label, added_at, copy_enabled, copy_amount,
         falcon_win_rate, falcon_roi, falcon_sharpe) VALUES (?,?,?,?,?,?,?,?)`);
    for (const w of store.watchlistTraders) {
      wt.run(w.address, w.label ?? null, w.addedAt, w.copyEnabled ? 1 : 0, w.copyAmount,
             w.falconWinRate ?? null, w.falconRoi ?? null, w.falconSharpe ?? null);
    }

    d.prepare('DELETE FROM open_trades').run();
    const oi = d.prepare(`INSERT INTO open_trades ${OPEN_INSERT_COLS} VALUES ${OPEN_INSERT_PLACEHOLDERS}`);
    let order = 1;
    for (const t of store.openTrades) oi.run(...openTradeRowParams(t, order++));

    d.prepare('DELETE FROM closed_trades').run();
    const ci = d.prepare(`INSERT INTO closed_trades ${CLOSED_INSERT_COLS} VALUES ${CLOSED_INSERT_PLACEHOLDERS}`);
    order = 1;
    for (const t of store.closedTrades) ci.run(...closedTradeRowParams(t, order++));

    d.prepare('DELETE FROM shadow_open_trades').run();
    const soi = d.prepare(`INSERT INTO shadow_open_trades ${OPEN_INSERT_COLS} VALUES ${OPEN_INSERT_PLACEHOLDERS}`);
    order = 1;
    for (const t of (store.shadowOpenTrades ?? [])) soi.run(...openTradeRowParams(t, order++));

    d.prepare('DELETE FROM shadow_closed_trades').run();
    const sci = d.prepare(`INSERT INTO shadow_closed_trades ${CLOSED_INSERT_COLS} VALUES ${CLOSED_INSERT_PLACEHOLDERS}`);
    order = 1;
    for (const t of (store.shadowClosedTrades ?? [])) sci.run(...closedTradeRowParams(t, order++));

    d.prepare('DELETE FROM processed_trade_ids').run();
    const pi = d.prepare('INSERT INTO processed_trade_ids (id, added_order) VALUES (?,?)');
    {
      let i = 1;
      const seen = new Set<string>();
      for (const id of store.processedTradeIds) if (!seen.has(id)) { pi.run(id, i++); seen.add(id); }
    }

    d.prepare('DELETE FROM processed_shadow_ids').run();
    const psi = d.prepare('INSERT INTO processed_shadow_ids (id, added_order) VALUES (?,?)');
    {
      let i = 1;
      const seen = new Set<string>();
      for (const id of (store.processedShadowIds ?? [])) if (!seen.has(id)) { psi.run(id, i++); seen.add(id); }
    }

    d.prepare('DELETE FROM trader_last_seen').run();
    const tls = d.prepare('INSERT INTO trader_last_seen (address, timestamp) VALUES (?,?)');
    for (const [a, ts] of Object.entries(store.traderLastSeen ?? {})) tls.run(a, ts);

    d.prepare('DELETE FROM trader_last_on_leaderboard').run();
    const tllb = d.prepare('INSERT INTO trader_last_on_leaderboard (address, timestamp) VALUES (?,?)');
    for (const [a, ts] of Object.entries(store.traderLastOnLeaderboard ?? {})) tllb.run(a, ts);

    d.prepare('DELETE FROM shadow_last_seen').run();
    const sls = d.prepare('INSERT INTO shadow_last_seen (address, timestamp) VALUES (?,?)');
    for (const [a, ts] of Object.entries(store.shadowLastSeen ?? {})) sls.run(a, ts);

    d.prepare('DELETE FROM trader_history').run();
    d.prepare('DELETE FROM trader_history_meta').run();
    const thi = d.prepare(
      `INSERT INTO trader_history (address, side, transaction_hash, timestamp, slug, title, outcome, type, price, size)
       VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const thm = d.prepare('INSERT INTO trader_history_meta (address, last_fetched) VALUES (?,?)');
    for (const [addr, h] of Object.entries(store.traderHistory ?? {})) {
      if (h.lastFetched) thm.run(addr, h.lastFetched);
      const seenB = new Set<string>(), seenS = new Set<string>();
      for (const b of h.buys  ?? []) { if (!b.transaction_hash || seenB.has(b.transaction_hash)) continue; seenB.add(b.transaction_hash);
        thi.run(addr, 'BUY', b.transaction_hash, b.timestamp, b.slug, b.title ?? null, b.outcome ?? null, b.type, b.price ?? null, b.size ?? null); }
      for (const s of h.sells ?? []) { if (!s.transaction_hash || seenS.has(s.transaction_hash)) continue; seenS.add(s.transaction_hash);
        thi.run(addr, 'SELL', s.transaction_hash, s.timestamp, s.slug, s.title ?? null, s.outcome ?? null, s.type, s.price ?? null, s.size ?? null); }
    }

    d.prepare('DELETE FROM trader_falcon_cache').run();
    const fc = d.prepare('INSERT INTO trader_falcon_cache (address, win_rate, updated_at) VALUES (?,?,?)');
    for (const [a, v] of Object.entries(store.traderFalconCache ?? {})) fc.run(a, v.winRate ?? null, v.updatedAt);

    const setMeta = d.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)');
    setMeta.run('leaderboardFilters', JSON.stringify(store.leaderboardFilters));
    setMeta.run('lastLeaderboardUpdate', store.lastLeaderboardUpdate);
    if (store.lastLeaderboardStats) setMeta.run('lastLeaderboardStats', JSON.stringify(store.lastLeaderboardStats));
    else d.prepare(`DELETE FROM meta WHERE key = 'lastLeaderboardStats'`).run();
  });
  tx();
}

// ── Public API ──────────────────────────────────────────────────────────────
export function readStore(): TradesStore {
  if (cachedStore) return cachedStore;
  cachedStore = loadSnapshot();
  return cachedStore;
}

export function writeStore(store: TradesStore): void {
  cachedStore = store;
  isDirty = false;
  persistSnapshot(store);
}

export function markDirty(store: TradesStore): void {
  cachedStore = store;
  isDirty = true;
}

export function flushIfDirty(): void {
  if (isDirty && cachedStore) {
    persistSnapshot(cachedStore);
    isDirty = false;
  }
}

export function startAutoFlush(intervalMs: number = 60_000): void {
  if (flushTimer) return;
  flushTimer = setInterval(flushIfDirty, intervalMs);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

export function stopAutoFlush(): void {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  flushIfDirty();
}

// ── Targeted mutations (direct SQL + cache mirror) ─────────────────────────

export function updateTrackedTraders(traders: LeaderboardTrader[]): void {
  const store = readStore();
  const now = new Date().toISOString();
  const prevMap = new Map(store.trackedTraders.map(t => [t.address, t.trackedSince]));
  for (const t of traders) t.trackedSince = prevMap.get(t.address) ?? now;
  store.trackedTraders = traders;
  store.lastLeaderboardUpdate = now;

  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM tracked_traders').run();
    const ins = d.prepare(
      `INSERT INTO tracked_traders (address, rank, username, weekly_pnl, total_volume, inactive,
         falcon_win_rate, falcon_roi, falcon_sharpe, tracked_since) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const t of traders) {
      ins.run(
        t.address, t.rank, t.username ?? null, t.weeklyPnl,
        t.totalVolume ?? null, t.inactive == null ? null : (t.inactive ? 1 : 0),
        t.falconWinRate ?? null, t.falconRoi ?? null, t.falconSharpe ?? null,
        t.trackedSince ?? null,
      );
    }
    d.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run('lastLeaderboardUpdate', now);
  });
  tx();
}

export function addOpenTrade(trade: SimulatedTrade): void {
  const store = readStore();
  store.openTrades.push(trade);
  store.processedTradeIds.push(trade.sourceTradeId);
  if (store.processedTradeIds.length > PROCESSED_IDS_CAP) {
    store.processedTradeIds = store.processedTradeIds.slice(-PROCESSED_IDS_CAP);
  } else if (store.processedTradeIds.length >= PROCESSED_IDS_WARN) {
    console.warn(`[store] processedTradeIds at ${store.processedTradeIds.length} — approaching ${PROCESSED_IDS_CAP} cap`);
  }

  const d = getDb();
  const order = insertionCounter++;
  const tx = d.transaction(() => {
    d.prepare(`INSERT INTO open_trades ${OPEN_INSERT_COLS} VALUES ${OPEN_INSERT_PLACEHOLDERS}`)
      .run(...openTradeRowParams(trade, order));
    d.prepare('INSERT OR IGNORE INTO processed_trade_ids (id, added_order) VALUES (?,?)').run(trade.sourceTradeId, order);
    // Enforce cap: drop oldest beyond cap.
    const over = d.prepare('SELECT COUNT(*) AS c FROM processed_trade_ids').get() as { c: number };
    if (over.c > PROCESSED_IDS_CAP) {
      const excess = over.c - PROCESSED_IDS_CAP;
      d.prepare('DELETE FROM processed_trade_ids WHERE id IN (SELECT id FROM processed_trade_ids ORDER BY added_order ASC LIMIT ?)').run(excess);
    }
  });
  tx();
}

function applyExitCosts(trade: SimulatedTrade, exitPrice: number): void {
  const shares = trade.simulatedShares;
  const gas    = trade.entryGasCost      ?? CONFIG.GAS_COST_PER_BUY;
  const eSlip  = trade.entrySlippageCost ?? CONFIG.SLIPPAGE_RATE * trade.entryPrice * shares;
  const xSlip  = CONFIG.SLIPPAGE_RATE * exitPrice * shares;
  trade.entryGasCost      = gas;
  trade.entrySlippageCost = eSlip;
  trade.exitSlippageCost  = xSlip;
  trade.costAdjustedPnl   = (trade.realizedPnl ?? 0) - gas - eSlip - xSlip;
}

export function closeOpenTrade(
  copiedTrader: string, marketSlug: string, outcome: string, sellPrice: number,
): boolean {
  const store = readStore();
  const idx = store.openTrades.findIndex(
    t => t.copiedTrader === copiedTrader && t.marketSlug === marketSlug && t.outcome === outcome,
  );
  if (idx === -1) return false;

  const trade = store.openTrades[idx];
  const closedAt = new Date().toISOString();
  trade.status = 'resolved';
  trade.exitPrice = sellPrice;
  trade.realizedPnl = (sellPrice - trade.entryPrice) * trade.simulatedShares;
  trade.closedAt = closedAt;
  trade.holdingPeriodMs = new Date(closedAt).getTime() - new Date(trade.timestamp).getTime();
  trade.currentPrice = sellPrice;
  trade.unrealizedPnl = 0;
  applyExitCosts(trade, sellPrice);

  store.openTrades.splice(idx, 1);
  store.closedTrades.push(trade);

  const d = getDb();
  const order = insertionCounter++;
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM open_trades WHERE id = ?').run(trade.id);
    d.prepare(`INSERT INTO closed_trades ${CLOSED_INSERT_COLS} VALUES ${CLOSED_INSERT_PLACEHOLDERS}`)
      .run(...closedTradeRowParams(trade, order));
  });
  tx();
  return true;
}

export function updateOpenTradeDepth(
  id: string,
  depth: { bestAsk: number; bestBid: number; askDepth5: number; askDepth10: number; spreadAtEntry: number },
  backfilled: boolean,
): void {
  const store = readStore();
  const t = store.openTrades.find(x => x.id === id);
  if (t) {
    t.bestAsk = depth.bestAsk;
    t.bestBid = depth.bestBid;
    t.askDepth5 = depth.askDepth5;
    t.askDepth10 = depth.askDepth10;
    t.spreadAtEntry = depth.spreadAtEntry;
    t.depthBackfilled = backfilled;
  }
  getDb().prepare(
    `UPDATE open_trades SET best_ask=?, best_bid=?, ask_depth_5=?, ask_depth_10=?,
       spread_at_entry=?, depth_backfilled=? WHERE id=?`
  ).run(depth.bestAsk, depth.bestBid, depth.askDepth5, depth.askDepth10,
        depth.spreadAtEntry, backfilled ? 1 : 0, id);
}

export function updateOpenTradePrices(
  updates: Array<{ id: string; currentPrice: number; unrealizedPnl: number }>,
): void {
  const store = readStore();
  for (const u of updates) {
    const t = store.openTrades.find(x => x.id === u.id);
    if (t) { t.currentPrice = u.currentPrice; t.unrealizedPnl = u.unrealizedPnl; }
  }
  const d = getDb();
  const stmt = d.prepare('UPDATE open_trades SET current_price = ?, unrealized_pnl = ? WHERE id = ?');
  const tx = d.transaction(() => { for (const u of updates) stmt.run(u.currentPrice, u.unrealizedPnl, u.id); });
  tx();
  // Still mark dirty so any callers that also mutated through the snapshot (besides prices) get flushed.
  isDirty = true;
}

export function resolveByPrice(
  toResolve: Array<{ id: string; exitPrice: number }>,
  status: 'resolved' | 'expired' = 'resolved',
): void {
  if (toResolve.length === 0) return;
  const store = readStore();
  const closedAt = new Date().toISOString();
  const closedMs = new Date(closedAt).getTime();
  const resolved: SimulatedTrade[] = [];
  store.openTrades = store.openTrades.filter(t => {
    const r = toResolve.find(x => x.id === t.id);
    if (!r) return true;
    t.status = status;
    t.exitPrice = r.exitPrice;
    t.realizedPnl = (r.exitPrice - t.entryPrice) * t.simulatedShares;
    t.closedAt = closedAt;
    t.holdingPeriodMs = closedMs - new Date(t.timestamp).getTime();
    applyExitCosts(t, r.exitPrice);
    resolved.push(t);
    return false;
  });
  store.closedTrades.push(...resolved);

  const d = getDb();
  const del = d.prepare('DELETE FROM open_trades WHERE id = ?');
  const insClosed = d.prepare(`INSERT INTO closed_trades ${CLOSED_INSERT_COLS} VALUES ${CLOSED_INSERT_PLACEHOLDERS}`);
  const tx = d.transaction(() => {
    for (const t of resolved) { del.run(t.id); insClosed.run(...closedTradeRowParams(t, insertionCounter++)); }
  });
  tx();
}

// Shadow variants ---------------------------------------------------------

export function isShadowProcessed(id: string): boolean {
  const store = readStore();
  return (store.processedShadowIds ?? []).includes(id);
}

export function markShadowProcessed(id: string): void {
  const store = readStore();
  if (!store.processedShadowIds) store.processedShadowIds = [];
  if (store.processedShadowIds.includes(id)) return;
  store.processedShadowIds.push(id);
  if (store.processedShadowIds.length > SHADOW_IDS_CAP) {
    store.processedShadowIds = store.processedShadowIds.slice(-SHADOW_IDS_CAP);
  }
  const d = getDb();
  const order = insertionCounter++;
  const tx = d.transaction(() => {
    d.prepare('INSERT OR IGNORE INTO processed_shadow_ids (id, added_order) VALUES (?,?)').run(id, order);
    const over = d.prepare('SELECT COUNT(*) AS c FROM processed_shadow_ids').get() as { c: number };
    if (over.c > SHADOW_IDS_CAP) {
      const excess = over.c - SHADOW_IDS_CAP;
      d.prepare('DELETE FROM processed_shadow_ids WHERE id IN (SELECT id FROM processed_shadow_ids ORDER BY added_order ASC LIMIT ?)').run(excess);
    }
  });
  tx();
}

export function addShadowOpenTrade(trade: SimulatedTrade): void {
  const store = readStore();
  if (!store.shadowOpenTrades) store.shadowOpenTrades = [];
  if (!store.processedShadowIds) store.processedShadowIds = [];
  store.shadowOpenTrades.push(trade);
  if (!store.processedShadowIds.includes(trade.sourceTradeId)) {
    store.processedShadowIds.push(trade.sourceTradeId);
    if (store.processedShadowIds.length > SHADOW_IDS_CAP) {
      store.processedShadowIds = store.processedShadowIds.slice(-SHADOW_IDS_CAP);
    }
  }

  const d = getDb();
  const order = insertionCounter++;
  const tx = d.transaction(() => {
    d.prepare(`INSERT INTO shadow_open_trades ${OPEN_INSERT_COLS} VALUES ${OPEN_INSERT_PLACEHOLDERS}`)
      .run(...openTradeRowParams(trade, order));
    d.prepare('INSERT OR IGNORE INTO processed_shadow_ids (id, added_order) VALUES (?,?)').run(trade.sourceTradeId, order);
    const over = d.prepare('SELECT COUNT(*) AS c FROM processed_shadow_ids').get() as { c: number };
    if (over.c > SHADOW_IDS_CAP) {
      const excess = over.c - SHADOW_IDS_CAP;
      d.prepare('DELETE FROM processed_shadow_ids WHERE id IN (SELECT id FROM processed_shadow_ids ORDER BY added_order ASC LIMIT ?)').run(excess);
    }
  });
  tx();
}

export function closeShadowOpenTrade(
  copiedTrader: string, marketSlug: string, outcome: string, sellPrice: number,
): boolean {
  const store = readStore();
  if (!store.shadowOpenTrades) return false;
  const idx = store.shadowOpenTrades.findIndex(
    t => t.copiedTrader === copiedTrader && t.marketSlug === marketSlug && t.outcome === outcome,
  );
  if (idx === -1) return false;
  const trade = store.shadowOpenTrades[idx];
  const closedAt = new Date().toISOString();
  trade.status = 'resolved';
  trade.exitPrice = sellPrice;
  trade.realizedPnl = (sellPrice - trade.entryPrice) * trade.simulatedShares;
  trade.closedAt = closedAt;
  trade.holdingPeriodMs = new Date(closedAt).getTime() - new Date(trade.timestamp).getTime();
  trade.currentPrice = sellPrice;
  trade.unrealizedPnl = 0;
  applyExitCosts(trade, sellPrice);
  store.shadowOpenTrades.splice(idx, 1);
  if (!store.shadowClosedTrades) store.shadowClosedTrades = [];
  store.shadowClosedTrades.push(trade);

  const d = getDb();
  const order = insertionCounter++;
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM shadow_open_trades WHERE id = ?').run(trade.id);
    d.prepare(`INSERT INTO shadow_closed_trades ${CLOSED_INSERT_COLS} VALUES ${CLOSED_INSERT_PLACEHOLDERS}`)
      .run(...closedTradeRowParams(trade, order));
  });
  tx();
  return true;
}

export function updateShadowPrices(
  updates: Array<{ id: string; currentPrice: number; unrealizedPnl: number }>,
): void {
  if (updates.length === 0) return;
  const store = readStore();
  if (!store.shadowOpenTrades) return;
  for (const u of updates) {
    const t = store.shadowOpenTrades.find(x => x.id === u.id);
    if (t) { t.currentPrice = u.currentPrice; t.unrealizedPnl = u.unrealizedPnl; }
  }
  const d = getDb();
  const stmt = d.prepare('UPDATE shadow_open_trades SET current_price = ?, unrealized_pnl = ? WHERE id = ?');
  const tx = d.transaction(() => { for (const u of updates) stmt.run(u.currentPrice, u.unrealizedPnl, u.id); });
  tx();
  isDirty = true;
}

export function resolveShadowByPrice(
  toResolve: Array<{ id: string; exitPrice: number }>,
  status: 'resolved' | 'expired' = 'resolved',
): void {
  if (toResolve.length === 0) return;
  const store = readStore();
  if (!store.shadowOpenTrades) return;
  if (!store.shadowClosedTrades) store.shadowClosedTrades = [];
  const closedAt = new Date().toISOString();
  const closedMs = new Date(closedAt).getTime();
  const resolved: SimulatedTrade[] = [];
  store.shadowOpenTrades = store.shadowOpenTrades.filter(t => {
    const r = toResolve.find(x => x.id === t.id);
    if (!r) return true;
    t.status = status;
    t.exitPrice = r.exitPrice;
    t.realizedPnl = (r.exitPrice - t.entryPrice) * t.simulatedShares;
    t.closedAt = closedAt;
    t.holdingPeriodMs = closedMs - new Date(t.timestamp).getTime();
    applyExitCosts(t, r.exitPrice);
    resolved.push(t);
    return false;
  });
  store.shadowClosedTrades.push(...resolved);

  const d = getDb();
  const del = d.prepare('DELETE FROM shadow_open_trades WHERE id = ?');
  const insClosed = d.prepare(`INSERT INTO shadow_closed_trades ${CLOSED_INSERT_COLS} VALUES ${CLOSED_INSERT_PLACEHOLDERS}`);
  const tx = d.transaction(() => {
    for (const t of resolved) { del.run(t.id); insClosed.run(...closedTradeRowParams(t, insertionCounter++)); }
  });
  tx();
}

export function setShadowLastSeen(address: string, timestamp: string): void {
  const store = readStore();
  if (!store.shadowLastSeen) store.shadowLastSeen = {};
  store.shadowLastSeen[address] = timestamp;
  getDb().prepare('INSERT OR REPLACE INTO shadow_last_seen (address, timestamp) VALUES (?,?)').run(address, timestamp);
}

export function markProcessed(id: string): void {
  const store = readStore();
  if (store.processedTradeIds.includes(id)) return;
  store.processedTradeIds.push(id);
  if (store.processedTradeIds.length > PROCESSED_IDS_CAP) {
    store.processedTradeIds = store.processedTradeIds.slice(-PROCESSED_IDS_CAP);
  }
  const d = getDb();
  const order = insertionCounter++;
  const tx = d.transaction(() => {
    d.prepare('INSERT OR IGNORE INTO processed_trade_ids (id, added_order) VALUES (?,?)').run(id, order);
    const over = d.prepare('SELECT COUNT(*) AS c FROM processed_trade_ids').get() as { c: number };
    if (over.c > PROCESSED_IDS_CAP) {
      const excess = over.c - PROCESSED_IDS_CAP;
      d.prepare('DELETE FROM processed_trade_ids WHERE id IN (SELECT id FROM processed_trade_ids ORDER BY added_order ASC LIMIT ?)').run(excess);
    }
  });
  tx();
}

export function setTraderExclusion(address: string, excluded: boolean): void {
  const store = readStore();
  if (excluded) {
    if (!store.excludedTraders.includes(address)) store.excludedTraders.push(address);
  } else {
    store.excludedTraders = store.excludedTraders.filter(a => a !== address);
    store.autoExcludedTraders = (store.autoExcludedTraders ?? []).filter(a => a !== address);
  }
  const d = getDb();
  if (excluded) d.prepare('INSERT OR IGNORE INTO excluded_traders (address, auto) VALUES (?, 0)').run(address);
  else          d.prepare('DELETE FROM excluded_traders WHERE address = ?').run(address);
}

export function setCategoryExclusion(category: string, excluded: boolean): void {
  const store = readStore();
  if (!store.excludedCategories) store.excludedCategories = [];
  if (excluded) {
    if (!store.excludedCategories.includes(category)) store.excludedCategories.push(category);
  } else {
    store.excludedCategories = store.excludedCategories.filter(c => c !== category);
  }
  const d = getDb();
  if (excluded) d.prepare('INSERT OR IGNORE INTO excluded_categories (category) VALUES (?)').run(category);
  else          d.prepare('DELETE FROM excluded_categories WHERE category = ?').run(category);
}

export function setTraderLastSeen(address: string, timestamp: string): void {
  const store = readStore();
  store.traderLastSeen[address] = timestamp;
  getDb().prepare('INSERT OR REPLACE INTO trader_last_seen (address, timestamp) VALUES (?,?)').run(address, timestamp);
}

export function appendTraderHistory(address: string, items: TraderHistoryEntry[]): void {
  if (items.length === 0) return;
  const store = readStore();
  if (!store.traderHistory) store.traderHistory = {};
  const hist = store.traderHistory[address] ?? { buys: [], sells: [], lastFetched: '' };

  const buyMap  = new Map((hist.buys  ?? []).map(t => [t.transaction_hash, t]));
  const sellMap = new Map((hist.sells ?? []).map(t => [t.transaction_hash, t]));

  let added = 0;
  for (const item of items) {
    if (!item.transaction_hash) continue;
    if (item.type.toUpperCase() !== 'TRADE') continue;
    const isSell = item.side.toUpperCase() === 'SELL';
    const map = isSell ? sellMap : buyMap;
    if (map.has(item.transaction_hash)) continue;
    map.set(item.transaction_hash, item);
    added++;
  }
  if (added === 0) return;

  const byDesc = (a: TraderHistoryEntry, b: TraderHistoryEntry) => b.timestamp > a.timestamp ? 1 : -1;
  const buys  = Array.from(buyMap.values()).sort(byDesc).slice(0, SIDE_CAP);
  const sells = Array.from(sellMap.values()).sort(byDesc).slice(0, SIDE_CAP);
  const lastFetched = new Date().toISOString();
  store.traderHistory[address] = { buys, sells, lastFetched };

  const d = getDb();
  const ins = d.prepare(
    `INSERT OR REPLACE INTO trader_history (address, side, transaction_hash, timestamp, slug, title, outcome, type, price, size)
     VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const tx = d.transaction(() => {
    // Clean up anything beyond SIDE_CAP: delete all for this address+side, re-insert the capped set.
    d.prepare('DELETE FROM trader_history WHERE address = ? AND side = ?').run(address, 'BUY');
    d.prepare('DELETE FROM trader_history WHERE address = ? AND side = ?').run(address, 'SELL');
    for (const b of buys)  ins.run(address, 'BUY',  b.transaction_hash, b.timestamp, b.slug, b.title ?? null, b.outcome ?? null, b.type, b.price ?? null, b.size ?? null);
    for (const s of sells) ins.run(address, 'SELL', s.transaction_hash, s.timestamp, s.slug, s.title ?? null, s.outcome ?? null, s.type, s.price ?? null, s.size ?? null);
    d.prepare('INSERT OR REPLACE INTO trader_history_meta (address, last_fetched) VALUES (?,?)').run(address, lastFetched);
  });
  tx();
}

export function setLeaderboardFilters(filters: LeaderboardFilters): void {
  const store = readStore();
  store.leaderboardFilters = filters;
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run('leaderboardFilters', JSON.stringify(filters));
}

export function setLeaderboardStats(stats: LeaderboardStats): void {
  const store = readStore();
  store.lastLeaderboardStats = stats;
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run('lastLeaderboardStats', JSON.stringify(stats));
}

export function updateTraderLastOnLeaderboard(addresses: string[]): void {
  if (addresses.length === 0) return;
  const store = readStore();
  if (!store.traderLastOnLeaderboard) store.traderLastOnLeaderboard = {};
  const now = new Date().toISOString();
  for (const addr of addresses) store.traderLastOnLeaderboard[addr] = now;

  const d = getDb();
  const stmt = d.prepare('INSERT OR REPLACE INTO trader_last_on_leaderboard (address, timestamp) VALUES (?,?)');
  const tx = d.transaction(() => { for (const a of addresses) stmt.run(a, now); });
  tx();
}

export function setAutoExclusion(address: string, excluded: boolean): void {
  const store = readStore();
  if (!store.autoExcludedTraders) store.autoExcludedTraders = [];
  if (excluded) {
    if (!store.excludedTraders.includes(address))      store.excludedTraders.push(address);
    if (!store.autoExcludedTraders.includes(address))  store.autoExcludedTraders.push(address);
  } else {
    store.excludedTraders     = store.excludedTraders.filter(a => a !== address);
    store.autoExcludedTraders = store.autoExcludedTraders.filter(a => a !== address);
  }
  const d = getDb();
  if (excluded) d.prepare('INSERT OR REPLACE INTO excluded_traders (address, auto) VALUES (?, 1)').run(address);
  else          d.prepare('DELETE FROM excluded_traders WHERE address = ?').run(address);
}

// Watchlist ---------------------------------------------------------------

export function addWatchlistTrader(address: string, label?: string): boolean {
  const store = readStore();
  const addr = address.toLowerCase();
  if (store.watchlistTraders.find(w => w.address === addr)) return false;
  const entry: WatchlistTrader = { address: addr, label, addedAt: new Date().toISOString(), copyEnabled: true, copyAmount: 5 };
  store.watchlistTraders.push(entry);
  getDb().prepare(
    `INSERT INTO watchlist_traders (address, label, added_at, copy_enabled, copy_amount) VALUES (?,?,?,?,?)`
  ).run(entry.address, entry.label ?? null, entry.addedAt, entry.copyEnabled ? 1 : 0, entry.copyAmount);
  return true;
}

export function removeWatchlistTrader(address: string): boolean {
  const store = readStore();
  const addr = address.toLowerCase();
  const before = store.watchlistTraders.length;
  store.watchlistTraders = store.watchlistTraders.filter(w => w.address !== addr);
  if (store.watchlistTraders.length === before) return false;
  getDb().prepare('DELETE FROM watchlist_traders WHERE address = ?').run(addr);
  return true;
}

export function setWatchlistCopyEnabled(address: string, enabled: boolean): boolean {
  const store = readStore();
  const addr = address.toLowerCase();
  const w = store.watchlistTraders.find(w => w.address === addr);
  if (!w) return false;
  w.copyEnabled = enabled;
  getDb().prepare('UPDATE watchlist_traders SET copy_enabled = ? WHERE address = ?').run(enabled ? 1 : 0, addr);
  return true;
}

export function setWatchlistCopyAmount(address: string, amount: number): boolean {
  const store = readStore();
  const addr = address.toLowerCase();
  const w = store.watchlistTraders.find(w => w.address === addr);
  if (!w) return false;
  w.copyAmount = Math.max(0.01, Math.round(amount * 100) / 100);
  getDb().prepare('UPDATE watchlist_traders SET copy_amount = ? WHERE address = ?').run(w.copyAmount, addr);
  return true;
}

export function updateWatchlistFalconData(
  address: string,
  data: { falconWinRate?: number; falconRoi?: number; falconSharpe?: number },
): void {
  const store = readStore();
  const addr = address.toLowerCase();
  const w = store.watchlistTraders.find(w => w.address === addr);
  if (!w) return;
  if (data.falconWinRate !== undefined) w.falconWinRate = data.falconWinRate;
  if (data.falconRoi     !== undefined) w.falconRoi     = data.falconRoi;
  if (data.falconSharpe  !== undefined) w.falconSharpe  = data.falconSharpe;

  const d = getDb();
  const sets: string[] = [];
  const vals: any[] = [];
  if (data.falconWinRate !== undefined) { sets.push('falcon_win_rate = ?'); vals.push(data.falconWinRate); }
  if (data.falconRoi     !== undefined) { sets.push('falcon_roi = ?');      vals.push(data.falconRoi); }
  if (data.falconSharpe  !== undefined) { sets.push('falcon_sharpe = ?');   vals.push(data.falconSharpe); }
  if (sets.length) { vals.push(addr); d.prepare(`UPDATE watchlist_traders SET ${sets.join(', ')} WHERE address = ?`).run(...vals); }
}

export function updateTraderFalconCache(data: Record<string, { winRate?: number }>): void {
  const store = readStore();
  if (!store.traderFalconCache) store.traderFalconCache = {};
  const updatedAt = new Date().toISOString();
  for (const [addr, d] of Object.entries(data)) {
    store.traderFalconCache[addr.toLowerCase()] = { winRate: d.winRate, updatedAt };
  }
  const db2 = getDb();
  const stmt = db2.prepare('INSERT OR REPLACE INTO trader_falcon_cache (address, win_rate, updated_at) VALUES (?,?,?)');
  const tx = db2.transaction(() => {
    for (const [addr, v] of Object.entries(data)) stmt.run(addr.toLowerCase(), v.winRate ?? null, updatedAt);
  });
  tx();
}

// ── Daily cleanup ───────────────────────────────────────────────────────────
function maybeWriteDailySnapshot(): void {
  const dbPath = dbPathOverride ?? CONFIG.DB_FILE;
  if (dbPath === ':memory:') return;
  if (!fs.existsSync(dbPath)) return;
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const existing = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('store-') && f.endsWith('.db'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const cutoff = Date.now() - 24 * 3_600_000;
  if (existing.length > 0 && existing[0].mtime > cutoff) {
    console.log(`[cleanup] Snapshot skipped — latest (${existing[0].name}) is <24h old`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const dest = path.join(backupDir, `store-${today}.db`);
  // Use SQLite backup API for a consistent copy while WAL is active.
  getDb().backup(dest).then(() => {
    const kb = (fs.statSync(dest).size / 1024).toFixed(1);
    console.log(`[cleanup] Wrote daily snapshot → backups/store-${today}.db (${kb} KB)`);
  }).catch(err => console.error('[cleanup] Snapshot backup failed:', err));

  const after = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('store-') && f.endsWith('.db'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const f of after.slice(30)) {
    try { fs.unlinkSync(path.join(backupDir, f.name)); } catch {}
  }
}

export function runDailyCleanup(): void {
  console.log('[cleanup] Starting daily maintenance...');

  try { maybeWriteDailySnapshot(); }
  catch (err) { console.error('[cleanup] Snapshot failed:', err instanceof Error ? err.message : err); }

  const store = readStore();
  const now = Date.now();
  const cutoff7d  = now - 7 * 86_400_000;

  // closed_trades archival/pruning was removed 2026-05-27: query perf at 30k+
  // rows is ~12ms and disk is 1TB free, so keeping the full history in-DB is
  // cheaper than walking JSON archives for analytics. Backups still run daily.
  console.log(`[cleanup] closedTrades: ${store.closedTrades.length} retained in DB (no archival)`);

  // 2. Trim processedTradeIds: drop IDs whose underlying trade is no longer referenced.
  const refIds = new Set<string>();
  for (const t of store.openTrades)   refIds.add(t.sourceTradeId);
  for (const t of store.closedTrades) refIds.add(t.sourceTradeId);
  for (const hist of Object.values(store.traderHistory ?? {})) {
    for (const b of hist.buys  ?? []) if (b.transaction_hash) refIds.add(b.transaction_hash);
    for (const s of hist.sells ?? []) if (s.transaction_hash) refIds.add(s.transaction_hash);
  }
  {
    const before = store.processedTradeIds.length;
    store.processedTradeIds = store.processedTradeIds.filter(id => refIds.has(id));
    if (store.processedTradeIds.length > PROCESSED_IDS_CAP) {
      store.processedTradeIds = store.processedTradeIds.slice(-PROCESSED_IDS_CAP);
    }
    console.log(`[cleanup] processedTradeIds: ${before} → ${store.processedTradeIds.length}`);
  }

  const shadowRefIds = new Set<string>();
  for (const t of store.shadowOpenTrades   ?? []) shadowRefIds.add(t.sourceTradeId);
  for (const t of store.shadowClosedTrades ?? []) shadowRefIds.add(t.sourceTradeId);
  if (Array.isArray(store.processedShadowIds)) {
    const before = store.processedShadowIds.length;
    store.processedShadowIds = store.processedShadowIds.filter(id => shadowRefIds.has(id));
    if (store.processedShadowIds.length > SHADOW_IDS_CAP) {
      store.processedShadowIds = store.processedShadowIds.slice(-SHADOW_IDS_CAP);
    }
    console.log(`[cleanup] processedShadowIds: ${before} → ${store.processedShadowIds.length}`);
  }

  // 3. Prune traderHistory for traders absent from leaderboard for 7+ days.
  const lastOnLb = store.traderLastOnLeaderboard ?? {};
  let pruned = 0;
  for (const addr of Object.keys(store.traderHistory ?? {})) {
    const lastSeen = lastOnLb[addr];
    if (!lastSeen) continue;
    if (new Date(lastSeen).getTime() < cutoff7d) {
      delete store.traderHistory[addr];
      pruned++;
    }
  }
  console.log(`[cleanup] traderHistory: pruned ${pruned} stale trader(s), ${Object.keys(store.traderHistory).length} remaining`);

  writeStore(store);
  console.log('[cleanup] Daily maintenance complete.');
}
