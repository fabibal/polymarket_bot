/**
 * System health for the dashboard: event-loop lag, copy latency, and the
 * one-line status records the cron scripts append to logs/ (mounted read-only
 * at /app/logs). Parsers are pure so they can be tested without the files.
 */
import fs from 'fs';
import path from 'path';
import { monitorEventLoopDelay, IntervalHistogram } from 'perf_hooks';
import type { SimulatedTrade } from './types';

// ── Event-loop lag ──────────────────────────────────────────────────────────
// A blocked loop delays every trade the bot processes: on 2026-09-26 the
// dashboard's observation panel held it ~9s per refresh. The histogram samples
// a 20ms timer, so each value includes those 20ms; lag = value - resolution.
const LOOP_RESOLUTION_MS = 20;
let histogram: IntervalHistogram | null = null;
let lastMinute: LoopLag | null = null;

export interface LoopLag {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  windowEnd: string;
}

export function loopLagFromNs(p50Ns: number, p99Ns: number, maxNs: number, windowEnd: Date): LoopLag {
  const lag = (ns: number) => Math.max(0, ns / 1e6 - LOOP_RESOLUTION_MS);
  return { p50Ms: lag(p50Ns), p99Ms: lag(p99Ns), maxMs: lag(maxNs), windowEnd: windowEnd.toISOString() };
}

/** Starts sampling; the reading rolls over every minute. Idempotent. */
export function startLoopMonitor(): void {
  if (histogram) return;
  const h = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  h.enable();
  histogram = h;
  const timer = setInterval(() => {
    lastMinute = loopLagFromNs(h.percentile(50), h.percentile(99), h.max, new Date());
    h.reset();
  }, 60_000);
  timer.unref();
}

/** Lag over the last full minute (null until the first minute has passed). */
export function getLoopLag(): LoopLag | null {
  return lastMinute;
}

// ── Copy latency ────────────────────────────────────────────────────────────
export interface CopyLatency {
  n: number;
  medianMs: number | null;
  p90Ms: number | null;
  rtdsShare: number | null;  // fraction of copies delivered by the RTDS socket
}

function percentile(sorted: number[], q: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

/** Trader fill -> copy opened, over copies opened in the last `windowMs`. */
export function copyLatencyStats(trades: SimulatedTrade[], nowMs: number, windowMs: number): CopyLatency {
  const lat: number[] = [];
  let rtds = 0;
  for (const t of trades) {
    if (!t.copiedAt) continue;
    const copied = Date.parse(t.copiedAt);
    const filled = Date.parse(t.timestamp);
    if (!Number.isFinite(copied) || !Number.isFinite(filled) || nowMs - copied > windowMs) continue;
    lat.push(Math.max(0, copied - filled));
    if (t.copySource === 'rtds') rtds++;
  }
  if (lat.length === 0) return { n: 0, medianMs: null, p90Ms: null, rtdsShare: null };
  lat.sort((a, b) => a - b);
  return { n: lat.length, medianMs: percentile(lat, 0.5), p90Ms: percentile(lat, 0.9), rtdsShare: rtds / lat.length };
}

// ── Cron status lines ───────────────────────────────────────────────────────
function lastNonEmptyLine(text: string): string | null {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

// "2026-09-26 09:00:01 UTC" -> ISO
function utcStampToIso(s: string): string | null {
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?: UTC|Z)?$/);
  if (!m) return null;
  const iso = `${m[1]}T${m[2].length === 5 ? m[2] + ':00' : m[2]}Z`;
  return Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString() : null;
}

export interface ExpiryStatus {
  checkedAt: string | null;
  level: string;              // OK / WARN / URGENT / ERROR as written by the script
  daysLeft: number | null;
  expiresAt: string | null;
}

/** check-*-expiry.sh line: "<ts> UTC | OK | days_left=18.0 | exp=2026-10-14 09:19 UTC | ..." */
export function parseExpiryLine(line: string | null): ExpiryStatus | null {
  if (!line) return null;
  const parts = line.split('|').map(p => p.trim());
  if (parts.length < 2) return null;
  const kv = (key: string) => parts.find(p => p.startsWith(key + '='))?.slice(key.length + 1) ?? null;
  const days = kv('days_left');
  const exp = kv('exp');
  return {
    checkedAt: utcStampToIso(parts[0]),
    level: parts[1],
    daysLeft: days != null && Number.isFinite(Number(days)) ? Number(days) : null,
    expiresAt: exp ? utcStampToIso(exp) : null,
  };
}

/** git-sync.sh line: "2026-09-27T03:00:01Z <message>" */
export function parseGitSyncLine(line: string | null): { at: string | null; text: string } | null {
  if (!line) return null;
  const m = line.match(/^(\S+)\s+(.*)$/);
  if (!m) return { at: null, text: line };
  const at = Number.isFinite(Date.parse(m[1])) ? new Date(m[1]).toISOString() : null;
  return { at, text: at ? m[2] : line };
}

/** weekly scan line: "<ts> UTC | DONE | stage2=... | ..." */
export function parseScanLine(line: string | null): { at: string | null; status: string; detail: string } | null {
  if (!line) return null;
  const parts = line.split('|').map(p => p.trim());
  return { at: utcStampToIso(parts[0]), status: parts[1] ?? '', detail: parts.slice(2).join(' | ') };
}

export interface WatchdogSummary {
  checks: number;
  fails: number;
  restarts: number;
  lastStatus: string | null;
  lastAt: string | null;
}

/** watchdog.sh lines within `windowMs`: "<ts> UTC | OK|FAIL|RESTART|RESTART_OK | ..." */
export function summarizeWatchdog(text: string, nowMs: number, windowMs: number): WatchdogSummary {
  const out: WatchdogSummary = { checks: 0, fails: 0, restarts: 0, lastStatus: null, lastAt: null };
  for (const raw of text.split('\n')) {
    const parts = raw.split('|').map(p => p.trim());
    if (parts.length < 2) continue;
    const at = utcStampToIso(parts[0]);
    if (!at || nowMs - Date.parse(at) > windowMs) continue;
    const status = parts[1];
    if (status === 'OK' || status === 'FAIL') out.checks++;
    if (status === 'FAIL') out.fails++;
    if (status === 'RESTART') out.restarts++;
    out.lastStatus = status;
    out.lastAt = at;
  }
  return out;
}

/** Last line containing `needle`: alert scripts append SENT lines after the status line. */
export function lastLineMatching(text: string, needle: string): string | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(needle)) return lines[i].trim();
  }
  return null;
}

export function readLastLine(file: string): string | null {
  try { return lastNonEmptyLine(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function readText(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

// ── Database size ───────────────────────────────────────────────────────────
export interface DbInfo {
  sizeBytes: number | null;
  walBytes: number | null;
  growthBytesPerDay: number | null;  // vs the newest daily backup at least a day old
}

export function dbInfo(dbFile: string, backupsDir: string, nowMs: number): DbInfo {
  const size = (f: string) => { try { return fs.statSync(f).size; } catch { return null; } };
  const sizeBytes = size(dbFile);
  const walBytes = size(dbFile + '-wal');
  let growthBytesPerDay: number | null = null;
  try {
    const backups = fs.readdirSync(backupsDir)
      .filter(f => /^store-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .map(f => ({ f, st: fs.statSync(path.join(backupsDir, f)) }))
      .filter(b => nowMs - b.st.mtimeMs >= 86_400_000)
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    if (sizeBytes != null && backups.length > 0) {
      const b = backups[0];
      const days = (nowMs - b.st.mtimeMs) / 86_400_000;
      growthBytesPerDay = (sizeBytes - b.st.size) / days;
    }
  } catch { /* no backups dir */ }
  return { sizeBytes, walBytes, growthBytesPerDay };
}
