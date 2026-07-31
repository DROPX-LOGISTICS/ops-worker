import type { Context } from 'hono';
import type { Env } from '../types';
import { createCredentialStore } from '../store/factory';
import { ValidationInputError } from '../errors';
import { refreshAmazonSession } from '../session/refreshSession';
import { ensureValidAmazonSession } from '../session/ensureSession';
import { PortalCredentialStore } from '../store/PortalCredentialStore';

interface UploadSessionBody {
  cookie: string;
  xApiUsageKey: string;
  uploadedBy: string;
}

interface RefreshSessionBody {
  triggeredBy?: string;
}

/** Redacts everything but the last 6 chars so status responses are safe to log/render. */
function redact(value: string): string {
  if (value.length <= 6) return '*'.repeat(value.length);
  return `${'*'.repeat(value.length - 6)}${value.slice(-6)}`;
}

export async function uploadSessionHandler(c: Context<{ Bindings: Env }>) {
  let body: UploadSessionBody;
  try {
    body = await c.req.json<UploadSessionBody>();
  } catch {
    throw new ValidationInputError('Request body must be valid JSON');
  }

  if (!body?.cookie || typeof body.cookie !== 'string') {
    throw new ValidationInputError('cookie is required');
  }
  if (!body?.xApiUsageKey || typeof body.xApiUsageKey !== 'string') {
    throw new ValidationInputError('xApiUsageKey is required');
  }

  const store = createCredentialStore(c.env);
  const stored = await store.upload(body.cookie, body.xApiUsageKey, body.uploadedBy || 'unknown');

  return c.json({
    status: 'stored',
    id: stored.id,
    uploadedBy: stored.uploadedBy,
    uploadedAt: stored.uploadedAt,
    cookiePreview: redact(stored.cookie),
    xApiUsageKeyPreview: redact(stored.xApiUsageKey),
  });
}

export async function sessionStatusHandler(c: Context<{ Bindings: Env }>) {
  const store = createCredentialStore(c.env);
  const portalStore = new PortalCredentialStore(c.env);
  const latest = await store.getLatest();
  const credentials = await portalStore.getPublic();

  if (!latest) {
    return c.json({
      status: 'none',
      message: 'No Amazon session has ever been uploaded.',
      credentials,
    });
  }

  return c.json({
    status: latest.status,
    id: latest.id,
    uploadedBy: latest.uploadedBy,
    uploadedAt: latest.uploadedAt,
    expiredAt: latest.expiredAt ?? null,
    cookiePreview: redact(latest.cookie),
    xApiUsageKeyPreview: redact(latest.xApiUsageKey),
    credentials,
  });
}

/**
 * Probe active session; if invalid/missing, auto-login (scrape station only).
 * Local Miniflare without BROWSER returns needsLocalLogin for the dev script.
 */
export async function ensureSessionHandler(c: Context<{ Bindings: Env }>) {
  let triggeredBy = 'admin-ensure';
  try {
    const body = await c.req.json<{ triggeredBy?: string }>();
    if (body?.triggeredBy) triggeredBy = body.triggeredBy;
  } catch {
    /* empty body ok */
  }

  const result = await ensureValidAmazonSession(c.env, { triggeredBy, notifyOnFailure: true });

  if (!result.ok) {
    const status =
      result.code === 'NO_CREDENTIALS' ? 400 : result.code === 'LOGIN_IN_PROGRESS' ? 409 : 503;
    return c.json(
      {
        status: 'failed',
        code: result.code,
        error: result.error,
        needsLocalLogin: Boolean(result.needsLocalLogin),
      },
      status,
    );
  }

  return c.json({
    status: 'ok',
    source: result.source,
    credentialId: result.credentialId,
  });
}

/**
 * Force Puppeteer re-login (scrape station from credentials / AMAZON_LOGIN_STATION_CODE).
 */
export async function refreshSessionHandler(c: Context<{ Bindings: Env }>) {
  let body: RefreshSessionBody = {};
  try {
    body = await c.req.json<RefreshSessionBody>();
  } catch {
    /* empty body ok */
  }

  const result = await refreshAmazonSession(c.env, {
    triggeredBy: body.triggeredBy || 'admin-refresh',
    notifyOnFailure: true,
  });

  if (!result.ok) {
    const status =
      result.code === 'NO_CREDENTIALS' ? 400 : result.code === 'LOGIN_IN_PROGRESS' ? 409 : 502;
    return c.json({ status: 'failed', code: result.code, error: result.error }, status);
  }

  return c.json({
    status: 'refreshed',
    source: result.source,
    id: result.stored.id,
    uploadedBy: result.stored.uploadedBy,
    uploadedAt: result.stored.uploadedAt,
    cookiePreview: redact(result.stored.cookie),
    xApiUsageKeyPreview: redact(result.stored.xApiUsageKey),
  });
}
