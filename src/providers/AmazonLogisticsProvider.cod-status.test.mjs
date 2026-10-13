import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const cache=new Map();
function load(url) {
 if(cache.has(url.href))return cache.get(url.href).exports;
 const module={exports:{}};cache.set(url.href,module);
 const out=ts.transpileModule(fs.readFileSync(url,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','exports','module',out)(name=>load(new URL(name+'.ts',url)),module.exports,module);return module.exports;
}
const {AmazonLogisticsProvider}=load(new URL('./AmazonLogisticsProvider.ts',import.meta.url));
const inr=value=>({unit:'INR',value});
const raw={remittanceId:'current-id',remittanceCode:'AC671126',status:'SUBMITTED',expectedAmount:inr(153319.11),actualAmount:inr(152553),variance:inr(-766.11),lastUpdated:1791019380000,creationDate:1790968980000};
function provider(result) {
 const p=new AmazonLogisticsProvider('https://www.amazonlogistics.eu',true),calls=[];
 p.callProxy=async(path,process,body)=>{calls.push({path,process,body});if(result instanceof Error)throw result;return result?.packageResultList && body.startingIndex > 0 ? {packageResultList:[]} : result;};return {p,calls};
}
const range={startTime:1791829800000,endTime:1791916199999};
test('GNTF source conflict: COD Status returns current SCC financial record exactly once',async()=>{
 const {p,calls}=provider({remittanceList:[raw]});const rows=await p.getRemittances('GNTF',range,{}, {sources:'primary'});
 assert.equal(calls.length,1);assert.equal(calls[0].path,'/v1/getRemittance');assert.equal(calls[0].process,'tmSystem');
 assert.equal(rows.length,1);assert.equal(rows[0].expectedAmount.value,153319.11);assert.equal(rows[0].variance.value,-766.11);
});
test('primary source failure or malformed actual amount cannot fall back to legacy or zero',async()=>{
 for(const response of [Error('source unavailable'),{remittanceList:[{...raw,actualAmount:null}]},{remittanceList:[{...raw,variance:inr(' ')}]}]){
  const {p,calls}=provider(response);await assert.rejects(p.getRemittances('GNTF',range,{}, {sources:'primary'}));assert.equal(calls.length,1);
 }
});
test('a verified empty current source is empty, not filled with historical shadow rows',async()=>{
 const {p,calls}=provider({remittanceList:[]});assert.deepEqual(await p.getRemittances('GNTF',range,{}, {sources:'primary'}),[]);assert.equal(calls.length,1);
});
const cashRow=(trackingId,stationCode='GDRD',more={})=>({trackingId,stationCode,driverId:'missing-roster',state:'Cash In Associate',paymentMethod:'CASH',receivableAmount:10000,lastUpdatedTime:'2020-01-01 12:00:00',...more});
test('cash coverage queries all outstanding history and paginates independently of active drivers',async()=>{
 const {p,calls}=provider({packageResultList:[]});
 p.callProxy=async(path,process,body)=>{calls.push({path,process,body});return {packageResultList:body.startingIndex===0?Array.from({length:1000},(_,i)=>cashRow(String(i))):body.startingIndex===1000?[cashRow('last')]:[]};};
 const rows=await p.getOutstandingAssociateCash('GDRD',{});assert.equal(rows.length,1001);assert.equal(calls.length,3);
 assert.equal(calls[0].body.lastUpdatedRange.startTime,0);assert.equal(calls[1].body.startingIndex,1000);
 assert.deepEqual(calls[0].body.packageStatusMap,{'Cash With Associate':[]});
});
test('cash coverage isolates station and actual payment method; parent and XPT never mix',async()=>{
 const {p}=provider({packageResultList:[cashRow('a'),cashRow('child','XAPH'),cashRow('digital','GDRD',{actualPaymentMethod:'PREPAID'}),cashRow('a')]});
 assert.deepEqual((await p.getOutstandingAssociateCash('GDRD',{})).map(p=>p.trackingId),['a']);
});
test('cash source errors, missing fields and contradictory duplicates fail closed',async()=>{
 for(const result of [{},{packageResultList:[cashRow('a','')]},{packageResultList:[cashRow('a','GDRD',{receivableAmount:''})]},{packageResultList:[cashRow('a'),cashRow('a','GDRD',{driverId:'other'})]}]){
 const {p}=provider(result);await assert.rejects(p.getOutstandingAssociateCash('GDRD',{}));}
});
test('a full last page at the source safety limit cannot claim complete coverage',async()=>{
 const {p}=provider(null);p.callProxy=async(path,process,body)=>({packageResultList:[cashRow(String(body.startingIndex))]});await assert.rejects(p.getOutstandingAssociateCash('GDRD',{}),/pagination incomplete/);
});

test('SCC server-capped short pages continue until empty, including omitted holders on later pages',async()=>{
 const {p,calls}=provider(null);
 const rows=[cashRow('first'),cashRow('second'),cashRow('omitted-holder','GDRD',{driverId:'A2NI3KUCC0HD69'})];
 p.callProxy=async(path,process,body)=>{calls.push(body);return {packageResultList:rows.slice(body.startingIndex,body.startingIndex+2)};};
 assert.equal((await p.getOutstandingAssociateCash('GDRD',{})).length,3);
 assert.deepEqual(calls.map(b=>b.startingIndex),[0,2,3]);
});
test('SCC repeating a nonempty page cannot be reported as complete',async()=>{
 const {p}=provider(null);p.callProxy=async()=>({packageResultList:[cashRow('repeated')]});
 await assert.rejects(p.getOutstandingAssociateCash('GDRD',{}),/repeated page/);
});

test('afternoon IST outstanding cash is not truncated by UTC-now cutoff',async()=>{
 const realNow=Date.now;Date.now=()=>Date.parse('2026-10-13T12:18:00Z');
 try {
  const {p,calls}=provider(null);
  p.callProxy=async(path,process,body)=>{calls.push(body);return {packageResultList:body.startingIndex===0 && body.lastUpdatedRange.endTime>=Date.parse('2026-10-13T17:37:49Z')/1000?[cashRow('afternoon','GDRD',{lastUpdatedTime:'2026-10-13 17:37:49'})]:[]};};
  assert.equal((await p.getOutstandingAssociateCash('GDRD',{})).length,1);
  assert.equal(calls[0].lastUpdatedRange.startTime,0);
 }finally{Date.now=realNow;}
});
