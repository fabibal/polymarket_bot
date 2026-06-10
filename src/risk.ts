/**
 * Risk controls (added 2026-06-10):
 *   1. Per-trader decay kill switch — rolling 30d cost-adjusted net per
 *      copy-enabled watchlist trader; below TRADER_DECAY_THRESHOLD_30D the
 *      trader is auto-disabled (keeps accruing observation data) + Telegram.
 *   2. Account-wide daily-loss circuit breaker — total cost-adjusted realized
 *      PnL over the last 24h; below DAILY_LOSS_CIRCUIT_BREAKER all copying
 *      pauses for 24h (cursors still advance — missed trades are NOT copied
 *      late). Auto-resumes; manual reset via dashboard.
 *
 * Window math is pure and unit-tested; side effects (disable, alert, meta
 * state) live in the two check functions called from the polling loop.
 */
import { SimulatedTrade } from './types';
import { CONFIG } from './config';
import {
  readStore, autoDisableWatchlistTrader,
  getMetaValue, setMetaValue, deleteMetaValue,
} from './store';
import { tradeCostAdjustedPnl } from './simulator';
import { sendTelegramAlert } from './alerts';

export const BREAKER_META_KEY = 'circuit_breaker_until';
export const BREAKER_PAUSE_MS = 24 * 3_600_000;

/** Cost-adjusted net over closed trades for one trader within the window. */
export function rollingNetForTrader(
  closedTrades: SimulatedTrade[], address: string, windowMs: number, nowMs: number,
): number {
  let net = 0;
  for (const t of closedTrades) {
    if (t.copiedTrader !== address) continue;
    if (!t.closedAt) continue;
    const ts = new Date(t.closedAt).getTime();
    if (Number.isNaN(ts) || ts < nowMs - windowMs || ts > nowMs) continue;
    net += tradeCostAdjustedPnl(t);
  }
  return net;
}

/** Cost-adjusted realized net across ALL traders within the window. */
export function rollingNetTotal(
  closedTrades: SimulatedTrade[], windowMs: number, nowMs: number,
): number {
  let net = 0;
  for (const t of closedTrades) {
    if (!t.closedAt) continue;
    const ts = new Date(t.closedAt).getTime();
    if (Number.isNaN(ts) || ts < nowMs - windowMs || ts > nowMs) continue;
    net += tradeCostAdjustedPnl(t);
  }
  return net;
}

export type BreakerDecision =
  | { action: 'none' }
  | { action: 'trip'; pauseUntilMs: number }
  | { action: 'active'; untilMs: number };

/** Pure breaker evaluation: existing pause state + current 24h net → decision. */
export function evaluateCircuitBreaker(args: {
  net24h: number;
  threshold: number;       // negative, e.g. -30
  activeUntilMs: number | null;
  nowMs: number;
}): BreakerDecision {
  if (args.activeUntilMs != null && args.nowMs < args.activeUntilMs) {
    return { action: 'active', untilMs: args.activeUntilMs };
  }
  if (args.net24h < args.threshold) {
    return { action: 'trip', pauseUntilMs: args.nowMs + BREAKER_PAUSE_MS };
  }
  return { action: 'none' };
}

// ── Side-effecting checks (called from the polling loop) ────────────────────

/**
 * Disable copying for any copy-enabled watchlist trader whose rolling 30d net
 * is below the decay threshold. Returns the addresses disabled this call.
 */
export async function checkTraderDecay(nowMs: number = Date.now()): Promise<string[]> {
  const store = readStore();
  const disabled: string[] = [];
  for (const w of store.watchlistTraders ?? []) {
    if (!w.copyEnabled) continue;
    const net30d = rollingNetForTrader(store.closedTrades, w.address, 30 * 86_400_000, nowMs);
    if (net30d >= CONFIG.TRADER_DECAY_THRESHOLD_30D) continue;

    const reason = `30d net $${net30d.toFixed(2)} below decay threshold $${CONFIG.TRADER_DECAY_THRESHOLD_30D}`;
    autoDisableWatchlistTrader(w.address, reason);
    disabled.push(w.address);
    const name = w.label ?? w.address.slice(0, 10) + '...';
    console.log(`[risk] ${new Date(nowMs).toISOString()} trader decay: ${name} (${w.address}) — ${reason}. Copy disabled automatically.`);
    await sendTelegramAlert(
      `⚠️ trader decay detected: ${name} ${w.address} 30d net = $${net30d.toFixed(2)}. Copy disabled automatically.`
    );
  }
  return disabled;
}

let breakerLoggedThisPause = false;

/** True while the daily-loss pause is active. Logs once per pause window. */
export function isCircuitBreakerActive(nowMs: number = Date.now()): boolean {
  const raw = getMetaValue(BREAKER_META_KEY);
  if (raw == null) { breakerLoggedThisPause = false; return false; }
  const untilMs = new Date(raw).getTime();
  if (Number.isNaN(untilMs) || nowMs >= untilMs) {
    deleteMetaValue(BREAKER_META_KEY);
    if (!Number.isNaN(untilMs)) console.log('[risk] circuit breaker pause expired — copying resumed');
    breakerLoggedThisPause = false;
    return false;
  }
  if (!breakerLoggedThisPause) {
    console.log(`[risk] circuit breaker active — copying paused until ${raw}`);
    breakerLoggedThisPause = true;
  }
  return true;
}

/**
 * Trip the breaker when the 24h realized net crosses the threshold. Call after
 * each polling cycle (when not already paused).
 */
export async function checkCircuitBreaker(nowMs: number = Date.now()): Promise<boolean> {
  const store = readStore();
  const net24h = rollingNetTotal(store.closedTrades, 86_400_000, nowMs);
  const raw = getMetaValue(BREAKER_META_KEY);
  const activeUntilMs = raw != null ? new Date(raw).getTime() : null;
  const decision = evaluateCircuitBreaker({
    net24h, threshold: CONFIG.DAILY_LOSS_CIRCUIT_BREAKER, activeUntilMs, nowMs,
  });
  if (decision.action !== 'trip') return decision.action === 'active';

  const until = new Date(decision.pauseUntilMs).toISOString();
  setMetaValue(BREAKER_META_KEY, until);
  breakerLoggedThisPause = false;
  console.log(`[risk] ${new Date(nowMs).toISOString()} daily loss circuit breaker TRIPPED: 24h net $${net24h.toFixed(2)} < $${CONFIG.DAILY_LOSS_CIRCUIT_BREAKER} — all copying paused until ${until}`);
  await sendTelegramAlert(
    `🚨 daily loss circuit breaker triggered: $${net24h.toFixed(2)} in 24h. All copying paused for 24h.`
  );
  return true;
}

/** Manual override (dashboard): clear the pause immediately. */
export function resetCircuitBreaker(): void {
  deleteMetaValue(BREAKER_META_KEY);
  breakerLoggedThisPause = false;
  console.log('[risk] circuit breaker manually reset — copying resumed');
}

/** Status for /api/stats + dashboard banner. */
export function getCircuitBreakerStatus(nowMs: number = Date.now()): {
  active: boolean; until: string | null; net24h: number; threshold: number;
} {
  const store = readStore();
  const raw = getMetaValue(BREAKER_META_KEY);
  const untilMs = raw != null ? new Date(raw).getTime() : null;
  const active = untilMs != null && !Number.isNaN(untilMs) && nowMs < untilMs;
  return {
    active,
    until: active ? raw : null,
    net24h: rollingNetTotal(store.closedTrades, 86_400_000, nowMs),
    threshold: CONFIG.DAILY_LOSS_CIRCUIT_BREAKER,
  };
}
