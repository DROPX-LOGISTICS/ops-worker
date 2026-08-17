/**
 * Copy amazon_portal_credentials from the previous Supabase project into the
 * project the deployed worker points at.
 *
 * Writes go through the worker's own PUT /api/admin/credentials, so the target
 * project's service-role key is never needed here. Passwords are never printed.
 *
 * Usage:
 *   node scripts/migrate_portal_credentials.mjs [--dry-run] [--only KDJG,AWEZ]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const devVars = resolve(here, '..', '.dev.vars');

function readVar(name) {
  const text = readFileSync(devVars, 'utf8');
  const match = text.match(new RegExp(`^${name}="(.+)"$`, 'm'));
  return match ? match[1] : '';
}

const SOURCE_URL = readVar('SUPABASE_URL');
const SOURCE_KEY = readVar('SUPABASE_SERVICE_ROLE_KEY');
const ADMIN_KEY = readVar('ADMIN_API_KEY');
const WORKER_URL = (process.env.WORKER_URL || readVar('WORKER_URL')).replace(/\/$/, '');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyArg = args.find((a) => a.startsWith('--only'));
const only = onlyArg
  ? new Set(
      (onlyArg.includes('=') ? onlyArg.split('=')[1] : args[args.indexOf(onlyArg) + 1] || '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    )
  : null;

if (!SOURCE_URL || !SOURCE_KEY) throw new Error('Source SUPABASE_URL / SERVICE_ROLE_KEY missing from .dev.vars');
if (!WORKER_URL || !ADMIN_KEY) throw new Error('WORKER_URL / ADMIN_API_KEY missing from .dev.vars');

const sourceRef = new URL(SOURCE_URL).hostname.split('.')[0];
console.log(`Source project : ${sourceRef}`);
console.log(`Target worker  : ${WORKER_URL}`);
if (dryRun) console.log('Mode           : DRY RUN (nothing will be written)\n');

const listed = await fetch(
  `${SOURCE_URL}/rest/v1/amazon_portal_credentials?select=account_key,email,password,default_station_code,updated_by`,
  { headers: { apikey: SOURCE_KEY, Authorization: `Bearer ${SOURCE_KEY}` } },
);
if (!listed.ok) throw new Error(`Source read failed (${listed.status}): ${await listed.text()}`);
const rows = await listed.json();

const existing = await fetch(`${WORKER_URL}/api/admin/credentials`, {
  headers: { 'x-admin-key': ADMIN_KEY, Accept: 'application/json' },
});
if (!existing.ok) throw new Error(`Worker read failed (${existing.status}): ${await existing.text()}`);
const before = new Set(((await existing.json()).accounts ?? []).map((a) => a.accountKey));
console.log(`Already in target: ${[...before].join(', ') || '(none)'}\n`);

let stored = 0;
let skipped = 0;
for (const row of rows) {
  const key = String(row.account_key ?? '').trim();
  if (!key) continue;
  if (only && !only.has(key.toUpperCase())) continue;
  if (before.has(key)) {
    console.log(`- ${key.padEnd(8)} already present, skipping`);
    skipped += 1;
    continue;
  }
  if (!row.password) {
    console.log(`! ${key.padEnd(8)} has no stored password in the source project`);
    continue;
  }
  if (dryRun) {
    console.log(`~ ${key.padEnd(8)} would store ${row.email} (station ${row.default_station_code})`);
    continue;
  }

  const response = await fetch(`${WORKER_URL}/api/admin/credentials`, {
    method: 'PUT',
    headers: {
      'x-admin-key': ADMIN_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      accountKey: key,
      email: row.email,
      password: row.password,
      defaultStationCode: row.default_station_code || key,
      updatedBy: row.updated_by || 'credential-migration',
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    console.log(`x ${key.padEnd(8)} FAILED (${response.status}): ${text.slice(0, 200)}`);
    continue;
  }
  console.log(`+ ${key.padEnd(8)} stored ${row.email} (station ${row.default_station_code})`);
  stored += 1;
}

console.log(`\nStored ${stored}, skipped ${skipped}, source rows ${rows.length}`);
