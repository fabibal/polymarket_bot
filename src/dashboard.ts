import express from 'express';
import https from 'https';
import http from 'http';
import path from 'path';
import fs from 'fs';
import {
  readStore, addWatchlistTrader, removeWatchlistTrader, setWatchlistCopyEnabled, setWatchlistCopyAmount,
  observationClosedStats, observationRowCount,
} from './store';
import { DashboardStats, SimulatedTrade } from './types';
import { CONFIG } from './config';
import { checkVpnConnectivity, RawActivityItem } from './bullpen';
import { detectCategory } from './categories';
import { tradeCostAdjustedPnl, tradeTotalCosts, costBreakdown } from './simulator';
import { getCircuitBreakerStatus, resetCircuitBreaker, rollingNetForTrader } from './risk';
import { FORWARD_TESTS, evaluateForwardTest, buildReadiness } from './forwardtest';
import { parseLowfreqReport, latestReportFile, nextWeeklyRun } from './discovery';
import {
  getLoopLag, copyLatencyStats, parseExpiryLine, parseGitSyncLine, parseScanLine,
  summarizeWatchdog, readLastLine, readText, lastLineMatching, dbInfo,
} from './health';
import { getRtdsStatus } from './rtds';
import { getChainFeedStatus } from './chainfeed';

// Watchlist Performance panel reset (2026-09-26 21:38 UTC, when 0x12d6 went to
// observation and only the LowFreq-* traders were left copying): headline PnL,
// win rate, trade counts, charts, costs and risk only include trades OPENED at
// or after this instant. Nothing is deleted; ?source=all on /api/stats still
// covers everything. Keep in sync with WATCHLIST_STATS_SINCE_MS in public/index.html.
const WATCHLIST_STATS_SINCE_MS = Date.parse('2026-09-26T21:38:14Z');

// Observation-ledger stats start here: before the 429 fix (deployed ~21:00 UTC
// 2026-09-26) rate-limited price sweeps marked live markets dead and expired
// observation positions at stale prices, 109k of them at 15:40 that day alone.
const OBSERVATION_STATS_SINCE = '2026-09-26T21:00:00.000Z';

const LOGS_DIR = '/app/logs';

// Minimal shape used by computeTraderStats (compatible with both RawActivityItem and TraderHistoryEntry)
type ActivityLike = {
  timestamp?: string | null;
  slug?: string | null;
  title?: string | null;
  outcome?: string | null;
  side?: string | null;
  type?: string | null;
  price?: number | null;
  size?: number | null;
  usdc_size?: number | null;
};

// In-memory cache for Polymarket positions (TTL: 2 min)
const positionsCache = new Map<string, { data: unknown[]; ts: number }>();
const POSITIONS_CACHE_TTL_MS = 2 * 60 * 1000;

// In-memory cache for position stats aggregates (TTL: 5 min)
const pstatsCache = new Map<string, { data: unknown; ts: number }>();
const PSTATS_CACHE_TTL_MS = 5 * 60 * 1000;

function httpsGet(url: string, timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', (d: Buffer) => body += d);
      res.on('end', () => {
        // A 429/500 error body is often valid JSON — without this check it
        // parsed cleanly and got cached as if it were real data.
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`JSON parse failed for ${url}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// In-memory VPN status cache (TTL: 25s — frontend polls every 30s)
let vpnCache: { status: 'ok' | 'error'; ip?: string; country?: string; city?: string; uptimeMs?: number; checkedAt: string } | null = null;
let vpnCacheTs = 0;
const VPN_CACHE_TTL_MS = 25_000;

function fetchIpInfo(): Promise<{ ip?: string; country?: string; city?: string }> {
  return new Promise(resolve => {
    const req = https.get('https://ipinfo.io/json', { timeout: 4000 }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { const d = JSON.parse(body); resolve({ ip: d.ip, country: d.country, city: d.city }); }
        catch { resolve({}); }
      });
    });
    req.on('error', () => resolve({}));
    req.on('timeout', () => { req.destroy(); resolve({}); });
  });
}

// ── Docker socket helpers ──────────────────────────────────────────────────
function dockerGet(path: string): Promise<unknown> {
  return new Promise(resolve => {
    const req = http.request(
      { socketPath: '/var/run/docker.sock', path, method: 'GET' },
      res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function getContainerUptimeMs(name: string): Promise<number | null> {
  const data = await dockerGet(`/containers/${name}/json`) as Record<string, unknown> | null;
  if (!data) return null;
  const startedAt = (data.State as Record<string, unknown>)?.StartedAt as string | undefined;
  if (!startedAt) return null;
  const started = new Date(startedAt).getTime();
  return isNaN(started) ? null : Date.now() - started;
}

// Fetch container logs (multiplexed Docker stream) and count substring matches.
// Used for "wallet cap skips" — bot logs go to docker stdout, not a host file.
function countContainerLogMatches(name: string, sinceSec: number, needle: string): Promise<number> {
  return new Promise(resolve => {
    const req = http.request(
      { socketPath: '/var/run/docker.sock', path: `/containers/${name}/logs?stdout=1&stderr=1&since=${sinceSec}`, method: 'GET' },
      res => {
        // Count matches incrementally on each streamed chunk so we never hold the
        // full (potentially tens of MB over 7d) log in memory at once. Each
        // "wallet_cap:" occurrence is on its own log line, so a raw byte search
        // across multiplex frame headers is safe (headers are 8 bytes of binary
        // that cannot contain the literal needle). We carry a small tail of the
        // previous chunk (needle.length - 1 bytes) so a match split across a
        // chunk boundary is still counted exactly once.
        let n = 0;
        let tail = '';
        const overlap = Math.max(0, needle.length - 1);
        res.on('data', (d: Buffer) => {
          const s = tail + d.toString('utf8');
          let idx = 0;
          while ((idx = s.indexOf(needle, idx)) !== -1) { n++; idx += needle.length; }
          tail = overlap > 0 ? s.slice(-overlap) : '';
        });
        res.on('end', () => resolve(n));
        res.on('error', () => resolve(n));
      }
    );
    req.on('error', () => resolve(0));
    req.setTimeout(5000, () => { req.destroy(); resolve(0); });
    req.end();
  });
}

let walletCapSkipsCache: { count: number; ts: number } | null = null;
const WALLET_CAP_SKIPS_TTL_MS = 60_000;

async function getWalletCapSkips7d(): Promise<number> {
  const now = Date.now();
  if (walletCapSkipsCache && now - walletCapSkipsCache.ts < WALLET_CAP_SKIPS_TTL_MS) {
    return walletCapSkipsCache.count;
  }
  const sinceSec = Math.floor((now - 7 * 86_400_000) / 1000);
  const count = await countContainerLogMatches('polymarket_bot', sinceSec, 'wallet_cap:');
  walletCapSkipsCache = { count, ts: now };
  return count;
}

// ── Container stats ────────────────────────────────────────────────────────
interface ContainerStat {
  name: string;
  cpuPct: number | null;
  ramMB: number | null;
  ramLimitMB: number | null;
  ramPct: number | null;
  restartCount: number | null;
  startedAt: string | null;
  uptimeMs: number | null;
}

async function fetchOneContainerStat(name: string): Promise<ContainerStat> {
  const empty: ContainerStat = { name, cpuPct: null, ramMB: null, ramLimitMB: null, ramPct: null, restartCount: null, startedAt: null, uptimeMs: null };
  const [s, info] = await Promise.all([
    dockerGet(`/containers/${name}/stats?stream=false`) as Promise<Record<string, unknown> | null>,
    dockerGet(`/containers/${name}/json`)                as Promise<Record<string, unknown> | null>,
  ]);

  // Extract restart count + uptime from inspect (independent of stats availability)
  let restartCount: number | null = null;
  let startedAt: string | null = null;
  let uptimeMs: number | null = null;
  if (info) {
    const rc = info.RestartCount;
    if (typeof rc === 'number') restartCount = rc;
    const state = info.State as Record<string, unknown> | undefined;
    const sa = state?.StartedAt;
    if (typeof sa === 'string' && sa.length > 0) {
      startedAt = sa;
      const t = new Date(sa).getTime();
      if (!isNaN(t)) uptimeMs = Date.now() - t;
    }
  }

  if (!s) return { ...empty, restartCount, startedAt, uptimeMs };
  try {
    const cpu = s.cpu_stats as Record<string, unknown>;
    const precpu = s.precpu_stats as Record<string, unknown>;
    const mem = s.memory_stats as Record<string, unknown>;
    const cpuUsage = cpu?.cpu_usage as Record<string, unknown>;
    const preCpuUsage = precpu?.cpu_usage as Record<string, unknown>;
    const cpuDelta = (cpuUsage?.total_usage as number) - (preCpuUsage?.total_usage as number);
    const sysDelta = (cpu?.system_cpu_usage as number) - (precpu?.system_cpu_usage as number);
    const numCpus = (cpu?.online_cpus as number) || 1;
    const cpuPct = sysDelta > 0 ? (cpuDelta / sysDelta) * numCpus * 100 : 0;
    const rawUsage = (mem?.usage as number) ?? 0;
    // Reclaimable page cache is subtracted like `docker stats` does: cgroup v2
    // reports inactive_file (there is no `cache` key, so nothing was subtracted
    // and the bot showed ~400MB/512MB right after scanning the DB).
    const memStats = (mem?.stats as Record<string, unknown>) ?? {};
    const cache = (memStats.inactive_file as number) ?? (memStats.cache as number) ?? 0;
    const ramUsed = rawUsage - cache;
    const ramLimit = (mem?.limit as number) ?? 0;
    const ramMB = ramUsed / 1_048_576;
    const ramLimitMB = ramLimit > 0 ? ramLimit / 1_048_576 : null;
    const ramPct = ramLimit > 0 ? (ramUsed / ramLimit) * 100 : null;
    return { name, cpuPct, ramMB, ramLimitMB, ramPct, restartCount, startedAt, uptimeMs };
  } catch {
    return { ...empty, restartCount, startedAt, uptimeMs };
  }
}

const MONITORED_CONTAINERS = ['gluetun', 'polymarket_bot'];
let containerStatsCache: { data: ContainerStat[]; ts: number } | null = null;
const CONTAINER_STATS_TTL_MS = 25_000;

function computeTraderStats(address: string, trades: ActivityLike[]) {
  type BuyEntry = { price: number; size: number; slug: string; title: string; outcome: string };
  type ClosedPnl = { slug: string; title: string; outcome: string; pnl: number };

  const buyQueues: Record<string, BuyEntry[]> = {};
  const closedPnls: ClosedPnl[] = [];
  const marketCounts: Record<string, { slug: string; title: string; count: number }> = {};

  let buyCount = 0;
  let sellCount = 0;
  let totalVolume = 0;

  const sorted = [...trades].sort(
    (a, b) => new Date(a.timestamp ?? 0).getTime() - new Date(b.timestamp ?? 0).getTime()
  );

  for (const t of sorted) {
    const side = (t.side ?? '').toUpperCase();
    const slug = t.slug ?? '';
    const outcome = (t.outcome ?? '').toLowerCase();
    const key = `${slug}::${outcome}`;
    const price = Number(t.price ?? 0);
    const size = Number(t.size ?? 0);
    const usdc = Number(t.usdc_size ?? (price * size));
    const title = t.title ?? slug;

    if (slug) {
      if (!marketCounts[slug]) marketCounts[slug] = { slug, title, count: 0 };
      marketCounts[slug].count++;
    }
    totalVolume += usdc;

    if (side === 'BUY') {
      buyCount++;
      if (!buyQueues[key]) buyQueues[key] = [];
      buyQueues[key].push({ price, size, slug, title, outcome: t.outcome ?? outcome });
    } else if (side === 'SELL') {
      sellCount++;
      const queue = buyQueues[key];
      if (queue && queue.length > 0) {
        const buy = queue.shift()!;
        const matchedSize = Math.min(buy.size, size);
        const pnl = (price - buy.price) * matchedSize;
        closedPnls.push({ slug, title, outcome: t.outcome ?? outcome, pnl });
      }
    }
  }

  const winners = closedPnls.filter(p => p.pnl > 0);
  const losers  = closedPnls.filter(p => p.pnl <= 0);
  const totalPnl = closedPnls.reduce((s, p) => s + p.pnl, 0);
  const avgWin  = winners.length > 0 ? winners.reduce((s, p) => s + p.pnl, 0) / winners.length : 0;
  const avgLoss = losers.length  > 0 ? losers.reduce((s, p) => s + p.pnl, 0) / losers.length  : 0;

  const bestTrade  = closedPnls.reduce<ClosedPnl | null>((b, p) => b === null || p.pnl > b.pnl ? p : b, null);
  const worstTrade = closedPnls.reduce<ClosedPnl | null>((b, p) => b === null || p.pnl < b.pnl ? p : b, null);

  const topMarkets = Object.values(marketCounts).sort((a, b) => b.count - a.count).slice(0, 5);

  // Derive the actual date range from the fetched trades
  const timestamps = trades.map(t => t.timestamp ?? '').filter(Boolean);
  const oldestTs = timestamps.length > 0 ? timestamps.reduce((a, b) => a < b ? a : b) : null;
  const newestTs = timestamps.length > 0 ? timestamps.reduce((a, b) => a > b ? a : b) : null;

  return {
    address,
    fetchedAt: new Date().toISOString(),
    oldestTrade: oldestTs,
    newestTrade: newestTs,
    tradeCount: trades.length,
    buyCount,
    sellCount,
    totalVolume,
    closedTrades: closedPnls.length,
    winners: winners.length,
    losers: losers.length,
    winRate: closedPnls.length > 0 ? winners.length / closedPnls.length : 0,
    totalPnl,
    avgWin,
    avgLoss,
    bestTrade,
    worstTrade,
    topMarkets,
  };
}

function computeInlineStats(
  address: string,
  allTrades: ActivityLike[],
  simClosed: Array<{ realizedPnl?: number | null; costAdjustedPnl?: number | null; timestamp: string; closedAt?: string }>
) {
  const now    = Date.now();
  const cut7d  = now - 7  * 86_400_000;
  const cut30d = now - 30 * 86_400_000;

  const trades = allTrades.filter(t => (t.type ?? '').toUpperCase() === 'TRADE');

  if (trades.length < 5) {
    return { hasEnoughData: false as const, tradeCount30d: trades.length };
  }

  // Total trade items (any side) in last 30d
  const tradeCount30d = trades.filter(t => new Date(t.timestamp ?? 0).getTime() >= cut30d).length;

  // Top category in last 30d by BUY count
  const catCounts: Record<string, number> = {};
  for (const t of trades) {
    if (new Date(t.timestamp ?? 0).getTime() < cut30d) continue;
    if ((t.side ?? '').toUpperCase() !== 'BUY') continue;
    const cat = detectCategory(t.slug ?? '');
    catCounts[cat] = (catCounts[cat] ?? 0) + 1;
  }
  const topCategory = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // Volume in last 30d from local history (usdc_size when available, else price × size)
  const histVol30d = trades
    .filter(t => new Date(t.timestamp ?? 0).getTime() >= cut30d)
    .reduce((sum, t) => sum + Number(t.usdc_size ?? (Number(t.price ?? 0) * Number(t.size ?? 0))), 0);

  // Win rate & avg W/L from our simulated closed trades (traders rarely SELL on Polymarket —
  // they hold to resolution, so BUY/SELL pairs in raw history are almost always zero)
  const sim7d     = simClosed.filter(t => new Date(t.closedAt ?? t.timestamp).getTime() >= cut7d);
  // WR uses costAdjustedPnl so it's consistent with the other win-rate
  // calculations on the dashboard (/api/stats, /api/watchlist allTimeWinRate).
  const winners7d = sim7d.filter(t => (t.costAdjustedPnl ?? t.realizedPnl ?? 0) > 0);
  const winRate7d = sim7d.length >= 2 ? winners7d.length / sim7d.length : null;

  const winners = simClosed.filter(t => (t.realizedPnl ?? 0) > 0);
  const losers  = simClosed.filter(t => (t.realizedPnl ?? 0) <= 0);
  const avgWin  = winners.length > 0 ? winners.reduce((s, t) => s + (t.realizedPnl ?? 0), 0) / winners.length : null;
  const avgLoss = losers.length  > 0 ? losers.reduce((s, t) => s + (t.realizedPnl ?? 0), 0) / losers.length  : null;

  return { hasEnoughData: true as const, tradeCount30d, winRate7d, avgWin, avgLoss, topCategory, histVol30d };
}

const openedSinceReset = (t: { timestamp: string }) => Date.parse(t.timestamp) >= WATCHLIST_STATS_SINCE_MS;

// File-backed parts of /api/system (log tails, DB size, ledger row count).
let systemFilesCache: { data: unknown; ts: number } | null = null;
const SYSTEM_FILES_TTL_MS = 5 * 60 * 1000;

function readSystemFiles(nowMs: number) {
  if (systemFilesCache && nowMs - systemFilesCache.ts < SYSTEM_FILES_TTL_MS) return systemFilesCache.data;
  const data = {
    bullpen: parseExpiryLine(lastLineMatching(readText(path.join(LOGS_DIR, 'bullpen-expiry.log')), 'days_left=')),
    gitSync: parseGitSyncLine(readLastLine(path.join(LOGS_DIR, 'git-sync.log'))),
    lowfreqScan: parseScanLine(readLastLine(path.join(LOGS_DIR, 'weekly-lowfreq-scan.log'))),
    watchdog7d: summarizeWatchdog(readText(path.join(LOGS_DIR, 'watchdog.log')), nowMs, 7 * 86_400_000),
    db: dbInfo(CONFIG.DB_FILE, path.join(path.dirname(CONFIG.DB_FILE), 'backups'), nowMs),
    observationRows: observationRowCount(),
  };
  systemFilesCache = { data, ts: nowMs };
  return data;
}

export function startDashboard(): void {
  const app = express();

  app.use(express.json());
  app.use(express.static(path.join(process.cwd(), 'public')));

  app.get('/api/stats', async (req, res) => {
    const store = readStore();
    // Watchlist is the primary view: headline PnL, slippage and net-edge must
    // reflect current watchlist-only performance, not the dead leaderboard era
    // (lifetime leaderboard copy PnL was -$2,451 and would dominate the totals).
    // Pass ?source=all to opt into the unfiltered all-source view.
    const source = String(req.query.source ?? 'watchlist');

    let openTrades  = store.openTrades;
    let closedTrades = store.closedTrades;
    if (source !== 'all') {
      openTrades   = openTrades.filter(t => t.copiedTraderSource === 'watchlist');
      closedTrades = closedTrades.filter(t => t.copiedTraderSource === 'watchlist');
    }
    // Wallet capacity counts every open position; performance counts only
    // trades opened since the panel reset.
    const walletOpen = openTrades;
    if (source !== 'all') {
      openTrades   = openTrades.filter(openedSinceReset);
      closedTrades = closedTrades.filter(openedSinceReset);
    }

    const realizedPnl = closedTrades.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
    const unrealizedPnl = openTrades.reduce((s, t) => s + (t.unrealizedPnl ?? 0), 0);
    // WR uses costAdjustedPnl to match the auto-exclusion gate.
    const winners = closedTrades.filter(t => (t.costAdjustedPnl ?? t.realizedPnl ?? 0) > 0).length;
    const losers  = closedTrades.filter(t => (t.costAdjustedPnl ?? t.realizedPnl ?? 0) <= 0).length;
    const resolved = winners + losers;

    // Cost-adjusted projections: entry gap (or 2% fallback), 2% exit slippage
    // and per-market taker fees (src/fees.ts).
    const realizedAdj   = closedTrades.reduce((s, t) => s + tradeCostAdjustedPnl(t), 0);
    const unrealizedAdj = openTrades.reduce((s, t) => s + tradeCostAdjustedPnl(t), 0);
    const totalCosts    = [...openTrades, ...closedTrades].reduce((s, t) => s + tradeTotalCosts(t), 0);
    const closedCount   = closedTrades.length || 1;
    const closedCosts   = closedTrades.reduce((s, t) => s + tradeTotalCosts(t), 0);
    const avgRawPnl     = realizedPnl / closedCount;
    const avgSlippage   = closedCosts / closedCount;
    const avgNetEdge    = realizedAdj / closedCount;

    const stats = {
      totalTrades: openTrades.length + closedTrades.length,
      openTrades: openTrades.length,
      closedTrades: closedTrades.length,
      winners,
      losers,
      winRate: resolved > 0 ? winners / resolved : 0,
      totalRealizedPnl: realizedPnl,
      totalUnrealizedPnl: unrealizedPnl,
      totalPnl: realizedPnl + unrealizedPnl,
      totalSimulatedAmount: [...openTrades, ...closedTrades].reduce((s, t) => s + (t.simulatedAmount ?? CONFIG.TRADE_AMOUNT), 0),
      lastUpdated: new Date().toISOString(),
      totalRealizedPnlAdjusted:   realizedAdj,
      totalUnrealizedPnlAdjusted: unrealizedAdj,
      totalPnlAdjusted:           realizedAdj + unrealizedAdj,
      totalTradingCosts:          totalCosts,
      avgRawPnlPerTrade:          avgRawPnl,
      avgSlippagePerTrade:        avgSlippage,
      avgNetEdgePerTrade:         avgNetEdge,
      simulatedWalletSize:        CONFIG.SIMULATED_WALLET_SIZE,
      walletInUse:                walletOpen.reduce((s, t) => s + (t.simulatedAmount ?? CONFIG.TRADE_AMOUNT), 0),
      walletOpenTrades:           walletOpen.length,
      statsSince:                 source !== 'all' ? new Date(WATCHLIST_STATS_SINCE_MS).toISOString() : null,
      walletCapUtilization:       CONFIG.WALLET_CAP_UTILIZATION,
      walletCapSkips7d:           await getWalletCapSkips7d(),
      tradeAmount:                CONFIG.TRADE_AMOUNT,
      circuitBreaker:             getCircuitBreakerStatus(),
      traderDecayThreshold30d:    CONFIG.TRADER_DECAY_THRESHOLD_30D,
    } as DashboardStats & { avgRawPnlPerTrade: number; avgSlippagePerTrade: number; avgNetEdgePerTrade: number; simulatedWalletSize: number; walletInUse: number; walletOpenTrades: number; statsSince: string | null; walletCapUtilization: number; walletCapSkips7d: number; tradeAmount: number; circuitBreaker: ReturnType<typeof getCircuitBreakerStatus>; traderDecayThreshold30d: number };
    res.json(stats);
  });

  // Per-day wallet $ in use over the last 30 days. Sum of simulatedAmount for
  // trades active on each day (opened on/before dayEnd, not closed before dayEnd).
  app.get('/api/wallet/history', (_req, res) => {
    const store = readStore();
    // Watchlist only: 466 legacy April rows have no closed_at and would
    // otherwise count as still open (~$2.3k phantom in use).
    const watchOnly = [...store.openTrades, ...store.closedTrades].filter(t => t.copiedTraderSource === 'watchlist');
    const DAY_MS = 86_400_000;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const days: string[] = [];
    const amounts: number[] = [];
    for (let i = 29; i >= 0; i--) {
      const dayStart = new Date(today.getTime() - i * DAY_MS);
      const dayEnd   = dayStart.getTime() + DAY_MS;
      let inUse = 0;
      for (const t of watchOnly) {
        const opened = new Date(t.timestamp).getTime();
        if (opened >= dayEnd) continue;
        const amt = Number(t.simulatedAmount ?? CONFIG.TRADE_AMOUNT) || 0;
        if (!t.closedAt) { inUse += amt; continue; }
        const closed = new Date(t.closedAt).getTime();
        if (closed >= dayEnd) inUse += amt;
      }
      days.push(dayStart.toISOString().slice(0, 10));
      amounts.push(Math.round(inUse * 100) / 100);
    }
    const cap = CONFIG.SIMULATED_WALLET_SIZE * CONFIG.WALLET_CAP_UTILIZATION;
    res.json({ days, amounts, walletSize: CONFIG.SIMULATED_WALLET_SIZE, cap });
  });

  app.get('/api/trades', (req, res) => {
    const store = readStore();
    const range  = String(req.query.range  ?? 'all');
    const source = String(req.query.source ?? '');

    let cutoff: number | null = null;
    if (range === 'today') {
      const now = new Date();
      cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    } else if (range === '7d') {
      cutoff = Date.now() - 7 * 86_400_000;
    } else if (range === '30d') {
      cutoff = Date.now() - 30 * 86_400_000;
    }
    // ?since=<epoch ms> (opened at or after) and ?limit=<n> keep the payload
    // small: the full watchlist history is ~5 MB of JSON.
    const since = Number(req.query.since);
    if (Number.isFinite(since) && since > 0) cutoff = Math.max(cutoff ?? 0, since);
    const limit = Number(req.query.limit);

    let all = [...store.openTrades, ...store.closedTrades];
    if (source === 'watchlist') {
      all = all.filter(t => t.copiedTraderSource === 'watchlist');
    }
    if (cutoff !== null) {
      all = all.filter(t => new Date(t.timestamp).getTime() >= cutoff!);
    }
    all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const labels = new Map(store.watchlistTraders.map(w => [w.address, w.label]));
    const page = Number.isInteger(limit) && limit > 0 ? all.slice(0, limit) : all;
    const items = page.map(t => ({ ...t, costAdjustedPnl: tradeCostAdjustedPnl(t), traderLabel: labels.get(t.copiedTrader) ?? null }));
    res.json({ count: all.length, items });
  });

  app.get('/api/vpn-status', async (_req, res) => {
    const now = Date.now();
    if (vpnCache && now - vpnCacheTs < VPN_CACHE_TTL_MS) {
      res.json(vpnCache);
      return;
    }
    const ok = await checkVpnConnectivity();
    const checkedAt = new Date().toISOString();
    if (ok) {
      const [info, uptimeMs] = await Promise.all([fetchIpInfo(), getContainerUptimeMs('gluetun')]);
      vpnCache = { status: 'ok', ip: info.ip, country: info.country, city: info.city, uptimeMs: uptimeMs ?? undefined, checkedAt };
    } else {
      vpnCache = { status: 'error', checkedAt };
    }
    vpnCacheTs = Date.now();
    res.json(vpnCache);
  });

  app.get('/api/containers', async (_req, res) => {
    const now = Date.now();
    if (containerStatsCache && now - containerStatsCache.ts < CONTAINER_STATS_TTL_MS) {
      res.json({ items: containerStatsCache.data, fetchedAt: new Date(containerStatsCache.ts).toISOString(), cached: true });
      return;
    }
    const data = await Promise.all(MONITORED_CONTAINERS.map(n => fetchOneContainerStat(n)));
    containerStatsCache = { data, ts: Date.now() };
    res.json({ items: data, fetchedAt: new Date().toISOString(), cached: false });
  });

  // ── Watchlist endpoints ────────────────────────────────────────────────────

  app.get('/api/watchlist', (_req, res) => {
    const store = readStore();
    const items = (store.watchlistTraders ?? []).map(w => {
      const hist       = store.traderHistory?.[w.address];
      const histTrades = hist ? [...hist.buys, ...hist.sells] : [];
      const simClosed  = store.closedTrades.filter(c => c.copiedTrader === w.address);
      const inlineStats = computeInlineStats(w.address, histTrades, simClosed);

      const simAllWinners = simClosed.filter(c => (c.costAdjustedPnl ?? c.realizedPnl ?? 0) > 0).length;
      const allTimeWinRate = simClosed.length >= 3 ? simAllWinners / simClosed.length : null;
      // Cost-adjusted realized PNL — same basis as the sparkline and the cards.
      const realizedPnl = simClosed.reduce((s, t) => s + tradeCostAdjustedPnl(t), 0);

      // Break-even win rate = average entry price (implied probability paid).
      // A favorites strategy buying at avg 0.75 must win >75% just to break even.
      const avgEntryPrice = simClosed.length > 0
        ? simClosed.reduce((s, t) => s + (Number(t.entryPrice) || 0), 0) / simClosed.length
        : null;

      // Profit factor = gross cost-adjusted wins / gross cost-adjusted losses.
      let grossWin = 0, grossLoss = 0;
      for (const t of simClosed) {
        const v = tradeCostAdjustedPnl(t);
        if (v > 0) grossWin += v; else grossLoss += -v;
      }
      const profitFactor = (simClosed.length >= 3 && grossLoss > 0) ? grossWin / grossLoss : null;

      const traderOpenTrades = store.openTrades.filter(t => t.copiedTrader === w.address);
      const openPositions = traderOpenTrades.length;

      // Average holding period (ms) over closed sim trades that have it
      const closedWithHold = simClosed.filter(c => typeof c.holdingPeriodMs === 'number' && c.holdingPeriodMs > 0);
      const avgHoldMs = closedWithHold.length > 0
        ? closedWithHold.reduce((s, c) => s + (c.holdingPeriodMs ?? 0), 0) / closedWithHold.length
        : null;

      // 30d daily realized PNL (UTC buckets, oldest -> newest). Uses cost-adjusted PNL.
      const dayMs = 86_400_000;
      const todayUtc = Math.floor(Date.now() / dayMs) * dayMs;
      const dailyPnl30d: number[] = new Array(30).fill(0);
      for (const t of simClosed) {
        if (!t.closedAt) continue;
        const ts = Date.parse(t.closedAt);
        if (Number.isNaN(ts)) continue;
        const dayBucket = Math.floor(ts / dayMs) * dayMs;
        const idx = 29 - Math.floor((todayUtc - dayBucket) / dayMs);
        if (idx < 0 || idx > 29) continue;
        dailyPnl30d[idx] += (t.costAdjustedPnl ?? t.realizedPnl ?? 0);
      }

      // Card status: copying, observing, or switched off by the decay kill switch.
      const status = w.copyEnabled ? 'copying' : w.autoDisabledAt ? 'auto-disabled' : 'observing';

      // Newest trade the bot has seen from this trader (local history).
      let lastTradeAt: string | null = null;
      for (const h of histTrades) {
        if ((h.type ?? '').toUpperCase() === 'TRADE' && (!lastTradeAt || h.timestamp > lastTradeAt)) lastTradeAt = h.timestamp;
      }

      // Copy-ledger results since the panel reset (cost-adjusted).
      const resetClosed = simClosed.filter(openedSinceReset);
      const resetOpen = traderOpenTrades.filter(openedSinceReset);
      const sinceReset = {
        closed: resetClosed.length,
        winners: resetClosed.filter(t => tradeCostAdjustedPnl(t) > 0).length,
        netPnl: resetClosed.reduce((s, t) => s + tradeCostAdjustedPnl(t), 0),
        open: resetOpen.length,
        unrealizedPnl: resetOpen.reduce((s, t) => s + tradeCostAdjustedPnl(t), 0),
      };

      // Observation ledger for copy-disabled traders, from the clean window on.
      let observation: {
        since: string; closed: number; winRate: number | null; profitFactor: number | null;
        netPnl: number; open: number; unrealizedPnl: number;
      } | null = null;
      if (!w.copyEnabled) {
        const c = observationClosedStats(w.address, OBSERVATION_STATS_SINCE);
        const openObs = store.observationOpenTrades.filter(t => t.copiedTrader === w.address && t.timestamp >= OBSERVATION_STATS_SINCE);
        observation = {
          since: OBSERVATION_STATS_SINCE,
          closed: c.closedCount,
          winRate: c.closedCount >= 3 ? c.winners / c.closedCount : null,
          profitFactor: c.closedCount >= 3 && c.grossLoss > 0 ? c.grossWin / c.grossLoss : null,
          netPnl: c.netPnl,
          open: openObs.length,
          unrealizedPnl: openObs.reduce((s, t) => s + tradeCostAdjustedPnl(t), 0),
        };
      }

      // Aggregate open trades by (market_slug, outcome) for the expand-row
      // "Bot Open Positions (with age)" block — mirrors the Polymarket panel grouping.
      const aggMap = new Map<string, {
        slug: string;
        title: string;
        outcome: string;
        side: string;
        entryPriceWeightedSum: number;
        simulatedAmount: number;
        currentPrice: number | null;
        unrealizedPnl: number;
        oldestTimestamp: string;
        fillCount: number;
      }>();
      for (const t of traderOpenTrades) {
        const key = `${t.marketSlug}||${t.outcome}`;
        const amt = Number(t.simulatedAmount) || 0;
        const cur = aggMap.get(key);
        if (!cur) {
          aggMap.set(key, {
            slug: t.marketSlug,
            title: t.marketTitle,
            outcome: t.outcome,
            side: t.side,
            entryPriceWeightedSum: (Number(t.entryPrice) || 0) * amt,
            simulatedAmount: amt,
            currentPrice: t.currentPrice ?? null,
            unrealizedPnl: Number(t.unrealizedPnl) || 0,
            oldestTimestamp: t.timestamp,
            fillCount: 1,
          });
        } else {
          cur.entryPriceWeightedSum += (Number(t.entryPrice) || 0) * amt;
          cur.simulatedAmount += amt;
          cur.unrealizedPnl += Number(t.unrealizedPnl) || 0;
          cur.fillCount += 1;
          if (t.timestamp && t.timestamp < cur.oldestTimestamp) cur.oldestTimestamp = t.timestamp;
          if (t.currentPrice != null) cur.currentPrice = t.currentPrice;
          if (!cur.title && t.marketTitle) cur.title = t.marketTitle;
        }
      }
      const openTradesData = Array.from(aggMap.values())
        .map(a => ({
          slug: a.slug,
          title: a.title,
          outcome: a.outcome,
          side: a.side,
          entryPrice: a.simulatedAmount > 0 ? a.entryPriceWeightedSum / a.simulatedAmount : null,
          simulatedAmount: a.simulatedAmount,
          currentPrice: a.currentPrice,
          unrealizedPnl: a.unrealizedPnl,
          timestamp: a.oldestTimestamp,
          fillCount: a.fillCount,
        }))
        .sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1))
        .slice(0, 25);

      // Recent 20 TRADE items sorted newest-first
      const recentTrades = [...(hist?.buys ?? []), ...(hist?.sells ?? [])]
        .filter(t => (t.type ?? '').toUpperCase() === 'TRADE')
        .sort((a, b) => b.timestamp > a.timestamp ? 1 : -1)
        .slice(0, 20);

      // Full trader stats from local history (win rate, best/worst trade, top market)
      const traderStats = histTrades.length > 0 ? computeTraderStats(w.address, histTrades) : null;

      // Resolve username from stored trade history
      const tradeWithName = store.closedTrades.find(t => t.copiedTrader === w.address && t.copiedTraderUsername)
        ?? store.openTrades.find(t => t.copiedTrader === w.address && t.copiedTraderUsername);

      // Liquidity profile from logged CLOB depth at fill time (watchlist BUYs only).
      // Averages across all this trader's open + closed sim trades that have data.
      const liqSamples = [...traderOpenTrades, ...simClosed]
        .filter(t => typeof t.askDepth5 === 'number' && typeof t.spreadAtEntry === 'number');
      const avgAskDepth5 = liqSamples.length > 0
        ? liqSamples.reduce((s, t) => s + (t.askDepth5 ?? 0), 0) / liqSamples.length
        : null;
      const avgSpread = liqSamples.length > 0
        ? liqSamples.reduce((s, t) => s + (t.spreadAtEntry ?? 0), 0) / liqSamples.length
        : null;

      // Rolling 30d net + distance to the decay kill-switch threshold.
      const pnl30d = rollingNetForTrader(store.closedTrades, w.address, 30 * 86_400_000, Date.now());
      const decayDistance   = pnl30d - CONFIG.TRADER_DECAY_THRESHOLD_30D; // $ headroom, 30d window

      // Drop stale Falcon fields (leaderboard removed 2026-05-29 — no refresh path; no UI consumer).
      const { falconWinRate: _fwr, falconRoi: _fr, falconSharpe: _fs, ...wRest } = w;
      return { ...wRest, username: tradeWithName?.copiedTraderUsername, status, lastTradeAt, sinceReset, observation, inlineStats, allTimeWinRate, avgEntryPrice, profitFactor, realizedPnl, openPositions, avgHoldMs, dailyPnl30d, openTradesData, recentTrades, traderStats, avgAskDepth5, avgSpread, liqSampleCount: liqSamples.length, pnl30d, decayDistance, decayThreshold: CONFIG.TRADER_DECAY_THRESHOLD_30D };
    });

    res.json({ count: items.length, items, statsSince: new Date(WATCHLIST_STATS_SINCE_MS).toISOString(), observationSince: OBSERVATION_STATS_SINCE });
  });

  app.get('/api/watchlist/open-history', (_req, res) => {
    const store = readStore();
    const watchOpen   = store.openTrades.filter(t => t.copiedTraderSource === 'watchlist');
    const watchClosed = store.closedTrades.filter(t => t.copiedTraderSource === 'watchlist');
    const all = [...watchOpen, ...watchClosed];

    const DAY_MS = 86_400_000;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const days: string[] = [];
    const counts: number[] = [];
    for (let i = 29; i >= 0; i--) {
      const dayStart = new Date(today.getTime() - i * DAY_MS);
      const dayEnd   = dayStart.getTime() + DAY_MS;
      const label    = dayStart.toISOString().slice(0, 10);
      let open = 0;
      for (const t of all) {
        const opened = new Date(t.timestamp).getTime();
        if (opened >= dayEnd) continue;
        if (!t.closedAt) { open++; continue; }
        const closed = new Date(t.closedAt).getTime();
        if (closed >= dayEnd) open++;
      }
      days.push(label);
      counts.push(open);
    }
    // Position-count ceiling implied by the wallet cap (the only active size limit
    // now that MAX_TOTAL_OPEN_POSITIONS is gone): cap $ / per-trade $.
    const walletCap = CONFIG.SIMULATED_WALLET_SIZE * CONFIG.WALLET_CAP_UTILIZATION;
    const walletPositionLimit = CONFIG.TRADE_AMOUNT > 0 ? Math.floor(walletCap / CONFIG.TRADE_AMOUNT) : 0;
    res.json({ days, counts, walletCap, walletPositionLimit });
  });

  app.post('/api/watchlist', (req, res) => {
    const { address, label, copyEnabled } = req.body as { address?: unknown; label?: unknown; copyEnabled?: unknown };
    if (typeof address !== 'string' || !address.trim()) {
      res.status(400).json({ error: 'address must be a non-empty string' });
      return;
    }
    const addr = address.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/i.test(addr)) {
      res.status(400).json({ error: 'invalid Ethereum address' });
      return;
    }
    const labelStr = typeof label === 'string' ? label.trim() || undefined : undefined;
    // copyEnabled=false adds straight to observation, so no poll or RTDS push
    // can copy the trader before a follow-up /copy call would disable it.
    const added = addWatchlistTrader(addr, labelStr, copyEnabled !== false);
    if (!added) {
      res.status(409).json({ error: 'trader already in watchlist' });
      return;
    }
    console.log(`[dashboard] Added ${addr} to watchlist`);
    res.json({ address: addr });
  });

  app.delete('/api/watchlist/:address', (req, res) => {
    const { address } = req.params;
    const removed = removeWatchlistTrader(address);
    if (!removed) {
      res.status(404).json({ error: 'trader not found in watchlist' });
      return;
    }
    console.log(`[dashboard] Removed ${address.slice(0, 10)}... from watchlist`);
    res.json({ address: address.toLowerCase() });
  });

  app.get('/api/watchlist/:address/positions', async (req, res) => {
    const { address } = req.params;
    const addr = address.toLowerCase();
    const cached = positionsCache.get(addr);
    if (cached && Date.now() - cached.ts < POSITIONS_CACHE_TTL_MS) {
      res.json(cached.data);
      return;
    }
    try {
      const raw = await httpsGet(
        `https://data-api.polymarket.com/positions?user=${addr}&sizeThreshold=.1`
      );
      const positions = Array.isArray(raw) ? raw : [];
      positionsCache.set(addr, { data: positions, ts: Date.now() });
      res.json(positions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[dashboard] Positions fetch failed for ${addr.slice(0, 10)}:`, msg);
      // Return stale cache if available rather than an error
      if (cached) { res.json(cached.data); return; }
      res.status(500).json({ error: msg });
    }
  });

  app.get('/api/watchlist/:address/pstats', async (req, res) => {
    const { address } = req.params;
    const addr = address.toLowerCase();
    const cached = pstatsCache.get(addr);
    if (cached && Date.now() - cached.ts < PSTATS_CACHE_TTL_MS) {
      res.json(cached.data);
      return;
    }
    try {
      const raw = await httpsGet(
        `https://data-api.polymarket.com/positions?user=${addr}&limit=500`
      );
      const positions = Array.isArray(raw) ? raw as Record<string, unknown>[] : [];

      const totalPositions = positions.length;

      // Open = position still has positive value/size
      const openPos  = positions.filter(p => Number(p.size ?? 0) > 0.01 || Number(p.currentValue ?? 0) > 0.01);
      const openPositions  = openPos.length;
      const closedPositions = totalPositions - openPositions;

      // Total invested: prefer initialValue field, fall back to avgPrice × size for open positions
      const hasInitialValue = positions.some(p => p.initialValue != null);
      let totalInvested: number | null = null;
      if (hasInitialValue) {
        totalInvested = positions.reduce((s, p) => s + Number(p.initialValue ?? 0), 0);
      } else if (openPos.length > 0) {
        totalInvested = openPos.reduce((s, p) => s + Number(p.avgPrice ?? 0) * Number(p.size ?? 0), 0);
      }

      // Realized PNL: from cashPnl field (present on resolved positions)
      const hasCashPnl = positions.some(p => p.cashPnl != null);
      let realizedPnl: number | null = null;
      let winCount = 0, lossCount = 0;
      if (hasCashPnl) {
        realizedPnl = 0;
        for (const p of positions) {
          if (p.cashPnl == null) continue;
          const cp = Number(p.cashPnl);
          if (cp !== 0) {
            realizedPnl += cp;
            if (cp > 0) winCount++; else lossCount++;
          }
        }
      }

      const winRate = (winCount + lossCount) >= 3 ? winCount / (winCount + lossCount) : null;

      // Earliest trade timestamp ("active since")
      let activeSince: string | null = null;
      try {
        const earliestRaw = await httpsGet(
          `https://data-api.polymarket.com/activity?user=${addr}&limit=1&type=TRADE&sortDirection=ASC`
        );
        const earliest = Array.isArray(earliestRaw) ? earliestRaw as Record<string, unknown>[] : [];
        if (earliest[0] && earliest[0].timestamp) {
          activeSince = new Date(Number(earliest[0].timestamp) * 1000).toISOString();
        }
      } catch { /* non-blocking */ }

      const data = { totalPositions, openPositions, closedPositions, totalInvested, realizedPnl, winCount, lossCount, winRate, activeSince };
      pstatsCache.set(addr, { data, ts: Date.now() });
      res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[dashboard] PStats fetch failed for ${addr.slice(0, 10)}:`, msg);
      if (cached) { res.json(cached.data); return; }
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/watchlist/:address/amount', (req, res) => {
    const { address } = req.params;
    const { amount } = req.body as { amount?: unknown };
    const n = typeof amount === 'number' ? amount : parseFloat(String(amount ?? ''));
    if (isNaN(n) || n <= 0) {
      res.status(400).json({ error: 'amount must be a positive number' });
      return;
    }
    const updated = setWatchlistCopyAmount(address, n);
    if (!updated) {
      res.status(404).json({ error: 'trader not found in watchlist' });
      return;
    }
    console.log(`[dashboard] Watchlist trader ${address.slice(0, 10)}... copy amount set to $${n}`);
    res.json({ address: address.toLowerCase(), copyAmount: Math.max(0.01, Math.round(n * 100) / 100) });
  });

  app.post('/api/watchlist/:address/copy', (req, res) => {
    const { address } = req.params;
    const { copyEnabled } = req.body as { copyEnabled?: unknown };
    if (typeof copyEnabled !== 'boolean') {
      res.status(400).json({ error: 'copyEnabled must be a boolean' });
      return;
    }
    const updated = setWatchlistCopyEnabled(address, copyEnabled);
    if (!updated) {
      res.status(404).json({ error: 'trader not found in watchlist' });
      return;
    }
    console.log(`[dashboard] Watchlist trader ${address.slice(0, 10)}... copy ${copyEnabled ? 'enabled' : 'disabled'}`);
    res.json({ address: address.toLowerCase(), copyEnabled });
  });

  // Weekly low-frequency discovery: the newest run's report.json from
  // scripts/weekly-lowfreq-scan.sh (host logs/ dir is bind-mounted read-only).
  app.get('/api/discovery', (_req, res) => {
    const runsDir = path.join(LOGS_DIR, 'weekly-lowfreq-scan-runs');
    const file = latestReportFile(runsDir);
    const nextRunAt = nextWeeklyRun(Date.now());
    if (!file) {
      res.json({ report: null, nextRunAt, message: 'No weekly scan has run yet.' });
      return;
    }
    try {
      const report = parseLowfreqReport(JSON.parse(fs.readFileSync(file, 'utf8')));
      const store = readStore();
      const onWatchlist = new Set(store.watchlistTraders.map(w => w.address));
      const candidates = (report?.candidates ?? []).map(c => ({ ...c, onWatchlist: onWatchlist.has(c.address) }));
      const lastRun = parseScanLine(readLastLine(path.join(LOGS_DIR, 'weekly-lowfreq-scan.log')));
      res.json({ report: report ? { ...report, candidates } : null, lastRun, nextRunAt });
    } catch (e) {
      console.error('[dashboard] /api/discovery error:', e);
      res.status(500).json({ error: 'failed to read scan report' });
    }
  });

  // ── Forward test + live-readiness checklist ─────────────────────────────────
  // Copy-ledger results of the traders in src/forwardtest.ts against their
  // backtest bands, and the checklist that gates a real-money test.
  app.get('/api/forward-test', (_req, res) => {
    const store = readStore();
    const now = Date.now();
    const onWatchlist = new Map(store.watchlistTraders.map(w => [w.address, w]));
    const results = FORWARD_TESTS
      .filter(p => onWatchlist.has(p.address))
      .map(p => {
        const lots = [...store.openTrades, ...store.closedTrades]
          .filter(t => t.copiedTrader === p.address && t.copiedTraderSource === 'watchlist');
        const r = evaluateForwardTest(p, lots, now, tradeCostAdjustedPnl);
        return { ...r, copyEnabled: onWatchlist.get(p.address)!.copyEnabled };
      });
    res.json({ results, readiness: buildReadiness(results, now), dryRun: CONFIG.DRY_RUN });
  });

  // ── Where the money goes ───────────────────────────────────────────────────
  // Gross PnL at the trader's prices vs every cost, closed copies opened since
  // the panel reset, per trader and in total.
  app.get('/api/costs', (_req, res) => {
    const store = readStore();
    const closed = store.closedTrades.filter(t => t.copiedTraderSource === 'watchlist' && openedSinceReset(t));
    const labels = new Map(store.watchlistTraders.map(w => [w.address, w.label]));
    const byTrader = new Map<string, SimulatedTrade[]>();
    for (const t of closed) byTrader.set(t.copiedTrader, [...(byTrader.get(t.copiedTrader) ?? []), t]);
    const traders = [...byTrader.entries()]
      .map(([address, trades]) => ({ address, label: labels.get(address) ?? null, ...costBreakdown(trades) }))
      .sort((a, b) => b.gross - a.gross);
    res.json({ since: new Date(WATCHLIST_STATS_SINCE_MS).toISOString(), total: costBreakdown(closed), traders });
  });

  // ── System health ──────────────────────────────────────────────────────────
  // Live parts (feed, loop lag, copy latency) on every call; log tails, DB
  // size and the ledger row count are cached for 5 minutes.
  app.get('/api/system', (_req, res) => {
    const store = readStore();
    const now = Date.now();
    const copies = [...store.openTrades, ...store.closedTrades].filter(t => t.copiedTraderSource === 'watchlist');
    res.json({
      rtds: { ...getRtdsStatus(now), configured: CONFIG.RTDS_ENABLED },
      chain: { ...getChainFeedStatus(now), configured: CONFIG.CHAIN_FEED_ENABLED },
      loopLag: getLoopLag(),
      uptimeSec: Math.round(process.uptime()),
      copyLatency7d: copyLatencyStats(copies, now, 7 * 86_400_000),
      files: readSystemFiles(now),
    });
  });

  // ── Circuit breaker manual override ──────────────────────────────────────────
  app.post('/api/breaker/reset', (_req, res) => {
    resetCircuitBreaker();
    res.json({ ok: true, circuitBreaker: getCircuitBreakerStatus() });
  });

  // ── Risk metrics ──────────────────────────────────────────────────────────────
  app.get('/api/risk/metrics', (_req, res) => {
    const store = readStore();
    const DAY_MS = 86_400_000;
    // Same window as the Watchlist Performance panel: copies opened since the reset.
    const closed = store.closedTrades
      .filter(t => t.copiedTraderSource === 'watchlist' && t.closedAt != null && openedSinceReset(t))
      .sort((a, b) => new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime());

    // Equity curve (cost-adjusted) → max drawdown $ and %.
    let cum = 0, peak = 0, maxDrawdownUsd = 0, maxDrawdownPct = 0;
    // Longest losing streak (consecutive non-positive trades).
    let streak = 0, longestLosingStreak = 0;
    const dailyPnl = new Map<string, number>();
    for (const t of closed) {
      const v = tradeCostAdjustedPnl(t);
      cum += v;
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDrawdownUsd) { maxDrawdownUsd = dd; maxDrawdownPct = peak > 0 ? (dd / peak) * 100 : 0; }
      if (v <= 0) { streak++; if (streak > longestLosingStreak) longestLosingStreak = streak; } else streak = 0;
      const day = t.closedAt!.slice(0, 10);
      dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + v);
    }

    // Daily-PNL Sharpe (annualized by sqrt(365)). Calendar days from first to
    // last close are filled with 0 so idle days count as flat returns.
    let sharpe: number | null = null;
    if (closed.length >= 2) {
      const first = new Date(closed[0].closedAt!.slice(0, 10)).getTime();
      const last = new Date(closed[closed.length - 1].closedAt!.slice(0, 10)).getTime();
      const series: number[] = [];
      for (let d = first; d <= last; d += DAY_MS) {
        series.push(dailyPnl.get(new Date(d).toISOString().slice(0, 10)) ?? 0);
      }
      if (series.length >= 2) {
        const mean = series.reduce((a, b) => a + b, 0) / series.length;
        const variance = series.reduce((a, b) => a + (b - mean) ** 2, 0) / (series.length - 1);
        const sd = Math.sqrt(variance);
        sharpe = sd > 0 ? (mean / sd) * Math.sqrt(365) : null;
      }
    }

    // Exposure concentration over OPEN watchlist positions.
    const open = store.openTrades.filter(t => t.copiedTraderSource === 'watchlist');
    const totalOpen = open.reduce((s, t) => s + (Number(t.simulatedAmount) || 0), 0);
    const labelByAddr = new Map<string, string>();
    for (const w of store.watchlistTraders ?? []) if (w.label) labelByAddr.set(w.address, w.label);
    const byTraderMap = new Map<string, number>();
    const byCatMap = new Map<string, number>();
    for (const t of open) {
      const amt = Number(t.simulatedAmount) || 0;
      byTraderMap.set(t.copiedTrader, (byTraderMap.get(t.copiedTrader) ?? 0) + amt);
      const cat = detectCategory(t.marketSlug || '');
      byCatMap.set(cat, (byCatMap.get(cat) ?? 0) + amt);
    }
    const byTrader = [...byTraderMap.entries()]
      .map(([address, amount]) => ({
        address,
        label: labelByAddr.get(address) ?? null,
        amount,
        pct: totalOpen > 0 ? (amount / totalOpen) * 100 : 0,
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 8);
    const byCategory = [...byCatMap.entries()]
      .map(([category, amount]) => ({ category, amount, pct: totalOpen > 0 ? (amount / totalOpen) * 100 : 0 }))
      .sort((a, b) => b.amount - a.amount);

    res.json({
      since: new Date(WATCHLIST_STATS_SINCE_MS).toISOString(),
      closedCount: closed.length,
      maxDrawdownUsd,
      maxDrawdownPct,
      longestLosingStreak,
      sharpe,
      totalOpen,
      byTrader,
      byCategory,
    });
  });

  app.listen(CONFIG.PORT, '0.0.0.0', () => {
    console.log(`[dashboard] Web UI → http://localhost:${CONFIG.PORT}`);
  });
}
