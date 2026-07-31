import type { Context } from 'hono';
import type { Env } from '../types';
import { createCredentialStore } from '../store/factory';
import { ValidationInputError } from '../errors';

interface UploadSessionBody {
  cookie: string;
  xApiUsageKey: string;
  uploadedBy: string;
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
  const latest = await store.getLatest();

  if (!latest) {
    return c.json({ status: 'none', message: 'No Amazon session has ever been uploaded.' });
  }

  return c.json({
    status: latest.status,
    id: latest.id,
    uploadedBy: latest.uploadedBy,
    uploadedAt: latest.uploadedAt,
    expiredAt: latest.expiredAt ?? null,
    cookiePreview: redact(latest.cookie),
    xApiUsageKeyPreview: redact(latest.xApiUsageKey),
  });
}