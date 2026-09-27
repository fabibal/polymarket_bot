import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sent } = vi.hoisted(() => ({ sent: [] as Array<{ url: string; body: string }> }));

// Capture what would be POSTed to Telegram instead of sending it.
vi.mock('https', () => ({
  default: {
    request: (url: string, _opts: unknown, cb: (res: { statusCode: number; resume: () => void }) => void) => {
      let body = '';
      const req = {
        on: () => req,
        write: (b: string) => { body += b; },
        end: () => { sent.push({ url, body }); cb({ statusCode: 200, resume: () => {} }); },
        destroy: () => {},
      };
      return req;
    },
  },
}));

import { sendTelegramAlert } from '../src/alerts';

const KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'POLYMARKET_TELEGRAM_CHAT_ID'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  sent.length = 0;
  saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('sendTelegramAlert', () => {
  it("posts to the bot's own channel when POLYMARKET_TELEGRAM_CHAT_ID is set", async () => {
    process.env.TELEGRAM_BOT_TOKEN = '123:abc';
    process.env.TELEGRAM_CHAT_ID = '505';
    process.env.POLYMARKET_TELEGRAM_CHAT_ID = '-1001234567890';
    expect(await sendTelegramAlert('hello')).toBe(true);
    expect(JSON.parse(sent[0].body)).toEqual({ chat_id: '-1001234567890', text: '[polymarket_bot] hello' });
  });

  it('falls back to the shared TELEGRAM_CHAT_ID', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '123:abc';
    process.env.TELEGRAM_CHAT_ID = '505';
    expect(await sendTelegramAlert('hi')).toBe(true);
    expect(JSON.parse(sent[0].body).chat_id).toBe('505');
  });

  it('sends nothing without a token', async () => {
    process.env.POLYMARKET_TELEGRAM_CHAT_ID = '-100';
    expect(await sendTelegramAlert('x')).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
