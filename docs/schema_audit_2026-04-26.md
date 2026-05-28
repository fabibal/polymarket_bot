# Schema Audit — store.db (SQLite)

Date: 2026-04-26
Branch / commit at audit: master @ 39f920e
Scope: scoping only — no fixes applied.

## TL;DR

The schema is mostly defensible. Numeric columns are correctly typed `REAL`/`INTEGER`, so the "ORDER BY pnl returns lexical order" worry from the stress-test does **not** apply — that risk was overstated. The real risks live elsewhere: TEXT timestamps that are only safe if every writer uses ISO-8601, no `NOT NULL` / `CHECK` discipline, untyped JSON in `meta`, and nullable FIFO/numeric fields that the application treats as guaranteed.

Watchlist Fix A re-verified: `countWatchlistEntriesInWindow` (filters.ts:95) iterates **both** `openTrades` and `closedTrades` and counts each entry whose `timestamp` is within `[now - windowMs, now]`. Your read of the code is correct; my earlier critique was wrong.

## Column-by-column report

Severity legend: **HIGH** = active or near-term silent bug · **MED** = latent risk · **LOW** = hygiene.

### tracked_traders
| Col | Stored | Used as | Risk |
|---|---|---|---|
| `weekly_pnl` | REAL NOT NULL | numeric | OK *if* writer wraps Bullpen's stringified number in `Number()` before INSERT. better-sqlite3 will pass a JS string straight through; SQLite's REAL affinity coerces, but `NaN` from a bad string becomes NULL silently → trader silently drops out of "top 10". **MED — verify writer at store.ts:526 / 683.** |
| `total_volume` | REAL | numeric | Same risk as above. **MED.** |
| `inactive` | INTEGER | boolean | No CHECK; any non-0/1 value stored would skew filters. **LOW.** |
| `falcon_win_rate` / `falcon_roi` / `falcon_sharpe` | REAL nullable | numeric | App likely does `row.falcon_win_rate ?? fallback`; NULL handling looks correct. **LOW.** |
| `tracked_since` | TEXT | timestamp | Only sortable if ISO-8601. Not currently sorted on, so latent. **LOW.** |

### excluded_traders
- `auto INTEGER NOT NULL DEFAULT 0` — fine. **LOW** (no CHECK, but only the app writes it).

### watchlist_traders
| Col | Risk |
|---|---|
| `added_at TEXT NOT NULL` | Sorted lexically at store.ts:453 (`ORDER BY added_at ASC`). Safe **iff** ISO-8601 UTC. If any code path wrote `new Date().toString()` (RFC 2822) or a localized string, ordering is broken. **MED — grep all writers, confirm `toISOString()`.** |
| `copy_amount REAL DEFAULT 5` | Fine. Default applied at SQL level — confirm code doesn't also default to `5` and drift if env-driven defaults change. **LOW.** |

### open_trades / closed_trades / shadow_open_trades / shadow_closed_trades
This is the hot path. Audit findings:

1. **`closed_at TEXT` (closed + shadow_closed)** — schema:147, 208. This is the column you flagged. The lexical-sort risk is **mitigated** by the fact that `idx_closed_closed_at` is only used for range filters, not ranking, and timestamps are ISO. But: the column is **nullable** with no CHECK that closed rows have a non-null `closed_at`. Any code that reads `closed_at` without a null guard will crash or coerce to `NaN`. **HIGH — search every read site and confirm `?? null` / null-safe parse.**
2. **`holding_period_ms INTEGER` nullable** — derived from `closed_at - timestamp`. If `closed_at` is null due to (1), this is null too. Any aggregate (avg holding period on dashboard) silently skips nulls and reports a biased mean. **MED.**
3. **`exit_price REAL` nullable on closed_trades** — a closed row with NULL exit_price means realized_pnl is meaningless. No CHECK constraint enforces "status='closed' ⇒ exit_price IS NOT NULL". **MED.**
4. **`realized_pnl REAL` nullable + `cost_adjusted_pnl REAL`** — `SUM(realized_pnl)` on the dashboard silently treats NULL as 0. Aggregate looks fine until one bad row. **MED.**
5. **`insertion_order INTEGER NOT NULL`** — driven by an in-process counter (`insertionCounter` at store.ts:272). On process restart the counter resets to 0; new rows get `insertion_order=0` while old rows have higher values. ORDER BY at store.ts:466-469 is therefore **non-monotonic across restarts**. FIFO close logic (idx_open_fifo) may pick the wrong leg after a restart if the same `(trader, slug, outcome)` has both pre- and post-restart opens. **HIGH — verify counter is initialized from `MAX(insertion_order)+1` on boot.**
6. **`status TEXT NOT NULL`** — no CHECK; typo-bugs ("opem", "cosed") are unrecoverable silently. **LOW.**
7. **No index on `copied_trader` alone** — `idx_open_fifo` covers it as the leading column, fine. But auto-exclusion WR queries scan `copied_trader, status` on closed_trades — no index. At 100x volume this is a full scan per trader per cycle. **MED at scale, LOW now.**

### processed_trade_ids / processed_shadow_ids
- `added_order INTEGER NOT NULL` — same in-process counter risk as `insertion_order`. Used only for FIFO eviction (LIMIT-N delete), so a counter reset means **the eviction deletes recently-added rows instead of oldest**. The dedup set still works (PRIMARY KEY on `id`), so functionally trades aren't double-processed, but the cap-trim is wrong. **MED.**

### trader_history / trader_history_meta
- `timestamp TEXT NOT NULL` indexed DESC — safe if ISO-8601. **LOW** (verify writer).
- `last_fetched TEXT NOT NULL` — used for "fetch since" diff; if any writer used a non-ISO format, the diff would be wrong. **MED.**
- No retention policy; trader_history grows unbounded. At 100x volume, this is the table that will swell. **MED at scale.**

### trader_falcon_cache
- `updated_at TEXT NOT NULL` — used for TTL check. Same ISO-format dependency. **LOW.**
- No index — fine, PK lookups only.

### trader_last_seen / trader_last_on_leaderboard / shadow_last_seen
- `timestamp TEXT NOT NULL` — used in comparisons via `Date.parse`, not SQL. **LOW.**

### meta (key/value, both TEXT)
- `value` holds JSON.stringify'd blobs (e.g. `leaderboardFilters` at store.ts:318). No schema validation on read. A bad write or a hand-edit corrupts startup. **MED — wrap reads in try/catch + schema validator.**

## Cross-cutting issues

1. **No PRAGMA `synchronous = NORMAL` set explicitly.** WAL mode is on (store.ts:282). Default `synchronous` with WAL is `NORMAL` on most builds, but on a power loss / OOM-kill mid-flush, you can lose the last few transactions. Acceptable for now; document expected loss window. **LOW.**
2. **No backup mechanism in schema setup** — relevant to your priority #2.
3. **No foreign keys between `closed_trades.source_trade_id` and `processed_trade_ids.id`** — orphan rows possible. Today they're created in the same transaction, so this is theoretical. **LOW.**
4. **`NOT NULL` discipline is uneven.** Trade tables have `entry_price NOT NULL` but `exit_price`, `realized_pnl`, `closed_at` nullable with no status-conditional CHECK. This is the single biggest source of "silent NaN" potential.
5. **No CHECK constraints anywhere.** Adding `CHECK(status IN ('open','closed'))`, `CHECK(side IN ('BUY','SELL'))`, `CHECK(entry_price BETWEEN 0 AND 1)` would catch ~80% of future schema-related bugs at insert time.

## Items I could not verify in this audit (next session)

- Every writer that produces a `TEXT` timestamp — confirm it's `new Date().toISOString()` and never `Date().toString()` or locale-dependent. Grep targets: `added_at`, `closed_at`, `tracked_since`, `last_fetched`, `updated_at`, `timestamp`.
- `insertionCounter` initialization on boot (store.ts:272). If it starts at 0 instead of `MAX(insertion_order) FROM open_trades UNION closed_trades`, this is a **HIGH** bug.
- Bullpen `weekly_pnl` / `total_volume` writers — confirm `Number()` wrap before INSERT.
- Shadow simulator slippage application (your concern #5) — confirm shadow inserts use the same `entry_slippage_cost` and `exit_slippage_cost` calculations as real inserts. If shadow has zero slippage, the 20-trade shadow gate unlocks traders whose "edge" is purely a simulation artifact.

## Prioritized fix list (for later, not tonight)

1. **HIGH** — `insertionCounter` boot initialization. One-line fix; massive correctness impact on FIFO close after restart.
2. **HIGH** — Status-conditional CHECK or app-side invariant: closed rows must have non-null `closed_at`, `exit_price`, `realized_pnl`. Add a one-shot migration that backfills or quarantines violators.
3. **MED** — Verify all timestamp writers use `toISOString()`. Add a single helper `nowIso()` and grep-replace `new Date().toString()` / `.toLocaleString()`.
4. **MED** — Wrap Bullpen numeric ingestion in `Number()` with NaN guard; reject the row instead of inserting NaN→NULL.
5. **MED** — Confirm shadow trades apply slippage the same way real trades do (related to your concern #5).
6. **MED** — Add CHECK constraints on `status`, `side`, `entry_price`, `exit_price` ranges. Cheap insurance.
7. **LOW** — Index `closed_trades(copied_trader, status)` for the auto-exclusion WR query. Defer until volume justifies.
8. **LOW** — Retention policy for `trader_history`.

## Addendum 2026-04-26 — empirical audit on production DB

Read-only audit of `/app/data/store.db` (2,605 closed rows: 384 real + 2,221 shadow). Most concerns from the morning audit are **not** materializing in production data:

| Check | Result |
|---|---|
| `closed_trades.closed_at IS NULL` | 0 / 384 |
| `closed_trades.exit_price IS NULL` | 0 / 384 |
| `closed_trades.realized_pnl IS NULL` | 0 / 384 |
| `closed_trades.holding_period_ms IS NULL` | 0 / 384 |
| `shadow_closed_trades.*` same checks | 0 / 2,221 each |
| Non-ISO-8601 timestamps across 8 columns | 0 violations |
| `tracked_traders.weekly_pnl` typeof | `real` × 10 (no string coercion) |
| Open trades status taxonomy | `open` × 6 |
| Closed status taxonomy | `resolved` × 376, `expired` × 8 (real) ; `resolved` × 2,034, `expired` × 187 (shadow) |

**Updated severity:**
- The "status-conditional NOT NULL invariant" worry: **DOWNGRADED LOW**. Application code already maintains it in practice. A defensive CHECK constraint is still nice-to-have but not urgent.
- Timestamp format risk: **DOWNGRADED LOW**. All writers are correctly using `toISOString()`.
- Bullpen numeric coercion: **DOWNGRADED LOW**. `weekly_pnl` is genuinely REAL.

**Real finding from this pass:** the closed-state status taxonomy is `resolved` / `expired`, **not** `closed`. The morning audit assumed `status='closed'`. Any future CHECK constraint must use `status IN ('open','resolved','expired')`. Worth grepping the code for hardcoded `'closed'` string comparisons that may be dead branches.

**Backup mechanism observed but not verified:** `/app/data/backups/store-2026-04-24.db` and `store-2026-04-26.db` exist on the data volume. Need to find the script that produces them, confirm cadence, and confirm they're being copied OFF-host (your priority #2). Same-disk backups don't survive disk failure.

## Note on the original "closed_at TEXT bug"

The schema column itself is fine — TEXT is the correct SQLite affinity for ISO-8601. If the original bug was "lexical sort returns wrong order", that was a misdiagnosis: ISO-8601 UTC timestamps **do** sort correctly lexically. More likely root causes worth re-checking when you revisit:
- A null `closed_at` being read as the string `"null"` somewhere.
- A writer that produced a non-ISO format (locale string).
- A reader that used `parseInt(closed_at)` expecting a unix ms.

Recommend pulling the actual incident commit/PR and re-reading the bug, rather than trusting the "TEXT type was wrong" framing.
