#!/usr/bin/env bash
# Weekly low-frequency trader discovery + auto-observation (replaces
# weekly-tape-scan.sh on 2026-09-26: every trader the tape scan auto-added was
# a high-frequency bot that lost money as a copy).
#
# 1. Fetches the Bullpen leaderboard on the host (the CLI and its login live
#    here) into the run's work dir.
# 2. Runs scripts/lowfreq_scan.js in its own node:20-alpine container inside
#    the VPN namespace (never inside the bot container): data-api filters,
#    then a backtest gate with our copy rules, real costs and fees. Survivors
#    are added as copy_enabled=0 (observation) via the dashboard API, capped
#    at 10 standing observation traders.
# 3. One Telegram message per added trader.
#
# Cron: 30 5 * * 0 /home/user/polymarket_bot/scripts/weekly-lowfreq-scan.sh
#   (05:30, not 05:00: the Sunday 05:00 `docker system prune` deleted the
#   unused node:20-alpine image under the first scheduled run on 2026-09-27.)
# Test: LOWFREQ_AUTO_ADD=0 ./weekly-lowfreq-scan.sh   (report only, adds nobody)
#
# Telegram creds: ~/.env.shared (cross-project, chmod 600).
# Logs: ~/polymarket_bot/logs/weekly-lowfreq-scan.log (last 200 lines);
#       per-run work dir with scan.log + report.json under
#       ~/polymarket_bot/logs/weekly-lowfreq-scan-runs/ (pruned after 30d).

set -u

PROJECT_DIR="/home/user/polymarket_bot"
SHARED_ENV="${HOME}/.env.shared"
LOG_DIR="${PROJECT_DIR}/logs"
LOG_FILE="${LOG_DIR}/weekly-lowfreq-scan.log"
RUNS_DIR="${LOG_DIR}/weekly-lowfreq-scan-runs"
TS="$(date -u +'%F %T') UTC"
RUN_ID="$(date -u +'%Y%m%dT%H%M%SZ')"
WORK="${RUNS_DIR}/${RUN_ID}"
AUTO_ADD="${LOWFREQ_AUTO_ADD:-1}"
BULLPEN_BIN="${BULLPEN_BIN:-$(command -v bullpen || echo /home/user/.npm-global/bin/bullpen)}"

mkdir -p "${WORK}/bullpen" "${WORK}/btcache"

# ----- Telegram creds (load from shared infra file) ---------------------------
TELEGRAM_BOT_TOKEN=""
TELEGRAM_CHAT_ID=""
if [ -f "${SHARED_ENV}" ]; then
    # shellcheck disable=SC1090
    set -a; . "${SHARED_ENV}"; set +a
fi
# polymarket_bot's own channel ("Polymarket") when ~/.env.shared defines it,
# like the other projects' <NAME>_TELEGRAM_CHAT_ID; otherwise the shared chat.
TELEGRAM_CHAT_ID="${POLYMARKET_TELEGRAM_CHAT_ID:-${TELEGRAM_CHAT_ID:-}}"

fail_infra() {
    local reason="$1"
    local line="${TS} | ERROR | infra_broken | reason=${reason}"
    echo "${line}" >> "${LOG_FILE}" 2>/dev/null || true
    echo "${line}" >&2
    echo "[polymarket_bot] weekly-lowfreq-scan.sh CANNOT ALERT: ${reason}" >&2
    exit 2
}

[ -f "${SHARED_ENV}" ] || fail_infra "shared env file missing at ${SHARED_ENV}"
[ -n "${TELEGRAM_BOT_TOKEN}" ] && [ -n "${TELEGRAM_CHAT_ID}" ] \
    || fail_infra "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID empty after sourcing ${SHARED_ENV}"
[[ "${TELEGRAM_BOT_TOKEN}" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] \
    || fail_infra "TELEGRAM_BOT_TOKEN failed format check"
[[ "${TELEGRAM_CHAT_ID}" =~ ^-?[0-9]+$ ]] \
    || fail_infra "TELEGRAM_CHAT_ID failed format check"

send_telegram() {
    local msg="$1"
    curl -fsS --max-time 15 \
        -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
        --data-urlencode "text=${msg}" \
        --data-urlencode "disable_web_page_preview=true" \
        > /dev/null \
        || { echo "ERROR: telegram send failed" >&2; return 1; }
    return 0
}

# ----- Preflight: bot (dashboard API) and VPN namespace up? ------------------
for c in polymarket_bot gluetun; do
    if ! docker ps --format '{{.Names}}' | grep -qx "${c}"; then
        echo "${TS} | ERROR | container_down | name=${c}" >> "${LOG_FILE}"
        send_telegram "🚨 [polymarket_bot] weekly-lowfreq-scan: container ${c} not running — skipped."
        exit 1
    fi
done

# ----- 1. Bullpen leaderboard on the host ------------------------------------
# Capped at 100 rows per query, so the pool is built from several sorts/periods
# plus the two slow trading styles. A failed query just shrinks the pool.
q=0; q_ok=0
bullpen_query() {
    q=$((q + 1))
    if "${BULLPEN_BIN}" polymarket data leaderboard "$@" --hide-bots --hide-farmers --limit 100 --output json \
        > "${WORK}/bullpen/q${q}.json" 2>/dev/null; then
        q_ok=$((q_ok + 1))
    else
        rm -f "${WORK}/bullpen/q${q}.json"
    fi
}
for tp in 90d 30d all; do
    for s in pnl copyability win-rate; do
        bullpen_query --time-period "${tp}" --sort "${s}"
        for style in high_conviction swing; do
            bullpen_query --time-period "${tp}" --sort "${s}" --style "${style}"
        done
    done
done
echo "${TS} | START | bullpen_queries_ok=${q_ok}/${q} | auto_add=${AUTO_ADD}" >> "${LOG_FILE}"

# ----- 2. Scan + backtest gate in its own container --------------------------
if ! timeout 3h docker run --rm -u 1000:1000 --network container:gluetun \
        -e LOWFREQ_AUTO_ADD="${AUTO_ADD}" \
        -v "${PROJECT_DIR}:/app:ro" -v "${WORK}:/work" \
        node:20-alpine node /app/scripts/lowfreq_scan.js > "${WORK}/scan.log" 2>&1; then
    echo "${TS} | ERROR | lowfreq_scan_failed | log=${WORK}/scan.log" >> "${LOG_FILE}"
    send_telegram "🚨 [polymarket_bot] weekly-lowfreq-scan: lowfreq_scan.js failed. See ${WORK}/scan.log."
    exit 1
fi

# ----- 3. One Telegram message per added trader ------------------------------
ADDED_COUNT=0
SEND_FAILS=0
while IFS= read -r line; do
    b64="${line#TELEGRAM_MSG_B64 }"
    [ -z "${b64}" ] && continue
    msg="$(printf '%s' "${b64}" | base64 -d 2>/dev/null)"
    [ -z "${msg}" ] && continue
    ADDED_COUNT=$((ADDED_COUNT + 1))
    send_telegram "${msg}" || SEND_FAILS=$((SEND_FAILS + 1))
done < <(grep '^TELEGRAM_MSG_B64 ' "${WORK}/scan.log")

SUMMARY="$(grep '^SUMMARY ' "${WORK}/scan.log" | tail -1)"
echo "${TS} | DONE | ${SUMMARY#SUMMARY } | telegram_sent=${ADDED_COUNT} | telegram_send_fails=${SEND_FAILS}" >> "${LOG_FILE}"

# ----- Trim app log to last 200 lines; drop the bulky caches, prune old runs --
if [ -f "${LOG_FILE}" ]; then
    tmp="$(mktemp)"
    tail -n 200 "${LOG_FILE}" > "${tmp}" && mv "${tmp}" "${LOG_FILE}"
fi
rm -rf "${WORK}/btcache/activity_"* 2>/dev/null || true
find "${RUNS_DIR}" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} + 2>/dev/null || true

exit 0
