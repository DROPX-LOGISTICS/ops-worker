import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const cache=new Map();
function load(url) {
 if(cache.has(url.href))return cache.get(url.href).exports;
 const module={exports:{}};cache.set(url.href,module);
 const out=ts.transpileModule(fs.readFileSync(url,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 new Function('require','exports','module',out)(name=>load(new URL(name+'.ts',url)),module.exports,module);return module.exports;
}
const {AmazonLogisticsProvider}=load(new URL('./AmazonLogisticsProvider.ts',import.meta.url));
const inr=value=>({unit:'INR',value});
const raw={remittanceId:'current-id',remittanceCode:'AC671126',status:'SUBMITTED',expectedAmount:inr(153319.11),actualAmount:inr(152553),variance:inr(-766.11),lastUpdated:1791019380000,creationDate:1790968980000};
function provider(result) {
 const p=new AmazonLogisticsProvider('https://www.amazonlogistics.eu',true),calls=[];
 p.callProxy=async(path,process,body)=>{calls.push({path,process,body});if(result instanceof Error)throw result;return result;};return {p,calls};
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
