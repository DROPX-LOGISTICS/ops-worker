import type { Notifier } from './Notifier';
import type { NotificationPayload } from '../types';

/** Fans a single notification out to every configured channel, in parallel. */
export class CompositeNotifier implements Notifier {
  constructor(private readonly notifiers: Notifier[]) {}

  async notify(payload: NotificationPayload): Promise<void> {
    await Promise.all(
      this.notifiers.map((n) => n.notify(payload).catch((err) => console.error('Notifier failed', err))),
    );
  }
}