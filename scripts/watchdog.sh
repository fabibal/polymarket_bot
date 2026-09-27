#!/usr/bin/env bash
# Dashboard watchdog for polymarket_bot.
#
# Pings http://localhost:8082 every 5 min via cron. If the dashboard fails
# 2 consecutive checks (~10 min), restarts the bot container — recovers from
# the gluetun-restart orphan-namespace failure mode where Express keeps
# listening inside a netns no longer wired to gluetun's published port.
#
# Cron: */5 * * * * /home/user/polymarket_bot/scripts/watchdog.sh \
#         >> /home/user/polymarket_bot/logs/watchdog.cron.log 2>&1
# Test: FORCE_RESTART=1 ./watchdog.sh  (forces 1 fail to trigger restart path)
#
# State:    ~/polymarket_bot/logs/watchdog.state  (consecutive failure count)
# Log:      ~/polymarket_bot/logs/watchdog.log    (rotated to last 100 lines)
# Telegram: ~/.env.shared (shared across projects)

set -u

URL="http://localhost:8082/"
TIMEOUT=5
FAIL_THRESHOLD=2

PROJECT_DIR="${HOME}/polymarket_bot"
SHARED_ENV="${HOME}/.env.shared"
LOG_DIR="${PROJECT_DIR}/logs"
LOG_FILE="${LOG_DIR}/watchdog.log"
STATE_FILE="${LOG_DIR}/watchdog.state"

mkdir -p "${LOG_DIR}"

TS="$(date -u +'%F %T') UTC"

# ----- Telegram creds (best-effort; watchdog must not hard-fail on infra) ----
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

read_state() {
    if [ -f "${STATE_FILE}" ]; then
        cat "${STATE_FILE}" 2>/dev/null || echo 0
    else
        echo 0
    fi
}

write_state() {
    echo "$1" > "${STATE_FILE}"
}

# ----- Probe ----------------------------------------------------------------
HTTP_CODE="$(curl -sS -o /dev/null -m "${TIMEOUT}" -w '%{http_code}' "${URL}" 2>/dev/null || echo 000)"

if [ "${FORCE_RESTART:-0}" = "1" ]; then
    HTTP_CODE=000
fi

PREV_FAILS="$(read_state)"
case "${PREV_FAILS}" in ''|*[!0-9]*) PREV_FAILS=0 ;; esac

if [ "${HTTP_CODE}" = "200" ]; then
    if [ "${PREV_FAILS}" -gt 0 ]; then
        echo "${TS} | OK | http=${HTTP_CODE} | recovered after ${PREV_FAILS} fail(s)" >> "${LOG_FILE}"
    else
        echo "${TS} | OK | http=${HTTP_CODE}" >> "${LOG_FILE}"
    fi
    write_state 0
    rotate_log
    exit 0
fi

# Probe failed
NEW_FAILS=$((PREV_FAILS + 1))
echo "${TS} | FAIL | http=${HTTP_CODE} | consecutive=${NEW_FAILS}/${FAIL_THRESHOLD}" >> "${LOG_FILE}"

if [ "${NEW_FAILS}" -lt "${FAIL_THRESHOLD}" ]; then
    write_state "${NEW_FAILS}"
    rotate_log
    exit 0
fi

# Threshold reached: restart bot
echo "${TS} | RESTART | triggering docker compose restart bot" >> "${LOG_FILE}"

RESTART_OUT="$(cd "${PROJECT_DIR}" && docker compose restart bot 2>&1)"
RESTART_RC=$?

if [ "${RESTART_RC}" -eq 0 ]; then
    echo "${TS} | RESTART_OK | rc=0" >> "${LOG_FILE}"
    send_telegram "🔄 [polymarket_bot] watchdog: dashboard unreachable for ${NEW_FAILS} checks (~$((NEW_FAILS * 5))m). Restarted bot container."
else
    echo "${TS} | RESTART_FAIL | rc=${RESTART_RC} | out=${RESTART_OUT:0:200}" >> "${LOG_FILE}"
    send_telegram "🚨 [polymarket_bot] watchdog: dashboard unreachable AND restart failed (rc=${RESTART_RC}). Manual intervention required."
fi

# Reset counter regardless — next cycle re-evaluates fresh
write_state 0
rotate_log
exit 0
