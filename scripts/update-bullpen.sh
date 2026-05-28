#!/usr/bin/env bash
# Daily bullpen CLI update.
# Cron: 0 2 * * * (02:00 server time, before git-sync at 03:00)
set -u

REPO=/home/user/polymarket_bot
LOG="$REPO/logs/bullpen-update.log"
mkdir -p "$REPO/logs"

# npm lives under user-local prefix; ensure PATH includes it for cron.
export PATH="/home/user/.npm-global/bin:/usr/local/bin:/usr/bin:/bin"

ts() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }

{
  echo "$(ts) === bullpen update start ==="
  before=$(bullpen --version 2>/dev/null || echo "unknown")
  echo "$(ts) before: $before"
  if npm install -g @bullpenfi/cli@latest 2>&1; then
    after=$(bullpen --version 2>/dev/null || echo "unknown")
    echo "$(ts) after:  $after"
    if [ "$before" != "$after" ]; then
      echo "$(ts) UPGRADED $before -> $after"
    else
      echo "$(ts) already latest"
    fi
  else
    echo "$(ts) ERROR npm install failed"
  fi
  echo "$(ts) === bullpen update end ==="
} >>"$LOG" 2>&1

# Rotate: keep last 100 lines.
tail -n 100 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
