#!/usr/bin/env bash
# RETIRED 2026-09-27: no longer in crontab -- replaced by weekly-lowfreq-scan.sh
# (docs/decisions.md "Falcon macro scan and its key alert retired"). Kept for manual runs.
#
# Weekly macro trader discovery scan.
#
# 1. Refreshes Falcon enrichment for cached traders (macro_scan.js section C).
# 2. Runs 90d on-chain macro scan (macro_scan_90d.js).
# 3. Parses candidates (avg_hold>=48h, t/wk<20, WR>60%, closed>=10, pnl>0,
#    not on watchlist, not excluded), enriches with Sharpe from
#    tracked_traders, and sends a Telegram summary.
#
# Does NOT auto-add to watchlist — manual review only.
#
# Cron: 0 4 * * 1 ~/polymarket_bot/scripts/weekly-macro-scan.sh
# Test: ./weekly-macro-scan.sh           (sends real Telegram message)
#
# Telegram creds: ~/.env.shared (cross-project, chmod 600).
# Logs:           ~/polymarket_bot/logs/weekly-macro-scan.log (last 200 lines)

set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHARED_ENV="${HOME}/.env.shared"
CONTAINER="polymarket_bot"
LOG_DIR="${PROJECT_DIR}/logs"
LOG_FILE="${LOG_DIR}/weekly-macro-scan.log"
RAW_DIR="${LOG_DIR}/weekly-macro-scan-runs"
TS="$(date -u +'%F %T') UTC"
RUN_ID="$(date -u +'%Y%m%dT%H%M%SZ')"
RAW_FALCON="${RAW_DIR}/${RUN_ID}-falcon.log"
RAW_SCAN="${RAW_DIR}/${RUN_ID}-scan90d.log"

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
    echo "[polymarket_bot] weekly-macro-scan.sh CANNOT ALERT: ${reason}" >&2
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
    send_telegram "🚨 [polymarket_bot] weekly-macro-scan: container ${CONTAINER} not running — skipped."
    exit 1
fi

# ----- Sync latest script copies into container -----------------------------
# scripts/ is COPY'd at image build, but we want the live versions so edits
# don't require a rebuild before they take effect.
for f in macro_scan.js macro_scan_90d.js; do
    docker cp "${PROJECT_DIR}/scripts/${f}" "${CONTAINER}:/app/scripts/${f}" 2>/dev/null \
        || { echo "${TS} | ERROR | docker_cp_failed | file=${f}" >> "${LOG_FILE}"; send_telegram "🚨 [polymarket_bot] weekly-macro-scan: docker cp ${f} failed"; exit 1; }
done

# ----- Step 1: Falcon enrichment (updates tracked_traders + watchlist) ------
echo "${TS} | START | step=falcon_enrichment" >> "${LOG_FILE}"
if ! docker exec "${CONTAINER}" node /app/scripts/macro_scan.js > "${RAW_FALCON}" 2>&1; then
    echo "${TS} | ERROR | falcon_enrichment_failed | log=${RAW_FALCON}" >> "${LOG_FILE}"
    send_telegram "🚨 [polymarket_bot] weekly-macro-scan: macro_scan.js (falcon enrichment) failed. See ${RAW_FALCON}."
    exit 1
fi
FALCON_UPD="$(grep -oE 'updated rows: tracked_traders=[0-9]+, watchlist_traders=[0-9]+' "${RAW_FALCON}" | tail -n1)"
echo "${TS} | OK    | step=falcon_enrichment | ${FALCON_UPD:-no_update_line}" >> "${LOG_FILE}"

# ----- Step 2: 90d macro scan -----------------------------------------------
echo "${TS} | START | step=macro_scan_90d" >> "${LOG_FILE}"
if ! docker exec "${CONTAINER}" node /app/scripts/macro_scan_90d.js > "${RAW_SCAN}" 2>&1; then
    echo "${TS} | ERROR | macro_scan_90d_failed | log=${RAW_SCAN}" >> "${LOG_FILE}"
    send_telegram "🚨 [polymarket_bot] weekly-macro-scan: macro_scan_90d.js failed. See ${RAW_SCAN}."
    exit 1
fi

# Header line in scan output:
#   [scan] cached=N, watchlist=W, excluded=E
SCANNED="$(grep -oE '\[scan\] cached=[0-9]+' "${RAW_SCAN}" | head -n1 | grep -oE '[0-9]+$')"
SCANNED="${SCANNED:-?}"

# Candidate table starts at the line with "tr=" subset header or address rows
# right after the "==========" header. Match address lines (40-hex prefixed).
# Format from macro_scan_90d.js:
#   {addr}    {on7d}  {tr90}  {t/wk}  {closed}  {hold_d}   {>48h}  {>7d}  {wr}  {pnl}
# We capture only the top-section lines (before the "subset NOT on 7d" header).
CANDIDATES_RAW="$(awk '
    /^========== MACRO CANDIDATES/             { in_top=1; next }
    /^--- subset NOT on 7d/                    { in_top=0 }
    in_top && /^0x[0-9a-f]{40}/ && ($5+0)>=10  { print }
' "${RAW_SCAN}")"

CANDIDATE_COUNT="$(printf '%s\n' "${CANDIDATES_RAW}" | grep -c '^0x' || true)"

# ----- Build Telegram message -----------------------------------------------
# Zero-candidate runs log silently (no Telegram spam); only candidate-found
# runs alert.
if [ "${CANDIDATE_COUNT}" -eq 0 ]; then
    echo "${TS} | SILENT | candidates=0 | scanned=${SCANNED} | ${FALCON_UPD:-}" >> "${LOG_FILE}"
    MSG=""
else
    # Take top 5, enrich each with Sharpe from tracked_traders (read inside
    # container; DB is root-owned on host).
    TOP="$(printf '%s\n' "${CANDIDATES_RAW}" | head -n 5)"
    LINES=""
    while IFS= read -r row; do
        [ -z "${row}" ] && continue
        addr="$(echo "${row}" | awk '{print $1}')"
        # Cols: addr on7 tr90 t/wk closed hold_d >48h >7d wr pnl
        hold_d="$(echo "${row}" | awk '{print $6}')"
        wr="$(echo "${row}" | awk '{print $9}')"
        pnl="$(echo "${row}" | awk '{print $10}')"
        # Container has no sqlite3 CLI; query via the better-sqlite3 module instead.
        sharpe="$(docker exec "${CONTAINER}" node -e '
            const db = require("better-sqlite3")("/app/data/store.db", { readonly: true });
            const r = db.prepare("SELECT COALESCE(falcon_sharpe,0) s FROM tracked_traders WHERE lower(address)=? LIMIT 1").get(process.argv[1]);
            process.stdout.write(r ? r.s.toFixed(2) : "");
        ' "${addr}" 2>/dev/null)"
        [ -z "${sharpe}" ] && sharpe="n/a"
        short="${addr:0:10}...${addr: -4}"
        LINES="${LINES}
${short}  WR=${wr}  hold=${hold_d}d  PNL=\$${pnl}  Sharpe=${sharpe}"
    done <<< "${TOP}"
    MSG="🔍 [polymarket_bot] Weekly macro scan: ${CANDIDATE_COUNT} candidate(s) found (scanned=${SCANNED}).
Top $(printf '%s\n' "${TOP}" | wc -l):${LINES}

Review manually before adding to watchlist. Full log: ${RAW_SCAN}"
fi

# ----- Send + log -----------------------------------------------------------
if [ -n "${MSG}" ]; then
    if send_telegram "${MSG}"; then
        echo "${TS} | SENT  | candidates=${CANDIDATE_COUNT} | scanned=${SCANNED} | ${FALCON_UPD:-}" >> "${LOG_FILE}"
    else
        echo "${TS} | SEND_FAILED | candidates=${CANDIDATE_COUNT}" >> "${LOG_FILE}"
    fi
fi

# ----- Trim app log to last 200 lines, prune raw run logs older than 30d ----
if [ -f "${LOG_FILE}" ]; then
    tmp="$(mktemp)"
    tail -n 200 "${LOG_FILE}" > "${tmp}" && mv "${tmp}" "${LOG_FILE}"
fi
find "${RAW_DIR}" -type f -mtime +30 -delete 2>/dev/null || true

exit 0
