import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import fs from 'node:fs';
let source=fs.readFileSync(new URL('./codStatus.ts',import.meta.url),'utf8');
source=source.replace("import { round2 } from '../utils/number';",'const round2 = n => Math.round(n * 100) / 100;').replace("import { todayIstYmd } from '../utils/dateRange';", "const todayIstYmd = ms => new Date(ms+19800000).toISOString().slice(0,10);");
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022}}).outputText;
const {requiredMoney,reconciliationStatus,prepareDepositStatus,remittanceStatus,codSourceTime}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const inr=value=>({unit:'INR',value});
const driver=(id,amount)=>({driverInfo:{id,name:id},paymentInfo:{overallPendingRecon:inr(amount),overallPendingReconBreakdownList:[]}});
const remit=(status,updatedAt)=>({remittanceId:'a',remittanceCode:'AC1',status,lastUpdated:Date.parse(updatedAt),creationDate:Date.parse('2026-10-11T17:00:00Z'),submissionDate:null,expectedAmount:inr(500),actualAmount:inr(500),variance:inr(0)});
test('pending count, value and completion use cumulative reconciliation',()=>{
 const result=reconciliationStatus([driver('one',25000),driver('two',500),driver('three',0)]);
 assert.equal(result.pendingCount,2); assert.equal(result.pendingAmount,25500);assert.equal(result.completedPercent,33.33);
});
test('missing or duplicate source cannot imply 100% completion',()=>{
 assert.throws(()=>requiredMoney(undefined));assert.throws(()=>requiredMoney({value:''}));assert.throws(()=>reconciliationStatus([]));
 assert.throws(()=>reconciliationStatus([driver('same',0),driver('same',0)]));
 assert.throws(()=>prepareDepositStatus({cashSummary:{expectedAmount:inr(0)}}));
});
test('completion uses COD-applicable portal rows, not the larger active driver roster',()=>{
 const result=reconciliationStatus([driver('one',0),driver('two',0)]);
 assert.equal(result.complete,true);assert.equal(result.driverCount,2);assert.equal(result.completedPercent,100);
});
test('prepare deposit retains expected actual and variance independently',()=>{
 assert.deepEqual(prepareDepositStatus({cashSummary:{expectedAmount:inr(0),actualAmount:inr(10),shortExcessAmount:inr(10)}}),{expectedAmount:0,actualAmount:10,variance:10,digitalAmount:null});
});
test('open remittances include both portal pending states',()=>{
 const result=remittanceStatus([remit('CREATED','2026-10-12T14:00Z'),{...remit('PENDING_SUBMISSION','2026-10-12T15:00Z'),remittanceId:'b'}],true,'2026-10-12');
 assert.equal(result.openCount,2);assert.equal(result.openAmount,1000);assert.equal(result.complete,true);
});
test('a prior deposit is not today; source failure and unknown statuses stay unverified',()=>{
 assert.equal(remittanceStatus([remit('SUBMITTED','2026-10-11T14:00Z')],true,'2026-10-12').submittedToday,false);
 assert.equal(remittanceStatus([remit('SUBMITTED','2026-10-12T14:00Z')],false,'2026-10-12').complete,false);
 assert.equal(remittanceStatus([remit('NEW_UNKNOWN','2026-10-12T14:00Z')],true,'2026-10-12').complete,false);
});
test('today is based on IST last update, not remittance creation',()=>{
 const result=remittanceStatus([remit('SUBMITTED','2026-10-11T20:00Z')],true,'2026-10-12');
 assert.equal(result.submittedToday,true);
});

test('retains collection time and separate transaction time without re-dating COD',()=>{
 const collected=Date.parse('2020-01-01T17:00:00Z'),updated=Date.parse('2020-01-02T05:00:00Z');
 const d=driver('one',100);d.paymentInfo.overallPendingReconBreakdownList=[{trackingId:'TID',paymentMethod:'CASH',amount:inr(100),moneyCollectionTime:collected,transactionTime:updated}];
 const p=reconciliationStatus([d]).drivers[0].packages[0];assert.equal(p.collectedAt,collected);assert.equal(p.transactionAt,updated);
 delete d.paymentInfo.overallPendingReconBreakdownList[0].moneyCollectionTime;
 assert.equal(reconciliationStatus([d]).drivers[0].packages[0].collectedAt,updated);
 assert.equal(reconciliationStatus([d]).drivers[0].packages[0].dateSource,'pending_transaction');
});
test('missing, invalid or future source timestamps remain unknown, never the refresh time',()=>{
 const now=Date.parse('2026-10-13T12:00:00Z');
 for(const value of [undefined,null,'',0,'bad',now+1,1577898000])assert.equal(codSourceTime(value,now),null);
 assert.equal(codSourceTime('1577898000000',now),1577898000000);
});

test('malformed monetary values never become verified zero',()=>{
 for(const value of [null,undefined,'', ' ',true,false,[],{},'NaN',Infinity]) assert.throws(()=>requiredMoney(inr(value)));
 assert.throws(()=>requiredMoney({value:20,unit:'USD'}));
 assert.equal(requiredMoney(inr('0')),0);
});
test('digital liability is retained separately from physical cash',()=>{
 const p=prepareDepositStatus({cashSummary:{expectedAmount:inr(167245.32),actualAmount:inr(167245.32),shortExcessAmount:inr(0)},mposSummary:{amount:inr(136338.78)}});
 assert.equal(p.expectedAmount,167245.32);assert.equal(p.digitalAmount,136338.78);
});
test('offsetting TIDs cannot hide a pending driver behind a net zero',()=>{
 const d=driver('one',0);d.paymentInfo.overallPendingReconBreakdownList=[{trackingId:'old',amount:inr(100)},{trackingId:'adjust',amount:inr(-100)}];
 assert.equal(reconciliationStatus([d]).pendingCount,1);
});
