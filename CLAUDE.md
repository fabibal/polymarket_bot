# Polymarket Copy Trading Bot

DRY_RUN simulation-only copy bot. **Watchlist-only** (leaderboard removed
2026-05-29): polls `watchlist_traders`, simulates each BUY as a $5 position
(`copyAmount` override per entry), closes FIFO on matching SELL.

## CLAUDE.md maintenance rules

- This file is a **TOC + current-state reference** — max ~80 lines.
- **No decision narratives here.** The *why* behind a choice → `docs/decisions.md`
  (dated, append-only ADRs). Accepted quirks → `docs/KNOWN_ISSUES.md`.
- **No info inferable from the code.** Strategy/constants live in code — when in
  doubt, grep. If a doc drifts, the code wins; fix the doc.
- Doc-routing table (what changed → what to update): `.claude/hooks/pre_edit.md`.

## Read when relevant

| Task / question                       | Read first                          |
|---------------------------------------|-------------------------------------|
| Why a decision was made               | `docs/decisions.md`                 |
| Accepted quirk / standing issue       | `docs/KNOWN_ISSUES.md`              |
| Deploy / rebuild / push               | `.claude/skills/deploy.md`          |
| Guardrails before editing             | `.claude/hooks/pre_edit.md`         |

## Stack
- Node.js / TypeScript, vitest tests under `tests/`
- Bullpen CLI (`@bullpenfi/cli`) — docs https://cli.bullpen.fi/ — requires `bullpen login` on host; config at `~/.bullpen/`
- Docker + gluetun WireGuard VPN (Polymarket geo-blocks Hungary)
- Express dashboard on container port 8080 → host 8082

## Key rules
- **Never flip `DRY_RUN=false`** without an explicit instruction in the current conversation.
- Ask before guessing — use AskUserQuestion for anything ambiguous.
- **🚨 WATCHLIST TRADERS BYPASS ALL ENTRY FILTERS — BY DESIGN. 🚨** A watchlist
  entry is an explicit, manual trust decision; the bot copies unconditionally.
  Price/spread/category/sample filters are inert no-ops (removed 2026-05-29).
  Rationale + removal scope: `docs/decisions.md` "Watchlist-only architecture".

### Active constraints (the ONLY things that gate a watchlist BUY)
1. **Wallet cap** — `SIMULATED_WALLET_SIZE * WALLET_CAP_UTILIZATION` (e.g. $1000 × 0.80 = $800); over-cap BUYs skipped.
2. **Per-market entry cap** — two-tier: match-style slugs (ISO date,
   `isMatchStyleSlug` in `filters.ts`) → LIFETIME cap of 1/slug; non-dated
   slugs → `MAX_WATCHLIST_ENTRIES_PER_MARKET` within `MAX_WATCHLIST_ENTRY_WINDOW_MS`.
3. **Depth gate** — skip BUY when CLOB `ask_depth_5 < DEPTH_GATE_MIN_DEPTH_5`.

Plus ONE per-trader carve-out (longshot filter, trader `0x12d6…`) and the
per-trader decay kill switch. All four constraints + the threshold-resolution,
observation-ledger, risk-control, persistence, and sizing-research designs are
documented in `docs/decisions.md`.

## Bullpen API gotchas
- `data leaderboard` and `activity` return direct JSON arrays, **not** `{items: []}`.
- `price` returns `{outcomes: [{outcome, midpoint, last_trade, best_bid, best_ask}]}` — `outcomes` is an ARRAY, not a keyed map.
- Leaderboard `pnl` / `volume` are STRINGS → wrap in `Number()`.
- Activity items use `transaction_hash` (not `id`) and `slug` (not `market_slug`).
- Only process items where `type === 'TRADE'` and `side` is `BUY` or `SELL`.
- `data leaderboard` ignores `--period` / `--limit`; slice in JS.

## Orderbook depth at fill time (watchlist only)
Every watchlist BUY snapshots CLOB state via `getOrderbookDepth(slug, outcome)`
(`src/bullpen.ts`) before `addOpenTrade`: two HTTPS calls (Gamma slug →
`clobTokenIds`, then CLOB `/book`). Failures fall through null — never blocking.
Persisted on `open_trades`/`closed_trades`: `best_ask`, `best_bid`,
`spread_at_entry`, `ask_depth_5`, `ask_depth_10`, `depth_backfilled`. Dashboard
`/api/watchlist` exposes per-trader `avgAskDepth5`, `avgSpread`, `liqSampleCount`.
Backfill caveat (coarse proxy): `docs/KNOWN_ISSUES.md`.

## Environment (docker-compose.yml)
```
NODE_OPTIONS=--max-old-space-size=450   # Node heap cap; container limit 512MB
DRY_RUN=true
PORT=8080
POLL_INTERVAL_MS=30000                  # 30 s per cycle
RTDS_ENABLED=true                       # real-time trade socket, poll stays as backfill; false = poll only (2026-09-26)
CHAIN_FEED_ENABLED=true                 # Polygon fill logs of copy-enabled wallets, 3rd source (2026-10-05)
PRICE_UPDATE_INTERVAL_MS=300000         # 5 min mark-to-market sweep

MAX_WATCHLIST_ENTRIES_PER_MARKET=2      # non-dated slugs only (match-style → lifetime 1)
MAX_WATCHLIST_ENTRY_WINDOW_MS=43200000  # 12h
GAS_COST_PER_BUY=0                      # gas only; per-market taker fees modelled in src/fees.ts (2026-09-26)
SLIPPAGE_RATE=0.02                      # exit slip (at bid) + entry FALLBACK; entry slip is gap-based when book snapshot exists (2026-06-19)
DEPTH_GATE_MIN_DEPTH_5=500              # thin-book guard (added 2026-05-27)
SIMULATED_WALLET_SIZE=1000              # models a fixed real wallet (added 2026-05-28)
WALLET_CAP_UTILIZATION=0.80
TRADER_DECAY_THRESHOLD_PCT_30D=5        # %-of-wallet kill switch (7d window removed 2026-06-15)
DAILY_LOSS_CIRCUIT_BREAKER=off          # breaker disabled 2026-06-11 (code retained)
DYNAMIC_SIZING=false                    # GROUP D research toggle (OFF)
FALCON_API_KEY=${POLYMARKET_ANALYTICS_API_KEY:-}
```
Removed 2026-05-29 (inert no-ops): `LEADERBOARD_REFRESH_MS`,
`AUTO_EXCLUDE_*`, `MIN_PRICE*`, `MAX_PRICE`, `MAX_SPREAD`,
`FORCE_EXCLUDE_CATEGORIES`, `MAX_POSITIONS_PER_MARKET*`,
`MAX_TOTAL_OPEN_POSITIONS`, `MIN_TRADER_*SAMPLE`. See `docs/decisions.md`.

## Server Environment
- Host: `<server-host>` (fallback `<server-ip>`), port `<ssh-port>`, user `user`
- Key: `~/.ssh/id_ed25519`
- Runtime dir: `/home/user/polymarket_bot/` — **source of truth filesystem**
- Bullpen CLI on server: `/home/user/.npm-global/lib/node_modules/@bullpenfi/cli/bin/bullpen`
- Dashboard: http://localhost:8082 — Claude Code runs directly on the server

## Secrets
- WireGuard creds (`WIREGUARD_*`) live in `/home/user/polymarket_bot/.env`,
  referenced from `docker-compose.yml` as `${…}`; port hardcoded `51820`. Do not
  hardcode creds in compose (caused VPN drift). To rotate: edit `.env`,
  `docker compose up -d gluetun bot`.
- Telegram creds (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) live at
  `~/.env.shared` (chmod 600, server-only, shared with `paper_trader`), injected
  via `env_file` in docker-compose. Use `[polymarket_bot]` prefix on messages.
- polymarket_bot posts to its own channel ("Polymarket", 2026-09-27) via
  `POLYMARKET_TELEGRAM_CHAT_ID` in `~/.env.shared`, like the other projects'
  `<NAME>_TELEGRAM_CHAT_ID` entries (`src/alerts.ts` and every alert script);
  unset -> the shared `TELEGRAM_CHAT_ID`.

### Alerts
Live scripts under `~/polymarket_bot/scripts/`, logs under `~/polymarket_bot/logs/`
— **neither is in the git repo** (server runtime only). Each script: app log
`<name>.log` + cron stdout/stderr `<name>.cron.log`; expiry scripts alert at
≤3 days (warning) and ≤0 days (urgent), `FORCE_ALERT=1` for test runs.

| Script | Cron | Purpose |
|---|---|---|
| `check-bullpen-expiry.sh` | `0 9 * * *` | `bullpen --output json status` → `account.session_expires`. Refresh: `bullpen login`. |
| `git-sync.sh` | `0 3 * * *` | Auto-commits tracked changes (`src/ tests/ scripts/ public/` + root configs) as `chore(sync): daily auto-sync <date>`, pushes `origin/main`. Untracked files NOT auto-added. |
| `watchdog.sh` | `*/5 * * * *` | Probes `http://localhost:8082/`; ≥2 consecutive non-200 → `docker compose restart bot` + alert. Recovers the gluetun-restart orphan-namespace failure. |
| `weekly-lowfreq-scan.sh` | `30 5 * * 0` | Leaderboard pool -> copyability filters -> backtest gate (`scripts/lowfreq_scan.js`, own container in the VPN netns); survivors auto-added as observation (copy_enabled=0, cap 10 standing) via the dashboard API, Telegram per addition. Replaced `weekly-tape-scan.sh` 2026-09-26; the Falcon `weekly-macro-scan.sh` + `check-falcon-expiry.sh` crons were retired 2026-09-27. |
| `update-bullpen.sh` | `0 2 * * *` | `npm install -g @bullpenfi/cli@latest`, before git-sync at 03:00. Log-only (`bullpen-update.log`), no Telegram alert even on failure. |

New alerts: copy `send_telegram()` and the env loading (incl. the
`POLYMARKET_TELEGRAM_CHAT_ID` line) from `check-bullpen-expiry.sh`. Always log one
line per run so a quiet log proves the cron ran.

## MCP Tools: code-review-graph

**This project has a knowledge graph. ALWAYS use the code-review-graph MCP tools
BEFORE Grep/Glob/Read to explore the codebase** — faster, cheaper, gives
structural context (callers, dependents, test coverage). Fall back to
Grep/Glob/Read only when the graph doesn't cover what you need.

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — risk-scored analysis |
| `get_review_context` | Source snippets for review — token-efficient |
| `get_impact_radius` | Blast radius of a change |
| `get_affected_flows` | Which execution paths are impacted |
| `query_graph` | Tracing callers/callees/imports/tests/dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | High-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

The graph auto-updates on file changes (via hooks).
