/**
 * Push selected keys from .dev.vars into Cloudflare Worker secrets.
 * Usage: node scripts/sync-secrets.mjs
 *        node scripts/sync-secrets.mjs --env staging
 *
 * Does not print secret values.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const envFlag = process.argv.includes('--env')
  ? process.argv[process.argv.indexOf('--env') + 1]
  : '';

const KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ADMIN_API_KEY',
  'AMAZON_PORTAL_EMAIL',
  'AMAZON_PORTAL_PASSWORD',
  'OWNER_EMAIL',
  'RESEND_API_KEY',
  'OWNER_NOTIFICATION_EMAIL',
  'NOTIFICATION_FROM_EMAIL',
];

function parseDevVars(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

if (!fs.existsSync('.dev.vars')) {
  console.error('Missing .dev.vars — copy from .dev.vars.example and fill values.');
  process.exit(1);
}

const vars = parseDevVars(fs.readFileSync('.dev.vars', 'utf8'));
const argsBase = ['wrangler', 'secret', 'put'];
if (envFlag !== undefined && process.argv.includes('--env')) {
  argsBase.push('--env', envFlag);
}

let ok = 0;
let skip = 0;
for (const key of KEYS) {
  const value = vars[key];
  if (!value) {
    console.log(`skip  ${key} (not set in .dev.vars)`);
    skip++;
    continue;
  }
  const result = spawnSync('npx', [...argsBase, key], {
    input: value,
    encoding: 'utf8',
    shell: true,
  });
  if (result.status === 0) {
    console.log(`ok    ${key}`);
    ok++;
  } else {
    console.error(`fail  ${key}`);
    if (result.stderr) console.error(result.stderr.trim());
    if (result.stdout) console.error(result.stdout.trim());
    process.exit(result.status || 1);
  }
}

console.log(`\nDone: ${ok} uploaded, ${skip} skipped.`);
