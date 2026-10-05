import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loopLagFromNs, copyLatencyStats, parseExpiryLine, parseGitSyncLine, parseScanLine,
  summarizeWatchdog, dbInfo, lastLineMatching,
} from '../src/health';
import { SimulatedTrade } from '../src/types';

describe('loopLagFromNs', () => {
  it('subtracts the 20ms sampling interval and never goes negative', () => {
    const r = loopLagFromNs(20_100_000, 21_200_000, 317_700_000, new Date('2026-09-27T00:00:00Z'));
    expect(r.p50Ms).toBeCloseTo(0.1, 6);
    expect(r.p99Ms).toBeCloseTo(1.2, 6);
    expect(r.maxMs).toBeCloseTo(297.7, 6);
    expect(loopLagFromNs(19_000_000, 0, 0, new Date()).p50Ms).toBe(0);
  });
});

describe('copyLatencyStats', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const t = (fillIso: string, copiedIso: string | undefined, src?: 'poll' | 'rtds') => ({
    timestamp: fillIso, copiedAt: copiedIso, copySource: src,
  } as unknown as SimulatedTrade);

  it('median/p90 of fill -> copy, rtds share, only copies inside the window', () => {
    const r = copyLatencyStats([
      t('2026-09-27T11:00:00Z', '2026-09-27T11:00:01Z', 'rtds'),
      t('2026-09-27T11:00:00Z', '2026-09-27T11:00:02Z', 'rtds'),
      t('2026-09-27T11:00:00Z', '2026-09-27T11:00:30Z', 'poll'),
      t('2026-09-27T11:00:00Z', undefined),                        // pre-change row: skipped
      t('2026-09-10T11:00:00Z', '2026-09-10T11:00:05Z', 'poll'),   // outside 7d
    ], now, 7 * 86_400_000);
    expect(r.n).toBe(3);
    expect(r.medianMs).toBe(2000);
    expect(r.p90Ms).toBe(30_000);
    expect(r.pushShare).toBeCloseTo(2 / 3, 10);
    expect(r.bySource).toEqual({ rtds: 2, poll: 1 });
  });

  it('empty when nothing qualifies', () => {
    expect(copyLatencyStats([], now, 1000)).toEqual({ n: 0, medianMs: null, p90Ms: null, pushShare: null, bySource: {} });
  });
});

describe('cron log parsers', () => {
  it('parses an expiry line', () => {
    const r = parseExpiryLine('2026-09-26 09:00:01 UTC | OK | days_left=18.0 | exp=2026-10-14 09:19 UTC | source=bullpen_status.session_expires | action=silent');
    expect(r).toEqual({
      checkedAt: '2026-09-26T09:00:01.000Z', level: 'OK', daysLeft: 18,
      expiresAt: '2026-10-14T09:19:00.000Z',
    });
    expect(parseExpiryLine(null)).toBeNull();
  });

  it('reads the last status line even when a SENT line follows it', () => {
    const log = [
      '2026-09-26 09:00:01 UTC | OK | days_left=18.0 | exp=2026-10-14 09:19 UTC | action=silent',
      '2026-09-27 07:48:12 UTC | OK | days_left=17.1 | exp=2026-10-14 09:19 UTC | action=forced_test',
      '2026-09-27 07:48:12 UTC | SENT | action=forced_test | msg_preview=[polymarket_bot] alert system test',
      '',
    ].join('\n');
    expect(parseExpiryLine(lastLineMatching(log, 'days_left='))!.daysLeft).toBe(17.1);
    expect(lastLineMatching('', 'days_left=')).toBeNull();
  });

  it('parses git-sync and scan lines', () => {
    expect(parseGitSyncLine('2026-09-26T03:00:01Z no changes to sync'))
      .toEqual({ at: '2026-09-26T03:00:01.000Z', text: 'no changes to sync' });
    const s = parseScanLine('2026-09-26 21:29:18 UTC | DONE | stage2=1295 stage3=31 | telegram_sent=0');
    expect(s).toEqual({ at: '2026-09-26T21:29:18.000Z', status: 'DONE', detail: 'stage2=1295 stage3=31 | telegram_sent=0' });
  });

  it('summarizes the watchdog over a window', () => {
    const text = [
      '2026-09-10 10:00:01 UTC | FAIL | http=000000 | consecutive=1/2',   // outside 7d
      '2026-09-26 19:40:01 UTC | FAIL | http=000000 | consecutive=1/2',
      '2026-09-26 19:45:01 UTC | OK | http=200 | recovered after 1 fail(s)',
      '2026-09-26 20:00:01 UTC | RESTART | triggering docker compose restart bot',
      '2026-09-26 20:00:05 UTC | RESTART_OK | rc=0',
      'garbage line',
    ].join('\n');
    const r = summarizeWatchdog(text, Date.parse('2026-09-27T00:00:00Z'), 7 * 86_400_000);
    expect(r).toEqual({ checks: 2, fails: 1, restarts: 1, lastStatus: 'RESTART_OK', lastAt: '2026-09-26T20:00:05.000Z' });
  });
});

describe('dbInfo', () => {
  it('growth per day vs the newest backup at least a day old', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbinfo-'));
    const db = path.join(dir, 'store.db');
    const backups = path.join(dir, 'backups');
    fs.mkdirSync(backups);
    fs.writeFileSync(db, Buffer.alloc(3000));
    fs.writeFileSync(db + '-wal', Buffer.alloc(100));
    const old = path.join(backups, 'store-2026-09-24.db');
    fs.writeFileSync(old, Buffer.alloc(1000));
    const now = Date.parse('2026-09-27T00:00:00Z');
    const oldMs = now - 2 * 86_400_000;
    fs.utimesSync(old, oldMs / 1000, oldMs / 1000);
    const fresh = path.join(backups, 'store-2026-09-26.db'); // under a day old: ignored
    fs.writeFileSync(fresh, Buffer.alloc(2900));
    fs.utimesSync(fresh, (now - 3_600_000) / 1000, (now - 3_600_000) / 1000);
    const r = dbInfo(db, backups, now);
    expect(r.sizeBytes).toBe(3000);
    expect(r.walBytes).toBe(100);
    expect(r.growthBytesPerDay).toBeCloseTo(1000, 6);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('missing files give nulls', () => {
    expect(dbInfo('/nonexistent/x.db', '/nonexistent/b', Date.now()))
      .toEqual({ sizeBytes: null, walBytes: null, growthBytesPerDay: null });
  });
});
