/**
 * Processes a watchlist trader's activity, from the data-api poll or pushed in
 * real time by the RTDS socket (see src/rtds.ts).
 * - BUY  → create a new simulated $5 position (subject to entry cap, depth gate, wallet cap)
 * - SELL → close the oldest matching open position at sell price (realized PNL)
 */
import { getTraderActivity, getOrderbookDepth, getTraderPositionSize, getMarketFeeRate, RawActivityItem } from './bullpen';
import {
  readStore, addOpenTrade, closeOpenTrade, markProcessed, setTraderLastSeen,
  appendTraderHistory, addSkippedTrade, addObservationTrade, closeObservationTrade,
} from './store';
import { ActivityTrade, SimulatedTrade, TraderHistoryEntry } from './types';
import { CONFIG } from './config';
import { takerFeeCost } from './fees';
import { countWatchlistEntriesInWindow, computeDynamicTradeAmount, computeSellFraction, isMatchStyleSlug } from './filters';
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
  const usdcSize = raw.usdc_size != null && Number.isFinite(Number(raw.usdc_size))
    ? Number(raw.usdc_size) : undefined;

  const marketTitle = String(raw.title ?? marketSlug);
  return { id, timestamp, marketSlug, marketTitle, outcome, side: side as 'buy' | 'sell', price, size, usdcSize };
}

type TraderRef = { address: string; username?: string };
type CopyOptions = { copyEnabled?: boolean; tradeAmount?: number; suspended?: boolean };

// One batch of activity is processed at a time, across all traders and both
// sources (poll + RTDS push). The wallet cap and the per-market entry cap are
// checked before the depth/fee HTTP awaits, so two concurrent BUYs could
// otherwise both pass them; serializing also keeps processedTradeIds dedup exact.
let processingChain: Promise<unknown> = Promise.resolve();
function withProcessingLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = processingChain.then(fn, fn);
  processingChain = run.catch(() => undefined);
  return run;
}

export async function pollTrader(trader: TraderRef, options: CopyOptions = {}): Promise<number> {
  const since = readStore().traderLastSeen[trader.address];

  let response;
  try {
    response = await getTraderActivity(trader.address, CONFIG.ACTIVITY_LIMIT, since);
  } catch (err) {
    console.error(`[monitor] Poll failed for ${trader.address.slice(0, 10)}...:`, err instanceof Error ? err.message : err);
    return 0;
  }

  const items = Array.isArray(response) ? response : [];
  if (items.length === 0) return 0;
  return withProcessingLock(() => processActivity(trader, items, options, since, 'poll'));
}

/**
 * Push path (RTDS socket or the Polygon chain feed): a trade processed exactly
 * like a polled one. It never moves the data-api cursor — only the poll does —
 * so a trade a push source missed is still picked up by the next poll, and any
 * later copy of the same trade (same tx hash) is dropped by the
 * processedTradeIds dedup.
 */
export function processRealtimeTrade(
  trader: TraderRef, raw: RawActivityItem, options: CopyOptions = {}, source: 'rtds' | 'chain' = 'rtds',
): Promise<number> {
  return withProcessingLock(() => processActivity(trader, [raw], options, undefined, source));
}

// Only the data-api poll moves the cursor; `source` is also stored on each
// copy to show which path delivered it.
async function processActivity(
  trader: TraderRef,
  items: RawActivityItem[],
  options: CopyOptions,
  since: string | undefined,
  source: 'poll' | 'rtds' | 'chain',
): Promise<number> {
  const advanceCursor = source === 'poll';
  const copyEnabled  = options.copyEnabled !== false; // default true
  // Daily-loss circuit breaker: copy-enabled traders' trades are discarded
  // (cursor advances, nothing recorded — a paused real wallet misses trades,
  // it doesn't fill them late). Observation traders are unaffected: their
  // ledger is not real money and must stay continuous.
  const suspended    = options.suspended === true;
  const tradeAmount  = options.tradeAmount ?? CONFIG.TRADE_AMOUNT;
  const store = readStore();

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

    // ── Copy-disabled: observation forward-test ────────────────────────────
    // Simulate the full trade lifecycle in the separate observation ledger so
    // candidates build a real forward-test record before copying is enabled.
    // Deliberately RAW — no wallet cap, entry cap, depth gate, or longshot
    // filter: the ledger measures the trader, not our execution constraints.
    if (!copyEnabled) {
      if (activity.side === 'buy') {
        const shares = tradeAmount / activity.price;
        const entryCosts = computeEntryCosts(activity.price, shares);
        const obsNotional = activity.usdcSize ?? (activity.size > 0 ? activity.price * activity.size : undefined);
        addObservationTrade({
          id: uuidv4(),
          sourceTradeId: activity.id,
          timestamp: activity.timestamp,
          copiedTrader: trader.address,
          copiedTraderRank: 0, // legacy leaderboard-era column; always 0
          copiedTraderUsername: trader.username,
          copiedTraderSource: 'observation',
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
          sourceNotional:    obsNotional != null && Number.isFinite(obsNotional) ? obsNotional : undefined,
        });
        newTrades++;
        console.log(
          `[OBS] BUY  ${activity.marketTitle.slice(0, 40).padEnd(40)} | ` +
          `${activity.outcome.padEnd(4)} @ $${activity.price.toFixed(3)} | ` +
          `$${tradeAmount} → ${shares.toFixed(2)} shares | ` +
          `${trader.username ?? trader.address.slice(0, 8) + '...'} (observation)`
        );
      } else {
        const closed = closeObservationTrade(trader.address, activity.marketSlug, activity.outcome, activity.price);
        if (closed) {
          newTrades++;
          console.log(
            `[OBS] SELL ${activity.marketTitle.slice(0, 40).padEnd(40)} | ` +
            `${activity.outcome.padEnd(4)} @ $${activity.price.toFixed(3)} | ` +
            `${trader.username ?? trader.address.slice(0, 8) + '...'} (observation)`
          );
        }
      }
      markProcessed(activity.id);
      continue;
    }

    // ── Circuit breaker pause: discard new BUYs ─────────────────────────────
    // SELLs still process: the breaker stops new exposure, but existing open
    // positions must keep following the trader's exits — holding what the
    // trader already sold would be unmanaged risk, not protection.
    if (suspended && activity.side === 'buy') {
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

      // ── Watchlist-only: per-market entry cap ──
      // Match-style markets (ISO date in slug, e.g. fif-ksa-sen-2026-06-09-draw)
      // resolve once, so every re-entry is a correlated bet on the same outcome:
      // LIFETIME cap of 1 entry per slug. Stacking analysis 2026-06-11 (test
      // window since 05-28): entries #2+ on match slugs added ~$0 net PnL but
      // tripled drawdown; on 06-10 two match losses stacked to -$35.70 and
      // tripped the circuit breaker. Non-dated markets (geo/political) keep the
      // rolling-window cap — they live for weeks and scale-in/out re-entries
      // there are genuine new trades (cap=1 would cost most of that cohort's
      // net). Counts both open and closed watchlist entries on the slug.
      const matchStyle = isMatchStyleSlug(activity.marketSlug);
      const maxEntries = matchStyle ? 1 : CONFIG.MAX_WATCHLIST_ENTRIES_PER_MARKET;
      const windowMs   = matchStyle ? Number.POSITIVE_INFINITY : CONFIG.MAX_WATCHLIST_ENTRY_WINDOW_MS;
      const watchlistEntries = countWatchlistEntriesInWindow(
        currentStore.openTrades,
        currentStore.closedTrades,
        activity.marketSlug,
        Date.now(),
        windowMs,
      );
      if (watchlistEntries >= maxEntries) {
        const capDesc = matchStyle
          ? 'match-style lifetime cap 1'
          : `${CONFIG.MAX_WATCHLIST_ENTRIES_PER_MARKET}/${Math.round(CONFIG.MAX_WATCHLIST_ENTRY_WINDOW_MS / 3600000)}h`;
        console.log(
          `[monitor] Skip BUY ${activity.marketSlug} — watchlist entry cap ${capDesc} reached (n=${watchlistEntries})`
        );
        markProcessed(activity.id);
        continue;
      }

      // Depth gate: fetch CLOB orderbook BEFORE creating the trade so we can
      // skip thin books. Non-blocking — depth fetch failure falls through to copy.
      // Runs before the wallet cap since dynamic sizing needs ask_depth_5 to know
      // the final amount (costs two HTTP calls on wallet-capped skips — rare).
      const watchlistDepth = await getOrderbookDepth(activity.marketSlug, activity.outcome);
      if (watchlistDepth && watchlistDepth.askDepth5 < CONFIG.DEPTH_GATE_MIN_DEPTH_5) {
        console.log(
          `[monitor] Skip BUY ${activity.marketSlug} — depth_gate: ` +
          `ask_depth_5=$${watchlistDepth.askDepth5.toFixed(0)} below ` +
          `$${CONFIG.DEPTH_GATE_MIN_DEPTH_5} threshold`
        );
        markProcessed(activity.id);
        continue;
      }

      // Dynamic sizing (DYNAMIC_SIZING=false → amount = per-trader copyAmount).
      const amount = computeDynamicTradeAmount(watchlistDepth?.askDepth5 ?? null, tradeAmount, {
        enabled: CONFIG.DYNAMIC_SIZING,
        min: CONFIG.MIN_TRADE_AMOUNT,
        max: CONFIG.MAX_TRADE_AMOUNT,
      });

      // ── Simulated wallet cap (checked with the FINAL amount) ──
      // Models a fixed-size real wallet. When sum of open simulatedAmount reaches
      // SIMULATED_WALLET_SIZE * WALLET_CAP_UTILIZATION, refuse new BUYs.
      if (CONFIG.SIMULATED_WALLET_SIZE > 0) {
        const inUse = currentStore.openTrades.reduce(
          (s, t) => s + (t.simulatedAmount ?? CONFIG.TRADE_AMOUNT), 0
        );
        const cap = CONFIG.SIMULATED_WALLET_SIZE * CONFIG.WALLET_CAP_UTILIZATION;
        if (inUse + amount > cap) {
          console.log(
            `[monitor] Skip BUY ${activity.marketSlug} — wallet_cap: ` +
            `$${inUse.toFixed(0)}/$${CONFIG.SIMULATED_WALLET_SIZE} in use ` +
            `(cap $${cap.toFixed(0)} @ ${(CONFIG.WALLET_CAP_UTILIZATION * 100).toFixed(0)}%)`
          );
          markProcessed(activity.id);
          continue;
        }
      }

      const shares = amount / activity.price;
      const entryGap = watchlistDepth ? watchlistDepth.bestAsk - activity.price : null;
      const entryCosts = computeEntryCosts(activity.price, shares, entryGap);
      // Taker fee on the copy's fill price (the ask when a snapshot exists).
      const fetchedFeeRate = await getMarketFeeRate(activity.marketSlug);
      const feeRate = fetchedFeeRate ?? CONFIG.FALLBACK_TAKER_FEE_RATE;
      const entryFee = takerFeeCost(feeRate, activity.price + Math.max(0, entryGap ?? 0), shares);
      const trade: SimulatedTrade = {
        id: uuidv4(),
        sourceTradeId: activity.id,
        timestamp: activity.timestamp,
        copiedTrader: trader.address,
        copiedTraderRank: 0, // legacy leaderboard-era column; always 0
        copiedTraderUsername: trader.username,
        copiedTraderSource: 'watchlist',
        marketSlug: activity.marketSlug,
        marketTitle: activity.marketTitle,
        outcome: activity.outcome,
        side: 'buy',
        entryPrice: activity.price,
        simulatedAmount: amount,
        simulatedShares: shares,
        currentPrice: activity.price,
        unrealizedPnl: 0,
        status: 'open',
        entryGasCost:      entryCosts.gas,
        entrySlippageCost: entryCosts.slippage,
        feeRate,
        entryFeeCost:      entryFee,
        copiedAt:          new Date().toISOString(),
        copySource:        source,
      };
      if (fetchedFeeRate === null) {
        console.log(`[monitor] fee config unavailable for ${activity.marketSlug} — using fallback rate ${feeRate}`);
      }
      // Research fields (GROUP D): the trader's own bet notional (conviction
      // signal) and the taker entry-price gap (maker-execution study).
      const notional = activity.usdcSize ?? (activity.size > 0 ? activity.price * activity.size : undefined);
      if (notional != null && Number.isFinite(notional)) trade.sourceNotional = notional;
      if (entryGap != null) trade.entryPriceGap = entryGap;
      // Persist the depth snapshot fetched above for the gate check.
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
      addOpenTrade(trade);
      newTrades++;
      const sizeTag = amount !== tradeAmount ? ` (dyn, base $${tradeAmount})` : '';
      console.log(
        `[WL] BUY  ${activity.marketTitle.slice(0, 40).padEnd(40)} | ` +
        `${activity.outcome.padEnd(4)} @ $${activity.price.toFixed(3)} | ` +
        `$${amount.toFixed(2)}${sizeTag} → ${shares.toFixed(2)} shares | ` +
        `${trader.username ?? trader.address.slice(0, 8) + '...'}`
      );
    } else {
      // SELL: close the oldest matching simulated position.
      // Partial-sell research: record what fraction of THEIR position this
      // SELL was (we always close 100% of ours). The /positions lookup runs
      // only when we actually hold a matching copy — sells we never copied
      // cost no API calls. The snapshot is the trader's balance at poll time
      // (post-sell, up to one poll cycle late); lookup failure → not recorded.
      const holding = readStore().openTrades.some(
        t => t.copiedTrader === trader.address && t.marketSlug === activity.marketSlug && t.outcome === activity.outcome
      );
      let sellFraction: number | undefined;
      if (holding) {
        const remaining = await getTraderPositionSize(trader.address, activity.marketSlug, activity.outcome);
        if (remaining !== null) sellFraction = computeSellFraction(activity.size, remaining) ?? undefined;
      }
      const closed = closeOpenTrade(trader.address, activity.marketSlug, activity.outcome, activity.price, sellFraction);
      markProcessed(activity.id);
      if (closed) {
        newTrades++;
        const fracTag = sellFraction != null ? ` | sold ${(sellFraction * 100).toFixed(0)}% of theirs` : '';
        console.log(
          `[WL] SELL ${activity.marketTitle.slice(0, 40).padEnd(40)} | ` +
          `${activity.outcome.padEnd(4)} @ $${activity.price.toFixed(3)} | ` +
          `${trader.username ?? trader.address.slice(0, 8) + '...'}${fracTag}`
        );
      }
    }
  }

  if (advanceCursor && latestTimestamp && latestTimestamp !== since) {
    setTraderLastSeen(trader.address, latestTimestamp);
  }

  return newTrades;
}
