/**
 * Data API v2 helpers for the scripts (v1 was retired: HTTP 410 since 2026-11-02).
 *
 * v2 differences the scripts care about:
 *   - rows are snake_case inside `{data: [...], pagination: {has_more, next_cursor}}`
 *   - paging is cursor-only (`offset` -> HTTP 400), no depth cap, `limit` max 1000
 *   - positions filter is `condition=` (not `market=`); closed positions are
 *     `/positions?status=CLOSED` (no /closed-positions)
 *   - `/trades` is taker-only unless `takerOnly=false`
 * The adapters below add the v1 camelCase names next to the v2 ones, so the
 * scripts' analysis code (and their on-disk caches) keep their v1 field names.
 */
const V2 = 'https://data-api.polymarket.com/v2';

/** Rows of a v2 envelope; throws on anything else (e.g. a v1-shaped array). */
function rowsOf(body) {
  if (!body || !Array.isArray(body.data)) throw new Error('unexpected Data API v2 response (no data array)');
  return body.data;
}

/** The v2 `next_cursor` while more pages exist, else null. */
function nextCursor(body) {
  const p = body && body.pagination;
  return p && p.has_more === true && typeof p.next_cursor === 'string' && p.next_cursor ? p.next_cursor : null;
}

/** `url` with `cursor` appended (url must already carry a query string). */
function withCursor(url, cursor) {
  return cursor ? `${url}&cursor=${encodeURIComponent(cursor)}` : url;
}

/**
 * Walk a v2 listing by cursor. `getBody(url)` returns the parsed JSON body.
 * `url` already has its query string including `limit`. Stops when there is no
 * next page, `maxRows` rows are collected, or `stop(pageRows)` returns true.
 * Returns { rows, more } where `more` says another page existed when it stopped.
 */
async function collect(getBody, url, { maxRows = Infinity, stop = null } = {}) {
  const rows = [];
  let cursor = null;
  for (;;) {
    const body = await getBody(withCursor(url, cursor));
    const page = rowsOf(body);
    rows.push(...page);
    cursor = nextCursor(body);
    if (!cursor) return { rows, more: false };
    if (rows.length >= maxRows || (stop && stop(page))) return { rows, more: true };
  }
}

/** Activity and trade rows -> v1 names (added alongside the v2 ones). */
function v1Activity(r) {
  return {
    ...r,
    proxyWallet: r.proxy_wallet,
    conditionId: r.condition_id,
    transactionHash: r.transaction_hash,
    usdcSize: r.usdc_size,
    asset: r.token_id,
    outcomeIndex: r.outcome_index,
    eventSlug: r.event_slug,
  };
}

/**
 * Position rows -> v1 names. `size`/`cashPnl` describe the held position
 * (current_size, unrealized_pnl); for CLOSED rows `timestamp` is the last event
 * (the v1 /closed-positions closing time) and `realizedPnl` the realised PnL.
 */
function v1Position(r) {
  return {
    ...r,
    conditionId: r.condition_id,
    asset: r.token_id,
    outcomeIndex: r.outcome_index,
    size: r.current_size,
    avgPrice: r.avg_price,
    initialValue: r.entry_cost_usdc,
    currentValue: r.current_value,
    curPrice: r.current_price,
    cashPnl: r.unrealized_pnl,
    realizedPnl: r.realized_pnl,
    percentPnl: r.percent_pnl,
    timestamp: r.last_event_at,
    endDate: r.end_date,
  };
}

/** Leaderboard rows -> v1 names (`vol` was the v1 volume key). */
function v1Leaderboard(r) {
  return { ...r, proxyWallet: r.user_id, userName: r.user_name, vol: r.volume };
}

module.exports = { V2, rowsOf, nextCursor, withCursor, collect, v1Activity, v1Position, v1Leaderboard };
