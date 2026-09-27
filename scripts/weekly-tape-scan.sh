#!/usr/bin/env bash
# Weekly tape-scan discovery + auto-observation.
#
# Runs scripts/tape_scan.js with TAPE_SCAN_AUTO_ADD=1: high-confidence
# survivors (MM check, fills/market, hold-time, pseudo-replication, WR>55%,
# pnl>$500, roi>10%) are auto-added to watchlist_traders as copy_enabled=0
# (observation only), capped at 10 standing observation traders. One
# Telegram alert per auto-added trader.
#
# Cron: 0 5 * * 0 /home/user/polymarket_bot/scripts/weekly-tape-scan.sh
# (Sundays 05:00 UTC -- the day before weekly-macro-scan.sh's Monday 04:00
# UTC run, so the two discovery pipelines don't overlap in the same window)
# Test: ./weekly-tape-scan.sh        (sends real Telegram messages if any
#                                      candidate is auto-added)
#
# Telegram creds: ~/.env.shared (cross-project, chmod 600).
# Logs:           ~/polymarket_bot/logs/weekly-tape-scan.log (last 200 lines)

set -u

PROJECT_DIR="/home/user/polymarket_bot"
SHARED_ENV="${HOME}/.env.shared"
CONTAINER="polymarket_bot"
LOG_DIR="${PROJECT_DIR}/logs"
LOG_FILE="${LOG_DIR}/weekly-tape-scan.log"
RAW_DIR="${LOG_DIR}/weekly-tape-scan-runs"
TS="$(date -u +'%F %T') UTC"
RUN_ID="$(date -u +'%Y%m%dT%H%M%SZ')"
RAW_SCAN="${RAW_DIR}/${RUN_ID}-tapescan.log"

mkdir -p "${LOG_DIR}" "${RAW_DIR}"

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
    echo "[polymarket_bot] weekly-tape-scan.sh CANNOT ALERT: ${reason}" >&2
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

# ----- Preflight: container running? ----------------------------------------
if ! docker ps --format '{{.Names}}' | grep -qx "${CONTAINER}"; then
    echo "${TS} | ERROR | container_down | name=${CONTAINER}" >> "${LOG_FILE}"
    send_telegram "🚨 [polymarket_bot] weekly-tape-scan: container ${CONTAINER} not running — skipped."
    exit 1
fi

# ----- Sync latest script copy into container --------------------------------
# scripts/ is COPY'd at image build, but we want the live version so edits
# don't require a rebuild before they take effect.
docker cp "${PROJECT_DIR}/scripts/tape_scan.js" "${CONTAINER}:/app/scripts/tape_scan.js" 2>/dev/null \
    || { echo "${TS} | ERROR | docker_cp_failed" >> "${LOG_FILE}"; send_telegram "🚨 [polymarket_bot] weekly-tape-scan: docker cp tape_scan.js failed"; exit 1; }

# ----- Run: tape scan + auto-observation -------------------------------------
echo "${TS} | START | step=tape_scan_auto_obs" >> "${LOG_FILE}"
if ! docker exec -e TAPE_SCAN_AUTO_ADD=1 "${CONTAINER}" node /app/scripts/tape_scan.js > "${RAW_SCAN}" 2>&1; then
    echo "${TS} | ERROR | tape_scan_failed | log=${RAW_SCAN}" >> "${LOG_FILE}"
    send_telegram "🚨 [polymarket_bot] weekly-tape-scan: tape_scan.js failed. See ${RAW_SCAN}."
    exit 1
fi

# ----- Send one Telegram message per auto-added trader -----------------------
# tape_scan.js prints one "TELEGRAM_MSG_B64 <base64>" line per addition so
# the message text (already fully formatted) survives the bash round-trip
# without any JSON-in-bash parsing.
ADDED_COUNT=0
SEND_FAILS=0
while IFS= read -r line; do
    b64="${line#TELEGRAM_MSG_B64 }"
    [ -z "${b64}" ] && continue
    msg="$(printf '%s' "${b64}" | base64 -d 2>/dev/null)"
    [ -z "${msg}" ] && continue
    ADDED_COUNT=$((ADDED_COUNT + 1))
    send_telegram "${msg}" || SEND_FAILS=$((SEND_FAILS + 1))
done < <(grep '^TELEGRAM_MSG_B64 ' "${RAW_SCAN}")

echo "${TS} | DONE | auto_added=${ADDED_COUNT} | telegram_send_fails=${SEND_FAILS}" >> "${LOG_FILE}"

# ----- Trim app log to last 200 lines, prune raw run logs older than 30d ----
if [ -f "${LOG_FILE}" ]; then
    tmp="$(mktemp)"
    tail -n 200 "${LOG_FILE}" > "${tmp}" && mv "${tmp}" "${LOG_FILE}"
fi
find "${RAW_DIR}" -type f -mtime +30 -delete 2>/dev/null || true

exit 0
