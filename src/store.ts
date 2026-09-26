/**
 * SQLite-backed trades store. readStore() returns a full in-memory snapshot
 * of type TradesStore. Every mutation (addOpenTrade, closeOpenTrade,
 * resolveByPrice, markProcessed, watchlist CRUD, appendTraderHistory, ...)
 * does a targeted, transactional SQL write at call time and mirrors the
 * in-memory cache, so the DB is always current — there is no deferred-flush
 * path. writeStore(store) bulk-rewrites only the cleanup-state datasets
 * (processed_trade_ids, trader_history) and exists for runDailyCleanup's
 * in-memory prunes.
 *
 * Crash-safety: WAL mode. Atomicity: per-mutation transactions.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  TradesStore, SimulatedTrade, TrackedTrader, WatchlistTrader,
  TraderHistoryEntry,
} from './types';
import { CONFIG } from './config';
import { takerFeeCost } from './fees';

const WATCHLIST_DEFAULTS: WatchlistTrader[] = [
  { address: '0x8a6c6811e8937f9e8afc1b9249fa540262c30b3f', label: 'MultiSport-Analytics', addedAt: new Date(0).toISOString(), copyEnabled: true,  copyAmount: 5 },
  { address: '0x8a3ab8120807bd64a3de48695110e390fa2ceb9a', label: 'SharpSports',          addedAt: new Date(0).toISOString(), copyEnabled: true,  copyAmount: 5 },
  { address: '0xdb27bf2ac5d428a9c63dbc914611036855a6c56e', label: 'DrPufferfish',         addedAt: new Date(0).toISOString(), copyEnabled: false, copyAmount: 5 },
  { address: '0xa4eb52229991c074bc560f825bf2776d77acd010', label: 'GeoPolitics-Expert',   addedAt: new Date(0).toISOString(), copyEnabled: true,  copyAmount: 5 },
  { address: '0x959afc4649fb9ed03c0205070fa114eec4f97b64', label: 'NBA-Specialist',       addedAt: new Date(0).toISOString(), copyEnabled: true,  copyAmount: 5 },
];

const EMPTY_STORE = (): TradesStore => ({
  trackedTraders: [],
  openTrades: [],
  closedTrades: [],
  processedTradeIds: [],
  traderLastSeen: {},
  traderHistory: {},
  watchlistTraders: [],
  observationOpenTrades: [],
});

const PROCESSED_IDS_CAP = 100_000;
const PROCESSED_IDS_WARN = 80_000;
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

CREATE TABLE IF NOT EXISTS trader_last_seen (
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

-- Trades that an active filter refused to copy. Record-only (no PnL lifecycle):
-- holds the would-be entry so the pattern can be monitored over time. Currently
-- written by the per-trader longshot carve-out (skip_reason='longshot_filter_0x12d6').
CREATE TABLE IF NOT EXISTS skipped_trades (
  id                     TEXT PRIMARY KEY,
  source_trade_id        TEXT NOT NULL,
  timestamp              TEXT NOT NULL,
  copied_trader          TEXT NOT NULL,
  copied_trader_username TEXT,
  market_slug            TEXT NOT NULL,
  market_title           TEXT NOT NULL,
  outcome                TEXT NOT NULL,
  entry_price            REAL NOT NULL,
  simulated_amount       REAL NOT NULL,
  simulated_shares       REAL NOT NULL,
  skip_reason            TEXT NOT NULL,
  skipped_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skipped_reason ON skipped_trades (skip_reason, skipped_at);

-- Forward-test ledger for copy-disabled watchlist traders. Full simulated
-- lifecycle (BUY opens, copy-SELL / threshold resolution / expiry closes) in a
-- single table: rows mutate in place from status='open' to resolved/expired.
-- Same cost model as real copies; no depth snapshot (no gates apply).
CREATE TABLE IF NOT EXISTS observation_trades (
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
  source_notional           REAL,
  insertion_order           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observation_fifo
  ON observation_trades (copied_trader, market_slug, outcome, status, insertion_order);
`;

// ── DB lifecycle ────────────────────────────────────────────────────────────
let db: Db | null = null;
let dbPathOverride: string | null = null;
let cachedStore: TradesStore | null = null;
let checkpointTimer: NodeJS.Timeout | null = null;
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
  migrateAutoDisableColumns(d);
  migrateResearchColumns(d);
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
       UNION ALL SELECT MAX(insertion_order) FROM observation_trades
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
  const tables = ['open_trades', 'closed_trades'];
  for (const t of tables) {
    const existing = new Set(
      (d.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(r => r.name)
    );
    for (const [col, type] of DEPTH_COLS) {
      if (!existing.has(col)) d.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${type}`);
    }
  }
}

// GROUP D research columns (2026-06-10): trader's own bet notional + taker
// entry-price gap on the live copy tables.
// observation_trades gets source_notional only (FIX 4) — conviction analysis
// applies to candidates too, but there's no depth fetch there, so no gap.
function migrateResearchColumns(d: Db): void {
  for (const t of ['open_trades', 'closed_trades']) {
    const existing = new Set(
      (d.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(r => r.name)
    );
    if (!existing.has('source_notional'))  d.exec(`ALTER TABLE ${t} ADD COLUMN source_notional REAL`);
    if (!existing.has('entry_price_gap')) d.exec(`ALTER TABLE ${t} ADD COLUMN entry_price_gap REAL`);
    // Partial-sell research (2026-06-11): set at copy-SELL close time, so the
    // column exists on closed_trades only.
    if (t === 'closed_trades' && !existing.has('source_sell_fraction')) {
      d.exec(`ALTER TABLE ${t} ADD COLUMN source_sell_fraction REAL`);
    }
    // Polymarket taker fees (2026-09-26): rate captured at BUY, fee per leg.
    if (!existing.has('fee_rate'))       d.exec(`ALTER TABLE ${t} ADD COLUMN fee_rate REAL`);
    if (!existing.has('entry_fee_cost')) d.exec(`ALTER TABLE ${t} ADD COLUMN entry_fee_cost REAL`);
    if (t === 'closed_trades' && !existing.has('exit_fee_cost')) {
      d.exec(`ALTER TABLE ${t} ADD COLUMN exit_fee_cost REAL`);
    }
  }
  const obsExisting = new Set(
    (d.prepare(`PRAGMA table_info(observation_trades)`).all() as Array<{ name: string }>).map(r => r.name)
  );
  if (!obsExisting.has('source_notional')) d.exec('ALTER TABLE observation_trades ADD COLUMN source_notional REAL');
}

function migrateAutoDisableColumns(d: Db): void {
  const existing = new Set(
    (d.prepare('PRAGMA table_info(watchlist_traders)').all() as Array<{ name: string }>).map(r => r.name)
  );
  if (!existing.has('auto_disabled_at'))     d.exec('ALTER TABLE watchlist_traders ADD COLUMN auto_disabled_at TEXT');
  if (!existing.has('auto_disabled_reason')) d.exec('ALTER TABLE watchlist_traders ADD COLUMN auto_disabled_reason TEXT');
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
}

/** Test hook: point the store at a fresh DB (file path or ':memory:'). */
export function _setDbPathForTests(p: string | null): void {
  if (db) { db.close(); db = null; }
  dbPathOverride = p;
  cachedStore = null;
  insertionCounter = 0;
}

/** Test hook: read the current in-memory insertion counter. */
export function _getInsertionCounter(): number {
  return insertionCounter;
}

/** Test hook: drop the in-memory snapshot cache. */
export function _resetStoreCache(): void {
  cachedStore = null;
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
  source_notional?: number | null; entry_price_gap?: number | null;
  source_sell_fraction?: number | null;
  fee_rate?: number | null; entry_fee_cost?: number | null; exit_fee_cost?: number | null;
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
  if (r.copied_trader_source   != null) t.copiedTraderSource   = r.copied_trader_source as SimulatedTrade['copiedTraderSource'];
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
  if (r.source_notional        != null) t.sourceNotional       = r.source_notional;
  if (r.entry_price_gap        != null) t.entryPriceGap        = r.entry_price_gap;
  if (r.source_sell_fraction   != null) t.sourceSellFraction   = r.source_sell_fraction;
  if (r.fee_rate               != null) t.feeRate              = r.fee_rate;
  if (r.entry_fee_cost         != null) t.entryFeeCost         = r.entry_fee_cost;
  if (r.exit_fee_cost          != null) t.exitFeeCost          = r.exit_fee_cost;
  return t;
}

const DEPTH_VALS = (t: SimulatedTrade) => [
  t.bestAsk ?? null, t.bestBid ?? null,
  t.askDepth5 ?? null, t.askDepth10 ?? null,
  t.spreadAtEntry ?? null,
  t.depthBackfilled == null ? null : (t.depthBackfilled ? 1 : 0),
];

const RESEARCH_VALS = (t: SimulatedTrade) => [
  t.sourceNotional ?? null, t.entryPriceGap ?? null,
];

const FEE_VALS = (t: SimulatedTrade) => [t.feeRate ?? null, t.entryFeeCost ?? null];

function openTradeRowParams(t: SimulatedTrade, order: number): any[] {
  return [
    t.id, t.sourceTradeId, t.timestamp, t.copiedTrader, t.copiedTraderRank,
    t.copiedTraderUsername ?? null, t.copiedTraderSource ?? null,
    t.marketSlug, t.marketTitle, t.outcome, t.side,
    t.entryPrice, t.simulatedAmount, t.simulatedShares,
    t.currentPrice ?? null, t.unrealizedPnl ?? null, t.status,
    t.entryGasCost ?? null, t.entrySlippageCost ?? null,
    ...DEPTH_VALS(t),
    ...RESEARCH_VALS(t),
    ...FEE_VALS(t),
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
    ...RESEARCH_VALS(t),
    t.sourceSellFraction ?? null,
    ...FEE_VALS(t), t.exitFeeCost ?? null,
    order,
  ];
}

const DEPTH_COL_NAMES = 'best_ask, best_bid, ask_depth_5, ask_depth_10, spread_at_entry, depth_backfilled';
const RESEARCH_COL_NAMES = 'source_notional, entry_price_gap';
const FEE_COL_NAMES = 'fee_rate, entry_fee_cost';

const OPEN_INSERT_COLS = `(id, source_trade_id, timestamp, copied_trader, copied_trader_rank,
  copied_trader_username, copied_trader_source, market_slug, market_title, outcome, side,
  entry_price, simulated_amount, simulated_shares, current_price, unrealized_pnl, status,
  entry_gas_cost, entry_slippage_cost, ${DEPTH_COL_NAMES}, ${RESEARCH_COL_NAMES}, ${FEE_COL_NAMES}, insertion_order)`;
const OPEN_INSERT_PLACEHOLDERS = '(' + new Array(30).fill('?').join(',') + ')';

const CLOSED_INSERT_COLS = `(id, source_trade_id, timestamp, copied_trader, copied_trader_rank,
  copied_trader_username, copied_trader_source, market_slug, market_title, outcome, side,
  entry_price, simulated_amount, simulated_shares, current_price, unrealized_pnl, status,
  exit_price, realized_pnl, closed_at, holding_period_ms,
  entry_gas_cost, entry_slippage_cost, exit_slippage_cost, cost_adjusted_pnl, ${DEPTH_COL_NAMES}, ${RESEARCH_COL_NAMES},
  source_sell_fraction, ${FEE_COL_NAMES}, exit_fee_cost, insertion_order)`;
const CLOSED_INSERT_PLACEHOLDERS = '(' + new Array(38).fill('?').join(',') + ')';

// ── Snapshot load ───────────────────────────────────────────────────────────
function loadSnapshot(): TradesStore {
  const d = getDb();
  const s = EMPTY_STORE();

  // Read-only: tracked_traders is never written by the bot — the weekly macro
  // scan updates it externally; loaded so /api/discovery/candidates can enrich
  // candidates with falconSharpe.
  s.trackedTraders = (d.prepare('SELECT * FROM tracked_traders ORDER BY rank ASC').all() as any[]).map(r => {
    const t: TrackedTrader = {
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
    if (r.auto_disabled_at     != null) w.autoDisabledAt     = r.auto_disabled_at;
    if (r.auto_disabled_reason != null) w.autoDisabledReason = r.auto_disabled_reason;
    return w;
  });

  s.openTrades     = (d.prepare('SELECT * FROM open_trades     ORDER BY insertion_order ASC').all() as TradeRow[]).map(rowToTrade);
  s.closedTrades   = (d.prepare('SELECT * FROM closed_trades   ORDER BY insertion_order ASC').all() as TradeRow[]).map(rowToTrade);
  // Open rows only — see TradesStore.observationOpenTrades. The closed tail is
  // read on demand via iterateObservationTrades().
  s.observationOpenTrades = (d.prepare(
    "SELECT * FROM observation_trades WHERE status = 'open' ORDER BY insertion_order ASC",
  ).all() as TradeRow[]).map(rowToTrade);

  s.processedTradeIds  = (d.prepare('SELECT id FROM processed_trade_ids  ORDER BY added_order ASC').all() as Array<{ id: string }>).map(r => r.id);

  s.traderLastSeen          = Object.fromEntries((d.prepare('SELECT address, timestamp FROM trader_last_seen').all() as Array<{ address: string; timestamp: string }>).map(r => [r.address, r.timestamp]));

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

  return s;
}

// ── Cleanup-state persist ───────────────────────────────────────────────────
// Rewrites ONLY the two datasets runDailyCleanup prunes through the in-memory
// snapshot: processed_trade_ids and trader_history. Hot tables (open_trades,
// closed_trades, watchlist_traders, trader_last_seen, skipped_trades) are
// persisted by targeted SQL at mutation time and are NEVER bulk-rewritten —
// the old full delete+reinsert of every table (30k+ closed_trades rows) on
// each 60s flush was the main driver of unbounded WAL growth. Frozen
// historical tables (tracked_traders — externally updated by the weekly macro
// scan —, excluded_traders, excluded_categories) are never written.
function persistSnapshot(store: TradesStore): void {
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM processed_trade_ids').run();
    const pi = d.prepare('INSERT INTO processed_trade_ids (id, added_order) VALUES (?,?)');
    {
      let i = 1;
      const seen = new Set<string>();
      for (const id of store.processedTradeIds) if (!seen.has(id)) { pi.run(id, i++); seen.add(id); }
    }

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
  persistSnapshot(store);
}

/**
 * Periodic PASSIVE WAL checkpoint. All store mutations are persisted by
 * targeted SQL at call time, so there is nothing to flush — this timer only
 * keeps the WAL from growing unbounded across multi-day uptime (the startup
 * TRUNCATE alone let it reach ~38MB by 2026-06-03). PASSIVE never blocks on
 * readers and is a no-op if it can't reclaim, so it is safe to run every cycle.
 */
export function startWalCheckpoint(intervalMs: number = 60_000): void {
  if (checkpointTimer) return;
  checkpointTimer = setInterval(() => {
    try { getDb().pragma('wal_checkpoint(PASSIVE)'); } catch { /* non-fatal */ }
  }, intervalMs);
  if (typeof checkpointTimer.unref === 'function') checkpointTimer.unref();
}

export function stopWalCheckpoint(): void {
  if (checkpointTimer) { clearInterval(checkpointTimer); checkpointTimer = null; }
}

// ── Targeted mutations (direct SQL + cache mirror) ─────────────────────────

export function addOpenTrade(trade: SimulatedTrade): void {
  const store = readStore();
  store.openTrades.push(trade);
  // Guard against duplicate IDs in the in-memory array (L3) — matches markProcessed.
  // The DB side already uses INSERT OR IGNORE; without this check the in-memory
  // array could accumulate duplicates (inflating the cap-trim slice) until the
  // next full persistSnapshot dedupes them.
  if (!store.processedTradeIds.includes(trade.sourceTradeId)) {
    store.processedTradeIds.push(trade.sourceTradeId);
    if (store.processedTradeIds.length > PROCESSED_IDS_CAP) {
      store.processedTradeIds = store.processedTradeIds.slice(-PROCESSED_IDS_CAP);
    } else if (store.processedTradeIds.length >= PROCESSED_IDS_WARN) {
      console.warn(`[store] processedTradeIds at ${store.processedTradeIds.length} — approaching ${PROCESSED_IDS_CAP} cap`);
    }
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

/**
 * Record a BUY that an active filter refused to copy. Record-only: no open/close
 * lifecycle, no PnL resolution — just the would-be entry for monitoring. Not part
 * of the TradesStore snapshot, so it writes directly to the DB without cache mirror.
 */
export interface SkippedTradeRecord {
  sourceTradeId: string;
  timestamp: string;
  copiedTrader: string;
  copiedTraderUsername?: string;
  marketSlug: string;
  marketTitle: string;
  outcome: string;
  entryPrice: number;
  simulatedAmount: number;
  simulatedShares: number;
  skipReason: string;
}

export function addSkippedTrade(rec: SkippedTradeRecord): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO skipped_trades
       (id, source_trade_id, timestamp, copied_trader, copied_trader_username,
        market_slug, market_title, outcome, entry_price, simulated_amount,
        simulated_shares, skip_reason, skipped_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    uuidv4(), rec.sourceTradeId, rec.timestamp, rec.copiedTrader,
    rec.copiedTraderUsername ?? null, rec.marketSlug, rec.marketTitle, rec.outcome,
    rec.entryPrice, rec.simulatedAmount, rec.simulatedShares, rec.skipReason,
    new Date().toISOString(),
  );
}

/** Count + total would-be notional of skipped trades, optionally filtered by reason. */
export function getSkippedTradeStats(reason?: string): { count: number; notional: number } {
  const d = getDb();
  const sql = reason
    ? `SELECT COUNT(*) AS c, COALESCE(SUM(simulated_amount),0) AS n FROM skipped_trades WHERE skip_reason = ?`
    : `SELECT COUNT(*) AS c, COALESCE(SUM(simulated_amount),0) AS n FROM skipped_trades`;
  const row = (reason ? d.prepare(sql).get(reason) : d.prepare(sql).get()) as { c: number; n: number };
  return { count: row.c, notional: row.n };
}

function applyExitCosts(trade: SimulatedTrade, exitPrice: number): void {
  const shares = trade.simulatedShares;
  const gas    = trade.entryGasCost      ?? CONFIG.GAS_COST_PER_BUY;
  const eSlip  = trade.entrySlippageCost ?? CONFIG.SLIPPAGE_RATE * trade.entryPrice * shares;
  const xSlip  = CONFIG.SLIPPAGE_RATE * exitPrice * shares;
  // Exit fee at the exit price: zero for 0/1 resolution payouts by formula.
  const eFee   = trade.entryFeeCost ?? 0;
  const xFee   = takerFeeCost(trade.feeRate, exitPrice, shares);
  trade.entryGasCost      = gas;
  trade.entrySlippageCost = eSlip;
  trade.exitSlippageCost  = xSlip;
  trade.exitFeeCost       = xFee;
  trade.costAdjustedPnl   = (trade.realizedPnl ?? 0) - gas - eSlip - xSlip - eFee - xFee;
}

export function closeOpenTrade(
  copiedTrader: string, marketSlug: string, outcome: string, sellPrice: number,
  sourceSellFraction?: number,
): boolean {
  const store = readStore();
  const idx = store.openTrades.findIndex(
    t => t.copiedTrader === copiedTrader && t.marketSlug === marketSlug && t.outcome === outcome,
  );
  if (idx === -1) return false;

  const trade = store.openTrades[idx];
  const closedAt = new Date().toISOString();
  if (sourceSellFraction != null) trade.sourceSellFraction = sourceSellFraction;
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

// Observation ledger ---------------------------------------------------------
// Forward-test lifecycle for copy-disabled watchlist traders. Single-table
// design: closes are in-place UPDATEs (no row movement between tables).

const OBS_INSERT_COLS = `(id, source_trade_id, timestamp, copied_trader, copied_trader_rank,
  copied_trader_username, copied_trader_source, market_slug, market_title, outcome, side,
  entry_price, simulated_amount, simulated_shares, current_price, unrealized_pnl, status,
  exit_price, realized_pnl, closed_at, holding_period_ms,
  entry_gas_cost, entry_slippage_cost, exit_slippage_cost, cost_adjusted_pnl,
  source_notional, insertion_order)`;
const OBS_INSERT_PLACEHOLDERS = '(' + new Array(27).fill('?').join(',') + ')';

function obsTradeRowParams(t: SimulatedTrade, order: number): any[] {
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
    t.sourceNotional ?? null,
    order,
  ];
}

const OBS_CLOSE_SQL = `UPDATE observation_trades SET status=?, exit_price=?, realized_pnl=?,
  closed_at=?, holding_period_ms=?, current_price=?, unrealized_pnl=?,
  entry_gas_cost=?, entry_slippage_cost=?, exit_slippage_cost=?, cost_adjusted_pnl=? WHERE id=?`;

function obsCloseRowParams(t: SimulatedTrade): any[] {
  return [
    t.status, t.exitPrice ?? null, t.realizedPnl ?? null,
    t.closedAt ?? null, t.holdingPeriodMs ?? null,
    t.currentPrice ?? null, t.unrealizedPnl ?? null,
    t.entryGasCost ?? null, t.entrySlippageCost ?? null,
    t.exitSlippageCost ?? null, t.costAdjustedPnl ?? null, t.id,
  ];
}

export function addObservationTrade(trade: SimulatedTrade): void {
  const store = readStore();
  // New observation rows are always open, so the open-only cache takes them.
  store.observationOpenTrades.push(trade);
  getDb().prepare(`INSERT INTO observation_trades ${OBS_INSERT_COLS} VALUES ${OBS_INSERT_PLACEHOLDERS}`)
    .run(...obsTradeRowParams(trade, insertionCounter++));
}

/** Stream the FULL observation ledger (open + closed) from SQLite, one row at
 *  a time. The in-memory cache holds open rows only, so any consumer that needs
 *  the closed tail (per-trader stats, dedup sets) must use this instead of
 *  store.observationOpenTrades — materialising the table costs ~450MB of heap. */
export function* iterateObservationTrades(): Generator<SimulatedTrade> {
  const rows = getDb()
    .prepare('SELECT * FROM observation_trades ORDER BY insertion_order ASC')
    .iterate() as Iterable<TradeRow>;
  for (const r of rows) yield rowToTrade(r);
}

/** FIFO-close the oldest open observation position matching (trader, slug, outcome). */
export function closeObservationTrade(
  copiedTrader: string, marketSlug: string, outcome: string, sellPrice: number,
): boolean {
  const store = readStore();
  // Array is insertion-ordered and open-only, so the first match is the oldest.
  const idx = store.observationOpenTrades.findIndex(
    t => t.copiedTrader === copiedTrader
      && t.marketSlug === marketSlug && t.outcome === outcome,
  );
  if (idx === -1) return false;
  const trade = store.observationOpenTrades[idx]!;

  const closedAt = new Date().toISOString();
  trade.status = 'resolved';
  trade.exitPrice = sellPrice;
  trade.realizedPnl = (sellPrice - trade.entryPrice) * trade.simulatedShares;
  trade.closedAt = closedAt;
  trade.holdingPeriodMs = new Date(closedAt).getTime() - new Date(trade.timestamp).getTime();
  trade.currentPrice = sellPrice;
  trade.unrealizedPnl = 0;
  applyExitCosts(trade, sellPrice);

  getDb().prepare(OBS_CLOSE_SQL).run(...obsCloseRowParams(trade));
  // Row stays in the table (status mutates in place); drop it from the
  // open-only cache so the closed tail never accumulates in heap.
  store.observationOpenTrades.splice(idx, 1);
  return true;
}

export function updateObservationTradePrices(
  updates: Array<{ id: string; currentPrice: number; unrealizedPnl: number }>,
): void {
  if (updates.length === 0) return;
  const store = readStore();
  const byId = new Map(store.observationOpenTrades.map(t => [t.id, t]));
  for (const u of updates) {
    const t = byId.get(u.id);
    if (t) { t.currentPrice = u.currentPrice; t.unrealizedPnl = u.unrealizedPnl; }
  }
  const d = getDb();
  const stmt = d.prepare('UPDATE observation_trades SET current_price = ?, unrealized_pnl = ? WHERE id = ?');
  const tx = d.transaction(() => { for (const u of updates) stmt.run(u.currentPrice, u.unrealizedPnl, u.id); });
  tx();
}

export function resolveObservationByPrice(
  toResolve: Array<{ id: string; exitPrice: number }>,
  status: 'resolved' | 'expired' = 'resolved',
): void {
  if (toResolve.length === 0) return;
  const store = readStore();
  const closedAt = new Date().toISOString();
  const closedMs = new Date(closedAt).getTime();
  const resolved: SimulatedTrade[] = [];
  const remaining: SimulatedTrade[] = [];
  const byId = new Map(toResolve.map(r => [r.id, r]));
  for (const t of store.observationOpenTrades) {
    const r = byId.get(t.id);
    if (!r) { remaining.push(t); continue; }
    t.status = status;
    t.exitPrice = r.exitPrice;
    t.realizedPnl = (r.exitPrice - t.entryPrice) * t.simulatedShares;
    t.closedAt = closedAt;
    t.holdingPeriodMs = closedMs - new Date(t.timestamp).getTime();
    applyExitCosts(t, r.exitPrice);
    resolved.push(t);
  }
  if (resolved.length === 0) return;
  const d = getDb();
  const stmt = d.prepare(OBS_CLOSE_SQL);
  const tx = d.transaction(() => { for (const t of resolved) stmt.run(...obsCloseRowParams(t)); });
  tx();
  // Rows stay in the table; drop them from the open-only cache.
  store.observationOpenTrades = remaining;
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

// Watchlist ---------------------------------------------------------------

export function addWatchlistTrader(address: string, label?: string, copyEnabled = true): boolean {
  const store = readStore();
  const addr = address.toLowerCase();
  if (store.watchlistTraders.find(w => w.address === addr)) return false;
  const entry: WatchlistTrader = { address: addr, label, addedAt: new Date().toISOString(), copyEnabled, copyAmount: 5 };
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
  if (enabled) {
    // Manual re-enable clears the kill-switch marker. NOTE: if the trader's 30d
    // net is still under TRADER_DECAY_THRESHOLD_30D, the next decay check will
    // re-disable and re-alert — raise the threshold via env to truly override.
    delete w.autoDisabledAt;
    delete w.autoDisabledReason;
    getDb().prepare(
      'UPDATE watchlist_traders SET copy_enabled = 1, auto_disabled_at = NULL, auto_disabled_reason = NULL WHERE address = ?'
    ).run(addr);
  } else {
    getDb().prepare('UPDATE watchlist_traders SET copy_enabled = 0 WHERE address = ?').run(addr);
  }
  return true;
}

/**
 * Per-trader decay kill switch: disable copying and record why. The trader
 * stays on the watchlist and keeps accruing observation forward-test data.
 */
export function autoDisableWatchlistTrader(address: string, reason: string): boolean {
  const store = readStore();
  const addr = address.toLowerCase();
  const w = store.watchlistTraders.find(w => w.address === addr);
  if (!w) return false;
  const at = new Date().toISOString();
  w.copyEnabled = false;
  w.autoDisabledAt = at;
  w.autoDisabledReason = reason;
  getDb().prepare(
    'UPDATE watchlist_traders SET copy_enabled = 0, auto_disabled_at = ?, auto_disabled_reason = ? WHERE address = ?'
  ).run(at, reason, addr);
  return true;
}

// Meta key-value helpers (circuit-breaker state lives here) ------------------

export function getMetaValue(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMetaValue(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run(key, value);
}

export function deleteMetaValue(key: string): void {
  getDb().prepare('DELETE FROM meta WHERE key = ?').run(key);
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
  // Prune AFTER the backup completes (L5): the backup is async, so running the
  // prune synchronously here races the write — the new file may not exist yet
  // when we re-scan the directory.
  getDb().backup(dest).then(() => {
    const kb = (fs.statSync(dest).size / 1024).toFixed(1);
    console.log(`[cleanup] Wrote daily snapshot → backups/store-${today}.db (${kb} KB)`);

    const after = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('store-') && f.endsWith('.db'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of after.slice(30)) {
      try { fs.unlinkSync(path.join(backupDir, f.name)); } catch {}
    }
  }).catch(err => console.error('[cleanup] Snapshot backup failed:', err));
}

export function runDailyCleanup(): void {
  console.log('[cleanup] Starting daily maintenance...');

  try { maybeWriteDailySnapshot(); }
  catch (err) { console.error('[cleanup] Snapshot failed:', err instanceof Error ? err.message : err); }

  const store = readStore();
  const now = Date.now();

  // closed_trades archival/pruning was removed 2026-05-27: query perf at 30k+
  // rows is ~12ms and disk is 1TB free, so keeping the full history in-DB is
  // cheaper than walking JSON archives for analytics. Backups still run daily.
  console.log(`[cleanup] closedTrades: ${store.closedTrades.length} retained in DB (no archival)`);

  // 2. Trim processedTradeIds: drop IDs whose underlying trade is no longer referenced.
  //
  // CURSOR DEPENDENCY (L1) — this trim is only safe because of the per-trader
  // `since` cursor (trader_last_seen). A processed-ID for a
  // trade that was fetched-but-skipped (depth gate, wallet cap, entry cap, price
  // filter) survives here only via traderHistory, which is itself capped at
  // SIDE_CAP per side. Once a skipped trade's hash ages out of that cap, this
  // step drops it from the dedup set. That is acceptable ONLY because the cursor
  // prevents the API from ever returning that trade again.
  //
  // WARNING: if the cursor is ever lost or reset (e.g. restoring an older DB
  // backup whose trader_last_seen predates current trades), getTraderActivity
  // can re-return those trades and they will be re-processed/re-simulated, since
  // their dedup IDs were pruned here. The 7-day staleness filter in monitor.ts
  // bounds the blast radius to the last 7 days. If you restore a backup, expect
  // some duplicate reprocessing within that window.
  const refIds = new Set<string>();
  for (const t of store.openTrades)   refIds.add(t.sourceTradeId);
  for (const t of store.closedTrades) refIds.add(t.sourceTradeId);
  // Observation ledger is not held in memory past its open rows, and it is the
  // largest table by far — pull just the one column we need, streamed, rather
  // than materialising every row.
  {
    const rows = getDb()
      .prepare('SELECT source_trade_id FROM observation_trades')
      .iterate() as Iterable<{ source_trade_id: string }>;
    for (const r of rows) refIds.add(r.source_trade_id);
  }
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

  // 3. Prune traderHistory entries older than 90 days. (The previous prune
  // keyed on traderLastOnLeaderboard, which nothing populates since the
  // leaderboard removal 2026-05-29 — it could never fire.) SIDE_CAP bounds the
  // per-side count, but entries for removed watchlist traders would otherwise
  // sit forever; no consumer looks further back than 30 days.
  const cutoff90d = now - 90 * 86_400_000;
  const keepEntry = (e: TraderHistoryEntry) => {
    const t = new Date(e.timestamp).getTime();
    return Number.isNaN(t) || t >= cutoff90d; // unparseable timestamp: keep (safe)
  };
  let prunedEntries = 0;
  for (const [addr, hist] of Object.entries(store.traderHistory ?? {})) {
    const buys  = (hist.buys  ?? []).filter(keepEntry);
    const sells = (hist.sells ?? []).filter(keepEntry);
    prunedEntries += (hist.buys?.length ?? 0) - buys.length
                   + (hist.sells?.length ?? 0) - sells.length;
    if (buys.length === 0 && sells.length === 0) delete store.traderHistory[addr];
    else store.traderHistory[addr] = { ...hist, buys, sells };
  }
  console.log(`[cleanup] traderHistory: pruned ${prunedEntries} entr(y/ies) older than 90d, ${Object.keys(store.traderHistory).length} trader(s) remaining`);

  writeStore(store);
  console.log('[cleanup] Daily maintenance complete.');
}
