import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// An isolated Postgres engine only; this test never contacts production.
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table amazon_portal_credentials (
    account_key text primary key, email text, password text, default_station_code text,
    updated_by text, updated_at timestamptz, login_locked_until timestamptz,
    last_login_at timestamptz, last_login_error text
  );
  create table amazon_sessions (
    id uuid primary key, account_key text not null, cookie text not null,
    x_api_usage_key text not null, uploaded_by text not null,
    status text not null check (status in ('active','expired')),
    created_at timestamptz default now(), expired_at timestamptz
  );
  insert into amazon_portal_credentials(account_key) values ('default'), ('dedicated'), ('legacy');
`);
await db.exec(await readFile(new URL('../supabase/migrations/20260912103341_shared_amazon_session_protocol.sql', import.meta.url), 'utf8'));
let tests = 0;
async function check(name, fn) { await fn(); tests++; console.log(`PASS ${name}`); }
async function scalar(sql, params = []) { return (await db.query(sql, params)).rows[0].value; }
const claim = (account, token) => scalar('select amazon_claim_login_v1($1,$2,300) as value', [account,token]);
const finish = (account, token, ok = true, cooldown = 0) => scalar('select amazon_finish_login_v1($1,$2,$3,$4,$5) as value', [account,token,ok,ok ? null : 'test failure',cooldown]);
const replace = (account, id, token = null, cookie = 'synthetic-cookie') => db.query('select id,status from amazon_replace_session_v1($1,$2,$3,$4,$5,$6)', [account,id,cookie,'synthetic-key','isolated-test',token]);
const active = account => scalar("select count(*)::int as value from amazon_sessions where account_key=$1 and status='active'",[account]);
const ownerA=randomUUID(), ownerB=randomUUID(), first=randomUUID(), second=randomUUID();

await check('one lease owner; same-owner retry is idempotent', async () => {
  assert.equal(await claim('default',ownerA),true);
  assert.equal(await claim('default',ownerA),true);
  assert.equal(await claim('default',ownerB),false);
});
await check('different account can log in independently', async () => {
  assert.equal(await claim('dedicated',ownerB),true);
});
await check('older unfenced lock writer is blocked', async () => {
  await assert.rejects(db.exec("update amazon_portal_credentials set login_locked_until=null where account_key='default'"), /AMAZON_SESSION_PROTOCOL_REQUIRED/);
});
await check('wrong owner cannot release or publish', async () => {
  assert.equal(await finish('default',ownerB),false);
  await assert.rejects(replace('default',first,ownerB),/LOGIN_LEASE_LOST/);
});
await check('valid session publication and receipt retry leave one active row', async () => {
  await replace('default',first,ownerA);
  await replace('default',first,ownerA);
  assert.equal(await active('default'),1);
});
await check('older unfenced session writer is blocked', async () => {
  await assert.rejects(db.exec("update amazon_sessions set status='expired' where account_key='default'"), /AMAZON_SESSION_PROTOCOL_REQUIRED/);
});
await check('insert failure rolls back previous-session expiry', async () => {
  await db.exec("alter table amazon_sessions add constraint reject_test_cookie check (cookie <> 'reject-test')");
  await assert.rejects(replace('default',second,ownerA,'reject-test'), /reject_test_cookie/);
  assert.equal(await active('default'),1);
  assert.equal(await scalar('select status as value from amazon_sessions where id=$1',[first]),'active');
});
await check('successful replacement expires only the preceding session', async () => {
  await replace('default',second,ownerA);
  assert.equal(await active('default'),1);
  assert.equal(await scalar('select status as value from amazon_sessions where id=$1',[first]),'expired');
  await assert.rejects(replace('default',first,ownerA),/SESSION_RECEIPT_SUPERSEDED/);
});
await check('old request expiry cannot expire a newer session', async () => {
  assert.equal(await scalar('select amazon_expire_session_v1($1,$2) as value',['default',first]),false);
  assert.equal(await active('default'),1);
});
await check('manual replacement fences an in-flight automatic login', async () => {
  await replace('default',randomUUID());
  await assert.rejects(replace('default',randomUUID(),ownerA), /LOGIN_LEASE_LOST/);
  assert.equal(await finish('default',ownerA),false);
  assert.equal(await active('default'),1);
});
await check('cooldown is shared and cannot be cleared by previous owner', async () => {
  assert.equal(await claim('default',ownerB),true);
  assert.equal(await finish('default',ownerB,false,900),true);
  assert.equal(await claim('default',ownerA),false);
  assert.equal(await finish('default',ownerA),false);
});
await check('legacy cooldown remains respected before account upgrade', async () => {
  await db.exec("update amazon_portal_credentials set login_locked_until=now()+interval '5 minutes' where account_key='legacy'");
  assert.equal(await claim('legacy',randomUUID()),false);
});
await check('expired lease owner cannot publish after a new owner takes over', async () => {
  // Administrative fixture only. Separate transaction from the tested RPCs.
  await db.exec("begin; select set_config('dropx.amazon_session_rpc','v1',true); update amazon_portal_credentials set login_locked_until=now()-interval '1 minute' where account_key='dedicated'; commit;");
  assert.equal(await claim('dedicated',ownerA),true);
  await assert.rejects(replace('dedicated',randomUUID(),ownerB),/LOGIN_LEASE_LOST/);
  assert.equal(await finish('dedicated',ownerB),false);
});
await check('RPC execution is service-only', async () => {
  for (const sig of ['amazon_claim_login_v1(text,uuid,integer)','amazon_finish_login_v1(text,uuid,boolean,text,integer)','amazon_replace_session_v1(text,uuid,text,text,text,uuid)','amazon_expire_session_v1(text,uuid)']) {
    for (const role of ['anon','authenticated']) assert.equal(await scalar('select has_function_privilege($1,$2,\'EXECUTE\') as value',[role,sig]),false);
    assert.equal(await scalar('select has_function_privilege($1,$2,\'EXECUTE\') as value',['service_role',sig]),true);
  }
});
console.log(`${tests} isolated SQL checks passed.`);
await db.close();
