import type { Context } from 'hono';
import type { Env } from '../types';
import { createCredentialStore } from '../store/factory';
import { ValidationInputError } from '../errors';
import { refreshAmazonSession } from '../session/refreshSession';
import { ensureValidAmazonSession } from '../session/ensureSession';
import { PortalCredentialStore } from '../store/PortalCredentialStore';
import { DEFAULT_PORTAL_ACCOUNT, portalAccountKeyForStation } from '../config';

interface UploadSessionBody {
  cookie: string;
  xApiUsageKey: string;
  uploadedBy: string;
  /** Portal account / station for dedicated logins (KDJG, JUGF, AWEZ, KGQE, HBSC). */
  accountKey?: string;
  stationCode?: string;
}

interface RefreshSessionBody {
  triggeredBy?: string;
  stationCode?: string;
  accountKey?: string;
}

/** Redacts everything but the last 6 chars so status responses are safe to log/render. */
function redact(value: string): string {
  if (value.length <= 6) return '*'.repeat(value.length);
  return `${'*'.repeat(value.length - 6)}${value.slice(-6)}`;
}

function resolveAccountKey(body: { accountKey?: string; stationCode?: string }): string {
  if (body.accountKey?.trim()) return body.accountKey.trim();
  if (body.stationCode?.trim()) return portalAccountKeyForStation(body.stationCode);
  return DEFAULT_PORTAL_ACCOUNT;
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

  const accountKey = resolveAccountKey(body);
  const store = createCredentialStore(c.env);
  const stored = await store.upload(
    body.cookie,
    body.xApiUsageKey,
    body.uploadedBy || 'unknown',
    accountKey,
  );

  return c.json({
    status: 'stored',
    id: stored.id,
    accountKey,
    uploadedBy: stored.uploadedBy,
    uploadedAt: stored.uploadedAt,
    cookiePreview: redact(stored.cookie),
    xApiUsageKeyPreview: redact(stored.xApiUsageKey),
  });
}

export async function sessionStatusHandler(c: Context<{ Bindings: Env }>) {
  const accountKey = resolveAccountKey({
    accountKey: c.req.query('accountKey') || undefined,
    stationCode: c.req.query('stationCode') || undefined,
  });
  const store = createCredentialStore(c.env);
  const portalStore = new PortalCredentialStore(c.env);
  const latest = await store.getLatest(accountKey);
  const credentials = await portalStore.getPublic(accountKey);
  const accounts = await portalStore.listPublic();

  if (!latest) {
    return c.json({
      status: 'none',
      accountKey,
      message: `No Amazon session has ever been uploaded for account "${accountKey}".`,
      credentials,
      accounts,
    });
  }

  return c.json({
    status: latest.status,
    id: latest.id,
    accountKey: latest.accountKey ?? accountKey,
    uploadedBy: latest.uploadedBy,
    uploadedAt: latest.uploadedAt,
    expiredAt: latest.expiredAt ?? null,
    cookiePreview: redact(latest.cookie),
    xApiUsageKeyPreview: redact(latest.xApiUsageKey),
    credentials,
    accounts,
  });
}

/**
 * Probe active session; if invalid/missing, auto-login for the resolved account.
 */
export async function ensureSessionHandler(c: Context<{ Bindings: Env }>) {
  let triggeredBy = 'admin-ensure';
  let stationCode: string | undefined;
  let accountKey: string | undefined;
  try {
    const body = await c.req.json<{ triggeredBy?: string; stationCode?: string; accountKey?: string }>();
    if (body?.triggeredBy) triggeredBy = body.triggeredBy;
    stationCode = body?.stationCode;
    accountKey = body?.accountKey;
  } catch {
    /* empty body ok */
  }

  const result = await ensureValidAmazonSession(c.env, {
    triggeredBy,
    notifyOnFailure: true,
    stationCode: stationCode || accountKey,
  });

  if (!result.ok) {
    const status =
      result.code === 'NO_CREDENTIALS' ? 400 : result.code === 'LOGIN_IN_PROGRESS' ? 409 : 503;
    return c.json(
      {
        status: 'failed',
        code: result.code,
        error: result.error,
        accountKey: result.accountKey,
        needsLocalLogin: Boolean(result.needsLocalLogin),
      },
      status,
    );
  }

  return c.json({
    status: 'ok',
    source: result.source,
    credentialId: result.credentialId,
    accountKey: result.accountKey,
  });
}

/**
 * Force Puppeteer re-login for the resolved portal account.
 */
export async function refreshSessionHandler(c: Context<{ Bindings: Env }>) {
  let body: RefreshSessionBody = {};
  try {
    body = await c.req.json<RefreshSessionBody>();
  } catch {
    /* empty body ok */
  }

  const accountKey = resolveAccountKey(body);
  const result = await refreshAmazonSession(c.env, {
    triggeredBy: body.triggeredBy || 'admin-refresh',
    notifyOnFailure: true,
    stationCode: body.stationCode,
    accountKey,
  });

  if (!result.ok) {
    const status =
      result.code === 'NO_CREDENTIALS' ? 400 : result.code === 'LOGIN_IN_PROGRESS' ? 409 : 502;
    return c.json(
      { status: 'failed', code: result.code, error: result.error, accountKey: result.accountKey },
      status,
    );
  }

  return c.json({
    status: 'refreshed',
    source: result.source,
    accountKey: result.accountKey,
    id: result.stored.id,
    uploadedBy: result.stored.uploadedBy,
    uploadedAt: result.stored.uploadedAt,
    cookiePreview: redact(result.stored.cookie),
    xApiUsageKeyPreview: redact(result.stored.xApiUsageKey),
  });
}
