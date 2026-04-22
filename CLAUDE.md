# Polymarket Copy Trading Bot

## Project Overview
A Polymarket copy trading bot running in DRY_RUN mode (simulation only, no real trades).

## Milestones
- **2026-04-21**: Statistical significance reached. 3013 closed trades, 74.9% WR, mean +$0.282/trade, **t-statistic = 4.67 (p < 0.001)**. Edge is real, not noise.
- **2026-04-21**: Corrected cost model — Polymarket charges NO fees on sports markets (only 15-min crypto). `GAS_COST_PER_BUY=0`. Historical `entryGasCost` zeroed via `migrate_zero_gas.js`. Slippage-adjusted PNL flipped from −$945 → **+$201**.

## Stack
- Node.js / TypeScript
- Bullpen CLI (`npm install -g @bullpenfi/cli`) for Polymarket API access
  - Docs: https://cli.bullpen.fi/
  - Auth: `bullpen login` on host, config stored at `~/.bullpen/`
- Docker + gluetun WireGuard VPN (Polymarket is geo-blocked in Hungary)
- Express web dashboard on port 8080

## Key Bullpen Commands Used
```bash
# Top traders by weekly PNL (no --period or --limit flags - slice in JS)
bullpen polymarket data leaderboard --output json

# Poll trader's recent activity (returns direct array, not wrapped object)
bullpen polymarket activity --address <addr> --output json --limit 25

# Get current market price (outcomes is an ARRAY not a map)
bullpen polymarket price <slug> --output json
```

## Important API Notes
- `data leaderboard` returns a direct JSON array (not {items: []})
- `activity` returns a direct JSON array (not {items: []})
- `price` returns {outcomes: [{outcome, midpoint, last_trade, best_bid, best_ask}]} - outcomes is an ARRAY
- `pnl` and `volume` fields in leaderboard are STRINGS not numbers - wrap in Number()
- Activity item fields: transaction_hash (not id), slug (not market_slug), title exists
- Only process activity items where type === 'TRADE' and side === 'BUY' or 'SELL'

## Key Rules
- **Always run in DRY_RUN=true mode** until explicitly told otherwise
- WireGuard config: `protonvpn-NL-FREE-161.conf` (in project root, ProtonVPN NL FREE#161, Netherlands)
- Fixed trade size: **$5 per trade** (simulated)
- Track **top 10 active traders by weekly PNL** (leaderboard)
- Log all trades to `data/trades.json`
- **Use ask user question until you reach clarity on any ambiguity**

## Trade Filters (monitor.ts)
- Skip BUY if entry price < MIN_PRICE (0.05) or > MAX_PRICE (0.95)
- Skip BUY if bid/ask spread > MAX_SPREAD (0.15)
- Skip if already in processedTradeIds

## Auto-exclusion (leaderboard.ts)
- Every leaderboard refresh: calculate each trader's 7-day win rate from closedTrades
- If win rate < AUTO_EXCLUDE_WIN_RATE_THRESHOLD (0.45) and >= 3 trades → auto-exclude
- If win rate recovers → auto-include
- Manual exclusions (dashboard toggle) are never overridden by auto-logic

## Trade Simulation Logic
- Trader BUY → Simulate BUY $5 worth (5/P shares)
- Trader SELL → Close matching open simulated position at sell price (realized PNL)
- PNL (unrealized) = (current_price - entry_price) × shares
- PNL (realized) = (exit_price - entry_price) × shares
- Closed trade fields: exitPrice, closedAt, holdingPeriodMs, realizedPnl

## Project Structure
```
polymarket_bot/
├── src/
│   ├── index.ts          # Main entry point + polling loop
│   ├── types.ts          # TypeScript interfaces
│   ├── config.ts         # Runtime configuration
│   ├── bullpen.ts        # Bullpen CLI subprocess wrapper
│   ├── store.ts          # trades.json read/write
│   ├── leaderboard.ts    # Refresh top 10 traders + auto-exclusion
│   ├── monitor.ts        # Poll trader activity, detect new trades, apply filters
│   ├── simulator.ts      # Update mark-to-market prices, resolve trades
│   └── dashboard.ts      # Express server + API endpoints for web UI
├── public/
│   └── index.html        # Dark-themed trading dashboard
├── data/
│   └── trades.json       # Persisted trade log (openTrades, closedTrades, trackedTraders, processedTradeIds, traderLastSeen, excludedTraders, autoExcludedTraders)
├── docker-compose.yml    # gluetun VPN + bot services
├── Dockerfile
├── protonvpn-US-FREE-43.conf
├── package.json
└── tsconfig.json
```

## Environment Variables (docker-compose.yml)
```
# ── Runtime ────────────────────────────────────────────────────────────
NODE_OPTIONS=--max-old-space-size=450   # cap Node heap at 450MB (container limit 512MB)
DRY_RUN=true                            # simulation only — never place real orders
PORT=8080

# ── Polling / refresh cadence ──────────────────────────────────────────
LEADERBOARD_REFRESH_MS=300000           # 5 min
POLL_INTERVAL_MS=30000                  # 30 s per cycle
PRICE_UPDATE_INTERVAL_MS=300000         # 5 min — mark-to-market sweep

# ── Auto-exclusion ─────────────────────────────────────────────────────
AUTO_EXCLUDE_WIN_RATE_THRESHOLD=0.42    # auto-exclude traders <42% 7d WR (lowered from 0.45 to keep RN1-style high W/L traders)
MIN_TRADER_SAMPLE=5                     # don't copy a leaderboard trader until ≥5 closed trades logged locally

# ── Entry-price / spread filters (monitor.ts) ─────────────────────────
MIN_PRICE=0.65                          # skip BUYs below this entry price (raised from 0.40 — 0.65-0.80 is the sweet spot)
MIN_PRICE_SPORTS=0.60                   # sports-specific floor — sports <0.60 had 43% WR historically; only copy favorites
MAX_PRICE=0.88                          # skip BUYs above this (lowered from 0.95 — 0.90-0.95 has 96% WR but only 4.85% ROI)
MAX_SPREAD=0.05                         # tightened from 0.15 — 15% spread was eating ~$0.75/round-trip

# ── Category / position caps ───────────────────────────────────────────
FORCE_EXCLUDE_CATEGORIES=esports        # always-excluded categories; merged into store.excludedCategories at read time; dashboard can add/remove more via /api/categories/:name/exclusion (persisted in trades.json → excludedCategories[])
MAX_POSITIONS_PER_MARKET=2              # max open positions per market slug (lowered from 5)
MAX_POSITIONS_PER_MARKET_SPORTS=1       # sports/esports cap — prevents single-trader domination
MAX_TOTAL_OPEN_POSITIONS=300            # global cap: skip all new BUYs when reached (lowered from 750)

# ── Cost model ─────────────────────────────────────────────────────────
GAS_COST_PER_BUY=0                      # Polymarket has NO fees on sports markets (only 15-min crypto). Polygon gas negligible.
SLIPPAGE_RATE=0.02                      # 2% slippage each side (entry at ask, exit at bid)

# ── External APIs ──────────────────────────────────────────────────────
FALCON_API_KEY=${POLYMARKET_ANALYTICS_API_KEY:-}   # Falcon (Polymarket Analytics) key for leaderboard/winrate cache
```

### /api/stats — trading-cost fields
In addition to raw PnL, the stats endpoint returns cost-adjusted figures derived from `GAS_COST_PER_BUY` + `SLIPPAGE_RATE` (applied per-trade in `simulator.ts` / `store.applyExitCosts`):

- `totalRealizedPnlAdjusted`   — realized PnL minus gas + entry/exit slippage (closed trades)
- `totalUnrealizedPnlAdjusted` — unrealized PnL minus projected costs (open trades)
- `totalPnlAdjusted`           — sum of the two above
- `totalTradingCosts`          — aggregate gas + slippage over every trade
- `avgRawPnlPerTrade`          — mean realized PnL per closed trade (pre-costs)
- `avgSlippagePerTrade`        — mean total cost per closed trade
- `avgNetEdgePerTrade`         — mean cost-adjusted realized PnL per closed trade (the "true" edge)
- `excludedCategories`         — categories currently filtered (union of `FORCE_EXCLUDE_CATEGORIES` + dashboard additions)

## Server
- Linux/Ubuntu (Stremio szerver)
- Docker already installed
- Bullpen CLI installed at: /home/user/.npm-global/lib/node_modules/@bullpenfi/cli/bin/bullpen
- Run via `docker compose up -d`

## Dashboard
- URL: http://localhost:8082 (host port 8082 → container port 8080)
- Auto-refreshes every 5 seconds
- Features: Total/Realized/Unrealized PNL, Win Rate, Trade counts
- Leaderboard table: clickable rows for trader stats, Exclude/Include toggle
- Trades table: date range filter (All/30d/7d/Today), category filter (All/Politics/Crypto/Sports/Other)
- API endpoints: GET /api/traders, POST /api/traders/:address/exclusion, GET /api/traders/:address/history, GET /api/trades?range=

## Deploy Process
Always follow these steps when deploying:
1. SCP all changed files to the server:
   ```bash
   scp -P <ssh-port> -i "~/.ssh/id_ed25519" \
     src/*.ts \
     user@<server-host>:/home/user/polymarket_bot/src/
   scp -P <ssh-port> -i "~/.ssh/id_ed25519" \
     public/index.html \
     user@<server-host>:/home/user/polymarket_bot/public/
   # Also SCP docker-compose.yml if changed
   scp -P <ssh-port> -i "~/.ssh/id_ed25519" \
     docker-compose.yml \
     user@<server-host>:/home/user/polymarket_bot/
   ```
2. SSH and rebuild:
   ```bash
   ssh -p <ssh-port> -i "~/.ssh/id_ed25519" \
     user@<server-host> \
     "cd ~/polymarket_bot && docker compose up -d --build"
   ```
3. Check build logs for TypeScript errors
4. Verify container is running:
   ```bash
   ssh -p <ssh-port> -i "~/.ssh/id_ed25519" \
     user@<server-host> \
     "docker ps | grep polymarket_bot && docker logs polymarket_bot --tail 20"
   ```

## SSH Details
- Host: <server-host> (if DNS fails, fallback IP: <server-ip>)
- Port: <ssh-port>
- User: user
- Key: ~/.ssh/id_ed25519