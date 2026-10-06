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
import WebSocket from 'ws';
import type { RawActivityItem, TokenMarket } from './bullpen';

export const EXCHANGES = [
  '0xe111180000d2663c0091e4f400237545b87b996b', // binary markets
  '0xe2222d279d744050d28e00520010520000310f59', // negRisk markets
];
export const ORDER_FILLED_TOPIC = '0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee';
const RPC_URL = 'wss://polygon-bor-rpc.publicnode.com';
const HEARTBEAT_MS = 30_000;      // eth_blockNumber; an unanswered one means a dead socket
const RESUBSCRIBE_CHECK_MS = 60_000;
// The node's push subscription silently dropped fills (2026-10-06: 2 of 4 while
// "connected"), so eth_getLogs sweeps the newest blocks as a safety net.
const CATCHUP_MS = 5_000;
const MAX_CATCHUP_BLOCKS = 600;   // ~20 min of Polygon blocks after a long outage
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;

export interface ChainLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
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
  recovered: number;          // fills the subscription never delivered, found by the getLogs sweep
}

const status = {
  enabled: false, connected: false, connectedSince: null as number | null, wallets: 0,
  lastHeartbeatAt: null as number | null, fills: 0, lastFillAt: null as number | null,
  unresolved: 0, reconnects: 0, recovered: 0,
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
  };
}

/**
 * Subscribes to the watched wallets' fills and keeps reconnecting until the
 * returned stop function is called. `getWallets` is re-read every minute and
 * the subscription follows changes. `resolveToken` maps a token id to its
 * market; a fill it cannot resolve is left to the poll.
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
  let filterTopics: unknown[] | null = null;
  let scannedBlock: number | null = null;   // survives reconnects so an outage gap is swept too
  let sweeping = false;
  const seen = new Set<string>();           // tx:logIndex of fills already handled
  let heartbeatPending = false;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let resubTimer: NodeJS.Timeout | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const blockTimes = new Map<number, number>();
  status.enabled = true;

  const request = (method: string, params: unknown[]): Promise<unknown> => new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error('socket not open')); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });

  const blockTimeMs = async (n: number): Promise<number> => {
    const hit = blockTimes.get(n);
    if (hit) return hit;
    try {
      const b = await request('eth_getBlockByNumber', ['0x' + n.toString(16), false]) as { timestamp?: string } | null;
      const t = b?.timestamp ? parseInt(b.timestamp, 16) * 1000 : Date.now();
      if (blockTimes.size > 200) blockTimes.clear();
      blockTimes.set(n, t);
      return t;
    } catch {
      return Date.now(); // a block is ~2s old when its log arrives
    }
  };

  const subscribe = async () => {
    const wallets = [...new Set(getWallets().map(w => w.toLowerCase()))].sort();
    const key = wallets.join(',');
    if (key === walletKey && subId) return;
    if (subId) { await request('eth_unsubscribe', [subId]).catch(() => undefined); subId = null; }
    walletKey = key;
    status.wallets = wallets.length;
    if (wallets.length === 0) return;
    const filter = { address: EXCHANGES, topics: [ORDER_FILLED_TOPIC, null, wallets.map(pad32)] };
    filterTopics = filter.topics;
    subId = String(await request('eth_subscribe', ['logs', filter]));
    console.log(`[chain] subscribed to fills of ${wallets.length} wallet(s)`);
  };

  const handleLog = async (log: ChainLog, viaSweep = false) => {
    const f = decodeOrderFilled(log);
    if (!f) return;
    const key = `${log.transactionHash}:${log.logIndex ?? ''}`;
    if (seen.has(key)) return;
    if (seen.size > 500) seen.clear();
    seen.add(key);
    if (viaSweep) {
      status.recovered++;
      console.warn(`[chain] fill of tx ${f.tx.slice(0, 12)}… was missed by the subscription — recovered by the sweep`);
    }
    status.fills++;
    status.lastFillAt = Date.now();
    const market = await resolveToken(f.tokenId);
    if (!market) {
      status.unresolved++;
      console.warn(`[chain] token ${f.tokenId.slice(0, 12)}… of tx ${f.tx.slice(0, 12)}… not found on Gamma — left to the poll`);
      return;
    }
    onTrade(f.wallet, fillToActivity(f, market, await blockTimeMs(f.blockNumber)));
  };

  const sweep = async () => {
    if (sweeping || !subId || !filterTopics) return;
    sweeping = true;
    try {
      const head = parseInt(String(await request('eth_blockNumber', [])), 16);
      if (!Number.isFinite(head)) return;
      const from = scannedBlock == null ? head : Math.max(scannedBlock, head - MAX_CATCHUP_BLOCKS);
      if (head < from) return;   // a lagging node behind the block already scanned
      const logs = await request('eth_getLogs', [{ address: EXCHANGES, topics: filterTopics, fromBlock: '0x' + from.toString(16), toBlock: '0x' + head.toString(16) }]) as ChainLog[];
      scannedBlock = head - 1;   // the newest block is re-read next time in case the node was still indexing it
      for (const log of logs ?? []) await handleLog(log, true);
    } catch (err) {
      console.warn('[chain] sweep failed:', err instanceof Error ? err.message : err);
    } finally {
      sweeping = false;
    }
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
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
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
      sweepTimer = setInterval(() => { void sweep(); }, CATCHUP_MS);
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

  return () => {
    stopped = true;
    status.enabled = false;
    status.connected = false;
    clearTimers();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.terminate();
  };
}
