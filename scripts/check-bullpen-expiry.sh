#!/usr/bin/env bash
# Bullpen CLI session expiry check for polymarket_bot.
#
# Bullpen CLI >=0.1.98 encrypts credentials (credentials.json.enc), so JWT
# is no longer decodable from the file. Instead we shell out to
# `bullpen --output json status` and parse account.session_expires.
#
# Cron: 0 9 * * * /home/user/polymarket_bot/scripts/check-bullpen-expiry.sh
# Test: FORCE_ALERT=1 ./check-bullpen-expiry.sh
#
# Telegram creds: ~/.env.shared (cross-project, chmod 600).
# Log:            ~/polymarket_bot/logs/bullpen-expiry.log
#
# Thresholds:
#   days_left  > 3   silent (log only)
#   0 < days_left <= 3   warning alert
#   days_left <= 0       urgent EXPIRED alert

set -u

SHARED_ENV="${HOME}/.env.shared"
CREDS_ENC="${HOME}/.bullpen/credentials.json.enc"
CREDS_PLAIN="${HOME}/.bullpen/credentials.json"
BULLPEN_BIN="${BULLPEN_BIN:-$(command -v bullpen || echo /home/user/.npm-global/bin/bullpen)}"
LOG_DIR="${HOME}/polymarket_bot/logs"
LOG_FILE="${LOG_DIR}/bullpen-expiry.log"
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
# log + stderr (cron mails stderr) than to silently miss an expiry alert
# because the shared file was deleted/corrupted.
fail_infra() {
    local reason="$1"
    local ts; ts="$(date -u +'%F %T') UTC"
    local line="${ts} | ERROR | infra_broken | reason=${reason}"
    mkdir -p "${LOG_DIR}" 2>/dev/null || true
    echo "${line}" >> "${LOG_FILE}" 2>/dev/null || true
    echo "${line}" >&2
    echo "[polymarket_bot] check-bullpen-expiry.sh CANNOT ALERT: ${reason}" >&2
    exit 2
}

if [ ! -f "${SHARED_ENV}" ]; then
    fail_infra "shared env file missing at ${SHARED_ENV}"
fi
if [ -z "${TELEGRAM_BOT_TOKEN}" ] || [ -z "${TELEGRAM_CHAT_ID}" ]; then
    fail_infra "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID empty after sourcing ${SHARED_ENV}"
fi
# Loose sanity check: bot token is "<digits>:<~35-char-secret>", chat id is digits.
if ! [[ "${TELEGRAM_BOT_TOKEN}" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
    fail_infra "TELEGRAM_BOT_TOKEN failed format check"
fi
if ! [[ "${TELEGRAM_CHAT_ID}" =~ ^-?[0-9]+$ ]]; then
    fail_infra "TELEGRAM_CHAT_ID failed format check"
fi

# ----- Reusable send_telegram() — copy this block into other alert scripts ---
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

# ----- Read credentials via `bullpen status` --------------------------------
NOW="$(date -u +%s)"
TS="$(date -u +'%F %T') UTC"

# Sanity: at least one credentials file must exist on disk before we shell out.
if [ ! -f "${CREDS_ENC}" ] && [ ! -f "${CREDS_PLAIN}" ]; then
    msg="🚨 [polymarket_bot] Bullpen credentials missing (no credentials.json or credentials.json.enc in ~/.bullpen) — bot Bullpen calls will fail. Run \`bullpen login\` on server."
    echo "${TS} | ERROR | credentials_missing | dir=${HOME}/.bullpen" >> "${LOG_FILE}"
    send_telegram "${msg}"
    exit 1
fi

if [ ! -x "${BULLPEN_BIN}" ]; then
    msg="🚨 [polymarket_bot] bullpen CLI binary not found/executable at ${BULLPEN_BIN}. Manual check required."
    echo "${TS} | ERROR | bullpen_bin_missing | path=${BULLPEN_BIN}" >> "${LOG_FILE}"
    send_telegram "${msg}"
    exit 1
fi

STATUS_JSON="$("${BULLPEN_BIN}" --output json status 2>/dev/null)" || STATUS_JSON=""
if [ -z "${STATUS_JSON}" ]; then
    msg="🚨 [polymarket_bot] \`bullpen status\` failed — cannot verify Bullpen auth health. Manual check required."
    echo "${TS} | ERROR | bullpen_status_failed" >> "${LOG_FILE}"
    send_telegram "${msg}"
    exit 1
fi

# Parse session_expires (ISO "YYYY-MM-DD HH:MM:SS UTC"); fall back to jwt_expires.
SESSION_EXPIRES_STR="$(printf '%s' "${STATUS_JSON}" | grep -oE '"session_expires"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/.*"session_expires"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
JWT_EXPIRES_STR="$(printf '%s' "${STATUS_JSON}" | grep -oE '"jwt_expires"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/.*"jwt_expires"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"

if [ -n "${SESSION_EXPIRES_STR}" ]; then
    EXP="$(date -u -d "${SESSION_EXPIRES_STR}" +%s 2>/dev/null || echo "")"
    SOURCE="bullpen_status.session_expires"
elif [ -n "${JWT_EXPIRES_STR}" ]; then
    EXP="$(date -u -d "${JWT_EXPIRES_STR}" +%s 2>/dev/null || echo "")"
    SOURCE="bullpen_status.jwt_expires"
else
    EXP=""
    SOURCE="none"
fi

if [ -z "${EXP}" ]; then
    msg="🚨 [polymarket_bot] Could not parse Bullpen session expiry from \`bullpen status\`. Manual check required."
    echo "${TS} | ERROR | parse_failed | source=none" >> "${LOG_FILE}"
    send_telegram "${msg}"
    exit 1
fi

JWT_EXP="${EXP}"
SESSION_EXP="${EXP}"

DAYS_LEFT=$(awk -v e="${EXP}" -v n="${NOW}" 'BEGIN{ printf "%.1f", (e-n)/86400 }')
EXP_HUMAN="$(date -u -d "@${EXP}" +'%F %H:%M UTC' 2>/dev/null || echo "(epoch ${EXP})")"

# ----- Decide action ---------------------------------------------------------
ACTION="silent"
ALERT_MSG=""

if [ "${FORCE_ALERT:-0}" = "1" ]; then
    ACTION="forced_test"
    echo "${TS} | FORCE_ALERT | exp=${EXP} | source=${SOURCE}" >> "${LOG_FILE}"
    ALERT_MSG="[polymarket_bot] alert system test - safe to ignore (session expires ${EXP_HUMAN}, ${DAYS_LEFT} days left, source=${SOURCE})"
elif awk -v d="${DAYS_LEFT}" 'BEGIN{ exit !(d <= 0) }'; then
    ACTION="urgent_expired"
    ALERT_MSG="🚨 [polymarket_bot] Bullpen refresh token EXPIRED (${EXP_HUMAN}, ${DAYS_LEFT} days). Bot Bullpen calls failing. Run \`bullpen login\` on server NOW."
elif awk -v d="${DAYS_LEFT}" -v w="${WARN_DAYS}" 'BEGIN{ exit !(d > 0 && d <= w) }'; then
    ACTION="warning_imminent"
    ALERT_MSG="⚠️ [polymarket_bot] Bullpen refresh token expires in ${DAYS_LEFT} day(s) (${EXP_HUMAN}). Run \`bullpen login\` on server soon."
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
