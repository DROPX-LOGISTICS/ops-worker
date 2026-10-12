import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import fs from 'node:fs';
let source=fs.readFileSync(new URL('./codStatus.ts',import.meta.url),'utf8');
source=source.replace("import { round2 } from '../utils/number';",'const round2 = n => Math.round(n * 100) / 100;').replace("import { todayIstYmd } from '../utils/dateRange';", "const todayIstYmd = ms => new Date(ms+19800000).toISOString().slice(0,10);");
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022}}).outputText;
const {requiredMoney,reconciliationStatus,prepareDepositStatus,remittanceStatus}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const inr=value=>({unit:'INR',value});
const driver=(id,amount)=>({driverInfo:{id,name:id},paymentInfo:{overallPendingRecon:inr(amount),overallPendingReconBreakdownList:[]}});
const remit=(status,updatedAt)=>({remittanceId:'a',remittanceCode:'AC1',status,lastUpdated:Date.parse(updatedAt),creationDate:Date.parse('2026-10-11T17:00:00Z'),submissionDate:null,expectedAmount:inr(500),actualAmount:inr(500),variance:inr(0)});
test('pending count, value and completion use cumulative reconciliation',()=>{
 const result=reconciliationStatus([driver('one',25000),driver('two',500),driver('three',0)],3);
 assert.equal(result.pendingCount,2); assert.equal(result.pendingAmount,25500);assert.equal(result.completedPercent,33.33);
});
test('missing, duplicate or incomplete source cannot imply 100% completion',()=>{
 assert.throws(()=>requiredMoney(undefined));assert.throws(()=>requiredMoney({value:''}));assert.throws(()=>reconciliationStatus([],0));
 assert.throws(()=>reconciliationStatus([driver('same',0),driver('same',0)],2));
 assert.equal(reconciliationStatus([driver('one',0)],2).complete,false);
 assert.throws(()=>prepareDepositStatus({cashSummary:{expectedAmount:inr(0)}}));
});
test('prepare deposit retains expected actual and variance independently',()=>{
 assert.deepEqual(prepareDepositStatus({cashSummary:{expectedAmount:inr(0),actualAmount:inr(10),shortExcessAmount:inr(10)}}),{expectedAmount:0,actualAmount:10,variance:10});
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
