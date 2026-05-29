# Polymarket Copy Trading Bot

DRY_RUN simulation-only copy bot. Tracks top 10 traders by weekly PNL plus a persistent watchlist; simulates each BUY as a $5 position (watchlist entries can override via `copyAmount`) and closes FIFO on matching SELL.

**Leaderboard = shadow-only (as of 2026-05-28).** Top-10 leaderboard traders are still tracked, polled, and recorded into `shadow_open_trades` / `shadow_closed_trades` for edge measurement, but they generate **zero** real sim copies. Enforced in `src/index.ts` by passing `{ shadowMode: true, copyEnabled: false }` to `pollTrader` for every leaderboard trader. Lifetime leaderboard real-copy PNL through 2026-05-28 was -$2,451 over 9,258 closed trades — no demonstrable edge, removed. Only `watchlist_traders` entries can produce real sim positions. On the policy flip, the 99 then-open leaderboard positions ($495) were deleted from `open_trades`, dropping wallet_in_use from $750 to $285.

## Stack
- Node.js / TypeScript, vitest tests under `tests/`
- Bullpen CLI (`@bullpenfi/cli`) — docs https://cli.bullpen.fi/ — requires `bullpen login` on host; config at `~/.bullpen/`
- Docker + gluetun WireGuard VPN (Polymarket geo-blocks Hungary)
- Express dashboard on container port 8080 → host 8082

## Key rules
- **Never flip `DRY_RUN=false`** without an explicit instruction in the current conversation.
- Ask before guessing — use AskUserQuestion for anything ambiguous.
- **Watchlist traders bypass ALL filters by design.** Price floor/ceiling, spread cap, category exclusions (incl. `FORCE_EXCLUDE_CATEGORIES`), and min-sample gates do NOT apply to watchlist entries. Watchlist = explicit user trust override; only `MAX_WATCHLIST_ENTRIES_PER_MARKET` / `MAX_WATCHLIST_ENTRY_WINDOW_MS` and `MAX_TOTAL_OPEN_POSITIONS` still constrain them.
- `store.ts` persistence: `writeStore()` is an immediate atomic flush (temp+rename) used for financial mutations (addOpenTrade, closeOpenTrade, resolveByPrice) and user-driven dashboard actions. `markDirty()` defers the write; a 60 s background flusher started by `startAutoFlush()` in `index.ts` coalesces bursts. Signal handlers force a final flush on exit.
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

LEADERBOARD_REFRESH_MS=300000           # 5 min
POLL_INTERVAL_MS=30000                  # 30 s per cycle
PRICE_UPDATE_INTERVAL_MS=300000         # 5 min mark-to-market sweep

AUTO_EXCLUDE_WIN_RATE_THRESHOLD=0.42    # auto-exclude when 7d WR < threshold
MIN_TRADER_SAMPLE=5                     # min locally-closed trades before copying (real)
MIN_TRADER_SHADOW_SAMPLE=20             # shadow-closed alt unlock; breaks chicken-and-egg

MIN_PRICE=0.65
MIN_PRICE_SPORTS=0.60                   # sports floor (favorites only)
MAX_PRICE=0.88
MAX_SPREAD=0.05

FORCE_EXCLUDE_CATEGORIES=esports        # merged with dashboard-driven exclusions
MAX_POSITIONS_PER_MARKET=2
MAX_POSITIONS_PER_MARKET_SPORTS=1
MAX_TOTAL_OPEN_POSITIONS=300

# Watchlist-only entry cap (open+closed within window) — closes the BUY-SELL-BUY
# loophole that MAX_POSITIONS_PER_MARKET (open-only) lets through.
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
