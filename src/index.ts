import { pollTrader, processRealtimeTrade, resetSkipDedup } from './monitor';
import { updatePrices } from './simulator';
import { startDashboard } from './dashboard';
import { readStore, runDailyCleanup, startWalCheckpoint, stopWalCheckpoint, initInsertionCounter, updateOpenTradeDepth } from './store';
import { getOrderbookDepth } from './bullpen';
import { CONFIG } from './config';
import { isCircuitBreakerActive, checkCircuitBreaker, checkTraderDecay } from './risk';
import { startRtds } from './rtds';
import { startLoopMonitor } from './health';

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

// Watchlist-only polling. Each watchlist trader's recent activity is polled
// and copied per its copyEnabled / copyAmount.
async function runPollingCycle(): Promise<void> {
  resetSkipDedup();
  const store = readStore();
  const watchlistTraders = store.watchlistTraders ?? [];

  if (watchlistTraders.length === 0) {
    console.log('[bot] No watchlist traders configured — add one via the dashboard.');
    return;
  }

  // Daily-loss circuit breaker: while active, polling continues (cursors must
  // advance so missed trades are never copied late) but new BUYs are discarded.
  const suspended = isCircuitBreakerActive();

  const disabledCount = watchlistTraders.filter(w => !w.copyEnabled).length;
  const note = disabledCount > 0 ? ` (${disabledCount} copy-disabled — enable via dashboard)` : '';
  console.log(`[bot] Polling ${watchlistTraders.length} watchlist trader(s)${note}${suspended ? ' [BREAKER PAUSED]' : ''}`);

  let totalNew = 0;
  for (const w of watchlistTraders) {
    try {
      const n = await pollTrader({ address: w.address }, { copyEnabled: w.copyEnabled, tradeAmount: w.copyAmount ?? CONFIG.TRADE_AMOUNT, suspended });
      totalNew += n;
    } catch (err) {
      // Per-trader isolation: one trader's failure (e.g. an SQL error mid-poll)
      // must not abort the remaining traders this cycle. The failed trader's
      // cursor doesn't advance, so its items are refetched next cycle.
      console.error(`[bot] Poll failed for ${w.address.slice(0, 10)}...:`, err instanceof Error ? err.message : err);
    }
    // Brief pause between traders to avoid rate-limiting
    await new Promise(r => setTimeout(r, 1_000));
  }

  if (totalNew > 0) {
    console.log(`[bot] Simulated ${totalNew} new trade(s) this cycle`);
  }

  // Risk checks run after each cycle on the fresh in-memory store. Both are
  // cheap (in-memory scans) and alert via Telegram on state transitions only.
  try { await checkTraderDecay(); }
  catch (err) { console.error('[risk] trader decay check failed:', err instanceof Error ? err.message : err); }
  try { await checkCircuitBreaker(); }
  catch (err) { console.error('[risk] circuit breaker check failed:', err instanceof Error ? err.message : err); }
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
  console.log(`  Tracking     : Watchlist traders only`);
  console.log(`  Poll interval: every ${CONFIG.POLL_INTERVAL_MS / 1_000}s per trader`);
  console.log(`  Price update : every ${CONFIG.PRICE_UPDATE_INTERVAL_MS / 60_000} min`);
  console.log('');

  // Resume insertion_order past any existing rows before any writes happen,
  // so post-restart trades sort correctly in FIFO close queries.
  initInsertionCounter();

  // Periodic PASSIVE WAL checkpoint (all store mutations persist immediately
  // via targeted SQL — this only keeps the WAL file from growing unbounded).
  startWalCheckpoint(60_000);

  // Event-loop lag for the dashboard: a blocked loop delays every copy.
  startLoopMonitor();

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

  // Real-time trade feed: a watched wallet's trade is processed ~1s after the
  // fill instead of after the data-api index catches up (~20-35s). The poll
  // above keeps running as the backfill for anything the socket misses.
  if (CONFIG.RTDS_ENABLED) {
    startRtds(
      wallet => readStore().watchlistTraders.some(w => w.address === wallet),
      (wallet, item) => {
        const w = readStore().watchlistTraders.find(x => x.address === wallet);
        if (!w) return;
        processRealtimeTrade({ address: w.address }, item, {
          copyEnabled: w.copyEnabled,
          tradeAmount: w.copyAmount ?? CONFIG.TRADE_AMOUNT,
          suspended: isCircuitBreakerActive(),
        }).then(n => {
          if (n > 0 && w.copyEnabled) {
            const lagS = (Date.now() - Date.parse(String(item.timestamp))) / 1000;
            console.log(`[rtds] ${w.label ?? w.address.slice(0, 10)} ${item.side} ${item.slug} processed ${lagS.toFixed(1)}s after the fill`);
          }
        }).catch(err => console.error(`[rtds] processing failed for ${wallet.slice(0, 10)}...:`, err instanceof Error ? err.message : err));
      },
    );
  }
}

function shutdown(signal: string): void {
  // All store writes are persisted at mutation time — nothing to flush.
  console.log(`[bot] Received ${signal} — exiting.`);
  try { stopWalCheckpoint(); } catch (err) { console.error('[bot] shutdown cleanup failed:', err); }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
  process.exit(1);
});

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
