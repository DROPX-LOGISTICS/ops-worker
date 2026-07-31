import type { Context } from 'hono';
import { createClient } from '@supabase/supabase-js';
import type { Env } from '../types';

function client(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

export async function listNotificationsHandler(c: Context<{ Bindings: Env }>) {
  const unacknowledgedOnly = c.req.query('unacknowledged') === 'true';

  let query = client(c.env).from('owner_notifications').select('*').order('created_at', { ascending: false }).limit(50);
  if (unacknowledgedOnly) query = query.eq('acknowledged', false);

  const { data, error } = await query;
  if (error) {
    return c.json({ error: 'Failed to load notifications', code: 'NOTIFICATIONS_READ_FAILED' }, 502);
  }

  return c.json({
    notifications: (data ?? []).map((row) => ({
      id: row.id,
      type: row.type,
      message: row.message,
      severity: row.severity,
      meta: row.meta,
      acknowledged: row.acknowledged,
      createdAt: row.created_at,
    })),
  });
}

export async function acknowledgeNotificationHandler(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id');
  const { error } = await client(c.env).from('owner_notifications').update({ acknowledged: true }).eq('id', id);
  if (error) {
    return c.json({ error: 'Failed to acknowledge notification', code: 'NOTIFICATION_ACK_FAILED' }, 502);
  }
  return c.json({ status: 'acknowledged', id });
}