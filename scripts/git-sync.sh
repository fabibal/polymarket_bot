#!/usr/bin/env bash
# Daily git sync: commit + push tracked changes (src/, configs, CLAUDE.md, docker-compose.yml).
# Cron: 0 3 * * * (03:00 server time)
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$REPO/logs/git-sync.log"
mkdir -p "$REPO/logs"

ts() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "$(ts) $*" >>"$LOG"; }

cd "$REPO" || { log "ERROR cd $REPO failed"; exit 1; }

# SSH identity comes from the `Host github.com` entry in ~/.ssh/config.
export GIT_SSH_COMMAND='ssh -o IdentitiesOnly=yes'

# Paths to consider for sync (only tracked changes; untracked files require manual review).
PATHS=(CLAUDE.md docker-compose.yml Dockerfile package.json package-lock.json tsconfig.json src tests scripts public .env.example .gitignore)

# Stage only tracked modifications/deletions within the allowed paths.
git add -u -- "${PATHS[@]}" 2>>"$LOG"

if git diff --cached --quiet; then
  log "no changes to sync"
else
  changed=$(git diff --cached --name-only | tr '\n' ' ')
  msg="chore(sync): daily auto-sync $(date -u +'%Y-%m-%d')"
  if git -c user.name='Balazs' -c user.email='fabibal@users.noreply.github.com' \
      commit -m "$msg" >>"$LOG" 2>&1; then
    log "committed: $changed"
    if git push origin HEAD:main >>"$LOG" 2>&1; then
      log "pushed to origin/main"
    else
      log "ERROR push failed"
    fi
  else
    log "ERROR commit failed"
  fi
fi

# Rotate log: keep last 100 lines.
if [ -f "$LOG" ]; then
  tail -n 100 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
