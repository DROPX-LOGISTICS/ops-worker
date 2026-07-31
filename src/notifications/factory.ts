import type { Env } from '../types';
import type { Notifier } from './Notifier';
import { SupabaseNotifier } from './SupabaseNotifier';
import { EmailNotifier } from './EmailNotifier';
import { CompositeNotifier } from './CompositeNotifier';

/**
 * Single place that decides which notification channels are active. The
 * dashboard row (SupabaseNotifier) is always on — it's the source of truth
 * the owner frontend reads. Email is additive and only wired in when
 * RESEND_API_KEY + OWNER_NOTIFICATION_EMAIL are both set as secrets/vars.
 * Add a new case (Slack webhook, SMS, etc.) the same way.
 */
export function createNotifier(env: Env): Notifier {
  const channels: Notifier[] = [new SupabaseNotifier(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)];

  if (env.RESEND_API_KEY && env.OWNER_NOTIFICATION_EMAIL) {
    channels.push(
      new EmailNotifier(env.RESEND_API_KEY, env.OWNER_NOTIFICATION_EMAIL, env.NOTIFICATION_FROM_EMAIL ?? 'ops@yourdomain.com'),
    );
  }

  return new CompositeNotifier(channels);
}