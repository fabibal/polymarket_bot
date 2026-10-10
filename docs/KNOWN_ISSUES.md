# Known Issues

Standing issues and accepted non-obvious quirks. Resolved bugs live in git
history and, where they changed behaviour, in `docs/decisions.md`.

## Accepted by design (no action planned)

- **Frozen shadow / leaderboard tables.** `shadow_open_trades`,
  `shadow_closed_trades`, `tracked_traders` (excl. the macro-scan writes),
  `excluded_traders` remain on disk as a historical record. The bot never reads
  or writes them as part of the live loop (the weekly macro scan that wrote
  `tracked_traders.falcon_*` externally was retired 2026-09-27; nothing reads
  those columns now). Do NOT re-add CREATE TABLE / migration logic for the
  shadow tables — they were deliberately dropped from startup. Context:
  `docs/decisions.md` "Watchlist-only architecture" + "Final shadow/leaderboard
  cleanup".

- **`copiedTraderRank` is hardcoded 0.** Legacy NOT NULL column on
  `closed_trades` left over from the leaderboard era. Every row written since
  2026-06-11 carries 0. Not meaningful — do not read it. Context:
  `docs/decisions.md` "Final shadow/leaderboard cleanup".

- **`copiedTraderSource: 'leaderboard'` still in the type union.** Historical
  `closed_trades` rows predating the watchlist-only switch carry it. New rows are
  always `'watchlist'`. The union member stays so old rows still type-check.

- **Depth-backfill is a coarse proxy, not the fill-moment book.**
  `backfillOpenTradeDepth()` runs once at startup for open watchlist trades where
  `bestAsk` is null. Backfilled depth reflects the *current* book, not the
  original fill moment. Rows carry `depth_backfilled=1` to flag this; treat their
  `ask_depth_5`/`spread_at_entry` as approximate. Fire-and-forget, throttled
  100ms/fetch, non-blocking.

- **Observation ledger has no entry cap, wallet cap, depth gate, or longshot
  filter.** Deliberately RAW — the `observation_trades` lifecycle measures the
  trader's edge, not our execution constraints, so it can run unbounded re-entries
  the live copy path would block. Observation rows never enter `open_trades`, so
  the wallet cap is unaffected. Context: `docs/decisions.md` "Observation
  forward-test ledger".

- **Daily-loss circuit breaker code is inert but retained.** `src/risk.ts` keeps
  `checkCircuitBreaker`/`isCircuitBreakerActive`; `CONFIG.DAILY_LOSS_BREAKER_ENABLED`
  short-circuits them to no-ops and any stale `meta.circuit_breaker_until` is
  ignored while `DAILY_LOSS_CIRCUIT_BREAKER=off`. Not dead code — kept for a
  one-line re-enable. Context: `docs/decisions.md` "Daily-loss circuit breaker
  disabled".

- **Maker execution would erase the edge.** Measured avg `entry_price_gap` is
  6.8% vs the 2% modeled slippage (1,167-trade review 2026-06-10). Taker
  execution is assumed for all PnL; do not model maker fills as free improvement.
  Context: `docs/decisions.md` "Sizing + maker-execution research".

- **Observation rows closed before 2026-09-26 21:00 UTC are partly false.**
  Until the 429 fix, rate-limited price sweeps marked live markets dead and the
  observation ledger expired (or snapped to 0/1) positions at stale prices: 109k
  closes at 15:40 UTC that day alone, and smaller bursts since at least 09-19.
  The rows were left as they are. The dashboard's observation stats count only
  rows opened from 21:00 on (`OBSERVATION_STATS_SINCE` in `src/dashboard.ts`);
  any analysis of `observation_trades` should do the same or skip the bursts.
  Context: `docs/decisions.md` "Price sweep: HTTP 429 no longer marks markets dead".

## Operational notes

- **Chain subscription drops fills; the HTTPS sweep is the safety net.** The
  publicnode `eth_subscribe` stream misses a sizeable share of fills (7 of 17
  in 4 days) and the socket reconnects about once an hour. A sweep over HTTPS
  (drpc, then publicnode) re-reads the newest blocks every 5s. When RTDS is
  healthy it has already copied the fill, so the dollar effect has been zero so
  far. Context: `docs/decisions.md` "Chain feed: HTTPS getLogs sweep on drpc".

- **`logs/` is NOT in the git repo** — server runtime only. `scripts/` files ARE
  tracked, but the daily `git-sync.sh` only commits changes to already-tracked
  files there; new/untracked files under `scripts/` are never auto-added — add
  them manually if they belong in git.

- **`source_sell_fraction` can be NULL.** Only set on copy-SELL closes when we
  hold a matching position and the data-api positions lookup succeeds.
  Threshold/expiry/delist closes never set it. NULL is expected, not a bug.

- **`source_notional` / dynamic-sizing data needs ~3-4 weeks** before
  conviction-weighted sizing analysis is statistically usable. Until then the
  columns are populated but under-sampled.

- **~64k observation rows sit in `status='open'`, many stale.** Measured
  2026-09-14: 64,426 open vs 155,966 resolved + 107,684 expired. These are the
  rows `readStore()` still loads on boot after the open-only cache change
  (`docs/decisions.md`, 2026-09-14), so they are the dominant term in the bot's
  heap. Headroom is fine today (137 MiB / 512 MiB) but this grows with every
  observation trader added. The price sweep only retires a position it can still
  price, so positions in delisted/unresolvable markets appear to accumulate
  open forever. Not yet diagnosed — needs an age/staleness sweep for
  observation rows before the open count becomes the next OOM.
