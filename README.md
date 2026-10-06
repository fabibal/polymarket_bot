# Polymarket Copy-Trading Simulator

A **simulation-only** bot that watches a hand-picked list of Polymarket wallets,
mirrors each of their trades as a small paper position, and measures whether
copying them would actually have made money **after** fees, slippage and
latency.

No orders are ever placed and no funds are involved. `DRY_RUN=true` is the only
supported mode; the code has no order-submission path at all.

> Not financial advice. This is an engineering and research project. All
> numbers it produces are simulated.

## Why this exists

Copy trading looks easy on a leaderboard: pick the wallets with the best PnL
and mirror them. The hard part is everything between "the wallet traded" and
"you filled": the data feed lags, books are thin, fees and spreads eat the edge,
and many leaderboard stats do not survive a closer look. This project is a
testbed for answering one question honestly: *if I had copied this wallet, what
would I have made, net of real costs?*

## What it does

- **Three trade sources, one dedup.** A real-time WebSocket feed (~1 s), a
  Polygon `OrderFilled` chain feed (~2 s, catches fills the socket drops during
  news bursts) and a REST poll as backfill. Whichever source sees a fill first
  wins; the transaction hash de-duplicates the rest.
- **Realistic fills.** Every simulated BUY snapshots the CLOB orderbook (best
  bid/ask, depth, spread). Entry slippage is derived from the gap between the
  trader's price and the book at copy time; per-market taker fees are modelled.
- **Explicit constraints, nothing hidden.** A BUY is gated only by a wallet cap,
  a per-market entry cap and an orderbook depth gate. Every decision and its
  rationale is written down in [`docs/decisions.md`](docs/decisions.md).
- **Position lifecycle.** FIFO close on the trader's matching SELL, resolution
  payouts, delisted-market handling, partial-sell tracking.
- **Risk controls.** Per-trader decay kill switch, optional daily-loss circuit
  breaker, observation-only "shadow" ledger to forward-test a wallet before
  enabling copy.
- **Backtests.** Offline scripts replay a wallet's history under different
  copy models (per-fill vs. mirrored, with and without fees and latency).
- **Dashboard.** Express + vanilla JS and Chart.js single page: equity curve, per-trader
  cards, open positions, costs, forward-test readiness, feed and VPN health.
- **Alerts.** Telegram notifications for session expiry, watchdog restarts and
  weekly scan results.

## Architecture

```
 RTDS socket ----\
 Polygon feed ----+--> monitor.ts --> filters.ts (caps, depth gate)
 REST poll -------/        |                 |
                           v                 v
                     simulator.ts <---- bullpen.ts (activity, prices, CLOB depth)
                           |
                           v
                  store.ts (SQLite, WAL)  <---->  dashboard.ts (Express :8080)
                           ^
                  risk.ts (kill switch, breaker)    health.ts (loop/feed monitors)
```

| Path | Role |
|------|------|
| `src/monitor.ts` | Turns a raw trade into a simulated BUY/SELL |
| `src/rtds.ts`, `src/chainfeed.ts` | Real-time and on-chain trade sources |
| `src/simulator.ts`, `src/fees.ts` | Entry/exit costs, mark-to-market, resolution |
| `src/filters.ts`, `src/risk.ts` | Entry caps, depth gate, decay kill switch |
| `src/store.ts` | SQLite persistence, per-mutation writes |
| `src/forwardtest.ts` | Forward-test plans for candidate wallets |
| `src/dashboard.ts`, `public/` | HTTP API and UI |
| `scripts/` | Backtests, weekly candidate scan, cron helpers |
| `tests/` | Vitest suite (169 tests) |

## Stack

TypeScript / Node.js 20, SQLite (`better-sqlite3`), Express, `ws`, Vitest,
Docker Compose. Network egress goes through a
[gluetun](https://github.com/qdm12/gluetun) WireGuard container because
Polymarket geo-blocks some regions. Market data comes from the
[Bullpen CLI](https://cli.bullpen.fi/), the Polymarket Gamma/CLOB/data APIs and a
public Polygon RPC.

## Run it

Requirements: Docker, a WireGuard config from a VPN provider (only if your
region is blocked), and a logged-in Bullpen CLI (`bullpen login`).

```bash
cp .env.example .env        # fill in the WireGuard values
docker compose up -d --build
docker logs polymarket_bot --tail 20
# dashboard: http://localhost:8082
```

Add a wallet to the watchlist from the dashboard (or `POST /api/watchlist`).
It is copied per its `copyEnabled` / `copyAmount` settings, default $5 per BUY.

Tests (the `better-sqlite3` native binding must match the runtime, so run them
in the same Alpine image the bot uses):

```bash
docker run --rm -v "$PWD":/app -w /app node:20-alpine sh -c "npm install && npx vitest run"
```

Key settings live in `docker-compose.yml` and `src/config.ts`: poll interval,
simulated wallet size and cap, depth gate, slippage fallback, kill-switch
threshold.

## What I learned

The short version, with the evidence in [`docs/decisions.md`](docs/decisions.md):

- Execution cost, not signal quality, usually decides whether a followed wallet
  is profitable. The same trade history flips from positive to negative as the
  assumed costs go from zero to twice the modelled level.
- A polled activity API lags by tens of seconds; a push feed plus an on-chain
  feed closes most of that, and the three together beat any single source.
- Headline wallet stats mislead: maker rebates, FIFO-derived win rates,
  pseudo-replicated positions and whale variance all produce flattering numbers
  that disappear under a forward test.
- Forward-testing a wallet in observation mode before copying it is cheap and
  filters out most candidates.

## Repo notes

- `docs/decisions.md` is an append-only log of design decisions with dates and
  reasoning; `docs/KNOWN_ISSUES.md` lists accepted quirks.
- `.claude/` and `CLAUDE.md` hold the agent-assistant context I used while
  building this with Claude Code.
- Wallet addresses in the code and docs are public on-chain data.

## License

MIT, see [LICENSE](LICENSE).
