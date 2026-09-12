import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise actual TypeScript with stubbed persistence; no production calls.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clients=[];
const modules=new Map();
function load(file) {
  const absolute=resolve(root,file);
  if(modules.has(absolute)) return modules.get(absolute);
  const module={exports:{}};
  modules.set(absolute,module.exports);
  const source=ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const require=specifier=>{
    if(specifier==='@supabase/supabase-js')return {createClient:()=>clients.shift()};
    return load(resolve(dirname(absolute),specifier+'.ts'));
  };
  vm.runInNewContext(source,{module,exports:module.exports,require,crypto:{randomUUID},setTimeout:(fn)=>setTimeout(fn,0),clearTimeout,console,fetch,Request,Response,AbortController},{filename:absolute});
  return module.exports;
}
const protocol=load('src/session/amazonSessionProtocol.ts');
const {SupabaseCredentialStore}=load('src/store/SupabaseCredentialStore.ts');
const {PortalCredentialStore}=load('src/store/PortalCredentialStore.ts');
let checks=0;
async function check(name,fn){await fn();checks++;console.log(`PASS ${name}`);}
await check('transport retry uses identical session ID and payload',async()=>{
  const args={p_session_id:randomUUID()}, calls=[];
  const result=await protocol.amazonSessionRpc({rpc:async(name,payload)=>{calls.push(payload);if(calls.length===1)throw Error('network');return {data:true,error:null};}},'amazon_replace_session_v1',args);
  assert.equal(result,true);assert.equal(calls.length,2);assert.equal(calls[0],calls[1]);
});
await check('ownership/permission errors are not retried or leaked',async()=>{
  let calls=0;
  await assert.rejects(protocol.amazonSessionRpc({rpc:async()=>{calls++;return{data:null,error:{code:'P0001',message:'private-payload'}};}},'amazon_replace_session_v1',{}),err=>!err.message.includes('private-payload'));
  assert.equal(calls,1);
});
await check('replace uses one atomic RPC and preserves owner',async()=>{
  const calls=[];
  clients.push({rpc:async(name,args)=>{calls.push({name,args});return{error:null,data:[{id:args.p_session_id,account_key:args.p_account_key,cookie:args.p_cookie,x_api_usage_key:args.p_api_key,status:'active'}]};}});
  const store=new SupabaseCredentialStore('synthetic','synthetic');
  const row=await store.upload('synthetic-cookie','synthetic-key','test','dedicated','owner');
  assert.equal(calls.length,1);assert.equal(calls[0].name,'amazon_replace_session_v1');assert.equal(calls[0].args.p_token,'owner');assert.equal(row.accountKey,'dedicated');
});
await check('lease release carries only the successful owner token',async()=>{
  const calls=[];clients.push({rpc:async(name,args)=>{calls.push({name,args});return{error:null,data:true};}});
  const store=new PortalCredentialStore({});store.fetchRow=async()=>({account_key:'default'});
  assert.equal(await store.tryAcquireLoginLock('default'),true);
  const token=store.getLoginLeaseToken('default');assert.ok(token);
  await store.releaseLoginLock({ok:true},'default');
  assert.equal(calls[1].args.p_token,token);assert.equal(store.getLoginLeaseToken('default'),undefined);
});
await check('failed claim cannot release another process lock',async()=>{
  const calls=[];clients.push({rpc:async(name,args)=>{calls.push({name,args});return{error:null,data:false};}});
  const store=new PortalCredentialStore({});store.fetchRow=async()=>({account_key:'default'});
  assert.equal(await store.tryAcquireLoginLock('default'),false);
  await store.releaseLoginLock({ok:true},'default');assert.equal(calls.length,1);
});
await check('quota and authentication challenges back off centrally',async()=>{
  assert.equal(protocol.loginFailureCooldown('429 rate limit exceeded'),900);
  assert.equal(protocol.loginFailureCooldown('MFA required'),900);
  assert.equal(protocol.loginFailureCooldown('Amazon rejected the login: Account Closed'),900);
  assert.equal(protocol.loginFailureCooldown('network failed'),60);
  assert.ok(protocol.AMAZON_BROWSER_LOGIN_TIMEOUT_MS<protocol.AMAZON_LOGIN_LEASE_SECONDS*1000);
});
await check('database lookup outage fails closed, not as missing session',async()=>{
  const chain=new Proxy({}, {get:(_,key)=>key==='maybeSingle'?async()=>({data:null,error:{code:'PGRST000'}}):()=>chain});
  clients.push({from:()=>chain});const store=new SupabaseCredentialStore('synthetic','synthetic');
  await assert.rejects(store.getActive('default'),/lookup unavailable/);
  clients.push({from:()=>chain});const portal=new PortalCredentialStore({});
  await assert.rejects(portal.getForLogin('default'),/lookup unavailable/);
});
console.log(`${checks} isolated client checks passed.`);
