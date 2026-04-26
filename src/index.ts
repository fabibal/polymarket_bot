import { refreshLeaderboard } from './leaderboard';
import { pollTrader } from './monitor';
import { updatePrices } from './simulator';
import { startDashboard } from './dashboard';
import { readStore, runDailyCleanup, startAutoFlush, stopAutoFlush, flushIfDirty, initInsertionCounter } from './store';
import { CONFIG } from './config';

async function runPollingCycle(): Promise<void> {
  const store = readStore();
  const excluded = new Set(store.excludedTraders ?? []);
  const traders = store.trackedTraders.filter(t => !excluded.has(t.address));

  // Shadow targets: all excluded addresses (manual + auto). They're not in trackedTraders anymore.
  // Synthesize minimal trader objects so pollTrader can use them.
  const shadowTargets = [...excluded].map(addr => {
    const pastTrade = store.closedTrades.find(t => t.copiedTrader === addr && t.copiedTraderUsername);
    return { rank: 0, address: addr, username: pastTrade?.copiedTraderUsername, weeklyPnl: 0 };
  });

  if (store.trackedTraders.length === 0) {
    console.log('[bot] No leaderboard traders yet — waiting for leaderboard refresh...');
  } else if (excluded.size > 0) {
    console.log(`[bot] Polling ${traders.length} active + ${shadowTargets.length} in shadow mode`);
  }

  const polledAddresses = new Set<string>();
  let totalNew = 0;

  for (const trader of traders) {
    polledAddresses.add(trader.address.toLowerCase());
    const n = await pollTrader(trader);
    totalNew += n;
    // Brief pause between traders to avoid rate-limiting
    await new Promise(r => setTimeout(r, 1_000));
  }

  // Shadow-poll excluded leaderboard traders (observe, don't copy)
  for (const trader of shadowTargets) {
    try {
      await pollTrader(trader, { shadowMode: true, copyEnabled: false });
    } catch (err) {
      console.error(`[shadow] poll failed for ${trader.address.slice(0,10)}:`, err instanceof Error ? err.message : err);
    }
    await new Promise(r => setTimeout(r, 1_000));
  }

  // Poll watchlist-only traders not already covered by the leaderboard
  const watchlistTraders = store.watchlistTraders ?? [];
  const watchlistOnly = watchlistTraders.filter(w => !polledAddresses.has(w.address.toLowerCase()));
  if (watchlistOnly.length > 0) {
    const disabledCount = watchlistOnly.filter(w => !w.copyEnabled).length;
    const note = disabledCount > 0 ? ` (${disabledCount} copy-disabled — enable via dashboard)` : '';
    console.log(`[bot] Polling ${watchlistOnly.length} watchlist-only trader(s)${note}`);
    for (const w of watchlistOnly) {
      const trader = { rank: 0, address: w.address, weeklyPnl: 0 };
      const n = await pollTrader(trader, { copyEnabled: w.copyEnabled, source: 'watchlist', tradeAmount: w.copyAmount ?? CONFIG.TRADE_AMOUNT });
      totalNew += n;
      await new Promise(r => setTimeout(r, 1_000));
    }
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
  console.log(`  Tracking     : Top ${CONFIG.LEADERBOARD_LIMIT} traders by weekly PNL`);
  console.log(`  Leaderboard  : refresh every ${CONFIG.LEADERBOARD_REFRESH_MS / 60_000} min`);
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

  // Initial leaderboard fetch
  try {
    await refreshLeaderboard();
  } catch (err) {
    console.error('[bot] Initial leaderboard fetch failed:', err instanceof Error ? err.message : err);
    console.error('[bot] Make sure `bullpen login` has been run and the config is mounted.');
  }

  // Periodic leaderboard refresh
  setInterval(async () => {
    try { await refreshLeaderboard(); }
    catch (err) { console.error('[leaderboard] Refresh failed:', err instanceof Error ? err.message : err); }
  }, CONFIG.LEADERBOARD_REFRESH_MS);

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

  // Give leaderboard a moment to load before first poll
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
