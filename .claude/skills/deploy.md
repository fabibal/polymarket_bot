# Deploy Workflow

Claude Code runs directly on the Linux server. Source of truth is the server
filesystem at `~/polymarket_bot/`. Container deployment and GitHub
push are **separate, manual** operations.

## Container rebuild

```bash
cd ~/polymarket_bot
docker compose up -d --build
docker logs polymarket_bot --tail 20
```

- VPN/secret rotation (gluetun): `docker compose up -d gluetun bot`.
- Falcon JWT refresh (no rebuild of the image needed):
  `docker compose up -d --no-deps bot`.

## After deploy — verify

1. `docker logs polymarket_bot --tail 20` — look for the startup banner, the
   depth-backfill pass, and the first polling cycle.
2. Dashboard reachable: http://localhost:8082 (host port 8082 → container
   8080).
3. `DRY_RUN=true` confirmed in the startup log. **Never flip `DRY_RUN=false`**
   without an explicit instruction in the current conversation.

## GitHub push (separate from deploy)

```bash
cd ~/polymarket_bot
git status --porcelain
git add <files>
git -c user.name="Balazs" -c user.email="fabibal@users.noreply.github.com" \
  commit -m "<subject>"
git push origin HEAD:main
git ls-remote git@github.com:fabibal/polymarket_bot.git HEAD
```

- Repo: `git@github.com:fabibal/polymarket_bot.git` (public, default `main`).
- The SSH key is wired via `Host github.com` in `~/.ssh/config`.
- A nightly `git-sync.sh` cron auto-commits tracked changes — ad-hoc pushes are
  for when you need it sooner. Untracked files are never auto-added.

## Container facts (gotchas)

- Container runs as uid/gid `1000:1000`; Bullpen creds at `/home/node/.bullpen`.
  A rebuild that recreates `data/` must `chown` it to 1000.
- `NODE_OPTIONS=--max-old-space-size=450`; container memory limit 512 MB.
- The bot uses `network_mode: container:gluetun` — a gluetun restart detaches
  the bot's netns and Express becomes unreachable from outside even though the
  process is healthy. `watchdog.sh` recovers this with a `restart bot`.
- DB-backed vitest tests must run in alpine
  (`docker run … node:20-alpine npx vitest run`) — the host node binding is
  root-owned musl and fails `dlopen`.
