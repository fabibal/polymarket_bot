import { pollTrader, resetSkipDedup } from './monitor';
import { updatePrices } from './simulator';
import { startDashboard } from './dashboard';
import { readStore, runDailyCleanup, startAutoFlush, stopAutoFlush, flushIfDirty, initInsertionCounter, updateOpenTradeDepth } from './store';
import { getOrderbookDepth } from './bullpen';
import { CONFIG } from './config';

/**
 * One-shot startup task: for every open watchlist trade missing orderbook depth,
 * fetch the current CLOB book and write it back with depth_backfilled=1.
 * Best-effort — failures are silent and the trade stays unannotated.
 */
async function backfillOpenTradeDepth(): Promise<void> {
  const store = readStore();
  const targets = store.openTrades.filter(
    t => t.copiedTraderSource === 'watchlist' && t.bestAsk == null
  );
  if (targets.length === 0) return;
  console.log(`[backfill] Filling orderbook depth for ${targets.length} open watchlist trade(s)...`);
  let ok = 0;
  for (const t of targets) {
    const d = await getOrderbookDepth(t.marketSlug, t.outcome);
    if (d) {
      updateOpenTradeDepth(t.id, {
        bestAsk: d.bestAsk, bestBid: d.bestBid,
        askDepth5: d.askDepth5, askDepth10: d.askDepth10,
        spreadAtEntry: d.spread,
      }, true);
      ok++;
    }
    await new Promise(r => setTimeout(r, 100)); // throttle CLOB calls
  }
  console.log(`[backfill] Done: ${ok}/${targets.length} succeeded`);
}

// Watchlist-only polling (leaderboard tracking removed 2026-05-29). Each watchlist
// trader's recent activity is polled and copied per its copyEnabled / copyAmount.
async function runPollingCycle(): Promise<void> {
  resetSkipDedup();
  const store = readStore();
  const watchlistTraders = store.watchlistTraders ?? [];

  if (watchlistTraders.length === 0) {
    console.log('[bot] No watchlist traders configured — add one via the dashboard.');
    return;
  }

  const disabledCount = watchlistTraders.filter(w => !w.copyEnabled).length;
  const note = disabledCount > 0 ? ` (${disabledCount} copy-disabled — enable via dashboard)` : '';
  console.log(`[bot] Polling ${watchlistTraders.length} watchlist trader(s)${note}`);

  let totalNew = 0;
  for (const w of watchlistTraders) {
    const trader = { rank: 0, address: w.address, weeklyPnl: 0 };
    const n = await pollTrader(trader, { copyEnabled: w.copyEnabled, source: 'watchlist', tradeAmount: w.copyAmount ?? CONFIG.TRADE_AMOUNT });
    totalNew += n;
    // Brief pause between traders to avoid rate-limiting
    await new Promise(r => setTimeout(r, 1_000));
  }

  if (totalNew > 0) {
    console.log(`[bot] Simulated ${totalNew} new trade(s) this cycle`);
  }
}

function scheduleMidnightCleanup(): void {
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const msUntil = nextMidnight.getTime() - now.getTime();
  setTimeout(() => {
    try { runDailyCleanup(); }
    catch (err) { console.error('[cleanup] Daily cleanup failed:', err instanceof Error ? err.message : err); }
    scheduleMidnightCleanup();
  }, msUntil);
  console.log(`[cleanup] Next cleanup scheduled in ${(msUntil / 3_600_000).toFixed(1)}h (${nextMidnight.toISOString()})`);
}

async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║  Polymarket Copy Trading Bot  [DRY RUN]    ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`  Trade amount : $${CONFIG.TRADE_AMOUNT} per trade (simulated)`);
  console.log(`  Tracking     : Watchlist traders only (leaderboard removed)`);
  console.log(`  Poll interval: every ${CONFIG.POLL_INTERVAL_MS / 1_000}s per trader`);
  console.log(`  Price update : every ${CONFIG.PRICE_UPDATE_INTERVAL_MS / 60_000} min`);
  console.log('');

  // Resume insertion_order past any existing rows before any writes happen,
  // so post-restart trades sort correctly in FIFO close queries.
  initInsertionCounter();

  // Background debounced flusher: persists pending store mutations every 60s
  // to collapse bursts of metric/cache updates into one disk write. Critical
  // financial mutations still flush immediately via writeStore().
  startAutoFlush(60_000);

  startDashboard();
  scheduleMidnightCleanup();

  // Best-effort backfill — fire-and-forget so it never blocks startup.
  backfillOpenTradeDepth().catch(err =>
    console.error('[backfill] Failed:', err instanceof Error ? err.message : err)
  );

  // Periodic price updates for open positions
  setInterval(async () => {
    try { await updatePrices(); }
    catch (err) { console.error('[simulator] Price update failed:', err instanceof Error ? err.message : err); }
  }, CONFIG.PRICE_UPDATE_INTERVAL_MS);

  // Main trade polling loop (sequential, self-rescheduling)
  const poll = async () => {
    try { await runPollingCycle(); }
    catch (err) { console.error('[bot] Poll cycle error:', err instanceof Error ? err.message : err); }
    setTimeout(poll, CONFIG.POLL_INTERVAL_MS);
  };

  // Start polling shortly after startup (dashboard/backfill get a head start).
  setTimeout(poll, 5_000);
}

function shutdown(signal: string): void {
  console.log(`[bot] Received ${signal} — flushing pending store writes and exiting.`);
  try { stopAutoFlush(); } catch (err) { console.error('[bot] flush on shutdown failed:', err); }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('exit', () => { try { flushIfDirty(); } catch {} });

process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err instanceof Error ? err.stack || err.message : err);
  try { flushIfDirty(); } catch {}
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
  try { flushIfDirty(); } catch {}
  process.exit(1);
});

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
