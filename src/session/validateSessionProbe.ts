import { ProviderError } from '../errors';

/** A single gateway/auth response must not invalidate a cookie shared by all
 * stations. Confirm once at the account's home station; actual shipment calls
 * still enforce Amazon authorization. No credentials or response bodies logged. */
export async function validateSessionProbe(probe: () => Promise<unknown>): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await probe();
      return true;
    } catch (error) {
      if (!(error instanceof ProviderError) || error.code !== 'AMAZON_SESSION_EXPIRED') {
        console.warn('amazon-session-probe', { outcome: 'inconclusive', attempt,
          code: error instanceof ProviderError ? error.code : 'PROBE_ERROR' });
        return true;
      }
      const reason = /404/.test(error.message) ? 'gateway_404'
        : /redirected/.test(error.message) ? 'redirect'
        : /HTML/.test(error.message) ? 'html_response' : 'unauthorized';
      console.warn('amazon-session-probe', { outcome: attempt === 2 ? 'confirmed_invalid' : 'confirmation_required',
        attempt, status: error.status, reason });
      if (attempt === 2) return false;
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }
  return true;
}
