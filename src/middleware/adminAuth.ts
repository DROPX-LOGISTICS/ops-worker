import type { Context, Next } from 'hono';
import type { Env } from '../types';

/**
 * Everything under /api/admin/* (session upload, notifications) is
 * owner-only — it's how the Amazon session cookie gets into the system and
 * how expiry alerts get read back out. Gate it behind a shared secret
 * rather than leaving it open like /api/validate's CORS-only protection.
 */
export async function adminAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const provided = c.req.header('x-admin-key');
  if (!provided || provided !== c.env.ADMIN_API_KEY) {
    return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
  }
  await next();
}