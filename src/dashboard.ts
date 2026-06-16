import express from 'express';
import https from 'https';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { readStore, addWatchlistTrader, removeWatchlistTrader, setWatchlistCopyEnabled, setWatchlistCopyAmount, getSkippedTradeStats } from './store';
import { DashboardStats } from './types';
import { CONFIG } from './config';
import { checkVpnConnectivity, RawActivityItem } from './bullpen';
import { detectCategory } from './categories';
import { tradeCostAdjustedPnl, tradeTotalCosts } from './simulator';
import { groupStats } from './stats';
import { getCircuitBreakerStatus, resetCircuitBreaker, rollingNetForTrader } from './risk';

// $1k wallet-test cutover: leaderboard real copies frozen, watchlist-only sim begins.
const TEST_START_MS = Date.UTC(2026, 4, 28, 0, 0, 0);

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
    const cache = ((mem?.stats as Record<string, unknown>)?.cache as number) ?? 0;
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

// Cost-adjusted per-trade edge stats for a set of closed trades.
// Used by the go-live readiness and risk endpoints.
function edgeStats(trades: import('./types').SimulatedTrade[]) {
  const vals = trades.map(t => tradeCostAdjustedPnl(t));
  const gs = groupStats(vals);
  const winners = vals.filter(v => v > 0).length;
  const totalPnl = vals.reduce((s, v) => s + v, 0);
  return {
    n: gs.n,
    winRate: gs.n > 0 ? winners / gs.n : null,
    expPerTrade: gs.mean,
    ciLow: gs.ciLow,
    ciHigh: gs.ciHigh,
    tStat: gs.tStat,
    pValue: gs.pValue,
    totalPnl,
  };
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

    const realizedPnl = closedTrades.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
    const unrealizedPnl = openTrades.reduce((s, t) => s + (t.unrealizedPnl ?? 0), 0);
    // WR uses costAdjustedPnl to match the auto-exclusion gate.
    const winners = closedTrades.filter(t => (t.costAdjustedPnl ?? t.realizedPnl ?? 0) > 0).length;
    const losers  = closedTrades.filter(t => (t.costAdjustedPnl ?? t.realizedPnl ?? 0) <= 0).length;
    const resolved = winners + losers;

    // Slippage-adjusted projections — Polymarket has NO fees on sports markets,
    // only 2% slippage each side (entry at ask, exit at bid) applies.
    const realizedAdj   = closedTrades.reduce((s, t) => s + tradeCostAdjustedPnl(t), 0);
    const unrealizedAdj = openTrades.reduce((s, t) => s + tradeCostAdjustedPnl(t), 0);
    const totalCosts    = [...openTrades, ...closedTrades].reduce((s, t) => s + tradeTotalCosts(t), 0);
    const closedCount   = closedTrades.length || 1;
    const closedCosts   = closedTrades.reduce((s, t) => s + tradeTotalCosts(t), 0);
    const avgRawPnl     = realizedPnl / closedCount;
    const avgSlippage   = closedCosts / closedCount;
    const avgNetEdge    = realizedAdj / closedCount;

    // $1k wallet-test window: watchlist-only closes at or after TEST_START_MS.
    const testCloses = store.closedTrades.filter(t =>
      t.copiedTraderSource === 'watchlist' &&
      t.closedAt != null &&
      new Date(t.closedAt).getTime() >= TEST_START_MS
    );
    const testPnl    = testCloses.reduce((s, t) => s + tradeCostAdjustedPnl(t), 0);
    const testTrades = testCloses.length;

    // Per-trader longshot carve-out (0x12d6) — record-only count + would-be notional.
    const longshot = getSkippedTradeStats('longshot_filter_0x12d6');

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
      walletInUse:                openTrades.reduce((s, t) => s + (t.simulatedAmount ?? CONFIG.TRADE_AMOUNT), 0),
      walletCapUtilization:       CONFIG.WALLET_CAP_UTILIZATION,
      walletCapSkips7d:           await getWalletCapSkips7d(),
      tradeAmount:                CONFIG.TRADE_AMOUNT,
      testPnl,
      testTrades,
      testStart:                  new Date(TEST_START_MS).toISOString(),
      longshotSkipCount:          longshot.count,
      longshotSkipNotional:       longshot.notional,
      circuitBreaker:             getCircuitBreakerStatus(),
      traderDecayThreshold30d:    CONFIG.TRADER_DECAY_THRESHOLD_30D,
    } as DashboardStats & { avgRawPnlPerTrade: number; avgSlippagePerTrade: number; avgNetEdgePerTrade: number; simulatedWalletSize: number; walletInUse: number; walletCapUtilization: number; walletCapSkips7d: number; tradeAmount: number; testPnl: number; testTrades: number; testStart: string; longshotSkipCount: number; longshotSkipNotional: number; circuitBreaker: ReturnType<typeof getCircuitBreakerStatus>; traderDecayThreshold30d: number };
    res.json(stats);
  });

  // Per-day wallet $ in use over the last 30 days. Sum of simulatedAmount for
  // trades active on each day (opened on/before dayEnd, not closed before dayEnd).
  app.get('/api/wallet/history', (_req, res) => {
    const store = readStore();
    const all = [...store.openTrades, ...store.closedTrades];
    const watchOnly = all.filter(t => t.copiedTraderSource === 'watchlist');
    const DAY_MS = 86_400_000;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const days: string[] = [];
    const amounts: number[] = [];
    const testAmounts: (number | null)[] = [];
    for (let i = 29; i >= 0; i--) {
      const dayStart = new Date(today.getTime() - i * DAY_MS);
      const dayEnd   = dayStart.getTime() + DAY_MS;
      let inUse = 0;
      for (const t of all) {
        const opened = new Date(t.timestamp).getTime();
        if (opened >= dayEnd) continue;
        const amt = Number(t.simulatedAmount ?? CONFIG.TRADE_AMOUNT) || 0;
        if (!t.closedAt) { inUse += amt; continue; }
        const closed = new Date(t.closedAt).getTime();
        if (closed >= dayEnd) inUse += amt;
      }
      days.push(dayStart.toISOString().slice(0, 10));
      amounts.push(Math.round(inUse * 100) / 100);

      if (dayEnd <= TEST_START_MS) {
        testAmounts.push(null);
      } else {
        let testInUse = 0;
        for (const t of watchOnly) {
          const opened = new Date(t.timestamp).getTime();
          if (opened >= dayEnd) continue;
          const amt = Number(t.simulatedAmount ?? CONFIG.TRADE_AMOUNT) || 0;
          if (!t.closedAt) { testInUse += amt; continue; }
          const closed = new Date(t.closedAt).getTime();
          if (closed >= dayEnd) testInUse += amt;
        }
        testAmounts.push(Math.round(testInUse * 100) / 100);
      }
    }
    const cap = CONFIG.SIMULATED_WALLET_SIZE * CONFIG.WALLET_CAP_UTILIZATION;
    res.json({ days, amounts, testAmounts, testStart: new Date(TEST_START_MS).toISOString(), walletSize: CONFIG.SIMULATED_WALLET_SIZE, cap });
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

    let all = [...store.openTrades, ...store.closedTrades];
    if (source === 'watchlist') {
      all = all.filter(t => t.copiedTraderSource === 'watchlist');
    }
    if (cutoff !== null) {
      all = all.filter(t => new Date(t.timestamp).getTime() >= cutoff!);
    }
    all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const items = all.map(t => ({ ...t, costAdjustedPnl: tradeCostAdjustedPnl(t) }));
    res.json({ count: items.length, items });
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
      // Cost-adjusted realized PNL — consistent basis with the sparkline + go-live panel.
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

      // Category breakdown for this trader's closed sim trades (using shared detectCategory).
      const categoryBreakdown: Record<string, number> = {};
      for (const t of simClosed) {
        const cat = detectCategory(t.marketSlug || '');
        categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + 1;
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
      return { ...wRest, username: tradeWithName?.copiedTraderUsername, inlineStats, allTimeWinRate, avgEntryPrice, profitFactor, realizedPnl, openPositions, avgHoldMs, dailyPnl30d, categoryBreakdown, openTradesData, recentTrades, traderStats, avgAskDepth5, avgSpread, liqSampleCount: liqSamples.length, pnl30d, decayDistance, decayThreshold: CONFIG.TRADER_DECAY_THRESHOLD_30D };
    });

    // Watchlist-wide PNL totals (simulated)
    const totalRealizedPnl   = items.reduce((s, i) => s + (i.realizedPnl  ?? 0), 0);
    const totalUnrealizedPnl = store.openTrades
      .filter(t => t.copiedTraderSource === 'watchlist')
      .reduce((s, t) => s + (t.unrealizedPnl ?? 0), 0);

    // Watchlist-wide category breakdown across ALL watchlist closed trades
    const categoryBreakdownAll: Record<string, number> = {};
    for (const t of store.closedTrades) {
      if (t.copiedTraderSource !== 'watchlist') continue;
      const cat = detectCategory(t.marketSlug || '');
      categoryBreakdownAll[cat] = (categoryBreakdownAll[cat] || 0) + 1;
    }

    res.json({ count: items.length, items, totalRealizedPnl, totalUnrealizedPnl, categoryBreakdownAll });
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
    const { address, label } = req.body as { address?: unknown; label?: unknown };
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
    const added = addWatchlistTrader(addr, labelStr);
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

  // Discovery candidates from latest weekly macro scan.
  // Parses /app/logs/weekly-macro-scan-runs/*-scan90d.log (host logs/ dir is bind-mounted ro)
  // and enriches each candidate with Sharpe from store.trackedTraders.
  app.get('/api/discovery/candidates', (_req, res) => {
    const RUNS_DIR = '/app/logs/weekly-macro-scan-runs';
    const SUMMARY_LOG = '/app/logs/weekly-macro-scan.log';
    try {
      let scanFile: string | null = null;
      let scanDate: string | null = null;
      if (fs.existsSync(RUNS_DIR)) {
        const files = fs.readdirSync(RUNS_DIR).filter(f => f.endsWith('-scan90d.log')).sort();
        if (files.length > 0) {
          scanFile = path.join(RUNS_DIR, files[files.length - 1]);
          const m = files[files.length - 1].match(/^(\d{8}T\d{6}Z)/);
          if (m) {
            const s = m[1];
            scanDate = `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(9,11)}:${s.slice(11,13)}:${s.slice(13,15)}Z`;
          }
        }
      }

      if (!scanFile) {
        res.json({ scanDate: null, scanned: 0, candidates: [], message: 'No weekly scan has run yet.' });
        return;
      }

      const content = fs.readFileSync(scanFile, 'utf8');
      const lines = content.split('\n');

      const headMatch = content.match(/\[scan\] cached=(\d+)/);
      const scanned = headMatch ? Number(headMatch[1]) : 0;

      // Candidate rows: prefer the machine-readable CANDIDATES_JSON line
      // (emitted by macro_scan_90d.js since 2026-06-10). Position-parsing the
      // human table is only a fallback for logs from older scans — a column
      // change there would silently shift fields into the wrong numbers.
      type RawCandidate = {
        address: string; onFalcon7d: boolean; tr90: number; tpw: number;
        closed: number; avgHoldDays: number; winRate: number; pnl: number;
      };
      let rawCandidates: RawCandidate[] | null = null;
      const jsonLine = lines.find(l => l.startsWith('CANDIDATES_JSON '));
      if (jsonLine) {
        try {
          const arr = JSON.parse(jsonLine.slice('CANDIDATES_JSON '.length));
          if (Array.isArray(arr)) {
            rawCandidates = arr.map((c: Record<string, unknown>) => ({
              address:     String(c.address ?? '').toLowerCase(),
              onFalcon7d:  Boolean(c.onFalcon7d),
              tr90:        Number(c.tr90) || 0,
              tpw:         Number(c.tpw) || 0,
              closed:      Number(c.closed) || 0,
              avgHoldDays: Number(c.avgHoldDays) || 0,
              winRate:     Number(c.winRate) || 0,
              pnl:         Number(c.pnl) || 0,
            })).filter(c => /^0x[0-9a-f]{40}$/.test(c.address));
          }
        } catch (e) {
          console.error('[dashboard] CANDIDATES_JSON parse failed, falling back to table parse:', e);
        }
      }
      if (!rawCandidates) {
        // Legacy fallback: extract the top "MACRO CANDIDATES" section (before
        // "--- subset NOT on 7d ---") and split rows on whitespace.
        // Row format: addr on7d tr90 t/wk closed hold_d >48h >7d wr pnl
        let inTop = false;
        const rawRows: string[] = [];
        for (const ln of lines) {
          if (/^========== MACRO CANDIDATES/.test(ln)) { inTop = true; continue; }
          if (/^--- subset NOT on 7d/.test(ln))       { inTop = false; }
          if (inTop && /^0x[0-9a-f]{40}/i.test(ln))   { rawRows.push(ln); }
        }
        rawCandidates = rawRows.map(row => {
          const parts = row.trim().split(/\s+/);
          return {
            address:     (parts[0] || '').toLowerCase(),
            onFalcon7d:  (parts[1] || '') === 'Y',
            tr90:        Number(parts[2]) || 0,
            tpw:         Number(parts[3]) || 0,
            closed:      Number(parts[4]) || 0,
            avgHoldDays: Number(parts[5]) || 0,
            winRate:     Number(String(parts[8] ?? '').replace('%', '')) || 0,
            pnl:         Number(parts[9]) || 0,
          };
        });
      }

      const store = readStore();
      const sharpeByAddr = new Map<string, number>();
      for (const t of store.trackedTraders ?? []) {
        if (t.address && typeof (t as any).falconSharpe === 'number') {
          sharpeByAddr.set(t.address.toLowerCase(), (t as any).falconSharpe);
        }
      }
      for (const w of store.watchlistTraders ?? []) {
        if (w.address && typeof (w as any).falconSharpe === 'number') {
          sharpeByAddr.set(w.address.toLowerCase(), (w as any).falconSharpe);
        }
      }
      const watchlistAddrs = new Set((store.watchlistTraders ?? []).map(w => w.address.toLowerCase()));

      const candidates = rawCandidates.map(c => {
        const expPerTrade = c.closed > 0 ? c.pnl / c.closed : 0;
        const sharpe = sharpeByAddr.has(c.address) ? sharpeByAddr.get(c.address)! : null;
        const why    = `WR ${c.winRate}% · hold ${c.avgHoldDays}d · ${c.tpw} trades/wk · ${c.closed} closed · PNL +$${c.pnl.toFixed(0)}`;
        return {
          ...c,
          expPerTrade,
          sharpe,
          alreadyWatchlisted: watchlistAddrs.has(c.address),
          why,
        };
      }).filter(c => c.closed >= 10);

      // Pull "SENT" line from summary log to confirm last cron run.
      let lastRunLine: string | null = null;
      if (fs.existsSync(SUMMARY_LOG)) {
        const sumLines = fs.readFileSync(SUMMARY_LOG, 'utf8').trim().split('\n').reverse();
        for (const ln of sumLines) {
          if (ln.includes('SENT') || ln.includes('SEND_FAILED')) { lastRunLine = ln; break; }
        }
      }

      res.json({ scanDate, scanned, candidates, lastRunLine });
    } catch (e) {
      console.error('[dashboard] /api/discovery/candidates error:', e);
      res.status(500).json({ error: 'failed to read scan results' });
    }
  });

  // ── Go-live readiness ───────────────────────────────────────────────────────
  // Statistical gate for flipping DRY_RUN=false. Computed over watchlist closed
  // trades in the $1k test window only (closed_at >= TEST_START_MS), cost-adjusted.
  app.get('/api/golive/readiness', (_req, res) => {
    const store = readStore();
    const TARGET = 5000;
    const P_THRESHOLD = 0.01;
    const test = store.closedTrades.filter(t =>
      t.copiedTraderSource === 'watchlist' &&
      t.closedAt != null &&
      new Date(t.closedAt).getTime() >= TEST_START_MS,
    );
    const e = edgeStats(test);
    // READY requires significance AND a positive edge — a significant *negative*
    // edge must never read as "go live" in this DRY_RUN-safety context.
    const ready = e.n >= TARGET && e.pValue < P_THRESHOLD && e.expPerTrade > 0;
    res.json({
      n: e.n,
      target: TARGET,
      pThreshold: P_THRESHOLD,
      netEdgePerTrade: e.expPerTrade,
      ciLow: e.ciLow,
      ciHigh: e.ciHigh,
      tStat: e.tStat,
      pValue: e.pValue,
      totalPnl: e.totalPnl,
      winRate: e.winRate,
      ready,
      testStart: new Date(TEST_START_MS).toISOString(),
    });
  });

  // ── Circuit breaker manual override ──────────────────────────────────────────
  app.post('/api/breaker/reset', (_req, res) => {
    resetCircuitBreaker();
    res.json({ ok: true, circuitBreaker: getCircuitBreakerStatus() });
  });

  // ── Observation forward-test (copy-disabled watchlist traders) ───────────────
  // Per-trader stats over the observation ledger: trades simulated with the full
  // lifecycle but never copied. Same cost-adjusted basis as the active watchlist.
  app.get('/api/observation', (_req, res) => {
    const store = readStore();
    const byTrader = new Map<string, typeof store.observationTrades>();
    for (const t of store.observationTrades ?? []) {
      const arr = byTrader.get(t.copiedTrader) ?? [];
      arr.push(t);
      byTrader.set(t.copiedTrader, arr);
    }
    const items = [...byTrader.entries()].map(([address, trades]) => {
      const w = store.watchlistTraders.find(x => x.address === address);
      const closed = trades.filter(t => t.status !== 'open');
      const open   = trades.filter(t => t.status === 'open');
      let netPnl = 0, grossWin = 0, grossLoss = 0, winners = 0;
      for (const t of closed) {
        const v = tradeCostAdjustedPnl(t);
        netPnl += v;
        if (v > 0) { winners++; grossWin += v; } else grossLoss += -v;
      }
      const unrealizedPnl = open.reduce((s, t) => s + tradeCostAdjustedPnl(t), 0);
      const avgEntryPrice = closed.length > 0
        ? closed.reduce((s, t) => s + (Number(t.entryPrice) || 0), 0) / closed.length
        : null;
      const timestamps = trades.map(t => t.timestamp).sort();
      return {
        address,
        label: w?.label ?? null,
        copyEnabled: w?.copyEnabled ?? null,   // null = no longer on watchlist
        openCount: open.length,
        closedCount: closed.length,
        winRate: closed.length >= 3 ? winners / closed.length : null,
        profitFactor: (closed.length >= 3 && grossLoss > 0) ? grossWin / grossLoss : null,
        netPnl,
        unrealizedPnl,
        avgEntryPrice,
        firstTrade: timestamps[0] ?? null,
        lastTrade: timestamps[timestamps.length - 1] ?? null,
      };
    }).sort((a, b) => b.netPnl - a.netPnl);
    res.json({ count: items.length, items });
  });

  // ── Risk metrics ──────────────────────────────────────────────────────────────
  app.get('/api/risk/metrics', (_req, res) => {
    const store = readStore();
    const DAY_MS = 86_400_000;
    const closed = store.closedTrades
      .filter(t => t.copiedTraderSource === 'watchlist' && t.closedAt != null)
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
