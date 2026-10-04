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

// Feed status for the dashboard header, one entry per parallel connection.
interface FeedState {
  connected: boolean;
  connectedSince: number | null;
  lastMessageAt: number | null;
  reconnects: number;
  // Per-second message counts over the last RATE_WINDOW_S seconds (ring).
  counts: number[];
  secs: number[];
}
const newFeed = (): FeedState => ({
  connected: false, connectedSince: null, lastMessageAt: null, reconnects: 0,
  counts: new Array<number>(RATE_WINDOW_S).fill(0), secs: new Array<number>(RATE_WINDOW_S).fill(-1),
});
let feeds: FeedState[] = [];
let enabled = false;
let watchedTrades = 0;

function feedAt(conn: number): FeedState {
  while (feeds.length <= conn) feeds.push(newFeed());
  return feeds[conn];
}

export function _resetFeedStatusForTests(): void {
  feeds = []; enabled = false; watchedTrades = 0;
}

export function countFeedMessage(nowMs: number, conn = 0): void {
  const f = feedAt(conn);
  f.lastMessageAt = nowMs;
  const sec = Math.floor(nowMs / 1000);
  const i = sec % RATE_WINDOW_S;
  if (f.secs[i] !== sec) { f.secs[i] = sec; f.counts[i] = 0; }
  f.counts[i]++;
}

function rateOf(f: FeedState, nowSec: number): number {
  let n = 0;
  for (let i = 0; i < RATE_WINDOW_S; i++) {
    if (f.secs[i] > nowSec - RATE_WINDOW_S && f.secs[i] <= nowSec) n += f.counts[i];
  }
  return n / RATE_WINDOW_S;
}

export interface RtdsStatus {
  enabled: boolean;
  connected: boolean;          // at least one connection is up
  connections: number;
  connectedCount: number;
  connectedSince: string | null;
  lastMessageAgoMs: number | null;  // newest message on any connection
  msgsPerSec: number;          // busiest connection, mean over the last minute
  watchedTrades: number;       // since process start, after de-duplication
  reconnects: number;          // all connections, since process start
}

export function getRtdsStatus(nowMs: number = Date.now()): RtdsStatus {
  const nowSec = Math.floor(nowMs / 1000);
  const up = feeds.filter(f => f.connected);
  const last = Math.max(-Infinity, ...feeds.map(f => f.lastMessageAt ?? -Infinity));
  const since = Math.min(Infinity, ...up.map(f => f.connectedSince ?? Infinity));
  return {
    enabled,
    connected: up.length > 0,
    connections: feeds.length,
    connectedCount: up.length,
    connectedSince: Number.isFinite(since) ? new Date(since).toISOString() : null,
    lastMessageAgoMs: Number.isFinite(last) ? nowMs - last : null,
    msgsPerSec: Math.max(0, ...feeds.map(f => rateOf(f, nowSec))),
    watchedTrades,
    reconnects: feeds.reduce((s, f) => s + f.reconnects, 0),
  };
}

/**
 * Every connection receives every trade, so the first copy wins. The key is the
 * whole fill (two fills in one transaction differ in size or price), kept for
 * the last `limit` fills.
 */
export function makeFillDeduper(limit = 5_000): (key: string) => boolean {
  const seen = new Set<string>();
  return key => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > limit) seen.delete(seen.values().next().value as string);
    return true;
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
 * Opens `connections` independent sockets and keeps each reconnecting
 * (exponential backoff) until the returned stop function is called. The socket
 * stalls ~2.5 times an hour; while one is silent the others keep delivering,
 * instead of the trade waiting ~30s for the data-api poll. `isWatched` gets the
 * lowercase wallet of every trade; `onTrade` is called once per watched fill.
 */
export function startRtds(
  isWatched: (wallet: string) => boolean,
  onTrade: (wallet: string, item: RawActivityItem) => void,
  connections = 1,
): () => void {
  const firstSight = makeFillDeduper();
  const stops: Array<() => void> = [];
  enabled = true;
  for (let i = 0; i < connections; i++) {
    stops.push(startConnection(i, connections > 1 ? `[rtds#${i + 1}]` : '[rtds]', isWatched, (wallet, item, key) => {
      if (!firstSight(key)) return;
      watchedTrades++;
      onTrade(wallet, item);
    }));
  }
  return () => {
    enabled = false;
    for (const stop of stops) stop();
  };
}

function startConnection(
  conn: number,
  tag: string,
  isWatched: (wallet: string) => boolean,
  onTrade: (wallet: string, item: RawActivityItem, key: string) => void,
): () => void {
  const feed = feedAt(conn);
  let ws: WebSocket | null = null;
  let stopped = false;
  let backoffMs = 1_000;
  let lastMsgAt = 0;
  let pingTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  const stats = { msgs: 0, matched: 0, reconnects: 0 };

  const statsTimer = setInterval(() => {
    console.log(`${tag} last ${STATS_EVERY_MS / 60_000}m: ${stats.msgs} msgs, ${stats.matched} watched trades, ${stats.reconnects} reconnects`);
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
      console.log(`${tag} connected`);
      feed.connected = true;
      feed.connectedSince = Date.now();
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (Date.now() - lastMsgAt > STALE_MS) {
          console.warn(`${tag} feed silent for ${STALE_MS / 1000}s — reconnecting`);
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
      countFeedMessage(lastMsgAt, conn);
      let payload: Record<string, unknown> | undefined;
      try { payload = JSON.parse(data.toString()).payload; } catch { return; } // PONGs etc.
      if (!payload || typeof payload.proxyWallet !== 'string') return;
      const wallet = payload.proxyWallet.toLowerCase();
      if (!isWatched(wallet)) return;
      const item = rtdsPayloadToActivity(payload);
      if (!item) return;
      stats.matched++;
      const key = [wallet, item.transaction_hash, item.slug, item.outcome, item.side, item.size, item.price].join('|');
      onTrade(wallet, item, key);
    });

    sock.on('close', () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (ws === sock) { ws = null; feed.connected = false; }
      if (!stopped) {
        console.warn(`${tag} disconnected — reconnecting in ${backoffMs / 1000}s (data-api polling continues)`);
        scheduleReconnect();
      }
    });

    sock.on('error', err => {
      console.warn(`${tag} socket error:`, err.message);
      // 'close' follows 'error' and handles the reconnect.
    });
  };

  connect();

  return () => {
    stopped = true;
    feed.connected = false;
    clearInterval(statsTimer);
    if (pingTimer) clearInterval(pingTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.terminate();
  };
}
