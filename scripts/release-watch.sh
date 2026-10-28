#!/usr/bin/env bash
# No-money capture. UTC cron unchanged. Each run has its own immutable input
# directory; report with release_watch_report.js <id> [run-id].
# RW_NOTIFY=0 disables Telegram AND loading shared credentials (tests/manual).
set -uo pipefail
ID="${1:-}"
PROJECT_DIR="${RW_PROJECT_DIR:-${HOME}/polymarket_bot}"
LOG_DIR="${PROJECT_DIR}/logs"
OUT_ROOT="${LOG_DIR}/release-watch"
LOG_FILE="${LOG_DIR}/release-watch.log"
SHARED_ENV="${SHARED_ENV:-${HOME}/.env.shared}"
NOTIFY="${RW_NOTIFY:-1}"
mkdir -p "${OUT_ROOT}" || exit 1
log() { echo "$(date -u +'%F %T') UTC | $*" >> "${LOG_FILE}"; }
if [[ ! "${ID}" =~ ^[a-z0-9_-]+$ ]]; then echo 'usage: release-watch.sh <release-id>' >&2; exit 2; fi
if [ "${ID: -10}" != "$(date -u +%F)" ] && [ "${RELEASE_WATCH_FORCE:-0}" != 1 ]; then
    log "SKIP | ${ID} | not today"; exit 0
fi
exec 9>"${OUT_ROOT}/.${ID}.lock" || exit 1
if ! flock -n 9; then log "FAIL | ${ID} | already running"; exit 75; fi
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
OUT="${OUT_ROOT}/${ID}/${RUN_ID}"
mkdir -p "${OUT}" || exit 1
printf '%s\n' "${RUN_ID}" > "${OUT_ROOT}/${ID}/latest.tmp" || exit 1
mv "${OUT_ROOT}/${ID}/latest.tmp" "${OUT_ROOT}/${ID}/latest" || exit 1
log "START | ${ID} | run=${RUN_ID}"

TELEGRAM_BOT_TOKEN=""
TELEGRAM_CHAT_ID=""
if [ "${NOTIFY}" = 1 ] && [ -f "${SHARED_ENV}" ]; then
    set -a; . "${SHARED_ENV}"; set +a
fi
TELEGRAM_CHAT_ID="${POLYMARKET_TELEGRAM_CHAT_ID:-${TELEGRAM_CHAT_ID:-}}"
send_telegram() {
    [ "${NOTIFY}" = 1 ] || return 0
    if [ -z "${TELEGRAM_BOT_TOKEN}" ] || [ -z "${TELEGRAM_CHAT_ID}" ]; then
        log "WARN | ${ID} | telegram_creds_missing"; return 1
    fi
    curl -fsS --max-time 10 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=$1" \
        --data-urlencode "disable_web_page_preview=true" > /dev/null 2>&1 \
        || { log "WARN | ${ID} | telegram_send_failed"; return 1; }
}
BOOK_NAME="release-watch-book-${RUN_ID}"
SRC_NAME="release-watch-sources-${RUN_ID}"
BOOK_PID=""; SRC_PID=""; FINISHED=0
cleanup() {
    local code=$?
    trap - EXIT
    if [ "${FINISHED}" = 0 ]; then
        log "FAIL | ${ID} | run=${RUN_ID} interrupted exit=${code}"
        [ -z "${BOOK_PID}" ] || kill "${BOOK_PID}" 2>/dev/null || true
        [ -z "${SRC_PID}" ] || kill "${SRC_PID}" 2>/dev/null || true
    fi
    # Only this invocation's containers. Bounded even if the Docker daemon hangs.
    timeout -k 2s 5s docker rm -f "${BOOK_NAME}" "${SRC_NAME}" >/dev/null 2>&1 || true
    exit "${code}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

PRE=""
if ! timeout -k 2s 10s docker ps --format '{{.Names}}' | grep -qx gluetun; then
    PRE="gluetun not running"
else
    VPN="$(curl -sS -m 10 http://localhost:8082/api/vpn-status 2>/dev/null || true)"
    [[ "${VPN}" =~ \"status\"[[:space:]]*:[[:space:]]*\"ok\" ]] || PRE="VPN status not ok"
fi
[ -z "${PRE}" ] || log "WARN | ${ID} | preflight: ${PRE}; still collecting sources"
RW_ENV=(-e RW_RUN_ID="${RUN_ID}" -e RW_AT="${RW_AT:-}" -e RW_EVENTS="${RW_EVENTS:-}" -e RW_EXTRA_SOURCE="${RW_EXTRA_SOURCE:-}")
timeout --kill-after=10s 15m docker run --init --rm --name "${BOOK_NAME}" -u 1000:1000 \
    --network container:gluetun "${RW_ENV[@]}" -v "${PROJECT_DIR}:/app:ro" -v "${OUT_ROOT}:/out" \
    node:20-alpine node /app/scripts/release_watch.js "${ID}" book > "${OUT}/book.log" 2>&1 &
BOOK_PID=$!
timeout --kill-after=10s 15m docker run --init --rm --name "${SRC_NAME}" -u 1000:1000 \
    --network host "${RW_ENV[@]}" -v "${PROJECT_DIR}:/app:ro" -v "${OUT_ROOT}:/out" \
    node:20-alpine node /app/scripts/release_watch.js "${ID}" sources > "${OUT}/sources.log" 2>&1 &
SRC_PID=$!
BOOK_EXIT=0; wait "${BOOK_PID}" || BOOK_EXIT=$?
SRC_EXIT=0; wait "${SRC_PID}" || SRC_EXIT=$?
SRC_LINE="$(sed -n 's/^TG //p' "${OUT}/sources.log" | tail -1)"
BOOK_LINE="$(sed -n 's/^TG //p' "${OUT}/book.log" | tail -1)"
[ -n "${SRC_LINE}" ] || SRC_LINE="sources FAILED (exit ${SRC_EXIT})"
[ -n "${BOOK_LINE}" ] || BOOK_LINE="book FAILED (exit ${BOOK_EXIT})"
RESULT=0; STATUS="OK"
if [ "${BOOK_EXIT}" -ne 0 ] || [ "${SRC_EXIT}" -ne 0 ] || [ -n "${PRE}" ]; then RESULT=1; STATUS="FAIL"; fi
# Exit 0 alone is not sufficient: both processes must have finished their summaries.
if ! node - "${OUT}" "${ID}" "${RUN_ID}" <<'JS'
const fs = require('fs'), path = require('path');
const [dir, release, runId] = process.argv.slice(2);
try {
  for (const part of ['sources', 'book']) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, `${part}_summary.json`), 'utf8'));
    if (s.schemaVersion !== 2 || s.release !== release || s.runId !== runId || s.quality?.ok !== true) process.exit(1);
  }
} catch { process.exit(1); }
JS
then RESULT=1; STATUS="FAIL"; fi
printf '{"runId":"%s","bookExit":%d,"sourcesExit":%d,"exitCode":%d,"status":"%s"}\n' \
    "${RUN_ID}" "${BOOK_EXIT}" "${SRC_EXIT}" "${RESULT}" "${STATUS}" > "${OUT}/run.json"
# STATUS is the capture; the offline report (full-depth book check, scenarios) can
# disagree with it, so say both. Best effort and bounded: never changes the result.
RLINE=""
if [ -f "${PROJECT_DIR}/scripts/release_watch_report.js" ]; then
    RLINE="$(RELEASE_WATCH_OUT="${OUT_ROOT}" timeout -k 2s 90s node "${PROJECT_DIR}/scripts/release_watch_report.js" "${ID}" "${RUN_ID}" --offline --line 2>/dev/null | tail -1)"
fi
[ -n "${RLINE}" ] || RLINE="report unavailable"
log "${STATUS} | ${ID} | run=${RUN_ID} | ${SRC_LINE} | ${BOOK_LINE} | ${RLINE} | ${PRE}"
send_telegram "[polymarket_bot] release-watch ${ID} ${STATUS} (${RUN_ID}): ${SRC_LINE} | ${BOOK_LINE} | ${RLINE}${PRE:+ | ${PRE}}" || true
FINISHED=1
exit "${RESULT}"
