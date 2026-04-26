import { getLeaderboard, getTraderActivity, getFalconLeaderboard, RawActivityItem, RawLeaderboardItem, RawLeaderboardResponse, RawFalconTrader } from './bullpen';
import { updateTrackedTraders, updateTraderLastOnLeaderboard, readStore, setAutoExclusion, setLeaderboardStats, appendTraderHistory, updateWatchlistFalconData, updateTraderFalconCache } from './store';
import { LeaderboardTrader, TradesStore, TraderHistoryEntry, SimulatedTrade } from './types';
import { CONFIG } from './config';
import { detectCategory } from './categories';

function normalize(item: RawLeaderboardItem, fallbackRank: number): LeaderboardTrader {
  return {
    rank: typeof item.rank === 'number' ? item.rank : fallbackRank,
    address: item.address,
    username: item.username,
    weeklyPnl: Number(item.pnl ?? 0),
    totalVolume: item.volume != null ? Number(item.volume) : undefined,
  };
}

function isRecentlyActive(address: string, store: TradesStore): boolean {
  const cutoff = Date.now() - 30 * 86_400_000;
  const hist = store.traderHistory?.[address];
  if (hist && (hist.buys.length + hist.sells.length) > 0) {
    return [...hist.buys, ...hist.sells].filter(t => new Date(t.timestamp).getTime() >= cutoff).length >= 3;
  }
  const lastSeen = store.traderLastSeen?.[address];
  if (lastSeen) return new Date(lastSeen).getTime() >= cutoff;
  return true; // no data → assume active
}

// Compute win-rate for trades closed after `cutoff` for a given trader.
// Returns null if fewer than AUTO_EXCLUDE_MIN_TRADES — caller decides fallback.
function winRateSince(
  trades: SimulatedTrade[] | undefined,
  addr: string,
  cutoff: number,
): { n: number; winners: number; winRate: number } | null {
  if (!trades || trades.length === 0) return null;
  const recent = trades.filter(t =>
    t.copiedTrader === addr &&
    new Date(t.closedAt ?? t.timestamp).getTime() >= cutoff
  );
  if (recent.length < CONFIG.AUTO_EXCLUDE_MIN_TRADES) return null;
  // Use costAdjustedPnl: a trade with raw +$0.05 but -$0.15 net is a loss
  // in live trading, so it must not count as a "winner" toward the gate.
  // Fall back to realizedPnl for legacy rows that lack the field.
  const winners = recent.filter(t => (t.costAdjustedPnl ?? t.realizedPnl ?? 0) > 0).length;
  return { n: recent.length, winners, winRate: winners / recent.length };
}

// Prefer real closed trades; fall back to shadow when real sample is thin.
// This lets us evaluate traders we haven't copied yet using our filtered-signal
// shadow book, and un-block traders that were auto-excluded before the
// SQLite cutover erased their real-trade history.
function sampledWinRate(
  store: TradesStore,
  addr: string,
  cutoff: number,
): { n: number; winners: number; winRate: number; source: 'real' | 'shadow' } | null {
  const real = winRateSince(store.closedTrades, addr, cutoff);
  if (real) return { ...real, source: 'real' };
  const shadow = winRateSince(store.shadowClosedTrades, addr, cutoff);
  if (shadow) return { ...shadow, source: 'shadow' };
  return null;
}

export function checkAutoExclusion(
  traders: LeaderboardTrader[],
  falconByAddress: Map<string, RawFalconTrader>
): void {
  const threshold = CONFIG.AUTO_EXCLUDE_WIN_RATE_THRESHOLD;
  if (!threshold || threshold <= 0) return;

  const store = readStore();
  const cutoff = Date.now() - 7 * 86_400_000;
  const autoExcluded = new Set(store.autoExcludedTraders ?? []);
  // Addresses manually excluded (not by the auto system) — leave them alone
  const manuallyExcluded = new Set(
    store.excludedTraders.filter(a => !autoExcluded.has(a))
  );
  // Watchlist traders are manually curated — never auto-exclude them
  const watchlistAddrs = new Set(
    (store.watchlistTraders ?? []).map(w => w.address.toLowerCase())
  );

  // ── 1. Check tracked traders for new auto-exclusions ──────────────────────
  for (const trader of traders) {
    const addr = trader.address;
    if (manuallyExcluded.has(addr)) continue;
    if (watchlistAddrs.has(addr.toLowerCase())) continue;
    if (autoExcluded.has(addr)) continue;

    const sample = sampledWinRate(store, addr, cutoff);
    if (!sample) continue;

    if (sample.winRate < threshold) {
      setAutoExclusion(addr, true);
      const name = trader.username ?? addr.slice(0, 10) + '...';
      const wrPct  = (sample.winRate * 100).toFixed(1);
      const thrPct = (threshold * 100).toFixed(1);
      console.warn(
        `[leaderboard] Auto-excluded ${name} — 7d ${sample.source} win rate ${wrPct}% < ${thrPct}%` +
        ` (${sample.winners}W/${sample.n - sample.winners}L over ${sample.n} trades)`
      );
    }
  }

  // ── 2. Check auto-excluded traders for recovery ────────────────────────────
  // Recovery criteria (either sufficient):
  //   a) 7d simulated win rate >= threshold (real if available, else shadow)
  //   b) Falcon win rate >= 80% when we have NO sim data at all
  for (const addr of [...autoExcluded]) {
    const sample = sampledWinRate(store, addr, cutoff);

    const falconEntry   = falconByAddress.get(addr.toLowerCase());
    const falconWinRate = falconEntry?.win_rate
      ?? (store.traderFalconCache?.[addr.toLowerCase()]?.winRate ?? null);

    // Recovery — prefer SIMULATED win rate when any real or shadow sample exists.
    // Falcon WR (≥0.80) is only a tiebreaker when we have no sim data in either
    // book, preventing the churn loop where a long-term Falcon WR re-includes
    // a trader with a failing simulated record.
    const simRecovered = sample !== null && sample.winRate >= threshold;
    const falconOnlyRecovered = sample === null && falconWinRate !== null && falconWinRate >= 0.80;
    const recovered = simRecovered || falconOnlyRecovered;

    if (recovered) {
      setAutoExclusion(addr, false);
      const parts: string[] = [];
      if (sample !== null) parts.push(`sim 7d ${sample.source} WR ${(sample.winRate * 100).toFixed(1)}% over ${sample.n}`);
      if (falconWinRate !== null) parts.push(`Falcon WR ${(falconWinRate * 100).toFixed(1)}%`);
      console.log(
        `[leaderboard] Auto-re-included ${addr.slice(0, 10)}... — recovered (${parts.join(', ')})` +
        ` — eligible at next leaderboard refresh`
      );
    }
  }
}

const CANDIDATE_LIMIT = 50; // API hard cap — returns at most 50 regardless of higher limits
const HISTORY_BATCH_SIZE = 10;
const HISTORY_FETCH_LIMIT = 100;

function getTopCategory(address: string, store: TradesStore): string | null {
  const hist = store.traderHistory?.[address];
  if (!hist || hist.buys.length < 5) return null;
  const cut30d = Date.now() - 30 * 86_400_000;
  const catCounts: Record<string, number> = {};
  for (const t of hist.buys) {
    if (new Date(t.timestamp).getTime() < cut30d) continue;
    const cat = detectCategory(t.slug ?? '');
    catCounts[cat] = (catCounts[cat] ?? 0) + 1;
  }
  const top = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

function getSimWinRate(address: string, store: TradesStore): number | null {
  const closed = store.closedTrades.filter(t => t.copiedTrader === address);
  if (closed.length < 3) return null;
  return closed.filter(t => (t.realizedPnl ?? 0) > 0).length / closed.length;
}

function get30dTradeCount(address: string, store: TradesStore): number {
  const cut30d = Date.now() - 30 * 86_400_000;
  const hist = store.traderHistory?.[address];
  if (!hist) return 0;
  return [...hist.buys, ...hist.sells].filter(t =>
    (t.type ?? '').toUpperCase() === 'TRADE' &&
    new Date(t.timestamp).getTime() >= cut30d
  ).length;
}

export async function refreshLeaderboard(): Promise<LeaderboardTrader[]> {
  console.log(`[leaderboard] Fetching leaderboard (Falcon 30d primary, Bullpen weekly fallback)...`);

  // Falcon 30d is the primary discovery source. Bullpen weekly is fetched in parallel
  // and used as a supplement (or sole source if Falcon is unavailable).
  const [bullpenResponse, falconRaw] = await Promise.all([
    getLeaderboard(CANDIDATE_LIMIT).catch((err: unknown) => {
      console.warn('[leaderboard] Bullpen API unavailable:', err instanceof Error ? err.message : err);
      return [] as RawLeaderboardResponse;
    }),
    getFalconLeaderboard().catch((err: unknown) => {
      console.warn('[leaderboard] Falcon API unavailable:', err instanceof Error ? err.message : err);
      return [] as RawFalconTrader[];
    }),
  ]);

  if (falconRaw.length > 0) {
    console.log(`[leaderboard] Falcon 30d returned ${falconRaw.length} traders`);
  }

  // Build Falcon lookup keyed by lowercase address for enrichment
  const falconByAddress = new Map<string, RawFalconTrader>();
  for (const f of falconRaw) {
    if (f.address) falconByAddress.set(f.address.toLowerCase(), f);
  }

  // Update watchlist traders + persist Falcon win rates for ALL traders (incl. auto-excluded)
  if (falconByAddress.size > 0) {
    const storeForWatchlist = readStore();
    for (const w of storeForWatchlist.watchlistTraders ?? []) {
      const f = falconByAddress.get(w.address.toLowerCase());
      if (f) {
        updateWatchlistFalconData(w.address, {
          falconWinRate: f.win_rate,
          falconRoi:     f.roi != null ? f.roi * 100 : undefined,
          falconSharpe:  f.sharpe_ratio,
        });
      }
    }
    // Persist win rates so auto-excluded traders can be evaluated for recovery
    const falconCacheUpdate: Record<string, { winRate?: number }> = {};
    for (const [addr, f] of falconByAddress) {
      if (f.win_rate != null) falconCacheUpdate[addr] = { winRate: f.win_rate };
    }
    if (Object.keys(falconCacheUpdate).length > 0) updateTraderFalconCache(falconCacheUpdate);
  }

  const bullpenRaw = (
    Array.isArray(bullpenResponse)
      ? bullpenResponse
      : ((bullpenResponse as { items?: RawLeaderboardItem[]; data?: RawLeaderboardItem[] }).items
         ?? (bullpenResponse as { items?: RawLeaderboardItem[]; data?: RawLeaderboardItem[] }).data
         ?? [])
  ) as RawLeaderboardItem[];

  // ── Candidate list: Falcon 30d primary, Bullpen weekly as fallback/supplement ──
  // If Falcon has data: Falcon 30d addresses lead (consistent long-term performers),
  // followed by any Bullpen-only traders not already in the Falcon list.
  // If Falcon is unavailable: fall back to Bullpen weekly only (existing behaviour).
  let raw: RawLeaderboardItem[];
  if (falconRaw.length > 0) {
    const falconAddrSet = new Set(falconRaw.map(f => f.address.toLowerCase()));
    // Convert Falcon entries to RawLeaderboardItem; carry total_pnl as pnl for display
    const falconItems: RawLeaderboardItem[] = falconRaw.map(f => ({
      address: f.address,
      pnl:     f.total_pnl != null ? String(f.total_pnl) : undefined,
    }));
    // Supplement with Bullpen-only traders (strong weekly performers not caught by 30d list)
    const bullpenOnly = bullpenRaw.filter(r => !falconAddrSet.has(r.address.toLowerCase()));
    raw = [...falconItems, ...bullpenOnly];
    console.log(`[leaderboard] Candidate list: ${falconItems.length} Falcon 30d + ${bullpenOnly.length} Bullpen-only supplement`);
  } else {
    raw = bullpenRaw;
    console.log(`[leaderboard] Falcon unavailable — using Bullpen weekly only (${bullpenRaw.length} candidates)`);
  }
  if (raw.length === 0) {
    console.warn('[leaderboard] No traders returned — check bullpen auth and connectivity');
    return [];
  }

  // Stamp all candidates as "seen on leaderboard" for retention tracking
  updateTraderLastOnLeaderboard(raw.map(r => r.address));

  // ── Batch-fetch history for all candidates ────────────────────────────────
  // Fetch in batches of HISTORY_BATCH_SIZE to populate traderHistory for all
  // candidates before filter evaluation (category / min-trades filters need it).
  {
    const storeForSince = readStore();
    console.log(`[leaderboard] Fetching history for ${raw.length} candidates (batches of ${HISTORY_BATCH_SIZE})...`);
    for (let i = 0; i < raw.length; i += HISTORY_BATCH_SIZE) {
      const batch = raw.slice(i, i + HISTORY_BATCH_SIZE);
      await Promise.all(batch.map(async (item) => {
        const address = item.address;
        const since = storeForSince.traderHistory?.[address]?.lastFetched;
        try {
          // Fetch all trades (incremental via since) + sell-only (no since, to capture
          // sells that fall outside the all-trades fetch window) in parallel.
          const [allActivity, sellActivity] = await Promise.all([
            getTraderActivity(address, HISTORY_FETCH_LIMIT, since),
            getTraderActivity(address, HISTORY_FETCH_LIMIT, undefined, 'sell'),
          ]);

          // Merge by transaction_hash — sells-only call fills in older sells
          const seen = new Map<string, RawActivityItem>();
          for (const r of [...(Array.isArray(allActivity) ? allActivity : []), ...(Array.isArray(sellActivity) ? sellActivity : [])]) {
            const hash = String(r.transaction_hash ?? '');
            if (hash && !seen.has(hash)) seen.set(hash, r);
          }

          const entries: TraderHistoryEntry[] = Array.from(seen.values())
            .filter(r => String(r.transaction_hash ?? '').length > 0)
            .map(r => ({
              transaction_hash: String(r.transaction_hash!),
              timestamp:        String(r.timestamp ?? ''),
              slug:             String(r.slug ?? ''),
              title:            r.title   != null ? String(r.title)   : undefined,
              outcome:          r.outcome != null ? String(r.outcome) : undefined,
              side:             String(r.side ?? ''),
              type:             String(r.type ?? ''),
              price:            r.price   != null ? Number(r.price)   : undefined,
              size:             r.size    != null ? Number(r.size)    : undefined,
            }));
          appendTraderHistory(address, entries);
        } catch (err) {
          console.warn(
            `[leaderboard] History fetch failed for ${address.slice(0, 10)}...:`,
            err instanceof Error ? err.message : err
          );
        }
      }));
    }
    console.log(`[leaderboard] History fetch complete.`);
  }

  const store = readStore(); // re-read to include freshly appended history
  const filters = store.leaderboardFilters ?? { categories: [], minWinRate: 0, minTrades: 0, minSharpe: 0, minRoi: 0 };
  const catFilters = Array.isArray(filters.categories)
    ? filters.categories.filter(c => c && c !== 'all')
    : [];
  const minWinRate = filters.minWinRate > 0 ? filters.minWinRate : null;
  const minTrades  = filters.minTrades  > 0 ? filters.minTrades  : null;
  const minSharpe  = (filters.minSharpe  ?? 0) > 0 ? (filters.minSharpe  ?? 0) : null;
  const minRoi     = (filters.minRoi     ?? 0) > 0 ? (filters.minRoi     ?? 0) : null;

  const autoExcludedSet = new Set(store.autoExcludedTraders ?? []);

  const traders: LeaderboardTrader[] = [];
  let rank = 1;
  let candidatesChecked = 0;

  for (const item of raw) {
    if (traders.length >= CONFIG.LEADERBOARD_LIMIT) break;
    candidatesChecked++;
    const trader = normalize(item, rank);
    const name = trader.username ?? trader.address.slice(0, 10) + '...';

    // 0. Auto-exclusion — permanently skip until manually re-included via dashboard
    if (autoExcludedSet.has(trader.address)) {
      console.log(`[leaderboard] Skipping ${name} — previously auto-excluded`);
      continue;
    }

    // 1. Activity filter
    if (!isRecentlyActive(trader.address, store)) {
      console.log(`[leaderboard] Skip ${name} — no activity in last 30 days`);
      continue;
    }

    // 2. Category filter (skip if no local history yet)
    if (catFilters.length > 0) {
      const topCat = getTopCategory(trader.address, store);
      if (topCat !== null && !catFilters.includes(topCat)) {
        console.log(`[leaderboard] Skip ${name} — top category "${topCat}" not in [${catFilters.join(', ')}]`);
        continue;
      }
    }

    // 3. Min win rate filter (skip if insufficient sim data)
    if (minWinRate !== null) {
      const wr = getSimWinRate(trader.address, store);
      if (wr !== null && wr < minWinRate) {
        console.log(`[leaderboard] Skip ${name} — sim win rate ${(wr * 100).toFixed(0)}% < ${(minWinRate * 100).toFixed(0)}%`);
        continue;
      }
    }

    // 4. Min trades filter
    if (minTrades !== null) {
      const tc = get30dTradeCount(trader.address, store);
      if (tc < minTrades) {
        console.log(`[leaderboard] Skip ${name} — ${tc} trades in 30d < ${minTrades}`);
        continue;
      }
    }

    // 5. Min Sharpe filter (Falcon data required — only applied when Falcon has data for this trader)
    if (minSharpe !== null) {
      const f = falconByAddress.get(trader.address.toLowerCase());
      if (f !== undefined && (f.sharpe_ratio ?? -Infinity) < minSharpe) {
        console.log(`[leaderboard] Skip ${name} — Falcon Sharpe ${(f.sharpe_ratio ?? 0).toFixed(2)} < ${minSharpe}`);
        continue;
      }
    }

    // 6. Min ROI filter (Falcon roi is a fraction — compare after converting to percentage)
    if (minRoi !== null) {
      const f = falconByAddress.get(trader.address.toLowerCase());
      if (f !== undefined) {
        const roiPct = f.roi != null ? f.roi * 100 : -Infinity;
        if (roiPct < minRoi) {
          console.log(`[leaderboard] Skip ${name} — Falcon ROI ${roiPct.toFixed(1)}% < ${minRoi}%`);
          continue;
        }
      }
    }

    // Attach Falcon metrics (roi stored as percentage for display consistency)
    const falconData = falconByAddress.get(trader.address.toLowerCase());
    if (falconData) {
      if (falconData.win_rate     != null) trader.falconWinRate = falconData.win_rate;
      if (falconData.roi          != null) trader.falconRoi     = falconData.roi * 100; // convert fraction → %
      if (falconData.sharpe_ratio != null) trader.falconSharpe  = falconData.sharpe_ratio;
    }

    trader.rank = rank;
    traders.push(trader);
    rank++;
  }

  if (traders.length === 0) {
    console.warn('[leaderboard] All candidates filtered — keeping previous trader list');
    setLeaderboardStats({
      candidatesChecked,
      passedFilters: 0,
      trackedCount: 0,
      filters,
      updatedAt: new Date().toISOString(),
    });
    return [];
  }

  updateTrackedTraders(traders);
  setLeaderboardStats({
    candidatesChecked,
    passedFilters: traders.length,
    trackedCount: traders.length,
    filters,
    updatedAt: new Date().toISOString(),
  });

  console.log(`[leaderboard] Tracking ${traders.length} traders (${candidatesChecked} candidates checked):`);
  for (const t of traders) {
    const name = t.username ?? t.address.slice(0, 10) + '...';
    console.log(`  #${t.rank} ${name}  weekly PNL: $${t.weeklyPnl.toFixed(2)}`);
  }

  checkAutoExclusion(traders, falconByAddress);
  return traders;
}
