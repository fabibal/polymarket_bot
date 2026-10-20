#!/usr/bin/env bash
# VPN egress alert for polymarket_bot.
#
# watchdog.sh only probes the dashboard, which stays up when the WireGuard
# peer stops answering (2026-10-20: 5 h without feeds, no alert). This asks the
# dashboard for its egress check (/api/vpn-status, status ok|error). After
# 2 consecutive non-ok checks (~10 min) it sends ONE Telegram alert, and one
# recovery message when the VPN returns. An unreachable dashboard is
# watchdog.sh's job, so it is ignored here.
#
# Cron: */5 * * * * ~/polymarket_bot/scripts/vpn-watch.sh \
#         >> ~/polymarket_bot/logs/vpn-watch.cron.log 2>&1
# Test: FORCE_ALERT=1 ./vpn-watch.sh  (treats the check as failed; needs 2 runs
#       to alert, 1 more to recover), VPN_STATUS_URL=... to point elsewhere.
#
# State:    ~/polymarket_bot/logs/vpn-watch.state  ("<consecutive fails> <alerted 0|1>")
# Log:      ~/polymarket_bot/logs/vpn-watch.log    (rotated to last 100 lines)
# Telegram: ~/.env.shared (shared across projects)

set -u

URL="${VPN_STATUS_URL:-http://localhost:8082/api/vpn-status}"
TIMEOUT=20
FAIL_THRESHOLD=2

PROJECT_DIR="${HOME}/polymarket_bot"
SHARED_ENV="${SHARED_ENV:-${HOME}/.env.shared}"
LOG_DIR="${PROJECT_DIR}/logs"
LOG_FILE="${LOG_DIR}/vpn-watch.log"
STATE_FILE="${LOG_DIR}/vpn-watch.state"

mkdir -p "${LOG_DIR}"

TS="$(date -u +'%F %T') UTC"

# ----- Telegram creds (best-effort; must not hard-fail on infra) ------------
TELEGRAM_BOT_TOKEN=""
TELEGRAM_CHAT_ID=""
if [ -f "${SHARED_ENV}" ]; then
    # shellcheck disable=SC1090
    set -a; . "${SHARED_ENV}"; set +a
fi
# polymarket_bot's own channel ("Polymarket") when ~/.env.shared defines it,
# like the other projects' <NAME>_TELEGRAM_CHAT_ID; otherwise the shared chat.
TELEGRAM_CHAT_ID="${POLYMARKET_TELEGRAM_CHAT_ID:-${TELEGRAM_CHAT_ID:-}}"

send_telegram() {
    local msg="$1"
    if [ -z "${TELEGRAM_BOT_TOKEN}" ] || [ -z "${TELEGRAM_CHAT_ID}" ]; then
        echo "${TS} | WARN | telegram_creds_missing | would_send=${msg:0:80}" >> "${LOG_FILE}"
        return 1
    fi
    curl -fsS --max-time 10 \
        -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
        --data-urlencode "text=${msg}" \
        --data-urlencode "disable_web_page_preview=true" \
        > /dev/null \
        || { echo "${TS} | WARN | telegram_send_failed" >> "${LOG_FILE}"; return 1; }
    return 0
}

rotate_log() {
    if [ -f "${LOG_FILE}" ] && [ "$(wc -l < "${LOG_FILE}")" -gt 100 ]; then
        tail -n 100 "${LOG_FILE}" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "${LOG_FILE}"
    fi
}

# ----- State ----------------------------------------------------------------
FAILS=0; ALERTED=0
if [ -f "${STATE_FILE}" ]; then
    read -r FAILS ALERTED < "${STATE_FILE}" || true
fi
case "${FAILS}" in ''|*[!0-9]*) FAILS=0 ;; esac
case "${ALERTED}" in 0|1) ;; *) ALERTED=0 ;; esac

# ----- Probe ----------------------------------------------------------------
BODY="$(curl -sS -m "${TIMEOUT}" "${URL}" 2>/dev/null || true)"

if [ -z "${BODY}" ] && [ "${FORCE_ALERT:-0}" != "1" ]; then
    # Dashboard unreachable: watchdog.sh handles that; keep the state as is.
    echo "${TS} | SKIP | dashboard_unreachable" >> "${LOG_FILE}"
    rotate_log
    exit 0
fi

STATUS="$(printf '%s' "${BODY}" | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p')"
[ "${FORCE_ALERT:-0}" = "1" ] && STATUS="error"

if [ "${STATUS}" = "ok" ]; then
    IP="$(printf '%s' "${BODY}" | sed -n 's/.*"ip"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    COUNTRY="$(printf '%s' "${BODY}" | sed -n 's/.*"country"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    if [ "${ALERTED}" = "1" ]; then
        echo "${TS} | RECOVERED | status=ok ip=${IP} country=${COUNTRY} | after ${FAILS} fail(s)" >> "${LOG_FILE}"
        send_telegram "✅ [polymarket_bot] VPN is back (${IP}, ${COUNTRY}) after ~$((FAILS * 5))m. Trades made during the outage are copied late via poll."
    else
        echo "${TS} | OK | status=ok ip=${IP} country=${COUNTRY}" >> "${LOG_FILE}"
    fi
    echo "0 0" > "${STATE_FILE}"
    rotate_log
    exit 0
fi

# Not ok (status=error, or a body we cannot parse)
FAILS=$((FAILS + 1))
echo "${TS} | FAIL | status=${STATUS:-unparsed} | consecutive=${FAILS}/${FAIL_THRESHOLD}" >> "${LOG_FILE}"

if [ "${FAILS}" -ge "${FAIL_THRESHOLD}" ] && [ "${ALERTED}" = "0" ]; then
    if send_telegram "🚨 [polymarket_bot] VPN egress down for ~$((FAILS * 5))m: no feeds, no copying. Likely the Proton server/config - get a new WireGuard config, update .env, docker compose up -d gluetun bot."; then
        ALERTED=1
    fi
fi

echo "${FAILS} ${ALERTED}" > "${STATE_FILE}"
rotate_log
exit 0
