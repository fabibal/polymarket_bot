import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseLowfreqReport, latestReportFile, nextWeeklyRun } from '../src/discovery';

describe('parseLowfreqReport', () => {
  it('normalizes the scan report (counts, candidates, backtest CI)', () => {
    const r = parseLowfreqReport({
      ranAt: '2026-09-26T21:37:22.585Z', since: '2025-09-26', autoAdd: false,
      counts: { stage2: 1295, stage3: 31, passed: 0, junk: 'x' },
      evaluated: [
        {
          a: '0xABC', src: 'polymarket', pnl: 207585, vol: 1545037, orders30: 67, markets30: 57,
          takerShare: 0.696, net: 134311,
          bt: { pass: false, failed: ['ciAboveZero'], pnl: -41, ci: [-139, 55], pnl2x: -129, fees: 12, markets: 245, months: 5 },
        },
        { src: 'no address' },
      ],
    });
    expect(r!.counts).toEqual({ stage2: 1295, stage3: 31, passed: 0 });
    expect(r!.candidates).toHaveLength(1);
    expect(r!.candidates[0].address).toBe('0xabc');
    expect(r!.candidates[0].backtest).toEqual({
      pass: false, failed: ['ciAboveZero'], pnl: -41, ciLow: -139, ciHigh: 55, pnl2x: -129, fees: 12, markets: 245, months: 5,
    });
  });

  it('rejects non-objects', () => {
    expect(parseLowfreqReport(null)).toBeNull();
    expect(parseLowfreqReport('x')).toBeNull();
  });
});

describe('latestReportFile', () => {
  it('picks the newest run dir that has a report.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-'));
    for (const d of ['20260920T050000Z', '20260926T212918Z', '20260927T050000Z']) fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, '20260920T050000Z', 'report.json'), '{}');
    fs.writeFileSync(path.join(dir, '20260926T212918Z', 'report.json'), '{}');
    // newest dir has no report yet (scan still running): skipped
    expect(latestReportFile(dir)).toBe(path.join(dir, '20260926T212918Z', 'report.json'));
    expect(latestReportFile(path.join(dir, 'missing'))).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('nextWeeklyRun', () => {
  it('next Sunday 05:30 UTC', () => {
    expect(nextWeeklyRun(Date.parse('2026-09-27T05:00:00Z'))).toBe('2026-09-27T05:30:00.000Z'); // Sunday, before the slot
    expect(nextWeeklyRun(Date.parse('2026-09-27T05:30:00Z'))).toBe('2026-10-04T05:30:00.000Z'); // at the slot: next week
    expect(nextWeeklyRun(Date.parse('2026-09-30T12:00:00Z'))).toBe('2026-10-04T05:30:00.000Z'); // Wednesday
  });
});
