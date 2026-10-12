import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const js=ts.transpileModule(fs.readFileSync(new URL('./reconciliationIdentity.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ES2022}}).outputText;
const {reconciliationIdentity}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const store={driverName:'Counterparty',tasId:null,employeeId:'673005-18',store:true};
test('retains real TAS IDs and resolves a store ID from the same station roster',()=>{
 assert.equal(reconciliationIdentity({tasId:'ABC'},[store]),'ABC');
 assert.equal(reconciliationIdentity({driverName:'Counterparty',store:true},[store]),'673005-18');
});
test('ambiguous, cross-type and missing identities remain unverified',()=>{
 assert.equal(reconciliationIdentity({driverName:'Counterparty',store:true},[store,{...store,employeeId:'another'}]),null);
 assert.equal(reconciliationIdentity({driverName:'Counterparty',store:false},[store]),null);
 assert.equal(reconciliationIdentity({driverName:'Not in station',store:true},[store]),null);
});
