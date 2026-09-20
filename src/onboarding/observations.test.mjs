import test from 'node:test';
import assert from 'node:assert/strict';
import {cookiesForAmazon,reconcileObservations} from './observations.ts';
const id=n=>`amzn1.flex.provider.v1.00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('only exact profile IDs are linked; missing does not mean activated',()=>{
  const result=reconcileObservations([{workforce_id:'worker',provider_profile_id:id(1)}],[{profileId:id(2),progress:'6% · Invitation',status:'DA: Accept email invitation'}]);
  assert.deepEqual(result,{observations:[],missing:1});
});
test('duplicate or invalid profile links fail closed',()=>{
  const link={workforce_id:'worker',provider_profile_id:id(1)};
  assert.throws(()=>reconcileObservations([link,{...link,workforce_id:'other'}],[]),/INVALID_PROFILE_LINKS/);
  assert.throws(()=>reconcileObservations([{...link,provider_profile_id:'name@example.com'}],[]),/INVALID_PROFILE_LINKS/);
});
test('duplicate pages and missing layout fields cannot publish a scan',()=>{
  const row={profileId:id(1),progress:'6%',status:'Invitation pending'};
  assert.throws(()=>reconcileObservations([],[row,row]),/LAYOUT_CHANGED/);
  assert.throws(()=>reconcileObservations([],[{...row,status:''}]),/LAYOUT_CHANGED/);
});
test('output excludes unlinked associates and preserves source status',()=>{
  const row={profileId:id(1),progress:'81% · InstructionalVideos',status:'Behind'};
  const r=reconcileObservations([{workforce_id:'worker',provider_profile_id:id(1)}],[row,{...row,profileId:id(2)}]);
  assert.equal(r.observations.length,1);assert.equal(r.missing,0);
  assert.equal(r.observations[0].provider_status,'Behind');
  assert.equal(r.observations[0].progress,row.progress);
});
test('cookie parser preserves equals and fixes destination to Amazon',()=>{
  assert.deepEqual(cookiesForAmazon('session-token=abc==; invalid; a=b').map(c=>[c.name,c.value,c.url]),[['session-token','abc==','https://logistics.amazon.in'],['a','b','https://logistics.amazon.in']]);
});
