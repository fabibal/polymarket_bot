#!/usr/bin/env bash
# Falcon (Polymarket Analytics) JWT expiry check for polymarket_bot.
#
# Decodes the JWT in POLYMARKET_ANALYTICS_API_KEY (= FALCON_API_KEY) from
# ~/polymarket_bot/.env and emits a Telegram alert when the token is close
# to (or past) expiry. Without a valid token, Falcon leaderboard enrichment
# silently degrades to Bullpen-only — bot keeps running but discovery quality
# drops.
#
# Cron: 0 9 * * * /home/user/polymarket_bot/scripts/check-falcon-expiry.sh \
#         >> /home/user/polymarket_bot/logs/falcon-expiry.cron.log 2>&1
# Test: FORCE_ALERT=1 ./check-falcon-expiry.sh
#
# Telegram creds: ~/.env.shared (cross-project, chmod 600).
# Log:            ~/polymarket_bot/logs/falcon-expiry.log
#
# Refresh procedure (manual): generate a new JWT at polymarketanalytics.com,
# update POLYMARKET_ANALYTICS_API_KEY in ~/polymarket_bot/.env, then
# `docker compose up -d --no-deps bot` to pick it up.
#
# Thresholds:
#   days_left  > 3   silent (log only)
#   0 < days_left <= 3   warning alert
#   days_left <= 0       urgent EXPIRED alert

set -u

SHARED_ENV="${HOME}/.env.shared"
BOT_ENV="${HOME}/polymarket_bot/.env"
LOG_DIR="${HOME}/polymarket_bot/logs"
LOG_FILE="${LOG_DIR}/falcon-expiry.log"
WARN_DAYS=3

mkdir -p "${LOG_DIR}"

# ----- Telegram creds (load from shared infra file) ---------------------------
TELEGRAM_BOT_TOKEN=""
TELEGRAM_CHAT_ID=""
if [ -f "${SHARED_ENV}" ]; then
    # shellcheck disable=SC1090
    set -a; . "${SHARED_ENV}"; set +a
fi

# Hard-fail if alerting infrastructure is broken — better to scream into the
# log + stderr (now redirected to falcon-expiry.cron.log) than to silently
# miss an expiry alert because the shared file was deleted/corrupted.
fail_infra() {
    local reason="$1"
    local ts; ts="$(date -u +'%F %T') UTC"
    local line="${ts} | ERROR | infra_broken | reason=${reason}"
    mkdir -p "${LOG_DIR}" 2>/dev/null || true
    echo "${line}" >> "${LOG_FILE}" 2>/dev/null || true
    echo "${line}" >&2
    echo "[polymarket_bot] check-falcon-expiry.sh CANNOT ALERT: ${reason}" >&2
    exit 2
}

if [ ! -f "${SHARED_ENV}" ]; then
    fail_infra "shared env file missing at ${SHARED_ENV}"
fi
if [ -z "${TELEGRAM_BOT_TOKEN}" ] || [ -z "${TELEGRAM_CHAT_ID}" ]; then
    fail_infra "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID empty after sourcing ${SHARED_ENV}"
fi
if ! [[ "${TELEGRAM_BOT_TOKEN}" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
    fail_infra "TELEGRAM_BOT_TOKEN failed format check"
fi
if ! [[ "${TELEGRAM_CHAT_ID}" =~ ^-?[0-9]+$ ]]; then
    fail_infra "TELEGRAM_CHAT_ID failed format check"
fi

# ----- Reusable send_telegram() — copied from check-bullpen-expiry.sh --------
send_telegram() {
    local msg="$1"
    if [ -z "${TELEGRAM_BOT_TOKEN}" ] || [ -z "${TELEGRAM_CHAT_ID}" ]; then
        echo "WARN: Telegram creds not set, would have sent: ${msg}" >&2
        return 1
    fi
    curl -fsS --max-time 10 \
        -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
        --data-urlencode "text=${msg}" \
        --data-urlencode "disable_web_page_preview=true" \
        > /dev/null \
        || { echo "ERROR: telegram send failed" >&2; return 1; }
    return 0
}

# ----- JWT exp decoder (pure shell, no python) -------------------------------
decode_jwt_exp() {
    local token="$1" payload b64 pad json exp
    [ -z "$token" ] && return 1
    payload="${token#*.}"
    payload="${payload%%.*}"
    [ -z "$payload" ] && return 1
    b64="${payload//-/+}"
    b64="${b64//_//}"
    pad=$((4 - ${#b64} % 4))
    [ "$pad" -lt 4 ] && b64="${b64}$(printf '=%.0s' $(seq 1 "$pad"))"
    json="$(echo "$b64" | base64 -d 2>/dev/null)" || return 1
    exp="$(echo "$json" | grep -oE '"exp":[0-9]+' | head -n1 | cut -d: -f2)"
    [ -z "$exp" ] && return 1
    echo "$exp"
}

# ----- Read credentials ------------------------------------------------------
NOW="$(date -u +%s)"
TS="$(date -u +'%F %T') UTC"

if [ ! -f "${BOT_ENV}" ]; then
    fail_infra "bot env file missing at ${BOT_ENV}"
fi
if [ ! -r "${BOT_ENV}" ]; then
    fail_infra "bot env file not readable at ${BOT_ENV}"
fi

# Prefer POLYMARKET_ANALYTICS_API_KEY (canonical); fall back to FALCON_API_KEY.
TOKEN="$(grep -oE '^POLYMARKET_ANALYTICS_API_KEY=.*' "${BOT_ENV}" | head -n1 | cut -d= -f2-)"
if [ -z "${TOKEN}" ]; then
    TOKEN="$(grep -oE '^FALCON_API_KEY=.*' "${BOT_ENV}" | head -n1 | cut -d= -f2-)"
fi
# Strip surrounding quotes if any
TOKEN="${TOKEN%\"}"; TOKEN="${TOKEN#\"}"
TOKEN="${TOKEN%\'}"; TOKEN="${TOKEN#\'}"

if [ -z "${TOKEN}" ]; then
    msg="🚨 [polymarket_bot] POLYMARKET_ANALYTICS_API_KEY not set in ${BOT_ENV} — Falcon leaderboard enrichment disabled."
    echo "${TS} | ERROR | key_missing | path=${BOT_ENV}" >> "${LOG_FILE}"
    send_telegram "${msg}"
    exit 1
fi

JWT_EXP="$(decode_jwt_exp "${TOKEN}")" || JWT_EXP=""

if [ -z "${JWT_EXP}" ]; then
    msg="🚨 [polymarket_bot] Could not decode Falcon JWT exp from POLYMARKET_ANALYTICS_API_KEY in ${BOT_ENV}. Manual check required."
    echo "${TS} | ERROR | jwt_decode_failed" >> "${LOG_FILE}"
    send_telegram "${msg}"
    exit 1
fi

EXP="${JWT_EXP}"
SOURCE="falcon_jwt"
DAYS_LEFT=$(awk -v e="${EXP}" -v n="${NOW}" 'BEGIN{ printf "%.1f", (e-n)/86400 }')
EXP_HUMAN="$(date -u -d "@${EXP}" +'%F %H:%M UTC' 2>/dev/null || echo "(epoch ${EXP})")"

# ----- Decide action ---------------------------------------------------------
ACTION="silent"
ALERT_MSG=""

if [ "${FORCE_ALERT:-0}" = "1" ]; then
    ACTION="forced_test"
    echo "${TS} | FORCE_ALERT | jwt_exp=${JWT_EXP} | days_left=${DAYS_LEFT}" >> "${LOG_FILE}"
    ALERT_MSG="[polymarket_bot] alert system test - safe to ignore (Falcon JWT expires ${EXP_HUMAN}, ${DAYS_LEFT} days left, source=${SOURCE})"
elif awk -v d="${DAYS_LEFT}" 'BEGIN{ exit !(d <= 0) }'; then
    ACTION="urgent_expired"
    ALERT_MSG="🚨 [polymarket_bot] Falcon API key EXPIRED (${EXP_HUMAN}). Polymarket Analytics calls failing. Generate new JWT at polymarketanalytics.com and update POLYMARKET_ANALYTICS_API_KEY in ~/polymarket_bot/.env."
elif awk -v d="${DAYS_LEFT}" -v w="${WARN_DAYS}" 'BEGIN{ exit !(d > 0 && d <= w) }'; then
    ACTION="warning_imminent"
    ALERT_MSG="⚠️ [polymarket_bot] Falcon API key expires in ${DAYS_LEFT} day(s) (${EXP_HUMAN}). Generate new JWT at polymarketanalytics.com and update POLYMARKET_ANALYTICS_API_KEY in ~/polymarket_bot/.env, then restart bot."
fi

# ----- Log + send ------------------------------------------------------------
echo "${TS} | OK | days_left=${DAYS_LEFT} | exp=${EXP_HUMAN} | source=${SOURCE} | action=${ACTION}" >> "${LOG_FILE}"

if [ -n "${ALERT_MSG}" ]; then
    if send_telegram "${ALERT_MSG}"; then
        echo "${TS} | SENT | action=${ACTION} | msg_preview=${ALERT_MSG:0:80}..." >> "${LOG_FILE}"
    else
        echo "${TS} | SEND_FAILED | action=${ACTION}" >> "${LOG_FILE}"
        exit 1
    fi
fi

exit 0
