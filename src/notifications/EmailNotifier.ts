import type { Notifier } from './Notifier';
import type { NotificationPayload } from '../types';

const SEVERITY_PREFIX: Record<NotificationPayload['severity'], string> = {
  info: '[Info]',
  warning: '[Warning]',
  critical: '[ACTION NEEDED]',
};

/**
 * Sends the owner an email via Resend (https://resend.com) in addition to
 * the dashboard row. Purely additive — if RESEND_API_KEY / OWNER_NOTIFICATION_EMAIL
 * aren't configured, notifications/factory.ts skips wiring this in at all,
 * so the dashboard notification is never blocked on email delivery.
 */
export class EmailNotifier implements Notifier {
  constructor(
    private readonly apiKey: string,
    private readonly toEmail: string,
    private readonly fromEmail: string,
  ) {}

  async notify(payload: NotificationPayload): Promise<void> {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: [this.toEmail],
          subject: `${SEVERITY_PREFIX[payload.severity]} cash-recon-worker: ${payload.type}`,
          text: `${payload.message}\n\n${payload.meta ? JSON.stringify(payload.meta, null, 2) : ''}`,
        }),
      });
      if (!res.ok) {
        console.error('EmailNotifier.notify: Resend returned', res.status, await res.text().catch(() => ''));
      }
    } catch (err) {
      // Never let email delivery failure surface to the caller.
      console.error('EmailNotifier.notify failed', err);
    }
  }
}