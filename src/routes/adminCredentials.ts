import type { Context } from 'hono';
import type { Env } from '../types';
import { PortalCredentialStore } from '../store/PortalCredentialStore';
import { ValidationInputError } from '../errors';
import {
  DEFAULT_PORTAL_ACCOUNT,
  STATION_PORTAL_ACCOUNT,
  portalAccountKeyForStation,
} from '../config';

interface UpsertCredentialsBody {
  email: string;
  password: string;
  /** Portal account key. Use station code for dedicated accounts (KDJG, JUGF, AWEZ, KGQE, HBSC). */
  accountKey?: string;
  /** Station used during login scrape. Defaults to accountKey for dedicated accounts. */
  defaultStationCode?: string;
  updatedBy?: string;
}

export async function getCredentialsHandler(c: Context<{ Bindings: Env }>) {
  const store = new PortalCredentialStore(c.env);
  const accountKey = (c.req.query('accountKey') || '').trim();
  if (accountKey) {
    const publicCreds = await store.getPublic(accountKey);
    return c.json(publicCreds);
  }

  const accounts = await store.listPublic();
  return c.json({
    accounts,
    dedicatedStations: STATION_PORTAL_ACCOUNT,
    defaultAccountKey: DEFAULT_PORTAL_ACCOUNT,
  });
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

  const accountKey = (body.accountKey || DEFAULT_PORTAL_ACCOUNT).trim() || DEFAULT_PORTAL_ACCOUNT;
  const defaultStation =
    (body.defaultStationCode ||
      (accountKey !== DEFAULT_PORTAL_ACCOUNT ? accountKey : c.env.AMAZON_LOGIN_STATION_CODE) ||
      'TIRC')
      .trim()
      .toUpperCase();

  const store = new PortalCredentialStore(c.env);
  const stored = await store.upsert(
    body.email.trim(),
    body.password,
    defaultStation,
    body.updatedBy || 'josephmathew072@gmail.com',
    accountKey,
  );

  return c.json({
    status: 'stored',
    resolvedAccountKey: portalAccountKeyForStation(defaultStation),
    ...stored,
  });
}
