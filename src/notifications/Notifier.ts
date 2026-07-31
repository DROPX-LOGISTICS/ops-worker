import type { NotificationPayload } from '../types';

/**
 * Anything that can tell the owner something needs attention (session
 * expired, etc.). `notify` must never throw in a way that's allowed to
 * break the request that triggered it — callers should treat failures as
 * best-effort and log rather than propagate.
 */
export interface Notifier {
  notify(payload: NotificationPayload): Promise<void>;
}