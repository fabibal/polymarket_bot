/**
 * Thin wrapper around the Bullpen CLI.
 * Every public function spawns `bullpen <args> --output json` and parses stdout.
 *
 * Exception: getMarketPrice uses the Polymarket Gamma REST API directly
 * (faster, more reliable, no subprocess overhead).
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import https from 'https';

const execFileAsync = promisify(execFile);
const BULLPEN_CMD = process.env.BULLPEN_CMD ?? 'bullpen';
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB — discover output can be ~1 MB

async function run(args: string[]): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync(BULLPEN_CMD, args, { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    return JSON.parse(stdout.trim());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`bullpen ${args.join(' ')} failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Response shapes (loosely typed — real CLI output may vary)
// ---------------------------------------------------------------------------

export interface RawLeaderboardItem {
  rank?: number;
  address: string;
  username?: string;
  pnl?: string | number;      // comes back as string e.g. "22053933.75"
  volume?: string | number;   // comes back as string e.g. "43013258.51"
  win_rate?: number | null;
  trades_count?: number | null;
  [key: string]: unknown;
}

export type RawLeaderboardResponse =
  | RawLeaderboardItem[]
  | { count?: number; items?: RawLeaderboardItem[]; data?: RawLeaderboardItem[]; [key: string]: unknown };

export interface RawActivityItem {
  transaction_hash?: string;
  timestamp?: string;
  slug?: string;
  title?: string;
  outcome?: string;
  side?: string;   // 'BUY' | 'SELL' | '' (empty for REDEEM/MERGE etc.)
  type?: string;   // 'TRADE' | 'REDEEM' | 'MERGE' | 'SPLIT' | ...
  price?: number;
  size?: number;   // token amount
  usdc_size?: number;
  [key: string]: unknown;
}

export interface RawPriceOutcome {
  outcome: string;       // e.g. "Yes" / "No"
  token_id?: string;
  midpoint?: number | null;
  last_trade?: number | null;
  best_bid?: number | null;
  best_ask?: number | null;
  spread?: number | null;
}

export interface RawPriceResponse {
  question?: string;
  slug?: string;
  outcomes?: RawPriceOutcome[];   // array, NOT a map
  tick_size?: number;
  fee_bps?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getLeaderboard(limit = 10): Promise<RawLeaderboardResponse> {
  return run([
    'polymarket', 'data', 'leaderboard',
    '--period', 'week',
    '--limit', String(limit),
    '--output', 'json',
  ]) as Promise<RawLeaderboardResponse>;
}

const DATA_API_BASE = 'https://data-api.polymarket.com';
const ACTIVITY_PAGE_SIZE = 500; // API max per request
const ACTIVITY_MAX_PAGES = 3;   // 3 × 500 = 1 500 trades max

export async function getTraderActivity(
  address: string,
  limit: number,
  since?: string,
  side?: 'buy' | 'sell'
): Promise<RawActivityItem[]> {
  const sinceMs = since ? new Date(since).getTime() : 0;
  const results: RawActivityItem[] = [];

  for (let page = 0; page < ACTIVITY_MAX_PAGES; page++) {
    const offset = page * ACTIVITY_PAGE_SIZE;
    let url = `${DATA_API_BASE}/activity?user=${encodeURIComponent(address)}&limit=${ACTIVITY_PAGE_SIZE}&offset=${offset}`;
    if (side) url += `&side=${side.toUpperCase()}`;

    let data: Array<Record<string, unknown>>;
    try {
      data = await httpsGet(url) as Array<Record<string, unknown>>;
    } catch {
      break;
    }
    if (!Array.isArray(data) || data.length === 0) break;

    let hitSince = false;
    for (const item of data) {
      // API returns newest-first; stop once we reach items older than `since`
      const tsMs = typeof item.timestamp === 'number' ? item.timestamp * 1000 : 0;
      if (sinceMs > 0 && tsMs <= sinceMs) { hitSince = true; break; }

      results.push({
        transaction_hash: item.transactionHash != null ? String(item.transactionHash) : undefined,
        timestamp: typeof item.timestamp === 'number'
          ? new Date(item.timestamp * 1000).toISOString()
          : String(item.timestamp ?? ''),
        slug:      item.slug      != null ? String(item.slug)      : undefined,
        title:     item.title     != null ? String(item.title)     : undefined,
        outcome:   item.outcome   != null ? String(item.outcome)   : undefined,
        side:      item.side      != null ? String(item.side)      : undefined,
        type:      item.type      != null ? String(item.type)      : undefined,
        price:     item.price     != null ? Number(item.price)     : undefined,
        size:      item.size      != null ? Number(item.size)      : undefined,
        usdc_size: item.usdcSize  != null ? Number(item.usdcSize)  : undefined,
      });
    }

    // NOTE: deliberately do NOT break on `results.length >= limit` here. Doing so
    // truncated paging before reaching `hitSince`, so the caller's cursor could
    // advance past unseen trades and drop them permanently (H1). Page until we
    // actually reach an item older than `since` (hitSince) or exhaust the pages.
    if (hitSince || data.length < ACTIVITY_PAGE_SIZE) break;
  }

  return results.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Direct Gamma REST API — no bullpen subprocess, no auth required
// ---------------------------------------------------------------------------

function httpsPost(url: string, body: unknown, headers: Record<string, string>, timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          ...headers,
        },
        timeout: timeoutMs,
      },
      res => {
        let buf = '';
        res.on('data', (chunk: Buffer) => { buf += chunk; });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode} from ${url}: ${buf.slice(0, 200)}`));
            return;
          }
          try { resolve(JSON.parse(buf)); }
          catch { reject(new Error(`Invalid JSON from ${url}`)); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout (${timeoutMs}ms) posting to ${url}`)); });
    req.write(bodyStr);
    req.end();
  });
}

function httpsGet(url: string, timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout (${timeoutMs}ms) fetching ${url}`)); });
  });
}

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

export async function getMarketPrice(slug: string): Promise<RawPriceResponse> {
  const url = `${GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}`;
  const data = await httpsGet(url) as unknown[];

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`No market found for slug: ${slug}`);
  }

  const market = data[0] as Record<string, unknown>;

  let outcomes: string[] = [];
  let prices: string[]   = [];
  try { outcomes = JSON.parse(market.outcomes as string ?? '[]'); } catch {}
  try { prices   = JSON.parse(market.outcomePrices as string ?? '[]'); } catch {}

  if (outcomes.length === 0) throw new Error(`No outcomes for slug: ${slug}`);

  return {
    question: market.question as string | undefined,
    slug:     market.slug     as string | undefined,
    outcomes: outcomes.map((name, i) => ({
      outcome:    name,
      midpoint:   prices[i] != null ? Number(prices[i]) : null,
      last_trade: null,
      best_bid:   null,
      best_ask:   null,
      spread:     null,
    })),
  };
}

export interface RawGammaMarket {
  id: string;
  question: string;
  slug: string;
  outcomes: string;       // JSON string: '["Yes","No"]'
  outcomePrices: string;  // JSON string: '["0.7","0.3"]'
  volume: number;
  volume24hr: number;
  active: boolean;
  closed: boolean;
  events?: Array<{ slug: string; title: string; [key: string]: unknown }>;
}

export interface OrderbookDepth {
  bestAsk: number;
  bestBid: number;
  spread: number;
  askDepth5: number;   // $ within 5% of best_ask
  askDepth10: number;  // $ within 10% of best_ask
}

const CLOB_BASE = 'https://clob.polymarket.com';

/**
 * Fetch CLOB order book depth for one outcome of a market.
 * Two HTTPS calls: Gamma (slug → clobTokenIds[]) + CLOB /book.
 * Returns null on any failure or missing data — callers treat as "unknown".
 */
export async function getOrderbookDepth(
  slug: string,
  outcome: string,
): Promise<OrderbookDepth | null> {
  try {
    const data = await httpsGet(`${GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}`) as unknown[];
    if (!Array.isArray(data) || data.length === 0) return null;
    const market = data[0] as Record<string, unknown>;
    let outcomes: string[] = [];
    let tokenIds: string[] = [];
    try { outcomes = JSON.parse(market.outcomes as string ?? '[]'); } catch {}
    try { tokenIds = JSON.parse(market.clobTokenIds as string ?? '[]'); } catch {}
    const idx = outcomes.findIndex(o => o.toLowerCase() === outcome.toLowerCase());
    if (idx === -1 || !tokenIds[idx]) return null;

    const book = await httpsGet(`${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenIds[idx])}`) as any;
    if (!book || !Array.isArray(book.asks) || !Array.isArray(book.bids)) return null;

    // Polymarket /book returns asks sorted DESC by price; bids sorted ASC by price.
    // Best ask = lowest ask price (last entry); best bid = highest bid price (last entry).
    const asks = book.asks.map((a: any) => ({ price: Number(a.price), size: Number(a.size) }))
      .filter((a: any) => Number.isFinite(a.price) && Number.isFinite(a.size));
    const bids = book.bids.map((b: any) => ({ price: Number(b.price), size: Number(b.size) }))
      .filter((b: any) => Number.isFinite(b.price) && Number.isFinite(b.size));
    if (asks.length === 0 || bids.length === 0) return null;

    asks.sort((a: any, b: any) => a.price - b.price);
    bids.sort((a: any, b: any) => b.price - a.price);
    const bestAsk = asks[0].price;
    const bestBid = bids[0].price;
    const ceil5  = bestAsk * 1.05;
    const ceil10 = bestAsk * 1.10;
    let askDepth5 = 0, askDepth10 = 0;
    for (const a of asks) {
      if (a.price <= ceil5)  askDepth5  += a.price * a.size;
      if (a.price <= ceil10) askDepth10 += a.price * a.size;
      else break;
    }
    return { bestAsk, bestBid, spread: bestAsk - bestBid, askDepth5, askDepth10 };
  } catch {
    return null;
  }
}

export async function getGammaTrendingMarkets(): Promise<RawGammaMarket[]> {
  const url = `${GAMMA_BASE}/markets?active=true&closed=false&order=volume&ascending=false&limit=10`;
  const data = await httpsGet(url) as unknown[];
  return Array.isArray(data) ? (data as RawGammaMarket[]) : [];
}

export interface RawProfileResponse {
  address?: string;
  volume?: string | number | null;
  trades_count?: number | null;
  win_rate?: number | null;        // Always null — Polymarket API does not expose win rate
  biggest_win?: string | null;
  account_age_days?: number | null;
  name?: string | null;
  pseudonym?: string | null;
  recent_trades?: unknown[] | null;
  error?: string;
  [key: string]: unknown;
}

// NOTE: The Polymarket profile API never returns win_rate (always null).
// Use only for trades_count / biggest_win display.
export async function getTraderProfile(address: string): Promise<RawProfileResponse> {
  return run([
    'polymarket', 'data', 'profile',
    address,           // positional arg — NOT --trades <ADDRESS>
    '--output', 'json',
  ]) as Promise<RawProfileResponse>;
}

// ---------------------------------------------------------------------------
// Falcon (Polymarket Analytics) Leaderboard — agent 579
// ---------------------------------------------------------------------------

export interface RawFalconTrader {
  address: string;
  rank?: number;
  total_pnl?: number;
  roi?: number;           // fraction, e.g. 1.505 means 150.5% (multiply by 100 for display)
  win_rate?: number;      // 0–1 fraction
  sharpe_ratio?: number;
  total_trades?: number;
  markets_traded?: number;
  avg_trade_size?: number;
  total_invested?: number;
  [key: string]: unknown;
}

const FALCON_API_URL = 'https://narrative.agent.heisenberg.so/api/v2/semantic/retrieve/parameterized';

function parseFalconField(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return isNaN(n) ? undefined : n;
}

export async function getFalconLeaderboard(): Promise<RawFalconTrader[]> {
  const apiKey = process.env.FALCON_API_KEY ?? '';
  if (!apiKey) return [];

  const body = {
    agent_id: 579,
    params: { wallet_address: 'ALL', leaderboard_period: '30d' },
    pagination: { limit: 100, offset: 0 },
    formatter_config: { format_type: 'raw' },
  };

  const data = await httpsPost(FALCON_API_URL, body, { Authorization: `Bearer ${apiKey}` });

  // Find the array of trader records in the (possibly nested) response
  let raw: unknown[] | null = null;
  if (Array.isArray(data)) {
    raw = data;
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      raw = obj.data;
    } else if (obj.data && typeof obj.data === 'object') {
      // Shape: { data: { results: [...] } }
      const inner = obj.data as Record<string, unknown>;
      if (Array.isArray(inner.results)) raw = inner.results;
      else if (Array.isArray(inner.items)) raw = inner.items;
    }
    if (!raw) {
      if (Array.isArray(obj.results)) raw = obj.results;
      else if (Array.isArray(obj.items)) raw = obj.items;
    }
  }

  if (!raw) return [];

  // Normalize: API returns numbers as strings — convert to number
  return (raw as Record<string, unknown>[]).map(item => ({
    address:        String(item.address ?? ''),
    rank:           parseFalconField(item.rank),
    total_pnl:      parseFalconField(item.total_pnl),
    roi:            parseFalconField(item.roi),           // fraction (0.18 = 18%)
    win_rate:       parseFalconField(item.win_rate),      // fraction (0-1)
    sharpe_ratio:   parseFalconField(item.sharpe_ratio),
    total_trades:   parseFalconField(item.total_trades),
    markets_traded: parseFalconField(item.markets_traded),
    avg_trade_size: parseFalconField(item.avg_trade_size),
    total_invested: parseFalconField(item.total_invested),
  })).filter(t => t.address.length > 0);
}

/** Check VPN connectivity by attempting a leaderboard call with a 5-second timeout. */
export async function checkVpnConnectivity(): Promise<boolean> {
  try {
    await execFileAsync(BULLPEN_CMD, ['polymarket', 'data', 'leaderboard', '--output', 'json'], {
      timeout: 5_000,
      maxBuffer: 512 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}
