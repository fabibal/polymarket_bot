# Pre-Edit Rules

## Doc-routing — always follow this

| What changed                          | Update                              |
|---------------------------------------|-------------------------------------|
| New permanent decision / why-choice   | `docs/decisions.md` (append entry)  |
| Superseded a prior decision           | mark old entry `[SUPERSEDED]` + add new one |
| New accepted quirk / standing issue   | `docs/KNOWN_ISSUES.md`              |
| Deploy / rebuild / push procedure     | `.claude/skills/deploy.md`          |
| Active-constraint change (wallet cap, entry cap, depth gate) | `CLAUDE.md` "Active constraints" + `docs/decisions.md` |
| Env var added/removed/renamed         | `CLAUDE.md` "Environment"           |
| Bullpen API behaviour learned         | `CLAUDE.md` "Bullpen API gotchas"   |
| Cron / alert script change            | `CLAUDE.md` "Alerts" table          |
| NEVER                                 | decision narratives inline in `CLAUDE.md` |

`CLAUDE.md` = TOC + current-state reference (constraints, env, infra, gotchas).
History, rationale, and supersession chains → `docs/decisions.md`. Accepted
quirks → `docs/KNOWN_ISSUES.md`. Procedures → `.claude/skills/`.

**Status:** documentation only — no executable hook enforces these. The code is
always the source of truth for behaviour; if a doc drifts, the code wins — fix
the doc.

## Rules

1. **Never flip `DRY_RUN=false`** without an explicit instruction in the current
   conversation.
2. **Never edit `.env` / `~/.env.shared`** via Claude Code — live secrets
   (WireGuard, Telegram, Falcon JWT). Manual changes only from a trusted shell.
3. **Never change the active constraints** (`SIMULATED_WALLET_SIZE`,
   `WALLET_CAP_UTILIZATION`, `MAX_WATCHLIST_ENTRIES_PER_MARKET`,
   `DEPTH_GATE_MIN_DEPTH_5`, the risk thresholds) as a side effect of a refactor
   or cleanup pass. They are real-money / risk knobs.
4. **Never push or amend commits** without explicit direction. A nightly
   `git-sync.sh` auto-commits tracked changes; ad-hoc pushes are off by default.
5. **Watchlist bypasses all entry filters — by design.** Do not "re-add" price,
   spread, category, or sample filters; they were removed as inert no-ops. The
   only active constraints are wallet cap, per-market entry cap, depth gate (and
   the single longshot carve-out). See `docs/decisions.md`.
