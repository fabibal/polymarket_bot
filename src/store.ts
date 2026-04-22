/**
 * Synchronous JSON file store for trades.json.
 * All mutations are atomic: read → modify → write.
 */
import fs from 'fs';
import path from 'path';
import { TradesStore, SimulatedTrade, LeaderboardTrader, WatchlistTrader, TraderHistoryEntry, LeaderboardFilters, LeaderboardStats } from './types';
import { CONFIG } from './config';

const DEFAULT_FILTERS: LeaderboardFilters = { categories: [], minWinRate: 0, minTrades: 0, minSharpe: 0, minRoi: 0 };

const WATCHLIST_DEFAULTS: WatchlistTrader[] = [
  { address: '0x8a6c6811e8937f9e8afc1b9249fa540262c30b3f', label: 'MultiSport-Analytics', addedAt: new Date(0).toISOString(), copyEnabled: true,  copyAmount: 5 },
  { address: '0x8a3ab8120807bd64a3de48695110e390fa2ceb9a', label: 'SharpSports',          addedAt: new Date(0).toISOString(), copyEnabled: true,  copyAmount: 5 },
  { address: '0xdb27bf2ac5d428a9c63dbc914611036855a6c56e', label: 'DrPufferfish',         addedAt: new Date(0).toISOString(), copyEnabled: false, copyAmount: 5 },
  { address: '0xa4eb52229991c074bc560f825bf2776d77acd010', label: 'GeoPolitics-Expert',   addedAt: new Date(0).toISOString(), copyEnabled: true,  copyAmount: 5 },
  { address: '0x959afc4649fb9ed03c0205070fa114eec4f97b64', label: 'NBA-Specialist',       addedAt: new Date(0).toISOString(), copyEnabled: true,  copyAmount: 5 },
];

const EMPTY_STORE: TradesStore = {
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
  watchlistTraders: WATCHLIST_DEFAULTS.map(w => ({ ...w })),
  traderFalconCache: {},
  shadowOpenTrades: [],
  shadowClosedTrades: [],
  processedShadowIds: [],
  shadowLastSeen: {},
};

export function readStore(): TradesStore {
  const file = CONFIG.DATA_FILE;
  if (!fs.existsSync(file)) return { ...EMPTY_STORE };
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    // Migrate old single-category format → categories array
    if (parsed.leaderboardFilters) {
      const f = parsed.leaderboardFilters;
      if (!Array.isArray(f.categories) && 'category' in f) {
        f.categories = f.category && f.category !== 'all' ? [f.category] : [];
        delete f.category;
      }
    }
    // Migrate old traderHistory {trades, lastFetched} → {buys, sells, lastFetched}
    if (parsed.traderHistory) {
      for (const addr of Object.keys(parsed.traderHistory)) {
        const h = parsed.traderHistory[addr];
        if (h && Array.isArray(h.trades) && !Array.isArray(h.buys)) {
          h.buys  = h.trades.filter((t: TraderHistoryEntry) => (t.side ?? '').toUpperCase() !== 'SELL');
          h.sells = h.trades.filter((t: TraderHistoryEntry) => (t.side ?? '').toUpperCase() === 'SELL');
          delete h.trades;
        }
      }
    }
    // Migrate / initialize watchlistTraders
    if (!Array.isArray(parsed.watchlistTraders)) {
      parsed.watchlistTraders = WATCHLIST_DEFAULTS.map(w => ({ ...w }));
    } else {
      for (const w of parsed.watchlistTraders) {
        if (w.address) w.address = w.address.toLowerCase();
        if (typeof w.copyEnabled !== 'boolean') w.copyEnabled = true;
        if (typeof w.copyAmount  !== 'number'  || w.copyAmount <= 0) w.copyAmount = 5;
      }
    }
    const merged = { ...EMPTY_STORE, ...parsed };
    if (!Array.isArray(merged.excludedCategories)) merged.excludedCategories = [];
    for (const c of CONFIG.FORCE_EXCLUDE_CATEGORIES) {
      if (!merged.excludedCategories.includes(c)) merged.excludedCategories.push(c);
    }
    return merged;
  } catch {
    return { ...EMPTY_STORE, excludedCategories: [...CONFIG.FORCE_EXCLUDE_CATEGORIES] };
  }
}

export function writeStore(store: TradesStore): void {
  const file = CONFIG.DATA_FILE;
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Atomic write: serialize to .tmp then rename. Prevents corruption on crash/OOM mid-write.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

function maybeWriteDailySnapshot(): void {
  const file = CONFIG.DATA_FILE;
  if (!fs.existsSync(file)) return;
  const backupDir = path.join(path.dirname(file), 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  // Find latest existing snapshot; skip if written within the last 24h.
  const existing = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('trades-') && f.endsWith('.json'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const cutoff = Date.now() - 24 * 3_600_000;
  if (existing.length > 0 && existing[0].mtime > cutoff) {
    console.log(`[cleanup] Snapshot skipped — latest (${existing[0].name}) is <24h old`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dest = path.join(backupDir, `trades-${today}.json`);
  fs.copyFileSync(file, dest);
  const kb = (fs.statSync(dest).size / 1024).toFixed(1);
  console.log(`[cleanup] Wrote daily snapshot → backups/trades-${today}.json (${kb} KB)`);

  // Keep only the 30 most recent snapshots (prevents unbounded backup growth).
  const after = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('trades-') && f.endsWith('.json'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const f of after.slice(30)) {
    try { fs.unlinkSync(path.join(backupDir, f.name)); } catch {}
  }
}

export function updateTrackedTraders(traders: LeaderboardTrader[]): void {
  const store = readStore();
  const now = new Date().toISOString();
  // Preserve trackedSince for traders already in the list; set it fresh for new/re-included ones.
  // Re-included traders won't be in store.trackedTraders (they were removed when excluded),
  // so they naturally get a fresh timestamp — which is the desired "reset" behavior.
  const prevMap = new Map(store.trackedTraders.map(t => [t.address, t.trackedSince]));
  for (const t of traders) {
    t.trackedSince = prevMap.get(t.address) ?? now;
  }
  store.trackedTraders = traders;
  store.lastLeaderboardUpdate = now;
  writeStore(store);
}

const PROCESSED_IDS_CAP = 100_000; // raised from 50k
const PROCESSED_IDS_WARN = 80_000;

export function addOpenTrade(trade: SimulatedTrade): void {
  const store = readStore();
  store.openTrades.push(trade);
  store.processedTradeIds.push(trade.sourceTradeId);
  if (store.processedTradeIds.length > PROCESSED_IDS_CAP) {
    store.processedTradeIds = store.processedTradeIds.slice(-PROCESSED_IDS_CAP);
  } else if (store.processedTradeIds.length >= PROCESSED_IDS_WARN) {
    console.warn(`[store] processedTradeIds at ${store.processedTradeIds.length} — approaching ${PROCESSED_IDS_CAP} cap`);
  }
  writeStore(store);
}

export function closeOpenTrade(
  copiedTrader: string,
  marketSlug: string,
  outcome: string,
  sellPrice: number
): boolean {
  const store = readStore();
  // Find oldest open matching position (FIFO)
  const idx = store.openTrades.findIndex(
    t => t.copiedTrader === copiedTrader && t.marketSlug === marketSlug && t.outcome === outcome
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
  writeStore(store);
  return true;
}

/**
 * Populate exitSlippageCost + costAdjustedPnl on a trade that is being closed.
 * Uses stored entryGasCost/entrySlippageCost when present (set at BUY creation)
 * and falls back to recomputing from CONFIG constants for legacy trades.
 */
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

export function updateOpenTradePrices(
  updates: Array<{ id: string; currentPrice: number; unrealizedPnl: number }>
): void {
  const store = readStore();
  for (const u of updates) {
    const t = store.openTrades.find(x => x.id === u.id);
    if (t) { t.currentPrice = u.currentPrice; t.unrealizedPnl = u.unrealizedPnl; }
  }
  writeStore(store);
}

export function resolveByPrice(
  toResolve: Array<{ id: string; exitPrice: number }>,
  status: 'resolved' | 'expired' = 'resolved'
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
  writeStore(store);
}

// ── Shadow tracking (excluded-trader observation) ───────────────────────────

const SHADOW_IDS_CAP = 50_000;

export function isShadowProcessed(id: string): boolean {
  const store = readStore();
  return (store.processedShadowIds ?? []).includes(id);
}

export function markShadowProcessed(id: string): void {
  const store = readStore();
  if (!store.processedShadowIds) store.processedShadowIds = [];
  if (!store.processedShadowIds.includes(id)) {
    store.processedShadowIds.push(id);
    if (store.processedShadowIds.length > SHADOW_IDS_CAP) {
      store.processedShadowIds = store.processedShadowIds.slice(-SHADOW_IDS_CAP);
    }
    writeStore(store);
  }
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
  writeStore(store);
}

export function closeShadowOpenTrade(
  copiedTrader: string,
  marketSlug: string,
  outcome: string,
  sellPrice: number
): boolean {
  const store = readStore();
  if (!store.shadowOpenTrades) return false;
  const idx = store.shadowOpenTrades.findIndex(
    t => t.copiedTrader === copiedTrader && t.marketSlug === marketSlug && t.outcome === outcome
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
  writeStore(store);
  return true;
}

export function updateShadowPrices(
  updates: Array<{ id: string; currentPrice: number; unrealizedPnl: number }>
): void {
  if (updates.length === 0) return;
  const store = readStore();
  if (!store.shadowOpenTrades) return;
  for (const u of updates) {
    const t = store.shadowOpenTrades.find(x => x.id === u.id);
    if (t) { t.currentPrice = u.currentPrice; t.unrealizedPnl = u.unrealizedPnl; }
  }
  writeStore(store);
}

export function resolveShadowByPrice(
  toResolve: Array<{ id: string; exitPrice: number }>,
  status: 'resolved' | 'expired' = 'resolved'
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
  writeStore(store);
}

export function setShadowLastSeen(address: string, timestamp: string): void {
  const store = readStore();
  if (!store.shadowLastSeen) store.shadowLastSeen = {};
  store.shadowLastSeen[address] = timestamp;
  writeStore(store);
}

export function markProcessed(id: string): void {
  const store = readStore();
  if (!store.processedTradeIds.includes(id)) {
    store.processedTradeIds.push(id);
    if (store.processedTradeIds.length > PROCESSED_IDS_CAP) {
      store.processedTradeIds = store.processedTradeIds.slice(-PROCESSED_IDS_CAP);
    }
    writeStore(store);
  }
}

export function setTraderExclusion(address: string, excluded: boolean): void {
  const store = readStore();
  if (excluded) {
    if (!store.excludedTraders.includes(address)) store.excludedTraders.push(address);
  } else {
    store.excludedTraders = store.excludedTraders.filter(a => a !== address);
  }
  writeStore(store);
}

export function setCategoryExclusion(category: string, excluded: boolean): void {
  const store = readStore();
  if (!store.excludedCategories) store.excludedCategories = [];
  if (excluded) {
    if (!store.excludedCategories.includes(category)) store.excludedCategories.push(category);
  } else {
    store.excludedCategories = store.excludedCategories.filter(c => c !== category);
  }
  writeStore(store);
}

export function setTraderLastSeen(address: string, timestamp: string): void {
  const store = readStore();
  store.traderLastSeen[address] = timestamp;
  writeStore(store);
}

/**
 * Auto-exclusion: adds/removes the address from both excludedTraders and
 * autoExcludedTraders. Manually excluded traders are NOT touched by this
 * function — only addresses already in autoExcludedTraders are re-included.
 */
const SIDE_CAP = 100; // max entries retained per side (buys / sells)

/**
 * Merge new activity items into the per-trader local history.
 * Items are split by side: non-SELL → buys, SELL → sells.
 * Each side is deduplicated by transaction_hash and capped at SIDE_CAP (most recent).
 * Skips the write entirely if no new entries are found.
 */
export function appendTraderHistory(address: string, items: TraderHistoryEntry[]): void {
  if (items.length === 0) return;
  const store = readStore(); // readStore already migrates legacy {trades} format
  if (!store.traderHistory) store.traderHistory = {};

  const hist = store.traderHistory[address] ?? { buys: [], sells: [], lastFetched: '' };

  const buyMap  = new Map((hist.buys  ?? []).map(t => [t.transaction_hash, t]));
  const sellMap = new Map((hist.sells ?? []).map(t => [t.transaction_hash, t]));

  let added = 0;
  for (const item of items) {
    if (!item.transaction_hash) continue;
    if (item.type.toUpperCase() !== 'TRADE') continue; // skip REDEEM, MERGE, SPLIT, etc.
    const isSell = item.side.toUpperCase() === 'SELL';
    const map = isSell ? sellMap : buyMap;
    if (map.has(item.transaction_hash)) continue;
    map.set(item.transaction_hash, item);
    added++;
  }

  if (added === 0) return; // nothing new — skip write

  const byDesc = (a: TraderHistoryEntry, b: TraderHistoryEntry) =>
    b.timestamp > a.timestamp ? 1 : -1;

  const buys  = Array.from(buyMap.values()).sort(byDesc).slice(0, SIDE_CAP);
  const sells = Array.from(sellMap.values()).sort(byDesc).slice(0, SIDE_CAP);

  store.traderHistory[address] = { buys, sells, lastFetched: new Date().toISOString() };
  writeStore(store);
}

export function setLeaderboardFilters(filters: LeaderboardFilters): void {
  const store = readStore();
  store.leaderboardFilters = filters;
  writeStore(store);
}

export function setLeaderboardStats(stats: LeaderboardStats): void {
  const store = readStore();
  store.lastLeaderboardStats = stats;
  writeStore(store);
}

export function updateTraderLastOnLeaderboard(addresses: string[]): void {
  if (addresses.length === 0) return;
  const store = readStore();
  if (!store.traderLastOnLeaderboard) store.traderLastOnLeaderboard = {};
  const now = new Date().toISOString();
  for (const addr of addresses) store.traderLastOnLeaderboard[addr] = now;
  writeStore(store);
}

export function setAutoExclusion(address: string, excluded: boolean): void {
  const store = readStore();
  if (!store.autoExcludedTraders) store.autoExcludedTraders = [];

  if (excluded) {
    if (!store.excludedTraders.includes(address)) store.excludedTraders.push(address);
    if (!store.autoExcludedTraders.includes(address)) store.autoExcludedTraders.push(address);
  } else {
    store.excludedTraders    = store.excludedTraders.filter(a => a !== address);
    store.autoExcludedTraders = store.autoExcludedTraders.filter(a => a !== address);
  }
  writeStore(store);
}

// ── Watchlist CRUD ────────────────────────────────────────────────────────────

export function addWatchlistTrader(address: string, label?: string): boolean {
  const store = readStore();
  const addr = address.toLowerCase();
  if (store.watchlistTraders.find(w => w.address === addr)) return false;
  store.watchlistTraders.push({ address: addr, label, addedAt: new Date().toISOString(), copyEnabled: true, copyAmount: 5 });
  writeStore(store);
  return true;
}

export function removeWatchlistTrader(address: string): boolean {
  const store = readStore();
  const addr = address.toLowerCase();
  const before = store.watchlistTraders.length;
  store.watchlistTraders = store.watchlistTraders.filter(w => w.address !== addr);
  if (store.watchlistTraders.length === before) return false;
  writeStore(store);
  return true;
}

export function setWatchlistCopyEnabled(address: string, enabled: boolean): boolean {
  const store = readStore();
  const addr = address.toLowerCase();
  const w = store.watchlistTraders.find(w => w.address === addr);
  if (!w) return false;
  w.copyEnabled = enabled;
  writeStore(store);
  return true;
}

export function setWatchlistCopyAmount(address: string, amount: number): boolean {
  const store = readStore();
  const addr = address.toLowerCase();
  const w = store.watchlistTraders.find(w => w.address === addr);
  if (!w) return false;
  w.copyAmount = Math.max(0.01, Math.round(amount * 100) / 100);
  writeStore(store);
  return true;
}

export function updateWatchlistFalconData(
  address: string,
  data: { falconWinRate?: number; falconRoi?: number; falconSharpe?: number }
): void {
  const store = readStore();
  const addr = address.toLowerCase();
  const w = store.watchlistTraders.find(w => w.address === addr);
  if (!w) return;
  if (data.falconWinRate !== undefined) w.falconWinRate = data.falconWinRate;
  if (data.falconRoi     !== undefined) w.falconRoi     = data.falconRoi;
  if (data.falconSharpe  !== undefined) w.falconSharpe  = data.falconSharpe;
  writeStore(store);
}

export function updateTraderFalconCache(data: Record<string, { winRate?: number }>): void {
  const store = readStore();
  if (!store.traderFalconCache) store.traderFalconCache = {};
  const updatedAt = new Date().toISOString();
  for (const [addr, d] of Object.entries(data)) {
    store.traderFalconCache[addr.toLowerCase()] = { winRate: d.winRate, updatedAt };
  }
  writeStore(store);
}

/**
 * Daily maintenance: archive old closed trades, prune stale trader history,
 * and trim processedTradeIds.  Safe to call at any time.
 */
export function runDailyCleanup(): void {
  console.log('[cleanup] Starting daily maintenance...');

  // ── 0. Daily snapshot (pre-cleanup, so rollback is possible) ─────────────
  try { maybeWriteDailySnapshot(); }
  catch (err) { console.error('[cleanup] Snapshot failed:', err instanceof Error ? err.message : err); }

  const store = readStore(); // also migrates traderHistory to buys/sells format
  const now = Date.now();
  const cutoff7d  = now - 7  * 86_400_000;
  const dataDir   = path.dirname(CONFIG.DATA_FILE);

  // ── 1. Archive closed trades older than 7 days ───────────────────────────
  const recentClosed = store.closedTrades.filter(
    t => new Date(t.closedAt ?? t.timestamp).getTime() >= cutoff7d
  );
  const oldClosed = store.closedTrades.filter(
    t => new Date(t.closedAt ?? t.timestamp).getTime() < cutoff7d
  );

  if (oldClosed.length > 0) {
    const archiveDir = path.join(dataDir, 'archive');
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

    const byMonth = new Map<string, SimulatedTrade[]>();
    for (const trade of oldClosed) {
      const d = new Date(trade.closedAt ?? trade.timestamp);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key)!.push(trade);
    }
    for (const [month, trades] of byMonth) {
      const archivePath = path.join(archiveDir, `trades_${month}.json`);
      let existing: SimulatedTrade[] = [];
      if (fs.existsSync(archivePath)) {
        try { existing = JSON.parse(fs.readFileSync(archivePath, 'utf-8')); } catch {}
      }
      const existingIds = new Set(existing.map(t => t.id));
      const merged = [...existing, ...trades.filter(t => !existingIds.has(t.id))];
      fs.writeFileSync(archivePath, JSON.stringify(merged, null, 2), 'utf-8');
      console.log(`[cleanup] Archived ${trades.length} trades to trades_${month}.json, kept ${recentClosed.length} trades`);
    }
    store.closedTrades = recentClosed;
  } else {
    console.log(`[cleanup] closedTrades: all ${recentClosed.length} within 7-day window — nothing to archive`);
  }

  // ── 2. Trim processedTradeIds: drop IDs whose underlying trade is no longer
  //       referenced. closedTrades is now 7d-windowed (step 1), so this
  //       effectively enforces a 7-day retention for dedup IDs. Falls back to
  //       cap-based truncation if something goes wrong and too many remain.
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

  // Shadow side: same logic
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

  // ── 3. Prune traderHistory for traders absent from leaderboard for 7+ days
  const lastOnLb = store.traderLastOnLeaderboard ?? {};
  let pruned = 0;
  for (const addr of Object.keys(store.traderHistory ?? {})) {
    const lastSeen = lastOnLb[addr];
    if (!lastSeen) continue; // no leaderboard record yet — keep
    if (new Date(lastSeen).getTime() < cutoff7d) {
      delete store.traderHistory[addr];
      pruned++;
    }
  }
  console.log(`[cleanup] traderHistory: pruned ${pruned} stale trader(s), ${Object.keys(store.traderHistory).length} remaining`);

  writeStore(store);
  console.log('[cleanup] Daily maintenance complete.');
}
