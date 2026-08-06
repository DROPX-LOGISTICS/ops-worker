import type { Context } from 'hono';
import type { Env, ValidateRequestBody, AmazonAuthContext } from '../types';
import { runValidationPipeline } from '../services/validationPipeline';
import { createStationDataProvider } from '../providers/factory';
import { createOverrideStore, createCredentialStore } from '../store/factory';
import { createNotifier } from '../notifications/factory';
import { ValidationInputError, ProviderError } from '../errors';
import { ensureValidAmazonSession } from '../session/ensureSession';
import { refreshAmazonSession } from '../session/refreshSession';

/**
 * Frontend sends stationCode for the station being validated.
 * Session cookie is shared; scrape-station is only used during login capture.
 */
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

  let auth = body.auth;
  let credentialId: string | undefined;
  let usedStoredSession = false;

  if (!auth) {
    const ensured = await ensureValidAmazonSession(c.env, {
      triggeredBy: `validate:${body.stationCode}`,
      notifyOnFailure: true,
      stationCode: body.stationCode,
    });

    if (!ensured.ok) {
      throw new ValidationInputError(
        `Amazon session unavailable (${ensured.code}): ${ensured.error}`,
        ensured.needsLocalLogin ? 'NEEDS_LOCAL_LOGIN' : ensured.code,
      );
    }

    auth = ensured.auth;
    credentialId = ensured.credentialId;
    usedStoredSession = true;
  }

  try {
    const result = await runValidationPipeline({ ...body, auth }, provider, overrideStore, c.env);
    return c.json(result, result.status === 'passed' ? 200 : 409);
  } catch (firstErr) {
    if (!(firstErr instanceof ProviderError) || firstErr.code !== 'AMAZON_SESSION_EXPIRED') {
      throw firstErr;
    }

    if (credentialId) {
      await credentialStore.markExpired(credentialId).catch((e) => console.error('markExpired failed', e));
    }

    if (usedStoredSession && !body.auth) {
      const refreshed = await refreshAmazonSession(c.env, {
        triggeredBy: `validate-retry:${body.stationCode}`,
        notifyOnFailure: true,
        stationCode: body.stationCode,
      });

      if (refreshed.ok) {
        const retryAuth: AmazonAuthContext = {
          cookie: refreshed.stored.cookie,
          xApiUsageKey: refreshed.stored.xApiUsageKey,
        };
        try {
          const result = await runValidationPipeline(
            { ...body, auth: retryAuth },
            provider,
            overrideStore,
            c.env,
          );
          return c.json(result, result.status === 'passed' ? 200 : 409);
        } catch (retryErr) {
          await notifyExpired(notifier, body, retryErr);
          throw retryErr;
        }
      }
    }

    await notifyExpired(notifier, body, firstErr);
    throw firstErr;
  }
}

async function notifyExpired(
  notifier: ReturnType<typeof createNotifier>,
  body: ValidateRequestBody,
  err: unknown,
): Promise<void> {
  await notifier
    .notify({
      type: 'AMAZON_SESSION_EXPIRED',
      severity: 'critical',
      message: `Amazon session expired while validating station ${body.stationCode} for ${body.date}. Auto-login was attempted; check credentials if this persists.`,
      meta: {
        stationCode: body.stationCode,
        date: body.date,
        httpStatus: err instanceof ProviderError ? err.status : undefined,
      },
    })
    .catch((e) => console.error('notify failed', e));
}
