import type { Context } from 'hono';

export function healthHandler(c: Context) {
  return c.json({ status: 'ok', service: 'cash-recon-worker', time: new Date().toISOString() });
}
