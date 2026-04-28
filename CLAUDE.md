# Polymarket Copy Trading Bot

DRY_RUN simulation-only copy bot. Tracks top 10 traders by weekly PNL plus a persistent watchlist; simulates each BUY as a $5 position (watchlist entries can override via `copyAmount`) and closes FIFO on matching SELL.

## Stack
- Node.js / TypeScript, vitest tests under `tests/`
- Bullpen CLI (`@bullpenfi/cli`) — docs https://cli.bullpen.fi/ — requires `bullpen login` on host; config at `~/.bullpen/`
- Docker + gluetun WireGuard VPN (Polymarket geo-blocks Hungary)
- Express dashboard on container port 8080 → host 8082

## Key rules
- **Never flip `DRY_RUN=false`** without an explicit instruction in the current conversation.
- Ask before guessing — use AskUserQuestion for anything ambiguous.
- `store.ts` persistence: `writeStore()` is an immediate atomic flush (temp+rename) used for financial mutations (addOpenTrade, closeOpenTrade, resolveByPrice) and user-driven dashboard actions. `markDirty()` defers the write; a 60 s background flusher started by `startAutoFlush()` in `index.ts` coalesces bursts. Signal handlers force a final flush on exit.

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

FALCON_API_KEY=${POLYMARKET_ANALYTICS_API_KEY:-}
```

## Server + SSH
- Host: `<server-host>` (fallback IP `<server-ip>`), port `<ssh-port>`, user `user`
- Key: `~/.ssh/id_ed25519`
- Runtime dir: `/home/user/polymarket_bot/` — **not a git repo**, deploys land via SCP
- Bullpen CLI on server: `/home/user/.npm-global/lib/node_modules/@bullpenfi/cli/bin/bullpen`
- Dashboard: http://localhost:8082

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
| `check-bullpen-expiry.sh` | `0 9 * * *` | `~/.bullpen/credentials.json` (refresh_token JWT) | `bullpen login` on server |
| `check-falcon-expiry.sh` | `0 9 * * *` | `POLYMARKET_ANALYTICS_API_KEY` (= `FALCON_API_KEY`) in `~/polymarket_bot/.env`, raw JWT, no auto-refresh, ~60 day TTL | Generate new JWT at https://polymarketanalytics.com → update `.env` → `docker compose up -d --no-deps bot` |

New alerts: copy `send_telegram()` from `check-bullpen-expiry.sh` (self-contained, sources `~/.env.shared`). Use `[polymarket_bot]` prefix so messages group separately from `paper_trader`. Always log one line per run so a quiet log proves the cron ran.

## Deploy (container rebuild)
```bash
SSH='ssh -p <ssh-port> -i "~/.ssh/id_ed25519" user@<server-host>'
SCP='scp -P <ssh-port> -i "~/.ssh/id_ed25519"'

$SCP src/*.ts user@<server-host>:/home/user/polymarket_bot/src/
$SCP public/index.html user@<server-host>:/home/user/polymarket_bot/public/
# SCP docker-compose.yml too if changed

$SSH "cd ~/polymarket_bot && docker compose up -d --build && docker logs polymarket_bot --tail 20"
```

## GitHub push (separate from container deploy)
- Repo: `git@github.com:fabibal/polymarket_bot.git` (private, default branch `main`)
- Windows workstation has no GitHub SSH key — push must go through the server, which has `~/.ssh/deploy-key` wired via `Host github.com` in `~/.ssh/config`.
- Commit author: `Balazs <fabibal@users.noreply.github.com>` (pass with `-c user.name= -c user.email=` since the server-wide git identity may differ).

```bash
$SSH "rm -rf /tmp/pb_gh_deploy && git clone git@github.com:fabibal/polymarket_bot.git /tmp/pb_gh_deploy"
$SCP <changed files> user@<server-host>:/tmp/pb_gh_deploy/<matching subpath>/
$SSH 'cd /tmp/pb_gh_deploy && git status --porcelain && \
  git -c user.name="Balazs" -c user.email="fabibal@users.noreply.github.com" add <files> && \
  git -c user.name="Balazs" -c user.email="fabibal@users.noreply.github.com" commit -m "<subject>" && \
  git push origin HEAD:main && \
  git ls-remote git@github.com:fabibal/polymarket_bot.git HEAD'
$SSH "rm -rf /tmp/pb_gh_deploy"
```

The GitHub push does NOT deploy. Container rebuild is the separate step above.
