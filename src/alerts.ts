/**
 * Telegram alerting. Credentials come from ~/.env.shared on the host, injected
 * into the container via `env_file` in docker-compose.yml (TELEGRAM_BOT_TOKEN,
 * TELEGRAM_CHAT_ID). Messages use the "[polymarket_bot]" prefix so they group
 * separately from paper_trader in the shared chat.
 *
 * Fire-and-forget: a missing config or a failed send only logs — alerting must
 * never break the trading loop.
 */
import https from 'https';

export function sendTelegramAlert(message: string): Promise<boolean> {
  const token  = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const chatId = process.env.TELEGRAM_CHAT_ID ?? '';
  if (!token || !chatId) {
    console.warn('[alerts] Telegram not configured (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing) — alert not sent:', message);
    return Promise.resolve(false);
  }

  const body = JSON.stringify({ chat_id: chatId, text: `[polymarket_bot] ${message}` });
  return new Promise(resolve => {
    const req = https.request(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 10_000 },
      res => {
        res.resume(); // drain
        const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
        if (!ok) console.error(`[alerts] Telegram send failed: HTTP ${res.statusCode}`);
        resolve(ok);
      },
    );
    req.on('error', err => { console.error('[alerts] Telegram send error:', err.message); resolve(false); });
    req.on('timeout', () => { req.destroy(); console.error('[alerts] Telegram send timeout'); resolve(false); });
    req.write(body);
    req.end();
  });
}
