# Polymarket Copy Trading Bot

DRY_RUN simulation-only copy bot. Tracks a persistent watchlist of traders; simulates each BUY as a $5 position (watchlist entries can override via `copyAmount`) and closes FIFO on matching SELL.

**Watchlist-only architecture (as of 2026-05-29).** Leaderboard tracking was removed completely. The bot polls **only** `watchlist_traders`; there is no leaderboard fetch, no Falcon leaderboard refresh, and no shadow polling. `runPollingCycle()` in `src/index.ts` iterates the watchlist and calls `pollTrader(trader, { source: 'watchlist', copyEnabled, tradeAmount })` — nothing else.

History: leaderboard was first demoted to shadow-only on 2026-05-28 (lifetime leaderboard real-copy PNL was -$2,451 over 9,258 closed trades — no demonstrable edge), then removed entirely on 2026-05-29. On removal: `src/leaderboard.ts` was deleted; `refreshLeaderboard` and the periodic refresh were removed from `index.ts`; auto-exclusion logic and its config (`AUTO_EXCLUDE_WIN_RATE_THRESHOLD`, `AUTO_EXCLUDE_MIN_TRADES`) plus `LEADERBOARD_LIMIT` / `LEADERBOARD_REFRESH_MS` were dropped from `config.ts`; `tests/auto_exclusion.test.ts` was deleted. DB: `tracked_traders` and `shadow_open_trades` were purged; `shadow_closed_trades` and `excluded_traders` are kept as a **historical record** (`shadow_closed_trades` still surfaced read-only via `/api/shadow/stats`; `excluded_traders` is no longer read by any endpoint — frozen table only).

A second cleanup pass on 2026-05-29 removed the dead code itself: the shadow + `!isWatchlist` real-copy branches and `hasSufficientSample` in `src/monitor.ts`; orphaned `store.ts` exports (`updateTrackedTraders`, `updateTraderLastOnLeaderboard`, `setAutoExclusion`, `setLeaderboardStats`, `updateWatchlistFalconData`, `updateTraderFalconCache`, `setTraderExclusion`, `isShadowProcessed`, `addShadowOpenTrade`, `closeShadowOpenTrade`, `markShadowProcessed`, `setShadowLastSeen`) plus the in-memory `excludedTraders`/`autoExcludedTraders` store fields; `bullpen.ts` leaderboard/Falcon fetchers (`getLeaderboard`, `getFalconLeaderboard`, `RawFalconTrader`, `RawLeaderboardItem`, `RawLeaderboardResponse`); `simulator.ts` shadow-resolution logic; and the now-inert filter config keys. `persistSnapshot` no longer rewrites `shadow_closed_trades` (read-only/frozen). Dashboard `/api/watchlist` no longer returns Falcon fields and `/api/stats` no longer returns `trackedTraders`/`lastLeaderboardUpdate`.

## Stack
- Node.js / TypeScript, vitest tests under `tests/`
- Bullpen CLI (`@bullpenfi/cli`) — docs https://cli.bullpen.fi/ — requires `bullpen login` on host; config at `~/.bullpen/`
- Docker + gluetun WireGuard VPN (Polymarket geo-blocks Hungary)
- Express dashboard on container port 8080 → host 8082

## Key rules
- **Never flip `DRY_RUN=false`** without an explicit instruction in the current conversation.
- Ask before guessing — use AskUserQuestion for anything ambiguous.
- **🚨 WATCHLIST TRADERS BYPASS ALL ENTRY FILTERS — BY DESIGN, INTENTIONAL. 🚨**
  Since the bot is **watchlist-only** (leaderboard removed 2026-05-29), **every** trade is a
  watchlist trade, so these filters apply to **nothing** and are inert no-ops:
  - price floor/ceiling (`MIN_PRICE`, `MIN_PRICE_SPORTS`, `MAX_PRICE`)
  - spread cap (`MAX_SPREAD`)
  - category exclusions (`FORCE_EXCLUDE_CATEGORIES`, dashboard exclusions)
  - per-market caps (`MAX_POSITIONS_PER_MARKET`, `MAX_POSITIONS_PER_MARKET_SPORTS`)
  - global open-position cap (`MAX_TOTAL_OPEN_POSITIONS`) — **NOT enforced for watchlist**
  - per-trader sample gates (`MIN_TRADER_SAMPLE`, `MIN_TRADER_SHADOW_SAMPLE`)

  **Rationale:** a watchlist entry is an explicit, manual trust decision by the operator.
  The operator vouches for the trader, so the bot copies them unconditionally — no
  algorithmic second-guessing on price, liquidity category, or sample size.

  **The ONLY active constraints on a watchlist BUY are:**
  1. **Wallet cap** — `SIMULATED_WALLET_SIZE * WALLET_CAP_UTILIZATION` (e.g. $1000 × 0.80 = $800);
     new BUYs are skipped once open `simulatedAmount` would exceed it.
  2. **Per-market watchlist entry cap** — `MAX_WATCHLIST_ENTRIES_PER_MARKET` within
     `MAX_WATCHLIST_ENTRY_WINDOW_MS` (closes the BUY-SELL-BUY loophole).
  3. **Depth gate** — skip BUY when CLOB `ask_depth_5 < DEPTH_GATE_MIN_DEPTH_5` (thin-book guard).

  As of 2026-05-29 the now-inert filter config keys above were removed from `config.ts` and
  `docker-compose.yml`; the dead `!isWatchlist` / shadow branches in `monitor.ts` that read
  them were deleted.

  **Per-trader carve-out exception (added 2026-06-09):** a single, NARROW exception to the
  "bypass all filters" rule, scoped to ONE trader by full address. When a BUY comes from
  `LONGSHOT_FILTER_TRADER` (`0x12d6cccfc7470a3f4bafc53599a4779cbf2cf2a8`, label
  *Geopolitics-Macro*) at `entryPrice < LONGSHOT_FILTER_MAX_PRICE` (default `0.10`), the bot
  **skips the copy** and instead records the would-be entry in the `skipped_trades` table with
  `skip_reason='longshot_filter_0x12d6'`. Record-only — no PnL lifecycle. Logged as
  `skip <slug> entry=<price> trader=0x12d6 reason=longshot_filter`. The check lives at the top
  of the BUY branch in `monitor.ts` (before wallet/entry-cap/depth gates). Rationale
  (re-verified 2026-06-10 on Gamma-corrected data after the threshold-resolution fix): the
  original justification used stats contaminated by the insta-resolution artifact, but the
  conclusion survives clean accounting — all-time 89 sub-$0.10 trades, corrected net ≈ -$196;
  0 of 57 ride-to-resolution longshots won (~2 expected at fair pricing); the trader's own
  later activity (0 REDEEMs, 1 SELL at a loss) confirms the booked outcomes. The carve-out
  stays; `skipped_trades` preserves count + cumulative would-be notional so the pattern can be
  monitored for change over time. Dashboard surfaces it via `/api/stats`
  (`longshotSkipCount`, `longshotSkipNotional`) and the "🚫 Longshot Skips" card. This is the
  ONLY per-trader filter override; to retire it, drop the `monitor.ts` block and the two config
  keys. Other watchlist traders are unaffected.
- **Threshold resolution (reworked 2026-06-10, `src/simulator.ts`):** positions at price
  ≥0.93 / ≤0.07 are no longer blindly proxy-booked at $1/$0. Three-way decision
  (`decideThresholdResolution`, pure + unit-tested): (1) Gamma-confirmed resolution
  (market `closed` AND all `outcomePrices` pinned to 0/1, `isMarketResolved`) → book actual
  final outcome immediately, no age gate; (2) entry price already beyond the threshold
  (longshots ≤0.07, favorites ≥0.93) → NEVER proxy-resolved — held until Gamma confirms,
  a copy-SELL closes, or max-hold expiry (pre-fix these were insta-booked as total
  wins/losses while still live, corrupting all sub-$0.10 / >$0.93 bucket stats before
  2026-06-10); (3) entry crossed the threshold after open → legacy price-proxy fallback
  after one price-update interval, each one logged
  (`price-proxy resolve ... (Gamma does not show market resolved)`) — kept because Gamma
  delists resolved sports markets within ~a day, usually before ever showing
  `closed=true`, so requiring confirmation would misbook winners as 'expired' at last price.
- **Observation forward-test (added 2026-06-10):** copy-disabled watchlist traders are no
  longer discarded — their trades run the full simulated lifecycle in the separate
  `observation_trades` table (single table; rows mutate in place from `status='open'` to
  `resolved`/`expired`). Same cost model and same threshold-resolution decision as real
  copies, but deliberately RAW: no wallet cap, no entry cap, no depth gate, no longshot
  filter — the ledger measures the trader, not our execution constraints — and observation
  rows never enter `open_trades`, so the wallet cap is unaffected. Store API:
  `addObservationTrade`, `closeObservationTrade` (FIFO), `updateObservationTradePrices`,
  `resolveObservationByPrice`. The 5-min price sweep covers observation positions in the
  same pass (shared slug fetches). Dashboard: `/api/observation` (per-trader n/WR/PF/net,
  cost-adjusted) + "👁 Observation Forward-Test" section. Logs: `[OBS] BUY/SELL`. Purpose:
  macro-scan candidates can be added copy-disabled and build a real forward-test record
  before copying is enabled.
- **Risk controls (added 2026-06-10, `src/risk.ts`):** two automatic guards, both alerting
  via Telegram (`src/alerts.ts`, creds injected from `~/.env.shared` via `env_file` in
  docker-compose — the `[polymarket_bot]` prefix groups messages):
  1. *Per-trader decay kill switch* — after each poll cycle, any copy-enabled watchlist
     trader whose rolling 30d cost-adjusted net drops below `TRADER_DECAY_THRESHOLD_30D`
     (default -50) is auto-disabled (`watchlist_traders.auto_disabled_at/_reason`); the
     trader keeps accruing observation forward-test data. Manual re-enable via dashboard
     clears the marker, but if still under threshold the next check re-disables — raise
     the env threshold to truly override.
  2. *Daily-loss circuit breaker* — when total cost-adjusted realized PnL over the last
     24h drops below `DAILY_LOSS_CIRCUIT_BREAKER` (default -30), ALL copying pauses for
     24h (`meta.circuit_breaker_until`). While paused, polling continues and cursors
     advance (missed BUYs are NOT copied late — a paused real wallet misses trades), and
     copy-SELLs still close existing positions (the breaker stops new exposure, not
     risk-reducing exits). Observation ledger unaffected. Auto-resumes on expiry; manual
     reset: dashboard banner button → `POST /api/breaker/reset`. Note: trades that close
     during the pause count in the next 24h window, so a still-bleeding book can re-trip
     immediately on resume — intended.
  Dashboard: `/api/stats` returns `circuitBreaker {active, until, net24h, threshold}` +
  `traderDecayThreshold30d`; `/api/watchlist` items carry `pnl30d`/`decayDistance`; the
  watchlist table shows a "30d Net (kill switch)" column with headroom tooltip and ⛔ badge.
  Window math is pure (`rollingNetForTrader`, `rollingNetTotal`, `evaluateCircuitBreaker`)
  and unit-tested (`tests/risk.test.ts` host-runnable, `tests/kill_switch.test.ts` DB-backed).
- **Sizing + maker-execution research (added 2026-06-10, GROUP D):**
  1. *Source notional* — every watchlist BUY persists the trader's OWN bet size
     (`source_notional` = activity `usdc_size`, falling back to `price*size`) on
     `open_trades`/`closed_trades` for conviction-weighted sizing analysis (~3-4 weeks of
     data needed; the old `trader_history` join only matched 40 trades).
  2. *Dynamic sizing* — `DYNAMIC_SIZING=false` (OFF; flip env to test): when on, BUY size
     = 1% of `ask_depth_5`, clamped to `[MIN_TRADE_AMOUNT=5, MAX_TRADE_AMOUNT=25]`;
     falls back to per-trader `copyAmount` when depth is unavailable. Pure helper
     `computeDynamicTradeAmount` in `filters.ts`. NOTE: the wallet-cap check moved AFTER
     the depth fetch (it needs the final amount), so wallet-capped skips now cost two
     Gamma/CLOB calls — rare, accepted.
  3. *Maker study* — `entry_price_gap` = `best_ask - entry_price` at copy time, persisted
     per BUY (a maker limit at the trader's price vs taker at the ask). After ~2 weeks:
     fill-rate proxy = share of trades with gap ≤ 0/within spread; PnL improvement =
     avg(gap)*shares. Measured baseline (review 2026-06-10, 1,167 trades): avg gap 6.8%
     vs the 2% modeled slippage — taker execution would eat the whole edge.
- `store.ts` persistence (reworked 2026-06-10): every mutation (addOpenTrade, closeOpenTrade, resolveByPrice, markProcessed, watchlist CRUD, appendTraderHistory, addSkippedTrade) is a targeted, transactional SQL write at call time — the DB is always current and nothing needs flushing on exit. `writeStore()` bulk-rewrites ONLY cleanup state (`processed_trade_ids`, `trader_history`) and is called solely by `runDailyCleanup()` after its in-memory prunes (processedTradeIds referenced-ID trim; traderHistory 90-day entry prune). `markDirty()`/`flushIfDirty()`/`startAutoFlush()` were removed. `startWalCheckpoint()` (called from `index.ts`) runs a PASSIVE WAL checkpoint every 60 s to bound WAL growth. Hot tables are never bulk-rewritten; frozen historical tables (`tracked_traders` — updated externally by the weekly macro scan —, `excluded_traders`, `shadow_*`) are never written by the bot.
- **`closed_trades` retention: unlimited.** As of 2026-05-27 the 7-day archival step in `runDailyCleanup()` was removed — the table holds the full history in-DB (query perf ~12 ms at 30k rows). Existing `data/archive/*.json` files are historical artifacts; the importer ran once to merge them back. Daily backups in `data/backups/` (last 30 retained) remain the disaster-recovery path. `traderHistory` and `processedTradeIds` still prune in the same daily run.

## Orderbook depth at fill time (watchlist only)
Every watchlist BUY snapshots CLOB orderbook state via `getOrderbookDepth(slug, outcome)`
(src/bullpen.ts) before `addOpenTrade`. Two HTTPS calls: Gamma (slug → `clobTokenIds`)
+ CLOB `/book`. Failures fall through with null — depth is never blocking.

Fields persisted on `open_trades` + `closed_trades` (and shadow tables, schema-symmetric):
- `best_ask`, `best_bid` — top of book at fill time
- `spread_at_entry` — `best_ask - best_bid`
- `ask_depth_5`, `ask_depth_10` — $ available within 5% / 10% of best_ask
  (sum of `price * size` over asks at `price <= best_ask * 1.0X`)
- `depth_backfilled` — 1 if filled in at startup from current book (stale), 0 if captured at fill time

Backfill: `backfillOpenTradeDepth()` runs once at startup for open watchlist trades
where `bestAsk` is null. Best-effort, fire-and-forget; throttled 100ms per fetch.
Backfilled depth reflects current book, not the original fill moment — coarse proxy only.

Dashboard `/api/watchlist` exposes per-trader `avgAskDepth5`, `avgSpread`, `liqSampleCount`
across the trader's open + closed sim trades. Leaderboard copies are not instrumented.

## Bullpen API gotchas
- `data leaderboard` and `activity` return direct JSON arrays, **not** `{items: []}`.
- `price` returns `{outcomes: [{outcome, midpoint, last_trade, best_bid, best_ask}]}` — `outcomes` is an ARRAY, not a keyed map.
- Leaderboard `pnl` / `volume` are STRINGS → wrap in `Number()`.
- Activity items use `transaction_hash` (not `id`) and `slug` (not `market_slug`).
- Only process items where `type === 'TRADE'` and `side` is `BUY` or `SELL`.
- `data leaderboard` ignores `--period` / `--limit`; slice in JS.

## Environment (docker-compose.yml)
```
NODE_OPTIONS=--max-old-space-size=450   # Node heap cap; container limit 512MB
DRY_RUN=true
PORT=8080

POLL_INTERVAL_MS=30000                  # 30 s per cycle
PRICE_UPDATE_INTERVAL_MS=300000         # 5 min mark-to-market sweep

# REMOVED 2026-05-29 (watchlist-only; these were inert no-ops — see "Key rules").
# Deleted from config.ts AND docker-compose.yml:
#   LEADERBOARD_REFRESH_MS, AUTO_EXCLUDE_WIN_RATE_THRESHOLD,
#   MIN_PRICE, MIN_PRICE_SPORTS, MAX_PRICE, MAX_SPREAD, FORCE_EXCLUDE_CATEGORIES,
#   MAX_POSITIONS_PER_MARKET, MAX_POSITIONS_PER_MARKET_SPORTS, MAX_TOTAL_OPEN_POSITIONS,
#   MIN_TRADER_SAMPLE, MIN_TRADER_SHADOW_SAMPLE

# Watchlist-only entry cap (open+closed within window) — closes the BUY-SELL-BUY
# loophole. One of the THREE active constraints (see "Key rules").
MAX_WATCHLIST_ENTRIES_PER_MARKET=2
MAX_WATCHLIST_ENTRY_WINDOW_MS=43200000   # 12h

GAS_COST_PER_BUY=0                      # Polymarket charges no fees on sports markets
SLIPPAGE_RATE=0.02                      # 2% each side (entry at ask, exit at bid)

# Watchlist depth gate (added 2026-05-27) — skip BUY when CLOB ask_depth_5 < $500.
# Protects against thin books where a $5-15 copy would itself move the market;
# also improves statistical validity of the watchlist edge by trimming low-liquidity
# tail trades. Non-blocking on depth-fetch failure (copy proceeds).
DEPTH_GATE_MIN_DEPTH_5=500

# Simulated wallet cap (added 2026-05-28) — models a fixed-size real wallet.
# When SIMULATED_WALLET_SIZE>0, sum(simulatedAmount) over open trades is compared
# against SIMULATED_WALLET_SIZE * WALLET_CAP_UTILIZATION before each BUY; over-cap
# BUYs are skipped (applies to BOTH watchlist and leaderboard — wallet is a hard
# real-money constraint regardless of trust override). Logs `wallet_cap: $X/$1000 in use`.
# Dashboard /api/stats returns simulatedWalletSize, walletInUse, walletCapUtilization.
SIMULATED_WALLET_SIZE=1000
WALLET_CAP_UTILIZATION=0.80

FALCON_API_KEY=${POLYMARKET_ANALYTICS_API_KEY:-}
```

## Server Environment
- Host: `<server-host>` (fallback IP `<server-ip>`), port `<ssh-port>`, user `user`
- Key: `~/.ssh/id_ed25519` (server local key)
- Runtime dir: `/home/user/polymarket_bot/` — **source of truth filesystem**
- Bullpen CLI on server: `/home/user/.npm-global/lib/node_modules/@bullpenfi/cli/bin/bullpen`
- Dashboard: http://localhost:8082
- Claude Code runs directly on the server — no Windows dependency

## Secrets (`.env` on server)
WireGuard creds (`WIREGUARD_PRIVATE_KEY`, `WIREGUARD_PUBLIC_KEY`, `WIREGUARD_ENDPOINT_IP`, `WIREGUARD_ADDRESSES`) live in `/home/user/polymarket_bot/.env` and are referenced from `docker-compose.yml` as `${…}`. The port stays hardcoded at `51820`. Do not hardcode the creds in compose — that caused VPN drift previously (compose froze while `.env` was rotated). `.env` is gitignored; to rotate, edit on the server and `docker compose up -d gluetun bot`.

## Shared alerting infrastructure (`~/.env.shared`)
Telegram bot credentials are **not** in `~/polymarket_bot/.env`. They live at `~/.env.shared` (chmod 600, server-only) and are reused by `paper_trader` on the same host. Format:
```
TELEGRAM_BOT_TOKEN=<...>
TELEGRAM_CHAT_ID=<...>
```
Host shell scripts source `~/.env.shared` directly. Future Docker services that need Telegram should add `env_file: [/home/user/.env.shared]` (see `paper_trader/docker-compose.yml` for the pattern).

### Alerts
Live scripts under `~/polymarket_bot/scripts/`, logs under `~/polymarket_bot/logs/`. **Neither directory is in the git repo** (server runtime only).

Cron lines redirect both stdout and stderr to a `.cron.log` file (no host MTA configured, so unredirected stderr would be lost). The script's own `.log` file is for application-level entries; the `.cron.log` is for cron-side surface (anything printed to stdout/stderr). Two tokens are monitored: Bullpen refresh token (auto-refreshed by CLI as long as the refresh token itself is alive) and Falcon JWT (manual rotation only).

Both scripts: alert at ≤3 days (warning) and ≤0 days (urgent), `FORCE_ALERT=1` for test runs, app log `<name>-expiry.log` + cron stdout/stderr log `<name>-expiry.cron.log`.

| Script | Cron | Token source | Refresh |
|---|---|---|---|
| `check-bullpen-expiry.sh` | `0 9 * * *` | `bullpen --output json status` → `account.session_expires` (CLI ≥0.1.98 stores creds encrypted as `credentials.json.enc`, so JWT is no longer decodable from disk; script shells out to the CLI instead) | `bullpen login` on server |
| `check-falcon-expiry.sh` | `0 9 * * *` | `POLYMARKET_ANALYTICS_API_KEY` (= `FALCON_API_KEY`) in `~/polymarket_bot/.env`, raw JWT, no auto-refresh, ~60 day TTL | Generate new JWT at https://polymarketanalytics.com → update `.env` → `docker compose up -d --no-deps bot` |
| `git-sync.sh` | `0 3 * * *` | Tracked changes under `src/`, `tests/`, `scripts/`, `public/`, plus `CLAUDE.md`, `Dockerfile`, `docker-compose.yml`, `package*.json`, `tsconfig.json`, `.gitignore`, `.env.example` | Auto: stages `git add -u` on those paths, commits as `chore(sync): daily auto-sync <date>`, pushes to `origin/main` via `~/.ssh/deploy-key`. Skips silently when no diff. Untracked files are NOT auto-added — add them manually if they belong in git. Log: `logs/git-sync.log` (rotated to last 100 lines) + `logs/git-sync.cron.log` |
| `watchdog.sh` | `*/5 * * * *` | Probes `http://localhost:8082/`. State file `logs/watchdog.state` tracks consecutive failures; ≥2 consecutive non-200 results (~10 min unreachable) triggers `docker compose restart bot` + Telegram alert. Recovers from the gluetun-restart orphan-namespace failure: bot uses `network_mode: container:gluetun`, so a gluetun restart detaches the bot's netns and Express becomes unreachable from outside even though the process is healthy. `FORCE_RESTART=1` simulates a failure for testing. Log: `logs/watchdog.log` (rotated to last 100 lines) + `logs/watchdog.cron.log`. |
| `weekly-macro-scan.sh` | `0 4 * * 1` (Mon) | `docker cp` latest `macro_scan.js` + `macro_scan_90d.js` into the container, then `docker exec` Falcon enrichment (updates `tracked_traders.falcon_sharpe/roi/win_rate`) + 90d on-chain scan. Parses MACRO CANDIDATES (avg_hold≥48h, t/wk<20, WR>60%, closed≥10, pnl>0; excludes watchlist + excluded_traders), enriches with Sharpe from `tracked_traders`, sends Telegram top-5 summary only when candidates>0 (zero-candidate runs log `SILENT` to the app log and send no message). **Does NOT auto-add to watchlist — manual review only.** Log: `logs/weekly-macro-scan.log` (last 200 lines) + per-run raw outputs under `logs/weekly-macro-scan-runs/` (pruned after 30d) + `logs/weekly-macro-scan.cron.log` |

New alerts: copy `send_telegram()` from `check-bullpen-expiry.sh` (self-contained, sources `~/.env.shared`). Use `[polymarket_bot]` prefix so messages group separately from `paper_trader`. Always log one line per run so a quiet log proves the cron ran.

## Deploy Process (container rebuild)
Code changes are made directly on the server filesystem. Source of truth is `/home/user/polymarket_bot/`.

```bash
# After editing files on server
cd ~/polymarket_bot 
docker compose up -d --build
docker logs polymarket_bot --tail 20
```

## GitHub Repository Sync
- Repo: `git@github.com:fabibal/polymarket_bot.git` (private, default branch `main`)
- Server has GitHub SSH key configured: `~/.ssh/deploy-key` wired via `Host github.com` in `~/.ssh/config`
- Commit author: `Balazs <fabibal@users.noreply.github.com>` (pass with `-c user.name= -c user.email=`)

To push changes to GitHub (run from server):
```bash
cd ~/polymarket_bot
git status --porcelain
git add <files>
git -c user.name="Balazs" -c user.email="fabibal@users.noreply.github.com" commit -m "<subject>"
git push origin HEAD:main
git ls-remote git@github.com:fabibal/polymarket_bot.git HEAD
```

Note: GitHub push is separate from container deployment. Both are manual operations.

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
