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
