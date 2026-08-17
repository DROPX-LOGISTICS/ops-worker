import type { Context } from 'hono';
import { createClient } from '@supabase/supabase-js';
import type { Env } from '../types';

/**
 * Every table this Worker reads or writes, in the same order as
 * sql/company-cutover.sql. Keep the two in sync when adding a store.
 */
export const REQUIRED_TABLES = [
  'validation_runs',
  'validation_overrides',
  'amazon_sessions',
  'owner_notifications',
  'amazon_portal_credentials',
  'workforce_sessions',
  'workforce_associates',
  'workforce_login_state',
  'cia_snapshot_runs',
  'cia_station_snapshots',
  'api_response_cache',
] as const;

/** Tables without which Cash In Associate cannot serve or build a snapshot. */
export const CIA_TABLES = ['cia_snapshot_runs', 'cia_station_snapshots'] as const;

export interface TableProbe {
  table: string;
  exists: boolean;
  rows: number | null;
  error: string | null;
}

/**
 * Identifies which Supabase project the Worker is pointed at without exposing
 * the service-role key — the host's first label is the project ref.
 */
export function supabaseProjectRef(url: string): string | null {
  try {
    return new URL(url).hostname.split('.')[0] || null;
  } catch {
    return null;
  }
}

/**
 * PGRST205 is PostgREST's "unknown table" (also raised when its schema cache is
 * stale after a migration); 42P01 is Postgres' undefined_table.
 */
function isUndefinedTable(code: string, message: string) {
  return code === '42P01' || code === 'PGRST205' || /does not exist|schema cache/i.test(message);
}

/**
 * Counts rows per table. Deliberately a GET (`limit(1)`) rather than a HEAD
 * count: PostgREST sends no body on a HEAD failure, so supabase-js surfaces
 * `error: null` with a null count and a missing table looks like an empty one.
 */
export async function probeTables(env: Env, tables: readonly string[]): Promise<TableProbe[]> {
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  return Promise.all(
    tables.map(async (table): Promise<TableProbe> => {
      const { count, error } = await client.from(table).select('*', { count: 'exact' }).limit(1);
      if (error) {
        const code = String(error.code ?? '');
        const message = String(error.message ?? 'unknown error');
        return {
          table,
          exists: !isUndefinedTable(code, message),
          rows: null,
          error: code ? `${code}: ${message}` : message,
        };
      }
      return { table, exists: true, rows: count, error: null };
    }),
  );
}

/** True when both CIA tables are present, so a snapshot can be read or written. */
export async function isCiaSchemaReady(env: Env): Promise<boolean> {
  try {
    const probes = await probeTables(env, CIA_TABLES);
    return probes.every((probe) => probe.exists);
  } catch {
    // A transport failure is not proof of a missing table; let the caller fall
    // back to its normal "no snapshot" answer.
    return true;
  }
}

/**
 * GET /api/admin/diag/db
 * Reports which Supabase project this Worker talks to and whether every
 * required table exists. Distinguishes "database not migrated" from
 * "migrated but empty", which the feature endpoints cannot express.
 */
export async function dbDiagHandler(c: Context<{ Bindings: Env }>) {
  const url = c.env.SUPABASE_URL ?? '';
  const key = c.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  if (!url || !key) {
    return c.json(
      {
        ok: false,
        code: 'SUPABASE_NOT_CONFIGURED',
        message: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set on this Worker.',
        projectRef: null,
      },
      503,
    );
  }

  let tables: TableProbe[];
  try {
    tables = await probeTables(c.env, REQUIRED_TABLES);
  } catch (error) {
    return c.json(
      {
        ok: false,
        code: 'SUPABASE_UNREACHABLE',
        message: error instanceof Error ? error.message : 'Could not reach Supabase.',
        projectRef: supabaseProjectRef(url),
      },
      502,
    );
  }

  const missingTables = tables.filter((t) => !t.exists).map((t) => t.table);
  const unreadable = tables.filter((t) => t.exists && t.error).map((t) => t.table);
  const schemaReady = missingTables.length === 0 && unreadable.length === 0;
  const ciaRuns = tables.find((t) => t.table === 'cia_snapshot_runs')?.rows ?? null;

  let latestCiaRun: Record<string, unknown> | null = null;
  let latestCiaRunError: string | null = null;
  if (schemaReady) {
    try {
      const client = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      });
      const { data, error } = await client
        .from('cia_snapshot_runs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        latestCiaRunError = `${error.code ?? ''}: ${error.message}`.trim();
      } else {
        latestCiaRun = (data as Record<string, unknown> | null) ?? null;
      }
    } catch (error) {
      latestCiaRunError = error instanceof Error ? error.message : String(error);
    }
  }

  return c.json(
    {
      ok: schemaReady,
      projectRef: supabaseProjectRef(url),
      schemaReady,
      missingTables,
      unreadableTables: unreadable,
      ciaSnapshotRuns: ciaRuns,
      latestCiaRun,
      latestCiaRunError,
      tables,
      hint: schemaReady
        ? ciaRuns === 0
          ? 'Schema is ready but no snapshot has run yet. POST /api/admin/executive/cash-in-associate/refresh or wait for the 06:00 IST cron.'
          : 'Schema is ready.'
        : "Run sql/company-cutover.sql in this Supabase project, then run \"notify pgrst, 'reload schema';\" so PostgREST picks the tables up.",
    },
    schemaReady ? 200 : 503,
  );
}
