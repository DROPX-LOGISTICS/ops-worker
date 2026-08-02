/**
 * Creates a Cloudflare API token named "DROPX OPS WORKER" with the same
 * permission set as the "bflb2c build token".
 *
 * Requires an existing token with "API Tokens Write" (dashboard OAuth /
 * wrangler login is NOT enough). Set:
 *   CLOUDFLARE_API_TOKEN=<token-with-API-Tokens-Write>
 *
 * Usage:
 *   node scripts/create-cf-api-token.mjs
 */
import fs from 'node:fs';

const ACCOUNT_ID = '0c1359d755dc6714ead89c7c8e9eb9d1';
const TOKEN_NAME = 'DROPX OPS WORKER';

const AUTH =
  process.env.CLOUDFLARE_API_TOKEN ||
  process.env.CF_API_TOKEN_CREATE ||
  '';

if (!AUTH) {
  console.error(`
Cannot create the token from this machine automatically.

Cloudflare only allows token creation with a credential that has
"API Tokens Write". Wrangler OAuth login does not include that.

Create it in the dashboard (2 minutes):

1. Open https://dash.cloudflare.com/profile/api-tokens
2. Create Token → Create Custom Token
3. Name: DROPX OPS WORKER
4. Permissions — match "bflb2c build token":

   Account | AI Search | Edit
   Account | Connectivity Directory | Read
   Account | Connectivity Directory | Bind
   Account | Containers | Edit
   Account | Secrets Store | Edit
   Account | Browser Rendering / Browser Run | Edit
   Account | AI Gateway | Run
   Account | Workers Pipelines | Edit
   Account | AI Gateway | Edit
   Account | AI Gateway | Read
   Account | Workers AI | Edit
   Account | Queues | Edit
   Account | Vectorize | Edit
   Account | Hyperdrive | Edit
   Account | Cloudchamber | Edit
   Account | D1 | Edit
   Account | Workers R2 Storage | Edit
   Account | Workers KV Storage | Edit
   Account | Workers Scripts | Edit
   Account | Account Settings | Read

   Zone | Workers Routes | Edit
   Zone | SSL and Certificates | Edit
   (Zone resources: All zones)

   User | Memberships | Read
   User | User Details | Read

5. Account Resources: Include → Aj13peace@gmail.com's Account
6. Continue to summary → Create Token
7. Copy the value ONCE into GitHub Actions secret CLOUDFLARE_API_TOKEN

For deploy-only (narrower), use the "Edit Cloudflare Workers" template instead.
`);
  process.exit(1);
}

const neededNames = [
  // Account
  'AI Search Edit',
  'AI Search Write',
  'Connectivity Directory Read',
  'Connectivity Directory Bind',
  'Containers Edit',
  'Containers Write',
  'Secrets Store Edit',
  'Secrets Store Write',
  'Browser Run Edit',
  'Browser Rendering Edit',
  'Browser Rendering Write',
  'AI Gateway Run',
  'Workers Pipelines Edit',
  'Workers Pipelines Write',
  'AI Gateway Edit',
  'AI Gateway Write',
  'AI Gateway Read',
  'Workers AI Edit',
  'Workers AI Write',
  'Queues Edit',
  'Queues Write',
  'Vectorize Edit',
  'Vectorize Write',
  'Hyperdrive Edit',
  'Hyperdrive Write',
  'Cloudchamber Edit',
  'Cloudchamber Write',
  'D1 Edit',
  'D1 Write',
  'Workers R2 Storage Edit',
  'Workers R2 Storage Write',
  'Workers KV Storage Edit',
  'Workers KV Storage Write',
  'Workers Scripts Edit',
  'Workers Scripts Write',
  'Account Settings Read',
  // Zone
  'Workers Routes Edit',
  'Workers Routes Write',
  'SSL and Certificates Edit',
  'SSL and Certificates Write',
  // User
  'Memberships Read',
  'User Details Read',
];

async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${AUTH}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const json = await res.json();
  if (!json.success) {
    const err = new Error(JSON.stringify(json.errors || json, null, 2));
    err.status = res.status;
    throw err;
  }
  return json.result;
}

const groups = await cf('/user/tokens/permission_groups?per_page=1000');
const byName = new Map(groups.map((g) => [g.name, g]));

const pick = (...candidates) => {
  for (const name of candidates) {
    const g = byName.get(name);
    if (g) return g;
  }
  return null;
};

const accountPerms = [
  pick('AI Search Edit', 'AI Search Write'),
  pick('Connectivity Directory Read'),
  pick('Connectivity Directory Bind'),
  pick('Containers Edit', 'Containers Write'),
  pick('Secrets Store Edit', 'Secrets Store Write'),
  pick('Browser Run Edit', 'Browser Rendering Edit', 'Browser Rendering Write'),
  pick('AI Gateway Run'),
  pick('Workers Pipelines Edit', 'Workers Pipelines Write'),
  pick('AI Gateway Edit', 'AI Gateway Write'),
  pick('AI Gateway Read'),
  pick('Workers AI Edit', 'Workers AI Write'),
  pick('Queues Edit', 'Queues Write'),
  pick('Vectorize Edit', 'Vectorize Write'),
  pick('Hyperdrive Edit', 'Hyperdrive Write'),
  pick('Cloudchamber Edit', 'Cloudchamber Write'),
  pick('D1 Edit', 'D1 Write'),
  pick('Workers R2 Storage Edit', 'Workers R2 Storage Write'),
  pick('Workers KV Storage Edit', 'Workers KV Storage Write'),
  pick('Workers Scripts Edit', 'Workers Scripts Write'),
  pick('Account Settings Read'),
].filter(Boolean);

const zonePerms = [
  pick('Workers Routes Edit', 'Workers Routes Write'),
  pick('SSL and Certificates Edit', 'SSL and Certificates Write'),
].filter(Boolean);

const userPerms = [
  pick('Memberships Read'),
  pick('User Details Read'),
].filter(Boolean);

console.log('Resolved account perms:', accountPerms.map((p) => p.name).join(', '));
console.log('Resolved zone perms:', zonePerms.map((p) => p.name).join(', '));
console.log('Resolved user perms:', userPerms.map((p) => p.name).join(', '));

const missing = neededNames.filter((n) => !byName.has(n));
if (missing.length) {
  console.log('\nNote: some cosmetic name variants not found (OK if Edit/Write alias resolved):');
  console.log(missing.slice(0, 20).join('\n'));
}

const body = {
  name: TOKEN_NAME,
  policies: [
    {
      effect: 'allow',
      resources: {
        [`com.cloudflare.api.account.${ACCOUNT_ID}`]: '*',
      },
      permission_groups: accountPerms.map((p) => ({ id: p.id })),
    },
    {
      effect: 'allow',
      resources: {
        'com.cloudflare.api.account.zone.*': '*',
      },
      permission_groups: zonePerms.map((p) => ({ id: p.id })),
    },
    {
      effect: 'allow',
      resources: {
        'com.cloudflare.api.user': '*',
      },
      permission_groups: userPerms.map((p) => ({ id: p.id })),
    },
  ],
};

const created = await cf('/user/tokens', {
  method: 'POST',
  body: JSON.stringify(body),
});

console.log('\nCreated token:', created.name, 'id=', created.id);
console.log('\n*** COPY THIS VALUE NOW (shown once) ***\n');
console.log(created.value);
console.log('\nAdd it as GitHub Actions secret CLOUDFLARE_API_TOKEN');

fs.writeFileSync(
  '.cf-token-created.json',
  JSON.stringify({ name: created.name, id: created.id, created_at: new Date().toISOString() }, null, 2),
);
console.log('\nWrote metadata only to .cf-token-created.json (value not saved).');
