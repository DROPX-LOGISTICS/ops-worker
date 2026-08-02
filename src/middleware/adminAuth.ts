import type { Context, Next } from 'hono';
import type { Env } from '../types';

/**
 * Everything under /api/admin/* (Amazon data fetches, session upload,
 * notifications) is gated behind a shared `x-admin-key` secret.
 */
export async function adminAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const provided = c.req.header('x-admin-key');
  if (!provided || provided !== c.env.ADMIN_API_KEY) {
    return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
  }
  await next();
}