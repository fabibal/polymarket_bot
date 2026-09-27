# Engineering Decisions

Why non-obvious choices are the way they are. Each entry: the decision, the
alternative considered, and the reason for choosing it. Append-only — new
entries at the bottom, supersessions marked explicitly. Source of truth for
behaviour is always the code; this file records *why*.

---

## Watchlist depth gate (2026-05-27)

**Decision:** skip a watchlist BUY when CLOB `ask_depth_5 < DEPTH_GATE_MIN_DEPTH_5`
(default $500). Non-blocking on depth-fetch failure (the copy proceeds).

**Alternative considered:** copy every watchlist BUY regardless of book depth
(the watchlist-trust principle says bypass all filters).

**Reason:** a $5-15 copy into a thin book would itself move the market, and the
thin-book tail trades degrade the statistical validity of the measured
watchlist edge. This is one of the THREE active constraints on a watchlist BUY
(see `CLAUDE.md` "Active constraints"). The gate lives in `src/monitor.ts`.

---

## `closed_trades` retention is unlimited (2026-05-27)

**Decision:** remove the 7-day archival step from `runDailyCleanup()`; the
`closed_trades` table holds full history in-DB.

**Alternative considered:** keep archiving rows older than 7 days to
`data/archive/*.json`.

**Reason:** query perf is ~12 ms at 30k rows — no need to archive. Existing
`data/archive/*.json` files are historical artifacts; the importer ran once to
merge them back. Daily backups in `data/backups/` (last 30 retained) remain the
disaster-recovery path. `traderHistory` and `processedTradeIds` still prune in
the same daily run.

---

## Leaderboard demoted to shadow-only (2026-05-28) [SUPERSEDED 2026-05-29 — removed entirely]

**Decision:** stop real-copying leaderboard traders; track them shadow-only.

**Alternative considered:** keep real-copying the leaderboard.

**Reason:** lifetime leaderboard real-copy PnL was **-$2,451 over 9,258 closed
trades** — no demonstrable edge. Superseded the next day by full removal (see
"Watchlist-only architecture").

---

## Simulated wallet cap (2026-05-28)

**Decision:** when `SIMULATED_WALLET_SIZE > 0`, compare
`sum(simulatedAmount)` over open trades against
`SIMULATED_WALLET_SIZE * WALLET_CAP_UTILIZATION` before each BUY; skip over-cap
BUYs. Logs `wallet_cap: $X/$1000 in use`.

**Alternative considered:** unbounded simulated exposure.

**Reason:** models a fixed-size real wallet — a hard real-money constraint that
applies regardless of the watchlist trust override. This is the first of the
THREE active constraints on a watchlist BUY. Dashboard `/api/stats` returns
`simulatedWalletSize`, `walletInUse`, `walletCapUtilization`.

---

## Watchlist-only architecture — leaderboard removed entirely (2026-05-29)

**Decision:** the bot polls **only** `watchlist_traders`. No leaderboard fetch,
no Falcon leaderboard refresh, no shadow polling. `runPollingCycle()` in
`src/index.ts` iterates the watchlist and calls `pollTrader` — nothing else.

**Alternative considered:** keep the shadow-only leaderboard track (the
2026-05-28 demotion) for ongoing comparison.

**Reason:** shadow track showed no edge worth the code surface. Removal scope:
- `src/leaderboard.ts` deleted; `refreshLeaderboard` + periodic refresh removed
  from `index.ts`.
- Auto-exclusion logic + config (`AUTO_EXCLUDE_WIN_RATE_THRESHOLD`,
  `AUTO_EXCLUDE_MIN_TRADES`, `LEADERBOARD_LIMIT`, `LEADERBOARD_REFRESH_MS`)
  dropped from `config.ts`; `tests/auto_exclusion.test.ts` deleted.
- DB: `tracked_traders` and `shadow_open_trades` purged; `shadow_closed_trades`
  and `excluded_traders` kept as a frozen historical record (read by no
  endpoint). See [KNOWN_ISSUES — Frozen tables](KNOWN_ISSUES.md).

**Second cleanup pass (same day):** removed the dead code itself — the shadow +
`!isWatchlist` real-copy branches and `hasSufficientSample` in `monitor.ts`;
orphaned `store.ts` exports (`updateTrackedTraders`,
`updateTraderLastOnLeaderboard`, `setAutoExclusion`, `setLeaderboardStats`,
`updateWatchlistFalconData`, `updateTraderFalconCache`, `setTraderExclusion`,
`isShadowProcessed`, `addShadowOpenTrade`, `closeShadowOpenTrade`,
`markShadowProcessed`, `setShadowLastSeen`) + the in-memory
`excludedTraders`/`autoExcludedTraders` fields; `bullpen.ts` leaderboard/Falcon
fetchers; `simulator.ts` shadow-resolution logic; the now-inert filter config
keys. `persistSnapshot` no longer rewrites `shadow_closed_trades`. Dashboard
`/api/watchlist` no longer returns Falcon fields; `/api/stats` no longer returns
`trackedTraders`/`lastLeaderboardUpdate`.

**Consequence — watchlist bypasses all entry filters by design.** Since every
trade is now a watchlist trade, these former filters apply to nothing and were
removed as inert no-ops: `MIN_PRICE`, `MIN_PRICE_SPORTS`, `MAX_PRICE`,
`MAX_SPREAD`, `FORCE_EXCLUDE_CATEGORIES`, `MAX_POSITIONS_PER_MARKET`,
`MAX_POSITIONS_PER_MARKET_SPORTS`, `MAX_TOTAL_OPEN_POSITIONS`,
`MIN_TRADER_SAMPLE`, `MIN_TRADER_SHADOW_SAMPLE`. Rationale: a watchlist entry is
an explicit, manual trust decision by the operator — the bot copies
unconditionally, no algorithmic second-guessing on price, liquidity, or sample
size. The ONLY active constraints are the wallet cap, the per-market entry cap,
and the depth gate (see `CLAUDE.md`).

---

## Longshot-filter per-trader carve-out (2026-06-09)

**Decision:** a single, NARROW exception to "watchlist bypasses all filters",
scoped to ONE trader by full address. When a BUY comes from
`LONGSHOT_FILTER_TRADER` (`0x12d6cccfc7470a3f4bafc53599a4779cbf2cf2a8`, label
*Geopolitics-Macro*) at `entryPrice < LONGSHOT_FILTER_MAX_PRICE` (default
`0.10`), skip the copy and record the would-be entry in `skipped_trades` with
`skip_reason='longshot_filter_0x12d6'`. Record-only — no PnL lifecycle. The
check is at the top of the BUY branch in `monitor.ts`, before
wallet/entry-cap/depth gates.

**Alternative considered:** keep copying this trader's longshots like any other
watchlist trade.

**Reason (re-verified 2026-06-10 on Gamma-corrected data after the
threshold-resolution fix):** the original justification used stats contaminated
by the insta-resolution artifact, but the conclusion survives clean accounting —
all-time 89 sub-$0.10 trades, corrected net ≈ -$196; 0 of 57 ride-to-resolution
longshots won (~2 expected at fair pricing); the trader's own later activity (0
REDEEMs, 1 SELL at a loss) confirms the booked outcomes. `skipped_trades`
preserves count + cumulative would-be notional so the pattern can be monitored.
Dashboard surfaces it via `/api/stats` (`longshotSkipCount`,
`longshotSkipNotional`) and the "🚫 Longshot Skips" card. This is the ONLY
per-trader filter override; to retire it, drop the `monitor.ts` block and the
two config keys. Other watchlist traders are unaffected.

---

## Threshold resolution reworked (2026-06-10, `src/simulator.ts`)

**Decision:** positions at price ≥0.93 / ≤0.07 are no longer blindly
proxy-booked at $1/$0. Three-way decision (`decideThresholdResolution`, pure +
unit-tested):
1. Gamma-confirmed resolution (market `closed` AND all `outcomePrices` pinned to
   0/1, `isMarketResolved`) → book actual final outcome immediately, no age gate.
2. Entry price already beyond the threshold (longshots ≤0.07, favorites ≥0.93) →
   NEVER proxy-resolved; held until Gamma confirms, a copy-SELL closes, or
   max-hold expiry.
3. Entry crossed the threshold after open → legacy price-proxy fallback after
   one price-update interval, each logged
   (`price-proxy resolve ... (Gamma does not show market resolved)`).

**Alternative considered:** require Gamma confirmation for all threshold
resolutions.

**Reason:** pre-fix, case (2) positions were insta-booked as total wins/losses
while still live, corrupting all sub-$0.10 / >$0.93 bucket stats before
2026-06-10. But case (3) keeps the price proxy because Gamma delists resolved
sports markets within ~a day, usually before ever showing `closed=true` —
requiring confirmation would misbook winners as 'expired' at last price.

---

## Observation forward-test ledger (2026-06-10)

**Decision:** copy-disabled watchlist traders are no longer discarded — their
trades run the full simulated lifecycle in the separate `observation_trades`
table (single table; rows mutate in place from `status='open'` to
`resolved`/`expired`). Same cost model and same threshold-resolution decision as
real copies, but deliberately RAW: no wallet cap, no entry cap, no depth gate,
no longshot filter. Observation rows never enter `open_trades`. Store API:
`addObservationTrade`, `closeObservationTrade` (FIFO),
`updateObservationTradePrices`, `resolveObservationByPrice`. The 5-min price
sweep covers observation positions in the same pass. Observation BUYs persist
`source_notional`. Dashboard: `/api/observation` + "👁 Observation Forward-Test"
section; logs `[OBS] BUY/SELL`.

**Alternative considered:** drop copy-disabled traders' trades entirely.

**Reason:** the ledger measures the *trader*, not our execution constraints, so
macro-scan candidates can be added copy-disabled and build a real forward-test
record before copying is enabled. RAW (no constraints) because constraints would
measure our execution, not the trader's edge. See
[KNOWN_ISSUES — Observation ledger has no entry cap](KNOWN_ISSUES.md).

---

## Risk controls — kill switch + circuit breaker (2026-06-10, `src/risk.ts`)

**Decision:** two automatic guards, both alerting via Telegram (`src/alerts.ts`,
creds from `~/.env.shared`, `[polymarket_bot]` prefix):
1. *Per-trader decay kill switch* — after each poll cycle, any copy-enabled
   watchlist trader whose rolling 30d cost-adjusted net drops below threshold is
   auto-disabled (`watchlist_traders.auto_disabled_at/_reason`). The trader keeps
   accruing observation data. Manual re-enable clears the marker, but if still
   under threshold the next check re-disables — raise the env threshold to truly
   override.
2. *Daily-loss circuit breaker* — when total cost-adjusted realized PnL over the
   last 24h drops below threshold, ALL copying pauses for 24h
   (`meta.circuit_breaker_until`). While paused, polling continues and cursors
   advance (missed BUYs are NOT copied late), and copy-SELLs still close existing
   positions. Auto-resumes on expiry; manual reset `POST /api/breaker/reset`.

**Thresholds are %-of-wallet:** `TRADER_DECAY_THRESHOLD_PCT_30D=5` and
`DAILY_LOSS_CIRCUIT_BREAKER_PCT=3`, derived from `SIMULATED_WALLET_SIZE`
(`resolveRiskThreshold` in config.ts; at $1000 → -50/-30). Absolute env vars
(`TRADER_DECAY_THRESHOLD_30D`, `DAILY_LOSS_CIRCUIT_BREAKER`) override the % when
set; wallet sim disabled (size 0) → fixed absolute defaults.

**Alternative considered:** fixed absolute-dollar thresholds.

**Reason:** %-of-wallet means enabling `DYNAMIC_SIZING=true` no longer requires
retuning thresholds by hand (still sanity-check derived values when
`SIMULATED_WALLET_SIZE` or `MAX_TRADE_AMOUNT` changes). Window math is pure
(`rollingNetForTrader`, `rollingNetTotal`, `evaluateCircuitBreaker`) and
unit-tested (`tests/risk.test.ts`, `tests/kill_switch.test.ts`).

---

## `store.ts` persistence reworked to per-mutation writes (2026-06-10)

**Decision:** every mutation (addOpenTrade, closeOpenTrade, resolveByPrice,
markProcessed, watchlist CRUD, appendTraderHistory, addSkippedTrade) is a
targeted, transactional SQL write at call time. `writeStore()` bulk-rewrites
ONLY cleanup state (`processed_trade_ids`, `trader_history`) and is called solely
by `runDailyCleanup()` after its in-memory prunes. `markDirty()`/
`flushIfDirty()`/`startAutoFlush()` removed. `startWalCheckpoint()` (from
`index.ts`) runs a PASSIVE WAL checkpoint every 60s.

**Alternative considered:** the old dirty-flag + periodic-flush model.

**Reason:** the DB is always current and nothing needs flushing on exit. Hot
tables are never bulk-rewritten; frozen historical tables (`tracked_traders` —
updated externally by the weekly macro scan —, `excluded_traders`, `shadow_*`)
are never written by the bot.

---

## Sizing + maker-execution research — GROUP D (2026-06-10)

**Decision:** instrument BUYs/SELLs for four research questions, mostly OFF by
default (data collection only):
1. *Source notional* — every watchlist BUY persists the trader's OWN bet size
   (`source_notional` = activity `usdc_size`, fallback `price*size`) on
   `open_trades`/`closed_trades` for conviction-weighted sizing analysis.
2. *Dynamic sizing* — `DYNAMIC_SIZING=false` (OFF; flip env to test): when on,
   BUY size = 1% of `ask_depth_5`, clamped `[MIN_TRADE_AMOUNT=5,
   MAX_TRADE_AMOUNT=25]`; falls back to per-trader `copyAmount` when depth
   unavailable. Pure helper `computeDynamicTradeAmount` in `filters.ts`.
3. *Maker study* — `entry_price_gap` = `best_ask - entry_price` at copy time,
   persisted per BUY.

**Alternative considered:** the old `trader_history` join for source notional
(matched only 40 trades).

**Reason:** ~3-4 weeks of data needed for conviction sizing. **Maker-study
baseline (review 2026-06-10, 1,167 trades): avg gap 6.8% vs the 2% modeled
slippage — taker execution would eat the whole edge.** NOTE: dynamic sizing
moved the wallet-cap check AFTER the depth fetch (it needs the final amount), so
wallet-capped skips now cost two Gamma/CLOB calls — rare, accepted.

---

## Two-tier per-market entry cap (2026-06-11)

**Decision:** *match-style* markets (ISO date in slug, e.g.
`fif-ksa-sen-2026-06-09-draw`; `isMatchStyleSlug` in `filters.ts`) get a LIFETIME
cap of 1 entry per slug. Non-dated markets (geo/political) keep
`MAX_WATCHLIST_ENTRIES_PER_MARKET` within `MAX_WATCHLIST_ENTRY_WINDOW_MS`.

**Alternative considered:** one uniform windowed cap for all slugs.

**Reason:** match-style markets resolve once, so re-entries are correlated bets
on the same outcome. Stacking analysis 2026-06-11: entries #2+ added ~$0 net,
3x drawdown; two stacked match losses -$35.70 tripped the breaker on 06-10.
Non-dated markets live for weeks — scale-in/out re-entries there are genuine new
trades. The windowed cap still closes the BUY-SELL-BUY loophole on those.

---

## Gamma-confirmed delist resolution (2026-06-11) [supersedes the price-only delist snap]

**Decision:** when a market is marked dead (Gamma delisted), re-query Gamma with
`?slug=<slug>&closed=true` — delisted resolved markets vanish from the default
query but stay retrievable with the closed filter, `outcomePrices` pinned to the
final 0/1. When `isMarketResolved` confirms, every position books its outcome's
ACTUAL payout as `resolved` (`decideDelistExit`, pure + unit-tested). Only when
Gamma doesn't confirm does it fall back to last-price inference: ≥0.93/≤0.07
snaps to 1/0 as `resolved` (`snapDelistExitPrice`), mid prices exit 'expired' at
last price.

**Alternative considered:** the prior price-only snap (guess 'expired' at last
price on delist).

**Reason:** the price-only snap misbooked winners whose last live price was
mid-range. Deliberately NOT applied to the 7-day max-hold expiry of
still-listed markets: a live market at 0.95 is not resolved (Fujimori
precedent) — there, last price stays the honest mark-to-market exit.

---

## Partial-sell mismatch tracking (2026-06-11)

**Decision:** every copy-SELL close records `source_sell_fraction` on
`closed_trades`: the fraction of the trader's OWN position their SELL
represented (`soldTokens / (remaining + soldTokens)`, remaining from data-api
`/positions?user&market=<conditionId>` at copy time — up to one poll cycle
late). Pure math `computeSellFraction` in `filters.ts`. Lookup runs only when we
hold a matching position; on failure the column stays NULL.
Threshold/expiry/delist closes never set it — copy-SELLs only.

**Alternative considered:** not tracking the mismatch.

**Reason:** we always close 100% of our copy, so values < 1 quantify the
mismatch (trader trims 10%, we exit fully) — needed to measure whether full
exits cost us edge.

---

## Daily-loss circuit breaker disabled (2026-06-11)

**Decision:** disable the daily-loss circuit breaker via
`DAILY_LOSS_CIRCUIT_BREAKER=off` in docker-compose.yml. Code kept in place
(`src/risk.ts`); `CONFIG.DAILY_LOSS_BREAKER_ENABLED` short-circuits
`checkCircuitBreaker`/`isCircuitBreakerActive` to no-ops, any stale
`meta.circuit_breaker_until` is ignored. Dashboard banner + "Resume now" button
removed; `POST /api/breaker/reset` remains.

**Alternative considered:** keep the breaker active.

**Reason:** a single bad day doesn't predict future performance; the per-trader
decay kill switches cover the real risk. To re-enable: set the env var to a
number (absolute $) or remove it (falls back to `DAILY_LOSS_CIRCUIT_BREAKER_PCT`).

---

## Final shadow/leaderboard cleanup (2026-06-11)

**Decision:** remove the last shadow/leaderboard remnants.

**Reason:** dead code from the 2026-05-29 removal. Scope:
- `/api/shadow/stats` endpoint + dashboard "Watchlist Edge vs Shadow Baseline"
  section removed.
- `shadowClosedTrades` removed from `TradesStore`/store loading; the
  `shadow_open_trades`/`shadow_closed_trades` CREATE TABLE statements,
  insertion-counter scan, and depth-column migration removed (existing DB tables
  remain on disk as frozen history).
- `LeaderboardTrader` type renamed `TrackedTrader` (still live — the weekly macro
  scan writes `tracked_traders`, `/api/discovery/candidates` reads
  `falconSharpe`).
- `pollTrader` lost its `source: 'leaderboard' | 'watchlist'` option and
  `isWatchlist` flag (every poll is watchlist; entry cap / depth gate now
  unconditional), taking `{ address, username? }` instead of a fake
  `LeaderboardTrader`. `copiedTraderRank` hardcoded 0 (legacy NOT NULL column).
  `copiedTraderSource: 'leaderboard'` stays in the type union — historical
  `closed_trades` rows still carry it. See
  [KNOWN_ISSUES — copiedTraderRank](KNOWN_ISSUES.md).

---

## 7-day decay window removed (2026-06-15)

**Decision:** remove the 7d window from the per-trader decay kill switch (the old
"FIX 2"). Only the 30d window remains.

**Alternative considered:** keep the 7d -$30 / 3%-of-wallet gate meant to catch
sustained bleeding hidden by a big 30d cushion.

**Reason:** it proved too tight for sports traders — a single bad weekend during
a seasonal trough tripped it. It false-disabled Shadow-Top4 on 2026-06-13 (7d
net -$33.80, $3.80 past threshold) while he was +$702/30d and about to
re-activate for the FIFA World Cup: the club season had just ended, so his
volume cratered and normal weekend variance dominated.

---

## Entry slippage switched flat-2% → gap-based (2026-06-19, `src/simulator.ts`)

**Decision:** when a watchlist BUY carries an orderbook snapshot, charge entry
slippage = `max(0, best_ask - trader_price) × shares` (the recorded
`entry_price_gap`) instead of the flat `SLIPPAGE_RATE × notional`. Flat 2% stays
as the fallback when no snapshot exists (depth fetch failed, or the raw
observation ledger, which takes no snapshot). `computeEntryCosts` gained an
optional `gap` arg; `monitor.ts` passes `watchlistDepth.bestAsk - activity.price`.

**Alternative considered:** keep the flat 2% model; or recalibrate the flat rate
to a higher constant.

**Reason:** the 06-19 gap analysis (n=230 with gap / 160 closed since 06-10)
showed the flat 2% model charged $16 of entry slippage while the *real* taker
cost (gap×shares) was $29.32 — understated ~83%. Cause is dimensional: the gap is
absolute (a 1-cent tick is the modal gap), while 2% is relative, so on cheap
longshot outcomes ($0.10) a 1-cent gap is ~10% but the model only booked 2%.
Gap-based uses the per-trade measured cost we already persist, removing the
miscalibration. Floor at 0 because a negative gap (stale snapshot, ask below the
trader's booked price) must not credit phantom profit. A flat recalibration was
rejected — it would fix the average but not the price-dependent dispersion.
Clean-window closed PnL under each model: flat-2% +$40.80, gap-based (real ask)
+$27.48. This is an execution-cost realism fix, **not** an edge/sizing decision —
n=160 is far below the n≥5k/p<0.01 bar and nothing about DRY_RUN changes.

## Macro-scan exclusion: whale `0xc8ec...8f1` (2026-06-29)

**Decision:** added `0xc8ec6d4cef5c5fe8409ef69303c37f05b678e8f1` to the
`excluded_traders` table (`auto=0`, manual) so the weekly macro scan stops
re-surfacing it. The two scan scripts filter their candidate universe against
this table (`scripts/macro_scan.js:253`, `scripts/macro_scan_90d.js:167`); the
live copy loop never reads it (watchlist-only, see "Frozen tables" in
KNOWN_ISSUES.md), so this affects discovery only, not trading.

**Reason:** the whale was vetted and rejected on 2026-06-22 but kept reappearing
in the scan (WR 65%, +$781,714 90d). It is NOT a market maker (maker fraction
6.1%, 1 MAKER_REBATE) so the MM auto-reject rule did not catch it. The reported
PnL is high-variance whale gambling, not a copyable edge: ~$476k of REDEEM
payouts = ~3 NBA mega-wins staked at $33k-$147k notional, offset by ~$433k of
held-to-resolution losers parked at curPrice~0. 70% of distinct slugs he buys are
never sold, so the 65% FIFO win-rate is the FIFO-hides-held-losers artifact. A
whale's size/variance edge is structurally non-replicable at a flat $5 clip
(local sim was net -$11.26 over 7 closes). Full analysis in memory
`project_candidate_0xc8ec_whale`; same artifact as the `0xef27`/`0x8a3ab8`
rejections.

---

## Tape scanner: two-tier gate + all-category universe (2026-07-21)

**Decision:** loosen `tape_scan.js`'s observation-bench gate (WR 55%→50%, pnl
$500→$200, roi 10%→5%) while leaving `GATE_MAX_FILLS_PER_MARKET` (10) and
`GATE_MIN_AVG_HOLD_HOURS` (4) unchanged. A `highConfidence` flag marks rows
that also clear the original thresholds — a subset of the loosened list, not
a second scan. Also expanded the market universe: union of the existing
closed_trades-sourced slugs with a broad, uncategorized sweep of every market
Gamma closed in the last `UNIVERSE_DAYS` days.

**Alternative considered:** filter the broad sweep by category/tag (e.g.
`tag=crypto`) to scope "expand to crypto, political, etc." literally.

**Reason:** the universe was previously limited to markets our own current
or former watchlist traders happened to trade — sports + Iran-geopolitics
only. Rejected the tag-filter alternative because Gamma's `tag` param is a
silent no-op (empirically verified: `tag=crypto` returns the identical
unfiltered page as no tag at all) — not filtering at all is the only way to
actually cover every category. Result: +2,100 additional distinct slugs
beyond the 351 from closed_trades (2,451 total; `MAX_MARKETS=1200` is now
the binding cap, previously never reached). The WR/PnL/ROI loosening is safe
specifically because the fills/market and hold-time gates (added the same
day after 0x7ea571c4/0x84ad9c5c) are the ones actually doing the
bot-vs-discretionary discrimination — confirmed on rerun: several new
high-PnL candidates surfaced by the broader universe (e.g. one at $73,318
pnl/44 markets) still fail on fills/market or WR and don't reach the bench.

**Gotcha found building this:** Gamma's `/markets` listing silently caps
`limit` at 100 regardless of what's requested (unlike `/trades` and
`/activity`, which cap at 1000 — see `project_tape_scanner` memory). First
implementation requested 500, got 100, and its "short page = last page"
stop check misread that as end-of-data after a single page — undercounted
the broad universe by ~20x (100 vs the true +2,100) until caught.

---

## Tape scanner auto-observation pipeline (2026-07-22)

**Decision:** `tape_scan.js` can now write to `watchlist_traders` directly.
When `TAPE_SCAN_AUTO_ADD=1` (set only by the new `weekly-tape-scan.sh` cron
wrapper, Sundays 05:00 UTC — never on a plain manual run), `highConfidence`
survivors get MM-checked individually (fresh `/activity` call per
candidate, adapted from `macro_scan.js`'s `isMarketMaker`) and, if clean,
inserted as `copy_enabled=0`/`label='Auto-Obs-MMDD'`, capped at 10 standing
observation traders total. One Telegram message per addition
(`weekly-tape-scan.sh` parses `TELEGRAM_MSG_B64` lines from the run log and
sends each verbatim — no JSON-in-bash parsing).

**Alternative considered:** ship exactly the gate list this was specced
with (MM check, fills/market, hold-time, WR>55%, pnl>$500, roi>10%) with no
further additions.

**Reason:** added a `GATE_MIN_PSEUDOREPL_RATIO` (0.15) gate not in the
original spec — distinct (market,outcome) pairs / total fills. This is the
exact check that separated `0x52d93dcf` (0.38, passed manual vet 2026-07-21)
from `0x7ea571c4`/`0x84ad9c5c` (0.03-0.07, rejected same day), and was an
explicit step in the manual-vet checklist used on `0x52d93dcf` — automating
watchlist writes on a gate this project had already twice proven incomplete
without it was not a tradeoff to make silently. Computed from data the
scanner already fetches, no extra API calls.

First live run (2026-07-22, via `weekly-tape-scan.sh`) validated the MM
check hard: of 8 `highConfidence` candidates that had already cleared every
numeric gate, **6 of 8 (75%) were market makers** caught only by the
per-candidate `/activity` check — including `0x28dc4b77...`, which had
appeared on an unvetted top-10 list shown to the user the same week. Only 2
survived and were added (`0xadfb6cba...`, `0x09b4c417...`). This is strong
evidence the numeric gates alone (even with fills/market, hold-time, and
pseudo-replication) are not sufficient on their own — the MM check the
pipeline was explicitly specced with is doing the majority of the real
discriminating work on this candidate pool.

**Consequence:** `watchlist_traders` entries added by this path have NOT
had the full manual 7-step vet (on-chain cash-flow verification, market/
category breakdown, qualitative "does this look like a bot" read) that
every prior addition (`Shadow-Top4`, `Geopolitics-Macro`,
`Soccer-Multi-Obs-0721`) received. They are `copy_enabled=0` (no capital
at risk) and trivially reversible (`DELETE FROM watchlist_traders WHERE
address=...`), but this is a real, deliberate narrowing of the
"manual trust decision" principle in `CLAUDE.md`'s watchlist section,
scoped specifically to the observation tier. Spot-check `Auto-Obs-*`
entries periodically rather than treating this as fire-and-forget.

## Observation ledger: in-memory cache narrowed to open rows (2026-09-14, `src/store.ts`)

**Decision:** `TradesStore.observationTrades` (every row of `observation_trades`,
loaded eagerly on boot) became `observationOpenTrades` — `status='open'` rows
only. Consumers that need the closed tail stream it from SQLite via the new
`store.iterateObservationTrades()` generator instead of reading the cache.

**Reason:** the bot was in a boot-loop OOM. `readStore()` materialised the whole
table as JS objects on every start; by 2026-09-14 that was 328,076 rows × 27
columns, which blew past `--max-old-space-size=450` about 28 s into startup —
before the first poll cycle ever ran. 67 crash-restarts in the 6 h window that
was still in the container log. The table is 146 MB + 38 MB index, ~78% of the
237 MB DB, and it only grows: the tape-scan auto-observation pipeline
(2026-07-22) took the watchlist from 4 to 11 traders, all writing ledger rows.

Open rows are the only ones with live work to do — the price sweep marks them
and FIFO/threshold closes retire them. Everything else was either an aggregate
(`/api/observation`) or a set-membership test (the cleanup `refIds` dedup set),
and both work fine streamed. Eviction on close is the half that matters as much
as the narrowed load: `closeObservationTrade` and `resolveObservationByPrice`
now splice the row out of the cache, so the closed tail cannot re-accumulate
between restarts.

Renamed rather than silently redefined, so the compiler forced every one of the
seven call sites to be revisited — a field named `observationTrades` that
holds only open rows is exactly the kind of trap that produces wrong dashboard
stats months later.

**Measured:** heap at steady state 137 MiB / 512 MiB, 147 MiB after streaming
the full 328k-row ledger through `/api/observation`; 0 OOM, 0 restarts.
Endpoint output shape unchanged (verified against the live dashboard).

**Not addressed:** 64,426 rows were sitting in `status='open'`, many of them
long stale — the cache is bounded now but that number is still the dominant
term in it, and it should be pruned or aged out separately. See
`docs/KNOWN_ISSUES.md`.

## Watchlist Performance panel reset (2026-09-26, `src/dashboard.ts`, `public/index.html`)

User asked to zero the Watchlist Performance panel when three low-frequency
traders (LowFreq-Events/Politics/Tennis-0926) went live in the sim at
2026-09-26T15:08:47Z. Implemented as a baseline, not a delete:
`WATCHLIST_STATS_SINCE_MS` filters the watchlist view of `/api/stats` and the
panel charts to trades **opened** at or after that instant. All history stays in
the DB; `?source=all`, the $1k test window (`TEST_START_MS`, May 28) and the
go-live gate are unchanged. Wallet and open-position cards keep counting every
open position, because the wallet cap applies to all of them. The constant is
duplicated in `public/index.html` (same pattern as `TEST_START`); keep both in
sync when resetting again.
Moved to 2026-09-26T21:38:14Z the same evening, when 0x12d6 went to observation:
all ten trades opened since 15:08 were its, so the panel now starts with the
three LowFreq traders only.

## Taker fees in the sim (2026-09-26, `src/fees.ts`, `src/monitor.ts`, `src/store.ts`, `src/simulator.ts`)

The sim assumed Polymarket had no trading fees. Since 2026 it charges takers
`fee = shares * rate * p * (1 - p)` with a per-category rate (crypto 0.07;
sports, economics, culture, other 0.05; politics, finance, tech, mentions 0.04;
geopolitics 0; makers 0 -- docs.polymarket.com/trading/fees). Every copy is a
taker order, so each watchlist BUY now reads the market's rate from Gamma
(`feesEnabled` + `feeSchedule.rate`, cached per slug; fallback 0.05 when the
lookup fails), stores it as `fee_rate`, and books `entry_fee_cost`; the close
books `exit_fee_cost` at the exit price, which is zero for 0/1 resolutions by
the formula. Both are subtracted in `cost_adjusted_pnl` and the dashboard cost
functions. Trades opened before this change carry no fee fields and stay
unchanged. The observation ledger is left fee-free (raw by design).
Backtest impact for $5 copies was small (0x12d6 3.5 months -$46 -> -$69).

## Real-time trade feed via Polymarket RTDS (2026-09-26, `src/rtds.ts`, `src/monitor.ts`, `src/index.ts`)

Latency survey (161 trades, 7 wallets): data-api `/activity` publishes a trade
~22s (median; p90 34s) after the fill even when polled every 3s, so the bot's
~33s copy latency came from the index, not the 30s poll interval. The RTDS
websocket (`wss://ws-live-data.polymarket.com`, topic `activity`/`trades`)
delivered 158/161 trades at a 0.8s median; Polygon `OrderFilled` logs were
~0.8s faster still but need asset-id decoding, so RTDS was chosen.

The socket can't be filtered by wallet server-side: the bot receives the whole
firehose (~30 msg/s, ~26 KB/s measured; the existing poll already downloads
~110 KB/s) and filters locally, ~1% of a core, no extra disk writes. Matching
trades go through the same `processActivity` as polled ones. Two rules keep it
safe: (1) only the poll moves the data-api cursor, so trades the socket misses
are still backfilled; (2) all processing runs behind one lock, because the
wallet cap and per-market entry cap are checked before the depth/fee HTTP
awaits and concurrent BUYs could both pass them (a test without the lock
double-copies). Reconnects with backoff; a 60s-silent feed is treated as dead.
`RTDS_ENABLED=false` reverts to polling only. Expected effect: roughly the
latency share (~21%) of the measured entry gap; the spread itself remains.

## Price sweep: HTTP 429 no longer marks markets dead (2026-09-26, `src/simulator.ts`)

The 5-minute price sweep fetched ~450 slugs from Gamma at concurrency 10
(~80 req/s) and drew 76-153 HTTP 429s per sweep. Any failure counted toward
the 3-strike dead-market rule, so a slug rate-limited in three consecutive
sweeps was "marked dead" and its positions closed at the last price -- e.g. 100
live markets and 232 observation positions at 20:56 today. The same burst
pattern (hundreds to thousands of observation expirations per day) is in the
DB since at least 2026-09-19; `closed_trades` shows none. Fix: 429 is skipped
and retried next sweep, never counted as a failure (`isRateLimitError`), and
concurrency dropped to 2 (~10 req/s; Gamma accepted ~15). First sweep after:
470 slugs in 36s, zero 429s, zero dead markings. Observation rows already
expired this way are left as they are.

## Weekly discovery: tape scan replaced by the low-frequency scan (2026-09-26, `scripts/lowfreq_scan.js`, `scripts/weekly-lowfreq-scan.sh`)

All eight traders `weekly-tape-scan.sh` auto-added since 2026-07-22 were bots
trading 50-1500 markets a day; seven lost heavily as copies (clustered t -5 to
-11, negative even before costs). The tape scan ranked by the trader's own
cash-flow PnL, which rewards exactly the high-turnover, maker/arb styles a
~30s-late $5 taker copy can't reproduce. It also inserted straight into the DB,
which the bot (cached store) only picked up after a restart.

The Sunday 05:00 UTC cron now runs `weekly-lowfreq-scan.sh`, which repeats the
manual search that found LowFreq-*-0926: Bullpen + data-api leaderboards ->
PnL per volume -> copyability from recent activity (<= 10 orders/day, taker,
no merge/split/conversion, no maker rebates) -> closed + open positions netted
-> backtest gate on our own copy rules with real costs and fees (90% CI above
zero, positive at double cost, >= 40 markets over >= 4 months, positive in both
halves of its history, not carried by one market). Survivors are added as
observation through the dashboard API (`POST /api/watchlist` now accepts
`copyEnabled: false`), capped at 10 standing observation traders. The gate
passes all three LowFreq traders and rejects 0x12d6 on both backtest windows.
First report-only run: 1295 -> 31 -> 10 backtested -> 0 passed, 6.8 minutes.
`tape_scan.js` stays in the repo but is no longer scheduled.

Same day: the seven losing auto-observation traders were removed from the
watchlist (their observation rows stay in the DB), and 0x12d6 was switched to
observation: its 30d copy PnL was significantly negative (t -2.4) and it fails
the gate with fees. Its 35 open copies stay open until resolution or the 7-day
max hold, since its SELLs now go to the observation ledger.

## Dashboard rework after the 2026-09-26 review (2026-09-27, `src/dashboard.ts`, `public/index.html`, `src/forwardtest.ts`, `src/health.ts`, `src/discovery.ts`)

The review found the dashboard slowing the bot and showing stale or wrong numbers.

- **Observation stats no longer block the bot.** `/api/observation` streamed
  all 550k ledger rows through JS on every 30s refresh, holding the event loop
  ~9s each time; copies arriving meanwhile waited. Stats are now a SQL
  aggregate per trader (`observationClosedStats`, new index on
  `(copied_trader, timestamp)`) for copy-disabled watchlist traders only,
  merged into `/api/watchlist`. They count rows opened from 2026-09-26 21:00 UTC,
  since earlier observation closes are contaminated by the 429 bug
  (KNOWN_ISSUES).
- **Removed, because they mixed in traders and regimes the bot no longer copies:**
  - the Test PNL / Test Trades cards (since May 28) and the 0x12d6 Longshot
    Skips card;
  - the all-time slug-category panel (42% "other");
  - the go-live gate (n >= 5000 and p < 0.01 over everything closed since
    May 28, which is unreachable for low-frequency traders anyway).
- **Now counted since the panel reset:** Risk metrics, which had been all-time
  (Sharpe 2.45 came from the April edge).
- **Traders:** the 2000px table (copy and remove buttons off-screen at 1440px)
  and the observation table became one card per trader. Each card shows its
  status, last trade, its ledger since the right start, kill-switch headroom
  and the copy toggle. One details panel opens below the cards. The FIFO
  "Hist Win Rate / Best / Worst" rows were dropped (the fake-win-rate trap).
  The positions rows were relabelled "current book".
- **New panels:**
  - **Forward test:** copy ledger vs each trader's backtest, per settled
    market, with a 90% band (constants in `src/forwardtest.ts`).
  - **Where the money goes:** gross at trader prices -> entry gap, fees, exit
    slippage -> net.
  - **Live readiness:** a checklist with automatic items from the forward test
    and manual build items.
  - **Header badges:** RTDS feed status and event-loop lag.
  - **System health strip:** copy latency (new `copied_at`/`copy_source`
    columns), Bullpen session, DB size and growth, git-sync, weekly scan,
    watchdog.
  - **Weekly discovery:** funnel and backtest reasons from the low-frequency
    scan's `report.json`.
- **Fixed:**
  - The history charts never loaded while nothing had closed since the reset.
  - The wallet chart counted 466 legacy April rows with no `closed_at` as open
    (~$2.3k phantom).
  - The charts pulled the full 5 MB trade history every 30s; `/api/trades` now
    takes `since` and `limit`.
  - The container RAM included page cache on cgroup v2 (`inactive_file` is now
    subtracted, as `docker stats` does).
  - The mobile header overflowed.

## Falcon macro scan and its key alert retired (2026-09-27, crontab)

`weekly-macro-scan.sh` (Mon 04:00, Falcon 7d/30d leaderboards + 90d scan) had
produced at most one weak candidate a week. The latest was 5 closed trades at a
100% win rate, the fake-win-rate trap. The dashboard's parser for its log had
also broken. The Sunday low-frequency scan covers discovery without Falcon. With
the macro scan gone, no scheduled job uses the Falcon key, so
`check-falcon-expiry.sh` would only have asked for a key nobody needs. Both
cron lines were removed. The scripts stay in the repo and the key stays in
`.env`. `trader_review.js` / `macro_verify.js` can still use it by hand until it
expires on 2026-11-13. To restore, re-add the two lines (`0 4 * * 1
weekly-macro-scan.sh`, `0 9 * * * check-falcon-expiry.sh`).

## Weekly low-frequency scan moved to Sunday 05:30 UTC (2026-09-27, crontab)

The Sunday 05:00 `docker system prune -f` removed the unused `node:20-alpine`
image at the moment the first scheduled scan started, so the scan had to pull it
again. It worked, but a prune mid-pull would fail the run. The scan now starts at
05:30.

## Watchlist: Auto-Obs-0830 and Shadow-Top4 removed (2026-09-27)

Auto-Obs-0830 (0x5268…135d) is a high-frequency bot. On clean observation data
alone (from 2026-09-26 21:00) it closed 3,806 positions in ~10 hours at PF 0.87,
-$1,338. It was also the largest source of ledger growth. Shadow-Top4
(0x507e…beae) was switched off by the kill switch on 2026-07-15 and has not
traded since. Both were removed through the dashboard API; their rows stay in
the DB. Auto-Obs-0723 stays: it is the one auto-added trader with a positive
record, and a silent trader costs nothing.
