import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const { evaluateBacktest, runBacktest, summarizeBacktests, withBacktestSnapshot } = require('../scripts/lowfreq_scan.js');
const exec = promisify(execFile);
const ADDRESS = '0x1111111111111111111111111111111111111111';
const SINCE = '2025-10-20';
const roots: string[] = [];
function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lowfreq-test-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    const backups = path.join(root, 'backups');
    if (fs.existsSync(backups)) fs.chmodSync(backups, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function result(total = 20) {
  return { results: [
    { k: 1, models: [{ name: 'A  live', s: {
      total, ci: total > 0 ? [5, 35] : [-35, -5], markets: 60, fees: 2, top1: 3,
      byMonth: { '2026-06': total / 4, '2026-07': total / 4, '2026-08': total / 4, '2026-09': total / 4 },
    } }] },
    { k: 2, models: [{ name: 'A  live', s: { total: total - 5 } }] },
  ] };
}

function fixture(body: string) {
  const work = temp();
  const script = path.join(work, 'backtest.js');
  fs.writeFileSync(script, `
    const fs = require('fs');
    const path = require('path');
    const file = path.join(process.env.BACKTEST_CACHE, 'results_' + process.argv[2].slice(0, 10) + '_' + process.argv[3] + '.json');
    ${body}
  `);
  return { work, script };
}

describe('low-frequency backtest database snapshot', () => {
  it('opens a WAL-mode backup from a readonly directory through one writable copy', async () => {
    const root = temp();
    const backupsDir = path.join(root, 'backups');
    fs.mkdirSync(backupsDir);
    const source = path.join(backupsDir, 'store-2026-10-19.db');
    const db = new Database(source);
    db.pragma('journal_mode = WAL');
    db.exec("CREATE TABLE excluded_traders(address TEXT); INSERT INTO excluded_traders VALUES ('kept');");
    db.close();
    const before = fs.readFileSync(source);
    fs.chmodSync(backupsDir, 0o555);
    // Root can bypass chmod; production and the regression run use uid 1000.
    if (process.getuid?.() !== 0) {
      const original = new Database(source, { readonly: true });
      try {
        expect(() => original.prepare('SELECT * FROM excluded_traders').all()).toThrow();
      } finally { original.close(); }
    }

    const work = path.join(root, 'work');
    let scratch = '';
    await withBacktestSnapshot(async (dbPath: string) => {
      scratch = dbPath;
      expect(dbPath.startsWith(work + path.sep)).toBe(true);
      // Successive connections represent exclusions and separate backtests.
      for (let i = 0; i < 2; i++) {
        const copy = new Database(dbPath, { readonly: true });
        try {
          expect(copy.prepare('SELECT address FROM excluded_traders').all()).toEqual([{ address: 'kept' }]);
        } finally { copy.close(); }
      }
    }, { work, backupsDir });
    expect(fs.existsSync(scratch)).toBe(false);
    expect(fs.readdirSync(work)).toEqual([]);
    expect(fs.readFileSync(source)).toEqual(before);
    expect(fs.readdirSync(backupsDir)).toEqual(['store-2026-10-19.db']);
  });

  it('cleans its scratch database when the scan fails', async () => {
    const root = temp();
    const backupsDir = path.join(root, 'backups');
    fs.mkdirSync(backupsDir);
    fs.writeFileSync(path.join(backupsDir, 'store-2026-10-19.db'), 'snapshot');
    const work = path.join(root, 'work');
    await expect(withBacktestSnapshot(async () => { throw new Error('scan failed'); }, { work, backupsDir })).rejects.toThrow('scan failed');
    expect(fs.readdirSync(work)).toEqual([]);
  });

  it('refuses a missing backup or an uncheckpointed WAL', async () => {
    const root = temp();
    const backupsDir = path.join(root, 'backups');
    fs.mkdirSync(backupsDir);
    const options = { work: path.join(root, 'work'), backupsDir };
    await expect(withBacktestSnapshot(() => {}, options)).rejects.toThrow('No daily database backup');
    fs.writeFileSync(path.join(backupsDir, 'store-2026-10-19.db'), 'snapshot');
    fs.writeFileSync(path.join(backupsDir, 'store-2026-10-19.db-wal'), 'uncheckpointed data');
    await expect(withBacktestSnapshot(() => {}, options)).rejects.toThrow('non-empty WAL');
  });
});

describe('backtest child process results', () => {
  it('passes the scratch path and retains both output streams for a valid result', async () => {
    const opts = fixture(`
      console.log(process.argv[4]); console.error('diagnostic');
      fs.writeFileSync(file, ${JSON.stringify(JSON.stringify(result()))});
    `);
    const out = await runBacktest(ADDRESS, SINCE, '/scratch/snapshot.db', opts);
    expect(out.pass).toBe(true);
    expect(out.technicalError).toBeUndefined();
    expect(fs.readFileSync(path.join(opts.work, 'btlogs', `${ADDRESS}_${SINCE}.stdout.log`), 'utf8')).toContain('/scratch/snapshot.db');
    expect(fs.readFileSync(path.join(opts.work, 'btlogs', `${ADDRESS}_${SINCE}.stderr.log`), 'utf8')).toContain('diagnostic');
  });

  it('keeps a losing strategy distinct from a technical failure', async () => {
    const opts = fixture(`fs.writeFileSync(file, ${JSON.stringify(JSON.stringify(result(-20)))});`);
    const out = await runBacktest(ADDRESS, SINCE, '/scratch/snapshot.db', opts);
    expect(out.pass).toBe(false);
    expect(out.failed).toContain('profitable');
    expect(out.technicalError).toBeUndefined();
  });

  it('records nonzero exit, stderr and stdout even if a result was written', async () => {
    const opts = fixture(`
      fs.writeFileSync(file, ${JSON.stringify(JSON.stringify(result()))});
      console.log('started'); console.error('SQLITE_CANTOPEN'); process.exit(7);
    `);
    const out = await runBacktest(ADDRESS, SINCE, '/scratch/snapshot.db', opts);
    expect(out.pass).toBe(false);
    expect(out.technicalError.exitCode).toBe(7);
    expect(out.technicalError.stderrTail).toContain('SQLITE_CANTOPEN');
    expect(fs.readFileSync(path.join(opts.work, out.technicalError.stdoutLog), 'utf8')).toContain('started');
  });

  it('does not accept a stale result when the child exits zero without output', async () => {
    const opts = fixture('');
    fs.mkdirSync(path.join(opts.work, 'btcache'));
    fs.writeFileSync(path.join(opts.work, 'btcache', `results_${ADDRESS.slice(0, 10)}_${SINCE}.json`), JSON.stringify(result()));
    const out = await runBacktest(ADDRESS, SINCE, '/scratch/snapshot.db', opts);
    expect(out.technicalError.exitCode).toBe(0);
    expect(out.technicalError.message).toContain('without a result file');
  });

  it.each(['{bad json', '{}', JSON.stringify({ results: [] }), JSON.stringify(result()).replace('"total":20', '"total":null')])(
    'reports malformed/incomplete output as a technical failure: %s', async raw => {
      const opts = fixture(`fs.writeFileSync(file, ${JSON.stringify(raw)});`);
      const out = await runBacktest(ADDRESS, SINCE, '/scratch/snapshot.db', opts);
      expect(out.pass).toBe(false);
      expect(out.failed).toEqual(['backtest technical error']);
      expect(out.technicalError.exitCode).toBe(0);
    },
  );

  it('records a timed-out child as a technical failure', async () => {
    const opts = fixture("console.error('waiting'); setInterval(() => {}, 1000);");
    const out = await runBacktest(ADDRESS, SINCE, '/scratch/snapshot.db', { ...opts, timeoutMs: 200 });
    expect(out.technicalError.killed).toBe(true);
    expect(out.technicalError.signal).toBe('SIGTERM');
    expect(out.pass).toBe(false);
  });
});

describe('scan completion status', () => {
  const failure = { bt: { pass: false, technicalError: { message: 'failed' } } };
  it('counts attempted, successful, rejected and failed backtests separately', () => {
    expect(summarizeBacktests([
      { bt: evaluateBacktest(result()) }, { bt: evaluateBacktest(result(-20)) }, failure,
    ])).toEqual({ status: 'partial', counts: { backtested: 3, backtestSucceeded: 2, backtestErrors: 1, rejected: 1, passed: 1 } });
    expect(summarizeBacktests([failure, failure]).status).toBe('error');
    expect(summarizeBacktests([]).status).toBe('done');
  });

  it('persists an all-failed report, skips additions and exits nonzero from the real scan entry point', async () => {
    const root = temp();
    const app = path.join(root, 'app');
    fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(app, 'data/backups'), { recursive: true });
    fs.symlinkSync(path.resolve('node_modules'), path.join(app, 'node_modules'));
    fs.copyFileSync(path.resolve('scripts/lowfreq_scan.js'), path.join(app, 'scripts/lowfreq_scan.js'));
    fs.copyFileSync(path.resolve('scripts/dataapi_v2.js'), path.join(app, 'scripts/dataapi_v2.js'));
    fs.writeFileSync(path.join(app, 'scripts/backtest_mirror.js'), "console.error('fixture database failure'); process.exit(9);");
    const db = new Database(path.join(app, 'data/backups/store-2026-10-19.db'));
    db.exec('CREATE TABLE excluded_traders(address TEXT)');
    db.close();
    const preload = path.join(root, 'fetch.cjs');
    fs.writeFileSync(preload, `
      global.fetch = async (url, options) => {
        if (options?.method === 'POST') throw new Error('Unexpected watchlist mutation');
        const u = new URL(url); let data;
        const timestamp = Math.floor(Date.now() / 1000) - 60;
        const trades = Array.from({length: 6}, (_, i) => ({type: 'TRADE', timestamp, condition_id: 'm'+i, transaction_hash: 't'+i}));
        const page = rows => ({data: rows, pagination: {has_more: false, next_cursor: ''}});
        if (u.pathname === '/api/watchlist') data = {items: []};
        else if (u.pathname === '/v2/leaderboard') data = page([{user_id: '${ADDRESS}', pnl: 50000, volume: 100000}]);
        else if (u.pathname === '/v2/activity' || u.pathname === '/v2/trades') data = page(trades);
        else if (u.pathname === '/v2/positions' && u.searchParams.get('status') === 'CLOSED') data = page(Array.from({length: 20}, () => ({last_event_at: timestamp, realized_pnl: 100})));
        else if (u.pathname === '/v2/positions') data = page([]);
        else throw new Error('Unexpected request: '+url);
        return {ok: true, status: 200, json: async () => data};
      };
    `);
    const work = path.join(root, 'work');
    let failure: any;
    try {
      await exec(process.execPath, ['--require', preload, path.join(app, 'scripts/lowfreq_scan.js')], {
        env: { ...process.env, LOWFREQ_WORK: work, LOWFREQ_AUTO_ADD: '1' }, timeout: 5000,
      });
    } catch (error) { failure = error; }
    expect(failure?.code).toBe(1);
    const report = JSON.parse(fs.readFileSync(path.join(work, 'report.json'), 'utf8'));
    expect(report.status).toBe('error');
    expect(report.counts).toMatchObject({ backtested: 1, backtestSucceeded: 0, backtestErrors: 1, rejected: 0, added: 0 });
    expect(report.evaluated[0].bt.technicalError.exitCode).toBe(9);
    expect(failure.stdout).toContain('SUMMARY status=error');
    expect(fs.readdirSync(work).some(f => f.startsWith('.backtest-db-'))).toBe(false);
  });
});
