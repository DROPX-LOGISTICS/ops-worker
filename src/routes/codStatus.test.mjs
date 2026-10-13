import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
function moduleAt(path,deps={}) {
 const out=ts.transpileModule(fs.readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};new Function('require','exports','module',out)(name=>{if(!(name in deps))throw Error('Unexpected dependency '+name);return deps[name];},module.exports,module);return module.exports;
}
const dates=moduleAt('../utils/dateRange.ts');
const service=moduleAt('../services/codStatus.ts',{'../utils/number':{round2:n=>Math.round(n*100)/100},'../utils/dateRange':dates});
const coverage=moduleAt('../services/codCashCoverage.ts',{'./codStatus':service,'../utils/number':{round2:n=>Math.round(n*100)/100},'../utils/dateRange':dates});
const inr=value=>({unit:'INR',value});
const cash=value=>({cashSummary:{expectedAmount:inr(value),actualAmount:inr(value),shortExcessAmount:inr(0)}});
function harness({failure,summary=cash(167245.32),fresh=false}={}) {
 const calls=[];
 class Provider {
  constructor(base,strict){calls.push(['provider',strict]);}
  async getActiveDrivers(){return [];}
  async getOutstandingAssociateCash(){if(failure==='scc')throw Error('SCC unavailable');return [];}
  async getDriverReconciliation(station,range){calls.push(['reconciliation',station,range]);return [{driverInfo:{id:'DA',name:'DA'},paymentInfo:{overallPendingRecon:inr(0),overallPendingReconBreakdownList:[]}}];}
  async getStationLiabilitySummary(station,range){calls.push(['liability',station,range]);if(failure==='liability')throw Error('simulated source failure');return range.startTime===0?summary:cash(0);}
  async getRemittances(station,range,auth,options){calls.push(['remittanceSource',options.sources]);if(failure==='remittances')throw Error('simulated primary source failure');return [];}
 }
 const deps={'../errors':{ValidationInputError:Error},'../providers/AmazonLogisticsProvider':{AmazonLogisticsProvider:Provider},'../utils/dateRange':dates,'../services/codStatus':service,'../services/codCashCoverage':coverage,'../store/factory':{createWorkforceAssociateStore:()=>({getByTransporterIds:async()=>new Map()})},'./executiveAmazon':{
  requireAmazonSessionOrThrow:async()=>({auth:{}}),respondCached:async(c,key,force,read)=>{calls.push(['cache',key,force]);return read();}
 }};
 const {codStatusHandler}=moduleAt('./codStatus.ts',deps);
 return {calls,run:()=>codStatusHandler({req:{json:async()=>({stationCode:'gdrd',fresh})},env:{}})};
}
test('live SCC regression: full-history liability window retains GDRD 167245.32, independent of today reconciliation',async()=>{
 const h=harness({fresh:true}),s=await h.run();
 assert.equal(s.prepareDeposit.data.expectedAmount,167245.32);
 assert.equal(s.prepareDeposit.data.sourceScope,'outstanding_history');
 assert.equal(h.calls.find(c=>c[0]==='liability')[2].startTime,0);
 assert.equal(h.calls.find(c=>c[0]==='liability')[2].endTime,dates.getBusinessDayRange(s.date).endTime);
 assert.ok(h.calls.find(c=>c[0]==='reconciliation')[2].startTime>0);
 assert.match(h.calls.find(c=>c[0]==='cache')[1],/cod-status:v6:GDRD/);
 assert.equal(h.calls.find(c=>c[0]==='cache')[2],true);
 assert.equal(h.calls.find(c=>c[0]==='provider')[1],true);
 assert.equal(h.calls.find(c=>c[0]==='remittanceSource')[1],'primary');
});
test('one failed source does not manufacture zero or erase independent verified components',async()=>{
 const s=await harness({failure:'liability'}).run();
 assert.equal(s.prepareDeposit.state,'unavailable');assert.equal(s.prepareDeposit.data,null);
 assert.equal(s.reconciliation.state,'ok');assert.equal(s.remittances.state,'ok');
});
test('malformed liability and incomplete remittance reads fail closed',async()=>{
 const s=await harness({summary:{cashSummary:{expectedAmount:inr(false)}}}).run();assert.equal(s.prepareDeposit.state,'unavailable');
 const m=await harness({failure:'remittances'}).run();assert.equal(m.remittances.state,'unavailable');assert.equal(m.remittances.data,null);
});

test('missing SCC coverage cannot publish the active roster as complete',async()=>{const s=await harness({failure:'scc'}).run();assert.equal(s.reconciliation.state,'unavailable');assert.equal(s.reconciliation.data,null);assert.equal(s.prepareDeposit.state,'ok');});
