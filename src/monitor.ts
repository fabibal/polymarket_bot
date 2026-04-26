/**
 * Polls a single trader's recent activity.
 * - BUY  → create a new simulated $5 position (subject to price/spread filters)
 * - SELL → close the oldest matching open position at sell price (realized PNL)
 */
import { getTraderActivity, getMarketPrice, RawActivityItem, RawPriceResponse } from './bullpen';
import { readStore, addOpenTrade, closeOpenTrade, markProcessed, setTraderLastSeen, appendTraderHistory, addShadowOpenTrade, closeShadowOpenTrade, markShadowProcessed, setShadowLastSeen } from './store';
import { LeaderboardTrader, ActivityTrade, SimulatedTrade, TraderHistoryEntry } from './types';
import { CONFIG } from './config';
import { detectCategory } from './categories';
import { countWatchlistEntriesInWindow } from './filters';
import { computeEntryCosts } from './simulator';
import { v4 as uuidv4 } from 'uuid';

export function hasSufficientSample(
  realClosed: number,
  shadowClosed: number,
  realThreshold: number = CONFIG.MIN_TRADER_SAMPLE,
  shadowThreshold: number = CONFIG.MIN_TRADER_SHADOW_SAMPLE,
): { passes: boolean; via: 'real' | 'shadow' | null } {
  if (realClosed >= realThreshold) return { passes: true, via: 'real' };
  if (shadowClosed >= shadowThreshold) return { passes: true, via: 'shadow' };
  return { passes: false, via: null };
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

  const outcome = String(raw.outcome ?? 'Yes');
  const size = Number(raw.size ?? 0);

  const marketTitle = String(raw.title ?? marketSlug);
  return { id, timestamp, marketSlug, marketTitle, outcome, side: side as 'buy' | 'sell', price, size };
}

function getOutcomeSpread(data: RawPriceResponse, outcome: string): number | null {
  if (!Array.isArray(data.outcomes)) return null;
  const entry = data.outcomes.find(o => o.outcome.toLowerCase() === outcome.toLowerCase());
  if (!entry) return null;
  if (typeof entry.spread === 'number') return entry.spread;
  if (typeof entry.best_ask === 'number' && typeof entry.best_bid === 'number') {
    return entry.best_ask - entry.best_bid;
  }
  return null;
}

export async function pollTrader(
  trader: LeaderboardTrader,
  options: { copyEnabled?: boolean; source?: 'leaderboard' | 'watchlist'; tradeAmount?: number; shadowMode?: boolean } = {}
): Promise<number> {
  const copyEnabled  = options.copyEnabled !== false; // default true
  const tradeAmount  = options.tradeAmount ?? CONFIG.TRADE_AMOUNT;
  const isWatchlist  = options.source === 'watchlist';
  const shadowMode   = options.shadowMode === true;
  const store = readStore();
  const since = shadowMode
    ? (store.shadowLastSeen?.[trader.address])
    : store.traderLastSeen[trader.address];

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

  const processedIds = shadowMode
    ? new Set(store.processedShadowIds ?? [])
    : new Set(store.processedTradeIds);
  let newTrades = 0;
  let latestTimestamp = since;
  const label = trader.username ?? trader.address.slice(0, 10);

  for (const raw of items) {
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
      if (shadowMode) markShadowProcessed(activity.id); else markProcessed(activity.id);
      continue;
    }

    // ── Copy-disabled: advance cursor and mark processed, skip simulation ──
    if (!copyEnabled && !shadowMode) {
      markProcessed(activity.id);
      continue;
    }

    if (activity.side === 'buy') {
      // ── Shadow mode: run filters, log outcome, never execute real trade ──
      if (shadowMode) {
        const cat = detectCategory(activity.marketSlug);
        const excludedCats = (readStore().excludedCategories ?? []);
        const isSportsCat = cat === 'sports' || cat === 'esports';
        const effectiveMinPrice = isSportsCat ? CONFIG.MIN_PRICE_SPORTS : CONFIG.MIN_PRICE;
        let filterFail: string | null = null;
        if (excludedCats.includes(cat)) filterFail = `category ${cat} excluded`;
        else if (activity.price > CONFIG.MAX_PRICE) filterFail = `price ${activity.price.toFixed(3)} > ${CONFIG.MAX_PRICE}`;
        else if (activity.price < effectiveMinPrice) filterFail = `${isSportsCat ? 'sports ' : ''}price ${activity.price.toFixed(3)} < ${effectiveMinPrice}`;
        if (!filterFail) {
          try {
            const pd = await getMarketPrice(activity.marketSlug);
            const spread = getOutcomeSpread(pd, activity.outcome);
            if (spread !== null && spread > CONFIG.MAX_SPREAD) {
              filterFail = `spread ${spread.toFixed(3)} > ${CONFIG.MAX_SPREAD}`;
            }
          } catch { /* ignore — let through */ }
        }
        if (filterFail) {
          console.log(`[shadow] EXCLUDED ${label} BUY ${activity.marketSlug} @ $${activity.price.toFixed(3)} — filtered (${filterFail})`);
          markShadowProcessed(activity.id);
          continue;
        }
        // Would-pass → record as shadow open trade
        const shares = tradeAmount / activity.price;
        const entryCosts = computeEntryCosts(activity.price, shares);
        const sTrade: SimulatedTrade = {
          id: uuidv4(),
          sourceTradeId: activity.id,
          timestamp: activity.timestamp,
          copiedTrader: trader.address,
          copiedTraderRank: trader.rank,
          copiedTraderUsername: trader.username,
          copiedTraderSource: 'leaderboard',
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
          entryGasCost: entryCosts.gas,
          entrySlippageCost: entryCosts.slippage,
        };
        addShadowOpenTrade(sTrade);
        newTrades++;
        console.log(`[shadow] EXCLUDED ${label} BUY ${activity.marketSlug} @ $${activity.price.toFixed(3)} — would have passed filters`);
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

      // ── Global and per-market caps (leaderboard only — watchlist bypasses) ──
      if (!isWatchlist) {
        if (currentStore.openTrades.length >= CONFIG.MAX_TOTAL_OPEN_POSITIONS) {
          console.log(
            `[monitor] Skip BUY ${activity.marketSlug} — global limit of ${CONFIG.MAX_TOTAL_OPEN_POSITIONS} open positions reached`
          );
          markProcessed(activity.id);
          continue;
        }
        const marketPositions = currentStore.openTrades.filter(t => t.marketSlug === activity.marketSlug).length;
        const marketCat = detectCategory(activity.marketSlug);
        const isSportsMarket = marketCat === 'sports' || marketCat === 'esports';
        const marketLimit = isSportsMarket
          ? CONFIG.MAX_POSITIONS_PER_MARKET_SPORTS
          : CONFIG.MAX_POSITIONS_PER_MARKET;
        if (marketPositions >= marketLimit) {
          console.log(
            `[monitor] Skip BUY ${activity.marketSlug} — market limit of ${marketLimit} positions reached (${marketPositions} open)${isSportsMarket ? ' [sports]' : ''}`
          );
          markProcessed(activity.id);
          continue;
        }
      }

      // ── Per-trader minimum sample gate (leaderboard only) ──
      // Don't copy a trader until we've resolved enough of their trades locally
      // to have real performance data. Watchlist traders bypass (manually curated).
      if (!isWatchlist) {
        const closedForTrader = currentStore.closedTrades.filter(
          c => c.copiedTrader === trader.address
        ).length;
        const shadowForTrader = (currentStore.shadowClosedTrades ?? []).filter(
          c => c.copiedTrader === trader.address
        ).length;
        const gate = hasSufficientSample(closedForTrader, shadowForTrader);
        if (!gate.passes) {
          const label = trader.username ?? trader.address.slice(0, 10);
          console.log(
            `[monitor] Skip BUY ${label} — insufficient sample (real ${closedForTrader}/${CONFIG.MIN_TRADER_SAMPLE}, shadow ${shadowForTrader}/${CONFIG.MIN_TRADER_SHADOW_SAMPLE})`
          );
          markProcessed(activity.id);
          continue;
        }
      }

      // ── Category exclusion / price range / spread filters (leaderboard only) ──
      // Watchlist traders bypass all of these — they are manually curated and
      // should be copied unconditionally regardless of price or spread.
      if (!isWatchlist) {
        const cat = detectCategory(activity.marketSlug);
        const excludedCats = currentStore.excludedCategories ?? [];
        if (excludedCats.includes(cat)) {
          console.log(
            `[monitor] Skip BUY ${activity.marketSlug} — category ${cat} is excluded`
          );
          markProcessed(activity.id);
          continue;
        }

        // Sports/esports use a higher minimum price floor — historical data shows <0.60
        // entry in sports markets has <43% win rate and deeply negative EV (underdogs).
        const isSportsCat = cat === 'sports' || cat === 'esports';
        const effectiveMinPrice = isSportsCat ? CONFIG.MIN_PRICE_SPORTS : CONFIG.MIN_PRICE;
        if (activity.price < effectiveMinPrice || activity.price > CONFIG.MAX_PRICE) {
          let reason: string;
          if (activity.price > CONFIG.MAX_PRICE) {
            reason = `price ${activity.price.toFixed(3)} > MAX_PRICE ${CONFIG.MAX_PRICE}`;
          } else if (isSportsCat) {
            reason = `sports price ${activity.price.toFixed(3)} < MIN_PRICE_SPORTS ${effectiveMinPrice}`;
          } else {
            reason = `price ${activity.price.toFixed(3)} < MIN_PRICE ${CONFIG.MIN_PRICE}`;
          }
          console.log(`[monitor] Skip BUY ${activity.marketSlug} — ${reason}`);
          markProcessed(activity.id);
          continue;
        }

        try {
          const priceData = await getMarketPrice(activity.marketSlug);
          const spread = getOutcomeSpread(priceData, activity.outcome);
          if (spread !== null && spread > CONFIG.MAX_SPREAD) {
            console.log(
              `[monitor] Skip BUY ${activity.marketSlug} — ` +
              `spread ${spread.toFixed(3)} > ${CONFIG.MAX_SPREAD}`
            );
            markProcessed(activity.id);
            continue;
          }
        } catch (err) {
          // Spread check failed — allow trade through rather than blocking on API error
          console.error(
            `[monitor] Spread check failed for ${activity.marketSlug}:`,
            err instanceof Error ? err.message : err
          );
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
        copiedTraderSource: options.source ?? 'leaderboard',
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
      if (shadowMode) {
        const closed = closeShadowOpenTrade(trader.address, activity.marketSlug, activity.outcome, activity.price);
        markShadowProcessed(activity.id);
        if (closed) {
          newTrades++;
          console.log(`[shadow] SELL ${label} ${activity.marketSlug} @ $${activity.price.toFixed(3)} — shadow position closed`);
        }
      } else {
        const closed = closeOpenTrade(trader.address, activity.marketSlug, activity.outcome, activity.price);
        markProcessed(activity.id);
        if (closed) {
          newTrades++;
          console.log(
            `[DRY_RUN] SELL ${activity.marketTitle.slice(0, 40).padEnd(40)} | ` +
            `${activity.outcome.padEnd(4)} @ $${activity.price.toFixed(3)} | ` +
            `${trader.username ?? trader.address.slice(0, 8) + '...'} (#${trader.rank})`
          );
        }
      }
    }
  }

  if (latestTimestamp && latestTimestamp !== since) {
    if (shadowMode) setShadowLastSeen(trader.address, latestTimestamp);
    else setTraderLastSeen(trader.address, latestTimestamp);
  }

  return newTrades;
}
