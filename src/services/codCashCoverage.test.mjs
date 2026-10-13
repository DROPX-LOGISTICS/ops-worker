import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const cache=new Map();
function load(url){if(cache.has(url.href))return cache.get(url.href).exports;const m={exports:{}};cache.set(url.href,m);new Function('require','exports','module',ts.transpileModule(fs.readFileSync(url,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(name=>load(new URL(name+'.ts',url)),m.exports,m);return m.exports;}
const {reconciliationWithSccCash:merge}=load(new URL('./codCashCoverage.ts',import.meta.url));
const recon=(id,rows)=>({driverInfo:{id,name:id},paymentInfo:{overallPendingRecon:{unit:'INR',value:rows.reduce((s,r)=>s+r.amount,0)},overallPendingReconBreakdownList:rows.map(r=>({trackingId:r.tid,paymentMethod:'CASH',amount:{unit:'INR',value:r.amount},transactionTime:1577898000000}))}});
const cash=(id,tid,amount)=>({driverId:id,trackingId:tid,receivableAmount:amount*100,lastUpdatedTime:'2020-01-01 12:00:00'});
test('GDRD omitted-holder regression: adds SCC cash without duplicating shared TIDs',()=>{
 const result=merge([recon('active',[{tid:'shared',amount:43267.31}])],[cash('active','shared',43267.31),cash('missing-1','a',11697.9),cash('missing-2','b',2925.81)],new Map([['missing-1','Mapped name']]));
 assert.equal(result.pendingAmount,57891.02);assert.equal(result.pendingCount,3);assert.equal(result.complete,true);
 assert.equal(result.coverage.supplementedAmount,14623.71);assert.equal(result.coverage.supplementedCount,2);
 assert.equal(result.drivers[1].name,'Mapped name');assert.equal(result.drivers[2].name,'Driver missing-2');
 assert.equal(result.drivers[1].packages[0].collectedAt,null);assert.equal(result.drivers[1].packages[0].transactionAt,null);
 assert.equal(result.drivers[1].packages[0].sourceUpdatedAt,Date.parse('2020-01-01T12:00:00+05:30'));
});
test('SCC Last Scan By never overrides the driver identity or shifts money between people',()=>{
 const r=merge([recon('driver',[{tid:'a',amount:612}])],[{...cash('driver','a',612),lastScanBy:'Another scanner'}]);
 assert.equal(r.drivers[0].id,'driver');assert.equal(r.pendingAmount,612);assert.equal(r.coverage.supplementedCount,0);
});
test('known-driver stale SCC row and amount/owner conflicts remain unverified, never double counted',()=>{
 for(const rows of [[cash('driver','cleared',100)],[cash('driver','a',200)],[cash('other','a',100)]]){
  const r=merge([recon('driver',[{tid:'a',amount:100}])],rows);assert.equal(r.complete,false);assert.equal(r.pendingAmount,100);assert.equal(r.coverage.conflictingTrackingIds.length,1);
 }
});
test('cash survives empty active roster or missing holder ID; names are optional',()=>{
 const r=merge([],[cash(null,'old',20)]);assert.equal(r.pendingAmount,20);assert.equal(r.drivers[0].name,'Unassigned cash holder');
 assert.equal(r.completedPercent,0);assert.equal(r.drivers[0].packages[0].collectedAt,null);
});
test('malformed, duplicate and negative SCC data cannot become clearance',()=>{
 for(const rows of [[cash('d','a',NaN)],[cash('d','a',-1)],[cash('d','a',1),cash('d','a',1)]])assert.throws(()=>merge([],rows));
 assert.throws(()=>merge([recon('d',[{tid:'same',amount:1}]),recon('e',[{tid:'same',amount:1}])],[]));
});
