/**
 * Polygon on-chain trade feed: `OrderFilled` events of Polymarket's two
 * exchange contracts, filtered server-side to the copy-enabled wallets.
 *
 * The RTDS socket drops trades in news bursts (2026-10-05: all 4 Fed-decision
 * and all 3 ISM-release fills of LowFreq-Events were missing on both sockets),
 * and those then waited ~40-50s for the data-api poll, when prices move most.
 * A block lands regardless of exchange load, so the chain sees them in ~2s.
 * The poll stays as the backfill and the processedTradeIds dedup (tx hash)
 * keeps whichever source is first.
 *
 * Event layout (verified against data-api fills, 2026-10-05):
 *   topics: [ORDER_FILLED_TOPIC, orderHash, maker, taker]
 *   data:   side (0 BUY, 1 SELL), tokenId, makerAmountFilled, takerAmountFilled, fee, ...
 * maker = the wallet whose order filled; for a taker order the taker topic is
 * the exchange itself. BUY: maker pays USDC (makerAmount) for tokens
 * (takerAmount); SELL: the reverse. Amounts have 6 decimals.
 */
import https from 'https';
import WebSocket from 'ws';
import type { RawActivityItem, TokenMarket } from './bullpen';
import { makeFillDeduper } from './rtds';

export const EXCHANGES = [
  '0xe111180000d2663c0091e4f400237545b87b996b', // binary markets
  '0xe2222d279d744050d28e00520010520000310f59', // negRisk markets
];
export const ORDER_FILLED_TOPIC = '0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee';
const RPC_URL = 'wss://polygon-bor-rpc.publicnode.com';
const HEARTBEAT_MS = 30_000;      // eth_blockNumber; an unanswered one means a dead socket
const RESUBSCRIBE_CHECK_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;

// The push subscription alone silently drops fills (2026-10-06..10: 7 of 17
// while "connected"), so every SWEEP_MS an eth_getLogs over HTTPS re-reads the
// newest blocks. It is a separate path on purpose: publicnode's backends
// disagree on the chain head ("invalid block range params") and its sticky
// socket times out, which made about a third of the sweeps over that socket
// fail. Providers are tried in order; drpc comes first: a 10-minute probe at the
// sweep cadence (2026-10-10, 120 sweeps) gave drpc 0 errors in 240 calls and
// publicnode 37 failed getLogs (35 invalid block range, 2 timeouts).
export const SWEEP_ENDPOINTS = ['https://polygon.drpc.org', 'https://polygon-bor-rpc.publicnode.com'];
const SWEEP_MS = 5_000;
const SWEEP_TIMEOUT_MS = 3_000;   // per HTTP call
const SWEEP_OVERLAP_BLOCKS = 4;   // the newest blocks are re-read: a lagging backend may not have indexed them yet
const MAX_CATCHUP_BLOCKS = 600;   // ~20 min of Polygon blocks after a long outage
const SWEEP_SUMMARY_MS = 30 * 60_000;

export interface ChainLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
  blockTimestamp?: string;   // sent by some providers (drpc); saves the block lookup
  logIndex?: string;
  removed?: boolean;
}

export interface DecodedFill {
  wallet: string;
  side: 'BUY' | 'SELL';
  tokenId: string;
  price: number;
  size: number;   // tokens
  usdc: number;
  tx: string;
  blockNumber: number;
}

export function decodeOrderFilled(log: ChainLog): DecodedFill | null {
  if (log.removed) return null;
  if (!EXCHANGES.includes(String(log.address).toLowerCase())) return null;
  if (!log.topics || log.topics.length < 4 || log.topics[0].toLowerCase() !== ORDER_FILLED_TOPIC) return null;
  const hex = String(log.data ?? '').replace(/^0x/, '');
  if (hex.length < 64 * 4) return null;
  const word = (i: number) => BigInt('0x' + hex.slice(64 * i, 64 * (i + 1)));
  const sideWord = word(0);
  const side = sideWord === 0n ? 'BUY' : sideWord === 1n ? 'SELL' : null;
  if (!side) return null;
  const makerAmount = Number(word(2)) / 1e6;
  const takerAmount = Number(word(3)) / 1e6;
  const size = side === 'BUY' ? takerAmount : makerAmount;
  const usdc = side === 'BUY' ? makerAmount : takerAmount;
  if (!(size > 0) || !(usdc > 0)) return null;
  const price = usdc / size;
  if (!(price > 0 && price <= 1)) return null;
  return {
    wallet: '0x' + log.topics[2].slice(-40).toLowerCase(),
    side,
    tokenId: word(1).toString(),
    price,
    size,
    usdc,
    tx: log.transactionHash,
    blockNumber: parseInt(log.blockNumber, 16),
  };
}

/** The same item shape the data-api poll and RTDS produce. */
export function fillToActivity(f: DecodedFill, m: TokenMarket, blockTimeMs: number): RawActivityItem {
  return {
    transaction_hash: f.tx,
    timestamp: new Date(blockTimeMs).toISOString(),
    slug: m.slug,
    title: m.title,
    outcome: m.outcome,
    side: f.side,
    type: 'TRADE',
    price: f.price,
    size: f.size,
    usdc_size: f.usdc,
  };
}

const pad32 = (addr: string) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');

export interface ChainFeedStatus {
  enabled: boolean;
  connected: boolean;
  connectedSince: string | null;
  wallets: number;
  lastHeartbeatAgoMs: number | null;
  fills: number;              // decoded fills of watched wallets since start
  lastFillAt: string | null;
  unresolved: number;         // fills whose token could not be mapped to a market
  reconnects: number;
  recovered: number;          // fills the sweep delivered before the subscription did (or without it)
  sweepOk: number;            // sweeps that read the newest blocks from at least one provider
  sweepFailed: number;        // sweeps where every provider failed
  lastSweepOkAgoMs: number | null;
}

const status = {
  enabled: false, connected: false, connectedSince: null as number | null, wallets: 0,
  lastHeartbeatAt: null as number | null, fills: 0, lastFillAt: null as number | null,
  unresolved: 0, reconnects: 0, recovered: 0,
  sweepOk: 0, sweepFailed: 0, lastSweepOkAt: null as number | null,
};

export function getChainFeedStatus(nowMs: number = Date.now()): ChainFeedStatus {
  return {
    enabled: status.enabled,
    connected: status.connected,
    connectedSince: status.connectedSince != null ? new Date(status.connectedSince).toISOString() : null,
    wallets: status.wallets,
    lastHeartbeatAgoMs: status.lastHeartbeatAt != null ? nowMs - status.lastHeartbeatAt : null,
    fills: status.fills,
    lastFillAt: status.lastFillAt != null ? new Date(status.lastFillAt).toISOString() : null,
    unresolved: status.unresolved,
    reconnects: status.reconnects,
    recovered: status.recovered,
    sweepOk: status.sweepOk,
    sweepFailed: status.sweepFailed,
    lastSweepOkAgoMs: status.lastSweepOkAt != null ? nowMs - status.lastSweepOkAt : null,
  };
}

// ── HTTPS sweep ─────────────────────────────────────────────────────────────
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

/** One JSON-RPC call over HTTPS with a hard deadline; rejects with the node's own error message. */
export function rpcPost(endpoint: string, method: string, params: unknown[], timeoutMs = SWEEP_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    let deadline: NodeJS.Timeout;
    const fail = (err: Error) => { clearTimeout(deadline); reject(err); };
    const req = https.request(endpoint, {
      method: 'POST',
      agent: httpsAgent,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': 'polymarket-bot' },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { data += c; });
      res.on('error', fail);
      res.on('end', () => {
        clearTimeout(deadline);
        let j: { result?: unknown; error?: { message?: string } };
        try { j = JSON.parse(data); } catch { reject(new Error(`http ${res.statusCode}`)); return; }
        if (j.error) reject(new Error(j.error.message ?? 'rpc error')); else resolve(j.result);
      });
    });
    deadline = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('error', fail);
    req.end(body);
  });
}

/** A short, countable label for an RPC failure. */
export function sweepReason(err: unknown): string {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (m.includes('timeout') || m.includes('timed out')) return 'timeout';
  if (m.includes('invalid block range')) return 'invalid block range';
  if (m.includes('node behind')) return 'node behind';
  if (m.includes('eai_again') || m.includes('enotfound')) return 'dns';
  const http = m.match(/^http (\d{3})/);
  return http ? `http ${http[1]}` : m.slice(0, 40);
}

export interface SweeperOptions {
  endpoints: string[];
  call: (endpoint: string, method: string, params: unknown[]) => Promise<unknown>;
  /** Log filter topics for the current wallets; null when there is nothing to watch. */
  getTopics: () => unknown[] | null;
  onLogs: (logs: ChainLog[], endpoint: string) => Promise<void>;
}

/**
 * Re-reads the newest blocks with eth_getLogs. `nextFrom` only moves after a
 * successful read, so an outage is swept up the moment any provider answers
 * again (at most MAX_CATCHUP_BLOCKS back). A provider that reports a head behind
 * the blocks already read is treated as failed rather than trusted.
 */
export function makeSweeper(opts: SweeperOptions) {
  let nextFrom: number | null = null;
  let running = false;
  const stats = { ok: 0, failed: 0, lastOkAt: null as number | null };
  const window = { ok: 0, failed: 0, byEndpoint: new Map<string, { ok: number; failed: number }>(), reasons: new Map<string, number>() };
  const slot = (ep: string) => {
    let s = window.byEndpoint.get(ep);
    if (!s) { s = { ok: 0, failed: 0 }; window.byEndpoint.set(ep, s); }
    return s;
  };

  const readOnce = async (ep: string, topics: unknown[]): Promise<ChainLog[]> => {
    const head = parseInt(String(await opts.call(ep, 'eth_blockNumber', [])), 16);
    if (!Number.isFinite(head)) throw new Error('bad block number');
    if (nextFrom != null && head < nextFrom) throw new Error('node behind');
    const from = nextFrom == null ? head - SWEEP_OVERLAP_BLOCKS + 1 : Math.max(nextFrom, head - MAX_CATCHUP_BLOCKS + 1);
    const logs = await opts.call(ep, 'eth_getLogs', [{ address: EXCHANGES, topics, fromBlock: '0x' + from.toString(16), toBlock: '0x' + head.toString(16) }]);
    if (!Array.isArray(logs)) throw new Error('bad logs');
    nextFrom = Math.max(nextFrom ?? 0, head - SWEEP_OVERLAP_BLOCKS + 1);
    return logs as ChainLog[];
  };

  /** true when some provider delivered the newest blocks. */
  const sweep = async (): Promise<boolean> => {
    const topics = opts.getTopics();
    if (!topics || running) return false;
    running = true;
    try {
      for (const ep of opts.endpoints) {
        let logs: ChainLog[];
        try {
          logs = await readOnce(ep, topics);
        } catch (err) {
          slot(ep).failed++;
          const why = sweepReason(err);
          window.reasons.set(why, (window.reasons.get(why) ?? 0) + 1);
          continue;
        }
        slot(ep).ok++;
        window.ok++;
        stats.ok++;
        stats.lastOkAt = Date.now();
        await opts.onLogs(logs, ep);
        return true;
      }
      window.failed++;
      stats.failed++;
      return false;
    } finally {
      running = false;
    }
  };

  /** One line for the periodic log; resets the window. */
  const summary = (): string => {
    const hostOf = (ep: string) => { try { return new URL(ep).hostname; } catch { return ep; } };
    const eps = [...window.byEndpoint].map(([ep, s]) => `${hostOf(ep)} ${s.ok} ok/${s.failed} failed`).join(', ');
    const why = [...window.reasons].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} x${n}`).join(', ');
    const line = `${window.ok} ok, ${window.failed} failed${eps ? ` (${eps})` : ''}${why ? `; errors: ${why}` : ''}`;
    window.ok = 0;
    window.failed = 0;
    window.byEndpoint.clear();
    window.reasons.clear();
    return line;
  };

  return { sweep, summary, stats };
}

/**
 * Subscribes to the watched wallets' fills and keeps reconnecting until the
 * returned stop function is called. `getWallets` is re-read every minute and
 * the subscription follows changes. `resolveToken` maps a token id to its
 * market; a fill it cannot resolve is left to the poll. Independently of the
 * socket, an HTTPS sweep re-reads the newest blocks (see SWEEP_ENDPOINTS).
 */
export function startChainFeed(
  getWallets: () => string[],
  onTrade: (wallet: string, item: RawActivityItem) => void,
  resolveToken: (tokenId: string) => Promise<TokenMarket | null>,
): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let backoffMs = 1_000;
  let nextId = 1;
  let subId: string | null = null;
  let walletKey = '';
  const firstSight = makeFillDeduper(1_000);   // tx:logIndex of fills already handled, whichever path saw them
  let heartbeatPending = false;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let resubTimer: NodeJS.Timeout | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  let summaryTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const blockTimes = new Map<number, number>();
  status.enabled = true;

  const currentWallets = () => [...new Set(getWallets().map(w => w.toLowerCase()))].sort();

  const request = (method: string, params: unknown[]): Promise<unknown> => new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error('socket not open')); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });

  // The socket answers block lookups for pushed fills; sweep-delivered fills (and a
  // closed socket) go over HTTPS, the same path that found them.
  const blockTimeMs = async (n: number, viaHttp: boolean): Promise<number> => {
    const hit = blockTimes.get(n);
    if (hit) return hit;
    try {
      const params = ['0x' + n.toString(16), false];
      const lookup = async (): Promise<unknown> => {
        if (!viaHttp && ws && ws.readyState === WebSocket.OPEN) return request('eth_getBlockByNumber', params);
        let last: unknown = new Error('no provider');
        for (const ep of SWEEP_ENDPOINTS) {
          try { return await rpcPost(ep, 'eth_getBlockByNumber', params); } catch (err) { last = err; }
        }
        throw last;
      };
      const b = await lookup() as { timestamp?: string } | null;
      const t = b?.timestamp ? parseInt(b.timestamp, 16) * 1000 : Date.now();
      if (blockTimes.size > 200) blockTimes.clear();
      blockTimes.set(n, t);
      return t;
    } catch {
      return Date.now(); // a block is ~2s old when its log arrives
    }
  };

  const subscribe = async () => {
    const wallets = currentWallets();
    const key = wallets.join(',');
    if (key === walletKey && subId) return;
    if (subId) { await request('eth_unsubscribe', [subId]).catch(() => undefined); subId = null; }
    walletKey = key;
    status.wallets = wallets.length;
    if (wallets.length === 0) return;
    const filter = { address: EXCHANGES, topics: [ORDER_FILLED_TOPIC, null, wallets.map(pad32)] };
    subId = String(await request('eth_subscribe', ['logs', filter]));
    console.log(`[chain] subscribed to fills of ${wallets.length} wallet(s)`);
  };

  const handleLog = async (log: ChainLog, viaSweep = false) => {
    const f = decodeOrderFilled(log);
    if (!f) return;
    if (!firstSight(`${log.transactionHash}:${log.logIndex ?? ''}`)) return;
    if (viaSweep) {
      status.recovered++;
      console.warn(`[chain] fill of tx ${f.tx.slice(0, 12)}… reached us through the sweep before the subscription`);
    }
    status.fills++;
    status.lastFillAt = Date.now();
    const market = await resolveToken(f.tokenId);
    if (!market) {
      status.unresolved++;
      console.warn(`[chain] token ${f.tokenId.slice(0, 12)}… of tx ${f.tx.slice(0, 12)}… not found on Gamma — left to the poll`);
      return;
    }
    const stamped = log.blockTimestamp ? parseInt(log.blockTimestamp, 16) * 1000 : NaN;
    onTrade(f.wallet, fillToActivity(f, market, Number.isFinite(stamped) ? stamped : await blockTimeMs(f.blockNumber, viaSweep)));
  };

  const sweeper = makeSweeper({
    endpoints: SWEEP_ENDPOINTS,
    call: rpcPost,
    getTopics: () => {
      const wallets = currentWallets();
      status.wallets = wallets.length;
      return wallets.length > 0 ? [ORDER_FILLED_TOPIC, null, wallets.map(pad32)] : null;
    },
    onLogs: async logs => {
      for (const log of logs) {
        await handleLog(log, true).catch(err => console.error('[chain] fill handling failed:', err instanceof Error ? err.message : err));
      }
    },
  });

  const runSweep = async () => {
    try { await sweeper.sweep(); } catch (err) { console.error('[chain] sweep handling failed:', err instanceof Error ? err.message : err); }
    status.sweepOk = sweeper.stats.ok;
    status.sweepFailed = sweeper.stats.failed;
    status.lastSweepOkAt = sweeper.stats.lastOkAt;
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    status.reconnects++;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  };

  const clearTimers = () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (resubTimer) { clearInterval(resubTimer); resubTimer = null; }
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('socket closed')); }
    pending.clear();
  };

  const connect = () => {
    if (stopped) return;
    const sock = new WebSocket(RPC_URL);
    ws = sock;
    subId = null;
    walletKey = '';

    sock.on('open', () => {
      status.connected = true;
      status.connectedSince = Date.now();
      status.lastHeartbeatAt = Date.now();
      heartbeatPending = false;
      subscribe().then(() => { backoffMs = 1_000; }).catch(err => {
        console.warn('[chain] subscribe failed:', err.message);
        sock.terminate();
      });
      heartbeatTimer = setInterval(() => {
        if (heartbeatPending) {
          console.warn('[chain] heartbeat unanswered — reconnecting');
          sock.terminate();
          return;
        }
        heartbeatPending = true;
        request('eth_blockNumber', []).then(() => { heartbeatPending = false; status.lastHeartbeatAt = Date.now(); }).catch(() => undefined);
      }, HEARTBEAT_MS);
      resubTimer = setInterval(() => {
        subscribe().catch(err => { console.warn('[chain] resubscribe failed:', err.message); sock.terminate(); });
      }, RESUBSCRIBE_CHECK_MS);
    });

    sock.on('message', (data: WebSocket.RawData) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: { result?: ChainLog } };
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'rpc error')); else p.resolve(msg.result);
        return;
      }
      if (msg.method === 'eth_subscription' && msg.params?.result) {
        handleLog(msg.params.result).catch(err => console.error('[chain] fill handling failed:', err instanceof Error ? err.message : err));
      }
    });

    sock.on('close', () => {
      clearTimers();
      if (ws === sock) { ws = null; status.connected = false; }
      if (!stopped) {
        console.warn(`[chain] disconnected — reconnecting in ${backoffMs / 1000}s (RTDS and the poll continue)`);
        scheduleReconnect();
      }
    });

    sock.on('error', err => {
      console.warn('[chain] socket error:', err.message);
      // 'close' follows 'error' and handles the reconnect.
    });
  };

  connect();

  // The sweep does not depend on the socket: it keeps reading blocks while the
  // socket is down or reconnecting.
  void runSweep();
  sweepTimer = setInterval(() => { void runSweep(); }, SWEEP_MS);
  summaryTimer = setInterval(() => console.log(`[chain] sweep last ${SWEEP_SUMMARY_MS / 60_000}m: ${sweeper.summary()}`), SWEEP_SUMMARY_MS);
  summaryTimer.unref();

  return () => {
    stopped = true;
    status.enabled = false;
    status.connected = false;
    clearTimers();
    if (sweepTimer) clearInterval(sweepTimer);
    if (summaryTimer) clearInterval(summaryTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.terminate();
  };
}
