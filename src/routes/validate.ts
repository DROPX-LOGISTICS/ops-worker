import type { Context } from 'hono';
import type { Env, ValidateRequestBody } from '../types';
import { runValidationPipeline } from '../services/validationPipeline';
import { createStationDataProvider } from '../providers/factory';
import { createOverrideStore, createCredentialStore } from '../store/factory';
import { createNotifier } from '../notifications/factory';
import { ValidationInputError, ProviderError } from '../errors';

export async function validateHandler(c: Context<{ Bindings: Env }>) {
  let body: ValidateRequestBody;
  try {
    body = await c.req.json<ValidateRequestBody>();
  } catch {
    throw new ValidationInputError('Request body must be valid JSON');
  }

  const provider = createStationDataProvider(c.env);
  const overrideStore = createOverrideStore(c.env);
  const credentialStore = createCredentialStore(c.env);
  const notifier = createNotifier(c.env);

  // The frontend can still pass `auth` explicitly for a one-off call, but
  // normally it won't have to — the owner uploads a session once via
  // POST /api/admin/session and every /api/validate call reuses it.
  let auth = body.auth;
  let credentialId: string | undefined;
  if (!auth) {
    const stored = await credentialStore.getActive();
    if (!stored) {
      throw new ValidationInputError(
        'No Amazon session on file. Ask the owner to upload one via POST /api/admin/session.',
        'NO_STORED_SESSION',
      );
    }
    auth = { cookie: stored.cookie, xApiUsageKey: stored.xApiUsageKey };
    credentialId = stored.id;
  }

  try {
    const result = await runValidationPipeline({ ...body, auth }, provider, overrideStore, c.env);
    return c.json(result, result.status === 'passed' ? 200 : 409);
  } catch (err) {
    if (err instanceof ProviderError && err.code === 'AMAZON_SESSION_EXPIRED') {
      // Best-effort side effects — never let these mask the original error.
      if (credentialId) {
        await credentialStore.markExpired(credentialId).catch((e) => console.error('markExpired failed', e));
      }
      await notifier
        .notify({
          type: 'AMAZON_SESSION_EXPIRED',
          severity: 'critical',
          message: `Amazon station-portal session expired/invalid (HTTP ${err.status}) while validating station ${body.stationCode} for ${body.date}. Please re-login to the station portal and re-upload the session.`,
          meta: { stationCode: body.stationCode, date: body.date, httpStatus: err.status },
        })
        .catch((e) => console.error('notify failed', e));
    }
    throw err;
  }
}