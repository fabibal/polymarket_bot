#!/usr/bin/env bash
# Release watch for polymarket_bot (2026-10-20): a no-money measurement at a
# scheduled macro release. How fast does this server learn the number, and what
# did the Polymarket book offer at that moment? Runs both parts of
# scripts/release_watch.js in parallel: "sources" on the host network, "book"
# in the gluetun namespace. Evaluate later with scripts/release_watch_report.js.
#
# Cron (UTC), one line per release, ~3 min before it, e.g.:
#   57 17 28 10 * ~/polymarket_bot/scripts/release-watch.sh fomc-2026-10-28 \
#     >> ~/polymarket_bot/logs/release-watch.cron.log 2>&1
# Day/month cron lines repeat every year, so the run exits unless the date at the
# end of the release id is today. RELEASE_WATCH_FORCE=1 skips that check.
# Dry run: release id test-<today> with RW_AT / RW_EVENTS / RW_EXTRA_SOURCE.
#
# Output:   ~/polymarket_bot/logs/release-watch/<release-id>/
# Log:      ~/polymarket_bot/logs/release-watch.log (one line per run)
# Telegram: ~/.env.shared (shared across projects); one message per run.

set -u

ID="${1:-}"
PROJECT_DIR="${HOME}/polymarket_bot"
SHARED_ENV="${SHARED_ENV:-${HOME}/.env.shared}"
LOG_DIR="${PROJECT_DIR}/logs"
LOG_FILE="${LOG_DIR}/release-watch.log"
OUT_ROOT="${LOG_DIR}/release-watch"
OUT="${OUT_ROOT}/${ID}"

mkdir -p "${LOG_DIR}"
TS="$(date -u +'%F %T') UTC"

if [ -z "${ID}" ]; then
    echo "usage: $0 <release-id>" >&2
    exit 2
fi
if [ "${ID: -10}" != "$(date -u +%F)" ] && [ "${RELEASE_WATCH_FORCE:-0}" != "1" ]; then
    echo "${TS} | SKIP | ${ID} | not today" >> "${LOG_FILE}"
    exit 0
fi

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

# ----- Preflight: the book part needs the VPN namespace and egress ----------
PRE=""
if ! docker ps --format '{{.Names}}' | grep -qx gluetun; then
    PRE="gluetun not running"
else
    VPN="$(curl -sS -m 10 http://localhost:8082/api/vpn-status 2>/dev/null || true)"
    case "${VPN}" in
        *'"status":"ok"'*) ;;
        *) PRE="VPN status not ok (${VPN:0:60})" ;;
    esac
fi
if [ -n "${PRE}" ]; then
    echo "${TS} | WARN | ${ID} | preflight: ${PRE}" >> "${LOG_FILE}"
    send_telegram "⚠️ [polymarket_bot] release-watch ${ID}: ${PRE}. Running anyway; the book part will probably fail."
fi

# ----- Both parts in parallel ------------------------------------------------
mkdir -p "${OUT}"
RW_ENV=(-e RW_AT="${RW_AT:-}" -e RW_EVENTS="${RW_EVENTS:-}" -e RW_EXTRA_SOURCE="${RW_EXTRA_SOURCE:-}")
timeout 15m docker run --rm -u 1000:1000 --network container:gluetun "${RW_ENV[@]}" \
    -v "${PROJECT_DIR}:/app:ro" -v "${OUT_ROOT}:/out" \
    node:20-alpine node /app/scripts/release_watch.js "${ID}" book > "${OUT}/book.log" 2>&1 &
BOOK_PID=$!
timeout 15m docker run --rm -u 1000:1000 --network host "${RW_ENV[@]}" \
    -v "${PROJECT_DIR}:/app:ro" -v "${OUT_ROOT}:/out" \
    node:20-alpine node /app/scripts/release_watch.js "${ID}" sources > "${OUT}/sources.log" 2>&1 &
SRC_PID=$!
BOOK_EXIT=0; wait "${BOOK_PID}" || BOOK_EXIT=$?
SRC_EXIT=0; wait "${SRC_PID}" || SRC_EXIT=$?

SRC_LINE="$(grep '^TG ' "${OUT}/sources.log" | tail -1 | cut -c4-)"
BOOK_LINE="$(grep '^TG ' "${OUT}/book.log" | tail -1 | cut -c4-)"
[ -n "${SRC_LINE}" ] || SRC_LINE="sources: FAILED (exit ${SRC_EXIT}, see sources.log)"
[ -n "${BOOK_LINE}" ] || BOOK_LINE="book: FAILED (exit ${BOOK_EXIT}, see book.log)"

STATUS="OK"; ICON="📡"
if [ "${SRC_EXIT}" -ne 0 ] || [ "${BOOK_EXIT}" -ne 0 ]; then STATUS="FAIL"; ICON="🚨"; fi
echo "${TS} | ${STATUS} | ${ID} | ${SRC_LINE} | ${BOOK_LINE}" >> "${LOG_FILE}"
send_telegram "${ICON} [polymarket_bot] release-watch ${ID}: ${SRC_LINE} | ${BOOK_LINE}"
exit 0
