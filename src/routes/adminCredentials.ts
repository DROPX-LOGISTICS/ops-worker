import type { Context } from 'hono';
import type { Env } from '../types';
import { PortalCredentialStore } from '../store/PortalCredentialStore';
import { ValidationInputError } from '../errors';

interface UpsertCredentialsBody {
  email: string;
  password: string;
  defaultStationCode?: string;
  updatedBy?: string;
}

export async function getCredentialsHandler(c: Context<{ Bindings: Env }>) {
  const store = new PortalCredentialStore(c.env);
  const publicCreds = await store.getPublic();
  return c.json(publicCreds);
}

export async function upsertCredentialsHandler(c: Context<{ Bindings: Env }>) {
  let body: UpsertCredentialsBody;
  try {
    body = await c.req.json<UpsertCredentialsBody>();
  } catch {
    throw new ValidationInputError('Request body must be valid JSON');
  }

  if (!body?.email || typeof body.email !== 'string') {
    throw new ValidationInputError('email is required');
  }
  if (!body?.password || typeof body.password !== 'string') {
    throw new ValidationInputError('password is required');
  }

  const store = new PortalCredentialStore(c.env);
  const stored = await store.upsert(
    body.email.trim(),
    body.password,
    (body.defaultStationCode || c.env.AMAZON_LOGIN_STATION_CODE || 'TIRC').trim().toUpperCase(),
    body.updatedBy || 'josephmathew072@gmail.com',
  );

  return c.json({ status: 'stored', ...stored });
}
