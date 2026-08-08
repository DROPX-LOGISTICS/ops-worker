import type { Context } from 'hono';
import type { Env } from '../types';
import { ValidationInputError } from '../errors';
import { DEFAULT_PORTAL_ACCOUNT } from '../config';
import {
  createWorkforceAssociateStore,
  createWorkforceSessionStore,
} from '../store/factory';
import {
  ensureWorkforceSession,
  loadWorkforceRosterMap,
  createWorkforceProvider,
} from '../services/workforceRoster';
import { refreshWorkforceSession } from '../session/refreshWorkforceSession';
import {
  getWorkforcePortalCredentials,
  WorkforceLoginStateStore,
} from '../session/workforceCredentials';

function redact(value: string): string {
  if (value.length <= 6) return '*'.repeat(value.length);
  return `${'*'.repeat(value.length - 6)}${value.slice(-6)}`;
}

function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

interface UploadWorkforceSessionBody {
  cookie: string;
  uploadedBy?: string;
  accountKey?: string;
}

/**
 * PUT /api/admin/workforce/session
 * Manual cookie upload fallback when Puppeteer is unavailable.
 */
export async function uploadWorkforceSessionHandler(c: Context<{ Bindings: Env }>) {
  let body: UploadWorkforceSessionBody;
  try {
    body = await c.req.json<UploadWorkforceSessionBody>();
  } catch {
    throw new ValidationInputError('Request body must be valid JSON');
  }

  if (!body?.cookie || typeof body.cookie !== 'string' || !body.cookie.trim()) {
    throw new ValidationInputError('cookie is required (full Cookie request header)');
  }

  const accountKey = body.accountKey?.trim() || DEFAULT_PORTAL_ACCOUNT;
  const store = createWorkforceSessionStore(c.env);
  const stored = await store.upload(body.cookie.trim(), body.uploadedBy || 'unknown', accountKey);

  return c.json({
    status: 'stored',
    id: stored.id,
    accountKey,
    uploadedBy: stored.uploadedBy,
    uploadedAt: stored.uploadedAt,
    cookiePreview: redact(stored.cookie),
    hint: 'Call POST /api/admin/workforce/roster/sync to populate associates cache.',
  });
}

/** GET /api/admin/workforce/session/status */
export async function workforceSessionStatusHandler(c: Context<{ Bindings: Env }>) {
  const accountKey = c.req.query('accountKey')?.trim() || DEFAULT_PORTAL_ACCOUNT;
  const store = createWorkforceSessionStore(c.env);
  const associateStore = createWorkforceAssociateStore(c.env);
  const loginState = new WorkforceLoginStateStore(c.env);
  const latest = await store.getLatest(accountKey);
  const rosterCount = await associateStore.count();
  const rosterSyncedAt = await associateStore.latestSyncedAt();
  const loginPublic = await loginState.getPublic(accountKey);
  const creds = getWorkforcePortalCredentials(c.env);

  const credentials = {
    configured: Boolean(creds),
    emailPreview: creds ? redactEmail(creds.email) : null,
    lastLoginAt: loginPublic.lastLoginAt,
    lastLoginError: loginPublic.lastLoginError,
    loginLocked: loginPublic.loginLocked,
  };

  if (!latest) {
    return c.json({
      status: 'none',
      accountKey,
      message: 'No workforce session yet. Call POST /api/admin/workforce/session/ensure or /refresh.',
      rosterCount,
      rosterSyncedAt,
      credentials,
    });
  }

  return c.json({
    status: latest.status,
    id: latest.id,
    accountKey: latest.accountKey,
    uploadedBy: latest.uploadedBy,
    uploadedAt: latest.uploadedAt,
    expiredAt: latest.expiredAt,
    cookiePreview: redact(latest.cookie),
    rosterCount,
    rosterSyncedAt,
    credentials,
  });
}

/**
 * POST /api/admin/workforce/session/ensure
 * Probe cookie; auto Puppeteer refresh when expired.
 */
export async function ensureWorkforceSessionHandler(c: Context<{ Bindings: Env }>) {
  let accountKey = DEFAULT_PORTAL_ACCOUNT;
  try {
    const body = (await c.req.json()) as { accountKey?: string };
    if (body?.accountKey?.trim()) accountKey = body.accountKey.trim();
  } catch {
    /* empty body ok */
  }

  const result = await ensureWorkforceSession(c.env, accountKey);
  if (!result.ok) {
    const status =
      result.reason === 'NO_SESSION' || result.reason === 'NO_CREDENTIALS'
        ? 404
        : result.reason === 'SESSION_EXPIRED' || result.reason === 'NEEDS_LOCAL_LOGIN'
          ? 401
          : 502;
    return c.json({ status: 'error', ...result, accountKey }, status);
  }

  return c.json({
    status: 'ok',
    accountKey,
    sessionId: result.sessionId,
    associateCount: result.associateCount,
    source: result.source,
  });
}

/**
 * POST /api/admin/workforce/session/refresh
 * Force Puppeteer login (email → Continue → password → Sign in).
 */
export async function refreshWorkforceSessionHandler(c: Context<{ Bindings: Env }>) {
  let accountKey = DEFAULT_PORTAL_ACCOUNT;
  let triggeredBy = 'admin-workforce-refresh';
  try {
    const body = (await c.req.json()) as { accountKey?: string; triggeredBy?: string };
    if (body?.accountKey?.trim()) accountKey = body.accountKey.trim();
    if (body?.triggeredBy?.trim()) triggeredBy = body.triggeredBy.trim();
  } catch {
    /* empty ok */
  }

  const result = await refreshWorkforceSession(c.env, {
    accountKey,
    triggeredBy,
    notifyOnFailure: true,
  });

  if (!result.ok) {
    const status =
      result.code === 'NO_CREDENTIALS'
        ? 404
        : result.code === 'LOGIN_IN_PROGRESS'
          ? 409
          : result.code === 'MFA_REQUIRED' || result.code === 'CAPTCHA_REQUIRED'
            ? 401
            : 502;
    return c.json({ status: 'error', ...result, accountKey }, status);
  }

  return c.json({
    status: 'ok',
    accountKey,
    source: result.source,
    id: result.stored.id,
    uploadedBy: result.stored.uploadedBy,
    uploadedAt: result.stored.uploadedAt,
    cookiePreview: redact(result.stored.cookie),
    hint: 'Call POST /api/admin/workforce/roster/sync to refresh associates cache.',
  });
}

/** POST /api/admin/workforce/roster/sync */
export async function syncWorkforceRosterHandler(c: Context<{ Bindings: Env }>) {
  let accountKey = DEFAULT_PORTAL_ACCOUNT;
  try {
    const body = (await c.req.json()) as { accountKey?: string };
    if (body?.accountKey?.trim()) accountKey = body.accountKey.trim();
  } catch {
    /* empty ok */
  }

  const roster = await loadWorkforceRosterMap(c.env, { forceRefresh: true, accountKey });
  if (roster.source === 'none') {
    return c.json(
      {
        status: 'error',
        code: 'NO_WORKFORCE_DATA',
        message:
          'Could not sync roster. Set WORKFORCE_PORTAL_EMAIL/PASSWORD and call session/ensure, or upload cookies.',
        accountKey,
      },
      401,
    );
  }

  return c.json({
    status: 'ok',
    accountKey,
    source: roster.source,
    count: roster.count,
    syncedAt: roster.syncedAt,
  });
}

/** GET /api/admin/workforce/associates */
export async function listWorkforceAssociatesHandler(c: Context<{ Bindings: Env }>) {
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const statusFilter = (c.req.query('status') ?? '').trim().toUpperCase();
  const limit = Math.min(Number(c.req.query('limit') ?? '100') || 100, 500);

  const store = createWorkforceAssociateStore(c.env);
  let associates = await store.listAll();

  if (statusFilter) {
    associates = associates.filter(
      (a) => (a.operationalStatus ?? '').toUpperCase() === statusFilter,
    );
  }
  if (q) {
    associates = associates.filter(
      (a) =>
        a.fullName.toLowerCase().includes(q) ||
        a.transporterId.toLowerCase().includes(q) ||
        (a.emailAddress ?? '').toLowerCase().includes(q),
    );
  }

  const sliced = associates.slice(0, limit);
  return c.json({
    status: 'ok',
    total: associates.length,
    returned: sliced.length,
    syncedAt: await store.latestSyncedAt(),
    associates: sliced,
  });
}

/** GET /api/admin/workforce/associates/:transporterId */
export async function getWorkforceAssociateHandler(c: Context<{ Bindings: Env }>) {
  const transporterId = c.req.param('transporterId')?.trim();
  if (!transporterId) throw new ValidationInputError('transporterId is required');

  const store = createWorkforceAssociateStore(c.env);
  const map = await store.getByTransporterIds([transporterId]);
  const associate = map.get(transporterId);
  if (!associate) {
    return c.json({ status: 'not_found', transporterId }, 404);
  }
  return c.json({ status: 'ok', associate });
}

export { createWorkforceProvider };
