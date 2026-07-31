import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Notifier } from './Notifier';
import type { NotificationPayload } from '../types';

/**
 * Writes to `owner_notifications`. The owner's frontend dashboard polls
 * `GET /api/admin/notifications?unacknowledged=true` to show these.
 */
export class SupabaseNotifier implements Notifier {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  async notify(payload: NotificationPayload): Promise<void> {
    const { error } = await this.client.from('owner_notifications').insert({
      type: payload.type,
      message: payload.message,
      severity: payload.severity,
      meta: payload.meta ?? null,
    });
    if (error) {
      console.error('SupabaseNotifier.notify failed', error);
    }
  }
}