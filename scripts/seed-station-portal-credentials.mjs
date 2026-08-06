/**
 * One-time seed for dedicated-station Amazon portal accounts.
 *
 * Preferred (avoids PostgREST cache issues):
 *   Run sql/seed-station-portal-credentials.sql in Supabase SQL editor.
 *
 * Optional Node path (needs schema cache up to date):
 *   node scripts/seed-station-portal-credentials.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function loadDevVars() {
  const path = resolve(process.cwd(), '.dev.vars');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDevVars();

const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const projectHost = new URL(url).host;
console.log(`Using Supabase project: ${projectHost}`);

/** Dedicated stations that cannot use the default portal user. */
const ACCOUNTS = [
  {
    account_key: 'KDJG',
    email: 'xguptapr@amazon.com',
    password: 'KDJG@12345',
    default_station_code: 'KDJG',
  },
  {
    account_key: 'JUGF',
    email: 'pattbije@amazon.com',
    password: 'JUGF@123',
    default_station_code: 'JUGF',
  },
  {
    account_key: 'AWEZ',
    email: 'yadukrps@amazon.com',
    password: 'DROPX@321',
    default_station_code: 'AWEZ',
  },
  {
    account_key: 'KGQE',
    email: 'mbibinv@amazon.com',
    password: 'Kgqe@123',
    default_station_code: 'KGQE',
  },
];

async function diagnoseSchema() {
  // Ask PostgREST what it currently knows about the table.
  const res = await fetch(`${url}/rest/v1/amazon_portal_credentials?select=*&limit=0`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    },
  });
  const body = await res.text();
  console.log(`Schema probe HTTP ${res.status}: ${body.slice(0, 300) || '(empty)'}`);

  // OpenAPI definition (column names appear here once cache is warm).
  const openApi = await fetch(`${url}/rest/v1/`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/openapi+json',
    },
  });
  if (openApi.ok) {
    const spec = await openApi.json();
    const props =
      spec?.definitions?.amazon_portal_credentials?.properties ||
      spec?.components?.schemas?.amazon_portal_credentials?.properties ||
      null;
    if (props) {
      console.log('PostgREST columns:', Object.keys(props).sort().join(', '));
      return Object.prototype.hasOwnProperty.call(props, 'account_key');
    }
    console.log('PostgREST OpenAPI has no amazon_portal_credentials definition yet.');
  } else {
    console.log(`OpenAPI probe HTTP ${openApi.status}`);
  }
  return false;
}

const hasAccountKey = await diagnoseSchema();
if (!hasAccountKey) {
  console.error(`
PostgREST does not expose account_key on amazon_portal_credentials yet.

Do this in the SAME project (${projectHost}):

1) SQL editor → run sql/force-fix-portal-accounts.sql
2) SQL editor → run sql/seed-station-portal-credentials.sql
   (this inserts the 4 accounts and runs NOTIFY pgrst reload)

Skip the npm seed until step 2 succeeds and the SELECT at the bottom lists KDJG/JUGF/AWEZ/KGQE.
`);
  process.exit(1);
}

const client = createClient(url, key, { auth: { persistSession: false } });
const now = new Date().toISOString();

for (const row of ACCOUNTS) {
  const { data, error } = await client
    .from('amazon_portal_credentials')
    .upsert(
      {
        ...row,
        updated_by: 'seed-station-portal-credentials',
        updated_at: now,
      },
      { onConflict: 'account_key' },
    )
    .select('account_key, email, default_station_code')
    .single();

  if (error) {
    console.error(`FAIL ${row.account_key}:`, error.message);
    process.exitCode = 1;
  } else {
    console.log(`OK  ${data.account_key} → ${data.email} (login station ${data.default_station_code})`);
  }
}

if (process.exitCode) process.exit(process.exitCode);

console.log('\nDone. Next: POST /api/admin/session/ensure with each stationCode (KDJG, JUGF, AWEZ, KGQE).');
