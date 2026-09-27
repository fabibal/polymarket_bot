/**
 * Weekly low-frequency discovery results for the dashboard. The Sunday cron
 * (scripts/weekly-lowfreq-scan.sh) writes one run directory per scan with a
 * report.json produced by scripts/lowfreq_scan.js; this module picks the
 * newest one and normalizes it.
 */
import fs from 'fs';
import path from 'path';

export interface LowfreqBacktest {
  pass: boolean;
  failed: string[];
  pnl: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  pnl2x: number | null;
  fees: number | null;
  markets: number | null;
  months: number | null;
}

export interface LowfreqCandidate {
  address: string;
  source: string | null;
  pnl: number | null;       // trader's own PnL on the leaderboard
  volume: number | null;
  orders30: number | null;
  markets30: number | null;
  takerShare: number | null;
  net: number | null;       // closed + open positions netted
  backtest: LowfreqBacktest | null;
}

export interface LowfreqReport {
  ranAt: string | null;
  since: string | null;
  autoAdd: boolean;
  counts: Record<string, number>;
  candidates: LowfreqCandidate[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseLowfreqReport(raw: unknown): LowfreqReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const counts: Record<string, number> = {};
  if (r.counts && typeof r.counts === 'object') {
    for (const [k, v] of Object.entries(r.counts as Record<string, unknown>)) {
      const n = num(v);
      if (n != null) counts[k] = n;
    }
  }
  const evaluated = Array.isArray(r.evaluated) ? r.evaluated : [];
  const candidates: LowfreqCandidate[] = evaluated
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as Record<string, unknown>).a === 'string')
    .map(e => {
      const bt = e.bt && typeof e.bt === 'object' ? e.bt as Record<string, unknown> : null;
      const ci = bt && Array.isArray(bt.ci) ? bt.ci : [];
      return {
        address: String(e.a).toLowerCase(),
        source: typeof e.src === 'string' ? e.src : null,
        pnl: num(e.pnl),
        volume: num(e.vol),
        orders30: num(e.orders30),
        markets30: num(e.markets30),
        takerShare: num(e.takerShare),
        net: num(e.net),
        backtest: bt ? {
          pass: bt.pass === true,
          failed: Array.isArray(bt.failed) ? bt.failed.map(String) : [],
          pnl: num(bt.pnl),
          ciLow: num(ci[0]),
          ciHigh: num(ci[1]),
          pnl2x: num(bt.pnl2x),
          fees: num(bt.fees),
          markets: num(bt.markets),
          months: num(bt.months),
        } : null,
      };
    });
  return {
    ranAt: typeof r.ranAt === 'string' ? r.ranAt : null,
    since: typeof r.since === 'string' ? r.since : null,
    autoAdd: r.autoAdd === true,
    counts,
    candidates,
  };
}

/** Newest run directory that has a report.json (run dirs are named by UTC timestamp). */
export function latestReportFile(runsDir: string): string | null {
  try {
    const dirs = fs.readdirSync(runsDir).filter(d => /^\d{8}T\d{6}Z$/.test(d)).sort().reverse();
    for (const d of dirs) {
      const f = path.join(runsDir, d, 'report.json');
      if (fs.existsSync(f)) return f;
    }
  } catch { /* no runs yet */ }
  return null;
}

/** Next occurrence of a weekly UTC slot (default: Sunday 05:30, the scan's cron). */
export function nextWeeklyRun(nowMs: number, dayOfWeek = 0, hourUtc = 5, minuteUtc = 30): string {
  const d = new Date(nowMs);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc, minuteUtc, 0));
  let add = (dayOfWeek - d.getUTCDay() + 7) % 7;
  if (add === 0 && next.getTime() <= nowMs) add = 7;
  next.setUTCDate(next.getUTCDate() + add);
  return next.toISOString();
}
