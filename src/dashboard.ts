import express from 'express';
import https from 'https';
import http from 'http';
import path from 'path';
import { readStore, setTraderExclusion, setAutoExclusion, setCategoryExclusion, setLeaderboardFilters, addWatchlistTrader, removeWatchlistTrader, setWatchlistCopyEnabled, setWatchlistCopyAmount } from './store';
import { refreshLeaderboard } from './leaderboard';
import { LeaderboardFilters } from './types';
import { DashboardStats } from './types';
import { CONFIG } from './config';
import { getTraderActivity, getGammaTrendingMarkets, RawGammaMarket, checkVpnConnectivity, RawActivityItem } from './bullpen';
import { detectCategory } from './categories';
import { tradeCostAdjustedPnl, tradeTotalCosts } from './simulator';

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

// In-memory cache for trader history (TTL: 5 min)
const statsCache = new Map<string, { data: unknown; ts: number }>();
const STATS_CACHE_TTL_MS = 5 * 60 * 1000;

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

// ── Container stats ────────────────────────────────────────────────────────
interface ContainerStat { name: string; cpuPct: number | null; ramMB: number | null; ramLimitMB: number | null; ramPct: number | null; }

async function fetchOneContainerStat(name: string): Promise<ContainerStat> {
  const s = await dockerGet(`/containers/${name}/stats?stream=false`) as Record<string, unknown> | null;
  if (!s) return { name, cpuPct: null, ramMB: null, ramLimitMB: null, ramPct: null };
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
    return { name, cpuPct, ramMB, ramLimitMB, ramPct };
  } catch {
    return { name, cpuPct: null, ramMB: null, ramLimitMB: null, ramPct: null };
  }
}

const MONITORED_CONTAINERS = ['gluetun', 'polymarket_bot'];
let containerStatsCache: { data: ContainerStat[]; ts: number } | null = null;
const CONTAINER_STATS_TTL_MS = 25_000;

// In-memory cache for trending markets (TTL: 5 min)
interface TrendingOutcome { name: string; price: number }
interface TrendingMarket {
  slug: string;
  title: string;
  category: string;
  volume24h: number;
  outcomes: TrendingOutcome[];
  url: string;
}
let trendingCache: { data: TrendingMarket[]; ts: number } | null = null;
const TRENDING_CACHE_TTL_MS = 5 * 60 * 1000;

function buildTrendingMarkets(markets: RawGammaMarket[]): TrendingMarket[] {
  const result: TrendingMarket[] = [];
  for (const m of markets) {
    // Parse outcomes and prices from JSON strings
    let outcomeNames: string[] = [];
    let outcomePrices: number[] = [];
    try { outcomeNames  = JSON.parse(m.outcomes ?? '[]'); }      catch {}
    try { outcomePrices = JSON.parse(m.outcomePrices ?? '[]').map(Number); } catch {}

    const outcomes: TrendingOutcome[] = [];
    const pairs = outcomeNames.map((name, i) => ({ name, price: outcomePrices[i] ?? 0 }));
    const yesOut = pairs.find(o => o.name === 'Yes');
    const noOut  = pairs.find(o => o.name === 'No');
    if (yesOut && noOut) {
      outcomes.push({ name: 'Yes', price: yesOut.price });
      outcomes.push({ name: 'No',  price: noOut.price  });
    } else {
      // Multi-outcome: top 2 by price
      for (const o of [...pairs].sort((a, b) => b.price - a.price).slice(0, 2)) {
        outcomes.push({ name: o.name, price: o.price });
      }
    }

    // Prefer event-level slug/title for the URL and display
    const event    = m.events?.[0];
    const urlSlug  = event?.slug ?? m.slug;
    const title    = event?.title ?? m.question;

    result.push({
      slug:      m.slug,
      title,
      category:  detectCategory(m.slug),
      volume24h: m.volume24hr ?? 0,
      outcomes,
      url: `https://polymarket.com/event/${urlSlug}`,
    });
  }
  return result;
}

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
  simClosed: Array<{ realizedPnl?: number | null; timestamp: string; closedAt?: string }>
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
  const winners7d = sim7d.filter(t => (t.realizedPnl ?? 0) > 0);
  const winRate7d = sim7d.length >= 2 ? winners7d.length / sim7d.length : null;

  const winners = simClosed.filter(t => (t.realizedPnl ?? 0) > 0);
  const losers  = simClosed.filter(t => (t.realizedPnl ?? 0) <= 0);
  const avgWin  = winners.length > 0 ? winners.reduce((s, t) => s + (t.realizedPnl ?? 0), 0) / winners.length : null;
  const avgLoss = losers.length  > 0 ? losers.reduce((s, t) => s + (t.realizedPnl ?? 0), 0) / losers.length  : null;

  return { hasEnoughData: true as const, tradeCount30d, winRate7d, avgWin, avgLoss, topCategory, histVol30d };
}

export function startDashboard(): void {
  const app = express();

  app.use(express.json());
  app.use(express.static(path.join(process.cwd(), 'public')));

  app.get('/api/stats', (req, res) => {
    const store = readStore();
    const source = String(req.query.source ?? '');

    let openTrades  = store.openTrades;
    let closedTrades = store.closedTrades;
    if (source === 'leaderboard') {
      openTrades   = openTrades.filter(t => t.copiedTraderSource !== 'watchlist');
      closedTrades = closedTrades.filter(t => t.copiedTraderSource !== 'watchlist');
    } else if (source === 'watchlist') {
      openTrades   = openTrades.filter(t => t.copiedTraderSource === 'watchlist');
      closedTrades = closedTrades.filter(t => t.copiedTraderSource === 'watchlist');
    }

    const realizedPnl = closedTrades.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
    const unrealizedPnl = openTrades.reduce((s, t) => s + (t.unrealizedPnl ?? 0), 0);
    const winners = closedTrades.filter(t => (t.realizedPnl ?? 0) > 0).length;
    const losers = closedTrades.filter(t => (t.realizedPnl ?? 0) <= 0).length;
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
      trackedTraders: store.trackedTraders.length,
      lastLeaderboardUpdate: store.lastLeaderboardUpdate,
      lastUpdated: new Date().toISOString(),
      totalRealizedPnlAdjusted:   realizedAdj,
      totalUnrealizedPnlAdjusted: unrealizedAdj,
      totalPnlAdjusted:           realizedAdj + unrealizedAdj,
      totalTradingCosts:          totalCosts,
      avgRawPnlPerTrade:          avgRawPnl,
      avgSlippagePerTrade:        avgSlippage,
      avgNetEdgePerTrade:         avgNetEdge,
    } as DashboardStats & { avgRawPnlPerTrade: number; avgSlippagePerTrade: number; avgNetEdgePerTrade: number };
    res.json({ ...stats, excludedCategories: store.excludedCategories ?? [] });
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
    if (source === 'leaderboard') {
      all = all.filter(t => t.copiedTraderSource !== 'watchlist');
    } else if (source === 'watchlist') {
      all = all.filter(t => t.copiedTraderSource === 'watchlist');
    }
    if (cutoff !== null) {
      all = all.filter(t => new Date(t.timestamp).getTime() >= cutoff!);
    }
    all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    res.json({ count: all.length, items: all });
  });

  app.get('/api/traders', (_req, res) => {
    const store = readStore();
    const excluded = new Set(store.excludedTraders);
    const cutoff = Date.now() - 30 * 86_400_000;

    // Aggregate shadow stats per trader address
    const shadowStatsMap: Record<string, { openCount: number; wins: number; losses: number; pnl: number; lastSeen?: string }> = {};
    for (const t of (store.shadowOpenTrades ?? [])) {
      const a = t.copiedTrader;
      shadowStatsMap[a] ||= { openCount: 0, wins: 0, losses: 0, pnl: 0 };
      shadowStatsMap[a].openCount++;
    }
    for (const t of (store.shadowClosedTrades ?? [])) {
      const a = t.copiedTrader;
      shadowStatsMap[a] ||= { openCount: 0, wins: 0, losses: 0, pnl: 0 };
      const pnl = t.realizedPnl ?? 0;
      if (pnl > 0) shadowStatsMap[a].wins++; else shadowStatsMap[a].losses++;
      shadowStatsMap[a].pnl += pnl;
      const ts = t.closedAt ?? t.timestamp;
      if (!shadowStatsMap[a].lastSeen || ts > shadowStatsMap[a].lastSeen!) shadowStatsMap[a].lastSeen = ts;
    }

    const items = store.trackedTraders.map(t => {
      const hist       = store.traderHistory?.[t.address];
      const histTrades = hist ? [...hist.buys, ...hist.sells] : [];

      // Active/inactive flag
      let inactive = false;
      if (histTrades.length > 0) {
        inactive = histTrades.filter(e => new Date(e.timestamp).getTime() >= cutoff).length < 3;
      } else {
        const lastSeen = store.traderLastSeen?.[t.address];
        if (lastSeen) inactive = new Date(lastSeen).getTime() < cutoff;
      }

      // Inline stats for the table row (win rate from simulated closed trades, category/volume from local history)
      const simClosed = store.closedTrades.filter(c => c.copiedTrader === t.address);
      const inlineStats = computeInlineStats(t.address, histTrades, simClosed);

      // All-time win rate from simulated closed trades.
      // Note: Polymarket's profile API always returns win_rate=null so we compute it ourselves.
      const simAllWinners = simClosed.filter(c => (c.realizedPnl ?? 0) > 0).length;
      const allTimeWinRate = simClosed.length >= 3 ? simAllWinners / simClosed.length : null;

      const shadowStats = shadowStatsMap[t.address];
      return { ...t, excluded: excluded.has(t.address), inactive, inlineStats, allTimeWinRate, shadowStats };
    });

    // Append auto-excluded traders at the bottom (not in trackedTraders, but still shown in UI)
    const threshold = CONFIG.AUTO_EXCLUDE_WIN_RATE_THRESHOLD;
    const autoExclItems = (store.autoExcludedTraders ?? []).map(addr => {
      const hist       = store.traderHistory?.[addr];
      const histTrades = hist ? [...hist.buys, ...hist.sells] : [];
      const simClosed  = store.closedTrades.filter(c => c.copiedTrader === addr);
      const inlineStats = computeInlineStats(addr, histTrades, simClosed);

      const simAllWinners = simClosed.filter(c => (c.realizedPnl ?? 0) > 0).length;
      const allTimeWinRate = simClosed.length >= 3 ? simAllWinners / simClosed.length : null;
      const realizedPnl = simClosed.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);

      const tradeWithName = store.closedTrades.find(t => t.copiedTrader === addr && t.copiedTraderUsername);

      // Falcon win rate from persistent cache (populated during leaderboard refresh)
      const falconWinRate = (store.traderFalconCache ?? {})[addr.toLowerCase()]?.winRate ?? null;

      // Recovery: 7d sim win rate back above threshold OR Falcon win rate >= 60%
      const current7dWr = inlineStats.hasEnoughData ? inlineStats.winRate7d : null;
      const recovered = (current7dWr != null && current7dWr >= threshold) ||
                        (falconWinRate != null && falconWinRate >= 0.6);

      return {
        address:          addr,
        username:         tradeWithName?.copiedTraderUsername ?? undefined,
        rank:             null,
        weeklyPnl:        null,
        excluded:         true,
        autoExcluded:     true,
        inactive:         false,
        inlineStats,
        allTimeWinRate,
        realizedPnl,
        recovered,
        excludeThreshold: threshold,
        falconWinRate,
        shadowStats:      shadowStatsMap[addr],
      };
    });

    res.json({ count: items.length, items: [...items, ...autoExclItems] });
  });

  app.post('/api/traders/:address/exclusion', (req, res) => {
    const { address } = req.params;
    const { excluded } = req.body as { excluded: boolean };
    if (typeof excluded !== 'boolean') {
      res.status(400).json({ error: 'excluded must be a boolean' });
      return;
    }
    if (excluded) {
      setTraderExclusion(address, true);
    } else {
      // Clear both manual and auto-exclusion so the trader can re-enter the leaderboard
      setAutoExclusion(address, false);
    }
    statsCache.delete(address);
    console.log(`[dashboard] Trader ${address.slice(0, 10)}... ${excluded ? 'excluded' : 'included (auto-exclusion cleared)'}`);
    res.json({ address, excluded });
  });

  app.post('/api/categories/exclusion', (req, res) => {
    const { category, excluded } = req.body as { category: string; excluded: boolean };
    if (typeof category !== 'string' || !category) {
      res.status(400).json({ error: 'category must be a non-empty string' });
      return;
    }
    if (typeof excluded !== 'boolean') {
      res.status(400).json({ error: 'excluded must be a boolean' });
      return;
    }
    setCategoryExclusion(category, excluded);
    console.log(`[dashboard] Category "${category}" ${excluded ? 'excluded' : 'included'} from trading`);
    res.json({ category, excluded });
  });

  app.get('/api/settings/leaderboard-filters', (_req, res) => {
    const store = readStore();
    res.json({
      filters: store.leaderboardFilters ?? { categories: [], minWinRate: 0, minTrades: 0, minSharpe: 0, minRoi: 0 },
      stats: store.lastLeaderboardStats ?? null,
    });
  });

  app.post('/api/settings/leaderboard-filters', (req, res) => {
    const { categories, minWinRate, minTrades, minSharpe, minRoi } = req.body as {
      categories?: unknown; minWinRate?: unknown; minTrades?: unknown;
      minSharpe?: unknown; minRoi?: unknown;
    };
    const filters: LeaderboardFilters = {
      categories: Array.isArray(categories)
        ? (categories as string[]).filter(c => typeof c === 'string' && c !== 'all')
        : [],
      minWinRate: typeof minWinRate === 'number' ? Math.max(0, Math.min(1, minWinRate)) : 0,
      minTrades:  typeof minTrades  === 'number' ? Math.max(0, Math.floor(minTrades))   : 0,
      minSharpe:  typeof minSharpe  === 'number' ? Math.max(0, minSharpe)               : 0,
      minRoi:     typeof minRoi     === 'number' ? Math.max(0, minRoi)                  : 0,
    };
    setLeaderboardFilters(filters);
    console.log(`[dashboard] Leaderboard filters updated:`, JSON.stringify(filters));
    // Trigger immediate refresh so filter takes effect without waiting 5 minutes
    refreshLeaderboard().catch(err =>
      console.error('[dashboard] Immediate leaderboard refresh failed:', err instanceof Error ? err.message : err)
    );
    res.json({ filters });
  });

  app.get('/api/markets/trending', async (_req, res) => {
    const now = Date.now();
    if (trendingCache && now - trendingCache.ts < TRENDING_CACHE_TTL_MS) {
      res.json({ items: trendingCache.data, fetchedAt: new Date(trendingCache.ts).toISOString(), cached: true });
      return;
    }
    try {
      const raw = await getGammaTrendingMarkets();
      const data = buildTrendingMarkets(raw);
      trendingCache = { data, ts: now };
      res.json({ items: data, fetchedAt: new Date(now).toISOString(), cached: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[dashboard] Trending markets fetch failed:', msg);
      // Return stale cache if available
      if (trendingCache) {
        res.json({ items: trendingCache.data, fetchedAt: new Date(trendingCache.ts).toISOString(), cached: true, stale: true });
      } else {
        // No cache yet — return empty list so dashboard shows graceful empty state instead of error
        res.json({ items: [], fetchedAt: new Date().toISOString(), cached: false, error: msg });
      }
    }
  });

  app.get('/api/traders/:address/history', async (req, res) => {
    const { address } = req.params;
    const cacheKey = address;

    const cached = statsCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < STATS_CACHE_TTL_MS) {
      res.json(cached.data);
      return;
    }

    try {
      const store = readStore();
      const localHist = store.traderHistory?.[address];
      const localHistoryCount = localHist ? localHist.buys.length + localHist.sells.length : 0;

      let trades: ActivityLike[];
      let source: 'local' | 'api';

      if (localHistoryCount > 0) {
        // Use accumulated local history — fast, no CLI call required
        trades = [...localHist!.buys, ...localHist!.sells];
        source = 'local';
      } else {
        // No local data yet — fall back to live API (last 100 trades)
        const activity = await getTraderActivity(address, 100);
        const raw = Array.isArray(activity) ? activity : [];
        trades = raw.filter(a => (a.type ?? '').toUpperCase() === 'TRADE');
        source = 'api';
      }

      const data = {
        ...computeTraderStats(address, trades),
        localHistoryCount,
        source,
      };
      statsCache.set(cacheKey, { data, ts: Date.now() });
      res.json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[dashboard] History fetch failed for ${address.slice(0, 10)}:`, msg);
      res.status(500).json({ error: msg });
    }
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

      const simAllWinners = simClosed.filter(c => (c.realizedPnl ?? 0) > 0).length;
      const allTimeWinRate = simClosed.length >= 3 ? simAllWinners / simClosed.length : null;
      const realizedPnl = simClosed.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
      const openPositions = store.openTrades.filter(t => t.copiedTrader === w.address).length;

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

      return { ...w, username: tradeWithName?.copiedTraderUsername, inlineStats, allTimeWinRate, realizedPnl, openPositions, recentTrades, traderStats };
    });

    // Watchlist-wide PNL totals (simulated)
    const totalRealizedPnl   = items.reduce((s, i) => s + (i.realizedPnl  ?? 0), 0);
    const totalUnrealizedPnl = store.openTrades
      .filter(t => t.copiedTraderSource === 'watchlist')
      .reduce((s, t) => s + (t.unrealizedPnl ?? 0), 0);

    res.json({ count: items.length, items, totalRealizedPnl, totalUnrealizedPnl });
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
      const data = { totalPositions, openPositions, closedPositions, totalInvested, realizedPnl, winCount, lossCount, winRate };
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

  app.listen(CONFIG.PORT, '0.0.0.0', () => {
    console.log(`[dashboard] Web UI → http://localhost:${CONFIG.PORT}`);
  });
}
