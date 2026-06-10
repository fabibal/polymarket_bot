/**
 * Polls a single trader's recent activity.
 * - BUY  → create a new simulated $5 position (subject to price/spread filters)
 * - SELL → close the oldest matching open position at sell price (realized PNL)
 */
import { getTraderActivity, getOrderbookDepth, RawActivityItem } from './bullpen';
import { readStore, addOpenTrade, closeOpenTrade, markProcessed, setTraderLastSeen, appendTraderHistory, addSkippedTrade } from './store';
import { LeaderboardTrader, ActivityTrade, SimulatedTrade, TraderHistoryEntry } from './types';
import { CONFIG } from './config';
import { countWatchlistEntriesInWindow } from './filters';
import { computeEntryCosts } from './simulator';
import { v4 as uuidv4 } from 'uuid';

// Per-cycle skip-log dedup. Same market_slug fires repeatedly across traders
// and Yes/No outcomes, flooding logs. Cleared at the start of each poll cycle.
const loggedSkipsThisCycle = new Set<string>();
export function resetSkipDedup(): void { loggedSkipsThisCycle.clear(); }
function logSkipOnce(key: string, msg: string): void {
  if (loggedSkipsThisCycle.has(key)) return;
  loggedSkipsThisCycle.add(key);
  console.log(msg);
}

function parseActivity(raw: RawActivityItem): ActivityTrade | null {
  // Only process TRADE type items
  if (String(raw.type ?? '').toUpperCase() !== 'TRADE') return null;

  const side = String(raw.side ?? '').toLowerCase();
  if (side !== 'buy' && side !== 'sell') return null;

  const price = Number(raw.price);
  if (!price || price <= 0 || price > 1) return null;

  const id = String(raw.transaction_hash ?? '');
  if (!id) return null;

  const timestamp = String(raw.timestamp ?? new Date().toISOString());
  const marketSlug = String(raw.slug ?? '');
  if (!marketSlug) return null;

  // No outcome → skip. Defaulting to 'Yes' (the old behavior) could open a
  // position on the wrong side or close the wrong side's position on SELL.
  const outcome = raw.outcome != null ? String(raw.outcome).trim() : '';
  if (!outcome) {
    console.warn(`[monitor] Skipping trade ${id} on ${marketSlug} — missing outcome field`);
    return null;
  }
  const size = Number(raw.size ?? 0);

  const marketTitle = String(raw.title ?? marketSlug);
  return { id, timestamp, marketSlug, marketTitle, outcome, side: side as 'buy' | 'sell', price, size };
}

export async function pollTrader(
  trader: LeaderboardTrader,
  options: { copyEnabled?: boolean; source?: 'leaderboard' | 'watchlist'; tradeAmount?: number } = {}
): Promise<number> {
  const copyEnabled  = options.copyEnabled !== false; // default true
  const tradeAmount  = options.tradeAmount ?? CONFIG.TRADE_AMOUNT;
  const isWatchlist  = options.source === 'watchlist';
  const store = readStore();
  const since = store.traderLastSeen[trader.address];

  let response;
  try {
    response = await getTraderActivity(trader.address, CONFIG.ACTIVITY_LIMIT, since);
  } catch (err) {
    console.error(`[monitor] Poll failed for ${trader.address.slice(0, 10)}...:`, err instanceof Error ? err.message : err);
    return 0;
  }

  const items = Array.isArray(response) ? response : [];
  if (items.length === 0) return 0;

  // Persist ALL fetched TRADE items to local history before processing
  const historyEntries: TraderHistoryEntry[] = items
    .filter(raw => String(raw.transaction_hash ?? '').length > 0)
    .map(raw => ({
      transaction_hash: String(raw.transaction_hash!),
      timestamp:        String(raw.timestamp ?? ''),
      slug:             String(raw.slug ?? ''),
      title:            raw.title  != null ? String(raw.title)   : undefined,
      outcome:          raw.outcome != null ? String(raw.outcome) : undefined,
      side:             String(raw.side ?? ''),
      type:             String(raw.type ?? ''),
      price:            raw.price != null ? Number(raw.price) : undefined,
      size:             raw.size  != null ? Number(raw.size)  : undefined,
    }));
  appendTraderHistory(trader.address, historyEntries);

  const processedIds = new Set(store.processedTradeIds);
  let newTrades = 0;
  let latestTimestamp = since;

  // Process oldest-first. The API returns newest-first, which ran a SELL before
  // its BUY when both landed in the same poll window — the close found no open
  // position, the SELL was marked processed and lost, and the position lingered
  // until threshold resolution or expiry.
  for (const raw of [...items].reverse()) {
    // Advance the cursor from every item (TRADE, REDEEM, MERGE, etc.)
    const rawTs = String(raw.timestamp ?? '');
    if (rawTs && (!latestTimestamp || rawTs > latestTimestamp)) {
      latestTimestamp = rawTs;
    }

    const activity = parseActivity(raw);
    if (!activity) continue;

    if (processedIds.has(activity.id)) continue;
    processedIds.add(activity.id);

    // ── Staleness filter ────────────────────────────────────────────────────
    // Skip activities older than 7 days — prevents historical Polymarket data
    // from generating simulated trades on first poll of a new trader.
    const activityAgeMs = Date.now() - new Date(activity.timestamp).getTime();
    if (activityAgeMs > 7 * 86_400_000) {
      markProcessed(activity.id);
      continue;
    }

    // ── Copy-disabled: advance cursor and mark processed, skip simulation ──
    if (!copyEnabled) {
      markProcessed(activity.id);
      continue;
    }

    if (activity.side === 'buy') {
      // ── Per-trader longshot carve-out (NARROW exception to "watchlist bypasses
      // all filters", added 2026-06-09) ── For one specific trader, refuse BUYs
      // priced below LONGSHOT_FILTER_MAX_PRICE and record the would-be entry in
      // skipped_trades for monitoring. See CLAUDE.md "Key rules".
      if (
        trader.address.toLowerCase() === CONFIG.LONGSHOT_FILTER_TRADER &&
        activity.price < CONFIG.LONGSHOT_FILTER_MAX_PRICE
      ) {
        addSkippedTrade({
          sourceTradeId:        activity.id,
          timestamp:            activity.timestamp,
          copiedTrader:         trader.address,
          copiedTraderUsername: trader.username,
          marketSlug:           activity.marketSlug,
          marketTitle:          activity.marketTitle,
          outcome:              activity.outcome,
          entryPrice:           activity.price,
          simulatedAmount:      tradeAmount,
          simulatedShares:      tradeAmount / activity.price,
          skipReason:           'longshot_filter_0x12d6',
        });
        console.log(
          `[monitor] skip ${activity.marketSlug} entry=${activity.price.toFixed(3)} ` +
          `trader=0x12d6 reason=longshot_filter`
        );
        markProcessed(activity.id);
        continue;
      }

      const currentStore = readStore();

      // ── Watchlist-only: per-market entry cap within a rolling window ──
      // Watchlist bypasses MAX_POSITIONS_PER_MARKET, but rapid BUY-SELL-BUY cycles
      // on fast sports/tennis markets still drag PnL. Counts both open and closed
      // watchlist entries on this slug within the window.
      if (isWatchlist) {
        const watchlistEntries = countWatchlistEntriesInWindow(
          currentStore.openTrades,
          currentStore.closedTrades,
          activity.marketSlug,
          Date.now(),
          CONFIG.MAX_WATCHLIST_ENTRY_WINDOW_MS,
        );
        if (watchlistEntries >= CONFIG.MAX_WATCHLIST_ENTRIES_PER_MARKET) {
          const windowH = Math.round(CONFIG.MAX_WATCHLIST_ENTRY_WINDOW_MS / 3600000);
          console.log(
            `[monitor] Skip BUY ${activity.marketSlug} — watchlist entry cap ${CONFIG.MAX_WATCHLIST_ENTRIES_PER_MARKET}/${windowH}h reached (n=${watchlistEntries})`
          );
          markProcessed(activity.id);
          continue;
        }
      }

      // ── Simulated wallet cap (applies to BOTH watchlist and leaderboard) ──
      // Models a fixed-size real wallet. When sum of open simulatedAmount reaches
      // SIMULATED_WALLET_SIZE * WALLET_CAP_UTILIZATION, refuse new BUYs.
      if (CONFIG.SIMULATED_WALLET_SIZE > 0) {
        const inUse = currentStore.openTrades.reduce(
          (s, t) => s + (t.simulatedAmount ?? CONFIG.TRADE_AMOUNT), 0
        );
        const cap = CONFIG.SIMULATED_WALLET_SIZE * CONFIG.WALLET_CAP_UTILIZATION;
        if (inUse + tradeAmount > cap) {
          console.log(
            `[monitor] Skip BUY ${activity.marketSlug} — wallet_cap: ` +
            `$${inUse.toFixed(0)}/$${CONFIG.SIMULATED_WALLET_SIZE} in use ` +
            `(cap $${cap.toFixed(0)} @ ${(CONFIG.WALLET_CAP_UTILIZATION * 100).toFixed(0)}%)`
          );
          markProcessed(activity.id);
          continue;
        }
      }

      // Depth gate: fetch CLOB orderbook BEFORE creating the trade so we can
      // skip thin books. Non-blocking — depth fetch failure falls through to copy.
      let watchlistDepth: Awaited<ReturnType<typeof getOrderbookDepth>> = null;
      if (isWatchlist) {
        watchlistDepth = await getOrderbookDepth(activity.marketSlug, activity.outcome);
        if (watchlistDepth && watchlistDepth.askDepth5 < CONFIG.DEPTH_GATE_MIN_DEPTH_5) {
          console.log(
            `[monitor] Skip BUY ${activity.marketSlug} — depth_gate: ` +
            `ask_depth_5=$${watchlistDepth.askDepth5.toFixed(0)} below ` +
            `$${CONFIG.DEPTH_GATE_MIN_DEPTH_5} threshold`
          );
          markProcessed(activity.id);
          continue;
        }
      }

      const shares = tradeAmount / activity.price;
      const entryCosts = computeEntryCosts(activity.price, shares);
      const trade: SimulatedTrade = {
        id: uuidv4(),
        sourceTradeId: activity.id,
        timestamp: activity.timestamp,
        copiedTrader: trader.address,
        copiedTraderRank: trader.rank,
        copiedTraderUsername: trader.username,
        copiedTraderSource: 'watchlist',
        marketSlug: activity.marketSlug,
        marketTitle: activity.marketTitle,
        outcome: activity.outcome,
        side: 'buy',
        entryPrice: activity.price,
        simulatedAmount: tradeAmount,
        simulatedShares: shares,
        currentPrice: activity.price,
        unrealizedPnl: 0,
        status: 'open',
        entryGasCost:      entryCosts.gas,
        entrySlippageCost: entryCosts.slippage,
      };
      // Watchlist BUYs: persist the depth snapshot fetched above for the gate check.
      if (isWatchlist) {
        if (watchlistDepth) {
          trade.bestAsk = watchlistDepth.bestAsk;
          trade.bestBid = watchlistDepth.bestBid;
          trade.askDepth5 = watchlistDepth.askDepth5;
          trade.askDepth10 = watchlistDepth.askDepth10;
          trade.spreadAtEntry = watchlistDepth.spread;
          trade.depthBackfilled = false;
          console.log(
            `[depth] ${activity.marketSlug} ${activity.outcome} ` +
            `ask=${watchlistDepth.bestAsk.toFixed(3)} bid=${watchlistDepth.bestBid.toFixed(3)} ` +
            `spr=${watchlistDepth.spread.toFixed(3)} d5=$${watchlistDepth.askDepth5.toFixed(0)} d10=$${watchlistDepth.askDepth10.toFixed(0)}`
          );
        } else {
          console.log(`[depth] ${activity.marketSlug} ${activity.outcome} — orderbook fetch failed (gate bypassed)`);
        }
      }
      addOpenTrade(trade);
      newTrades++;
      const srcTag = isWatchlist ? '[WL]' : '[DRY_RUN]';
      console.log(
        `${srcTag} BUY  ${activity.marketTitle.slice(0, 40).padEnd(40)} | ` +
        `${activity.outcome.padEnd(4)} @ $${activity.price.toFixed(3)} | ` +
        `$${tradeAmount} → ${shares.toFixed(2)} shares | ` +
        `${trader.username ?? trader.address.slice(0, 8) + '...'} (#${trader.rank})`
      );
    } else {
      // SELL: close the oldest matching simulated position.
      const closed = closeOpenTrade(trader.address, activity.marketSlug, activity.outcome, activity.price);
      markProcessed(activity.id);
      if (closed) {
        newTrades++;
        console.log(
          `[WL] SELL ${activity.marketTitle.slice(0, 40).padEnd(40)} | ` +
          `${activity.outcome.padEnd(4)} @ $${activity.price.toFixed(3)} | ` +
          `${trader.username ?? trader.address.slice(0, 8) + '...'} (#${trader.rank})`
        );
      }
    }
  }

  if (latestTimestamp && latestTimestamp !== since) {
    setTraderLastSeen(trader.address, latestTimestamp);
  }

  return newTrades;
}
