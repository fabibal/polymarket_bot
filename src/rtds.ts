/**
 * Polymarket real-time data socket (RTDS): a push feed of every trade on the
 * exchange. It delivers a watched wallet's fill ~1s after it happens, versus a
 * ~22s median (p90 34s) for data-api /activity even when polled every 3s —
 * the index lags, so polling faster can't close the gap (latency survey
 * 2026-09-26: 161 trades, RTDS saw 158).
 *
 * The feed can't be filtered by wallet server-side, so the whole firehose is
 * received (~30 msg/s, ~26 KB/s, ~1% of one core) and filtered locally. Only
 * matching trades reach `onTrade`; nothing is stored here. The data-api poll
 * stays in place as the backfill for the few trades the socket misses.
 */
import WebSocket from 'ws';
import type { RawActivityItem } from './bullpen';

const RTDS_URL = 'wss://ws-live-data.polymarket.com';
const PING_MS = 10_000;          // server drops idle clients; it expects a text PING
const STALE_MS = 20_000;         // ~27 msg/s (and a PONG every 10s): 20s of silence is a dead socket
const MAX_BACKOFF_MS = 60_000;
const STATS_EVERY_MS = 30 * 60_000;
const RATE_WINDOW_S = 60;

// Feed status for the dashboard header. Module-level: one feed per process.
const feed = {
  enabled: false,
  connected: false,
  connectedSince: null as number | null,
  lastMessageAt: null as number | null,
  watchedTrades: 0,
  reconnects: 0,
  // Per-second message counts over the last RATE_WINDOW_S seconds (ring).
  counts: new Array<number>(RATE_WINDOW_S).fill(0),
  secs: new Array<number>(RATE_WINDOW_S).fill(-1),
};

export function _resetFeedStatusForTests(): void {
  feed.enabled = false; feed.connected = false; feed.connectedSince = null;
  feed.lastMessageAt = null; feed.watchedTrades = 0; feed.reconnects = 0;
  feed.counts.fill(0); feed.secs.fill(-1);
}

export function countFeedMessage(nowMs: number): void {
  feed.lastMessageAt = nowMs;
  const sec = Math.floor(nowMs / 1000);
  const i = sec % RATE_WINDOW_S;
  if (feed.secs[i] !== sec) { feed.secs[i] = sec; feed.counts[i] = 0; }
  feed.counts[i]++;
}

export interface RtdsStatus {
  enabled: boolean;
  connected: boolean;
  connectedSince: string | null;
  lastMessageAgoMs: number | null;
  msgsPerSec: number;       // mean over the last minute
  watchedTrades: number;    // since process start
  reconnects: number;       // since process start
}

export function getRtdsStatus(nowMs: number = Date.now()): RtdsStatus {
  const nowSec = Math.floor(nowMs / 1000);
  let n = 0;
  for (let i = 0; i < RATE_WINDOW_S; i++) {
    if (feed.secs[i] > nowSec - RATE_WINDOW_S && feed.secs[i] <= nowSec) n += feed.counts[i];
  }
  return {
    enabled: feed.enabled,
    connected: feed.connected,
    connectedSince: feed.connectedSince != null ? new Date(feed.connectedSince).toISOString() : null,
    lastMessageAgoMs: feed.lastMessageAt != null ? nowMs - feed.lastMessageAt : null,
    msgsPerSec: n / RATE_WINDOW_S,
    watchedTrades: feed.watchedTrades,
    reconnects: feed.reconnects,
  };
}

/**
 * RTDS payloads use the data-api activity schema (camelCase, timestamp in
 * seconds). Normalized exactly like getTraderActivity so both paths feed
 * identical items to the monitor. usdcSize isn't in the payload; the monitor
 * falls back to price * size for the notional.
 */
export function rtdsPayloadToActivity(p: Record<string, unknown>): RawActivityItem | null {
  if (typeof p.proxyWallet !== 'string' || typeof p.transactionHash !== 'string') return null;
  const ts = Number(p.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return {
    transaction_hash: p.transactionHash,
    timestamp: new Date(ts * 1000).toISOString(),
    slug:      p.slug      != null ? String(p.slug)      : undefined,
    title:     p.title     != null ? String(p.title)     : undefined,
    outcome:   p.outcome   != null ? String(p.outcome)   : undefined,
    side:      p.side      != null ? String(p.side)      : undefined,
    type:      'TRADE', // the subscription is activity/trades only
    price:     p.price     != null ? Number(p.price)     : undefined,
    size:      p.size      != null ? Number(p.size)      : undefined,
    usdc_size: p.usdcSize  != null ? Number(p.usdcSize)  : undefined,
  };
}

/**
 * Connects and keeps reconnecting (exponential backoff) until the returned
 * stop function is called. `isWatched` gets the lowercase wallet of every
 * trade; `onTrade` is called for the watched ones.
 */
export function startRtds(
  isWatched: (wallet: string) => boolean,
  onTrade: (wallet: string, item: RawActivityItem) => void,
): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let backoffMs = 1_000;
  let lastMsgAt = 0;
  let pingTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  const stats = { msgs: 0, matched: 0, reconnects: 0 };
  feed.enabled = true;

  const statsTimer = setInterval(() => {
    console.log(`[rtds] last ${STATS_EVERY_MS / 60_000}m: ${stats.msgs} msgs, ${stats.matched} watched trades, ${stats.reconnects} reconnects`);
    stats.msgs = 0; stats.matched = 0; stats.reconnects = 0;
  }, STATS_EVERY_MS);
  statsTimer.unref();

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    stats.reconnects++;
    feed.reconnects++;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  };

  const connect = () => {
    if (stopped) return;
    const sock = new WebSocket(RTDS_URL);
    ws = sock;
    lastMsgAt = Date.now();

    sock.on('open', () => {
      sock.send(JSON.stringify({ action: 'subscribe', subscriptions: [{ topic: 'activity', type: 'trades' }] }));
      console.log('[rtds] connected');
      feed.connected = true;
      feed.connectedSince = Date.now();
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (Date.now() - lastMsgAt > STALE_MS) {
          console.warn(`[rtds] feed silent for ${STALE_MS / 1000}s — reconnecting`);
          sock.terminate();
          return;
        }
        if (sock.readyState === WebSocket.OPEN) sock.send('PING');
      }, PING_MS);
    });

    sock.on('message', (data: WebSocket.RawData) => {
      lastMsgAt = Date.now();
      backoffMs = 1_000; // a delivering connection resets the backoff
      stats.msgs++;
      countFeedMessage(lastMsgAt);
      let payload: Record<string, unknown> | undefined;
      try { payload = JSON.parse(data.toString()).payload; } catch { return; } // PONGs etc.
      if (!payload || typeof payload.proxyWallet !== 'string') return;
      const wallet = payload.proxyWallet.toLowerCase();
      if (!isWatched(wallet)) return;
      const item = rtdsPayloadToActivity(payload);
      if (!item) return;
      stats.matched++;
      feed.watchedTrades++;
      onTrade(wallet, item);
    });

    sock.on('close', () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (ws === sock) { ws = null; feed.connected = false; }
      if (!stopped) {
        console.warn(`[rtds] disconnected — reconnecting in ${backoffMs / 1000}s (data-api polling continues)`);
        scheduleReconnect();
      }
    });

    sock.on('error', err => {
      console.warn('[rtds] socket error:', err.message);
      // 'close' follows 'error' and handles the reconnect.
    });
  };

  connect();

  return () => {
    stopped = true;
    feed.enabled = false;
    feed.connected = false;
    clearInterval(statsTimer);
    if (pingTimer) clearInterval(pingTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.terminate();
  };
}
