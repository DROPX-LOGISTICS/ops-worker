import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRemittanceSources } from './remittanceMerge.ts';

const inr = (value) => ({ unit: 'INR', value });
const row = (over) => ({
  remittanceCode: null, remittanceId: '', creationDate: 0, lastUpdated: 0, submissionDate: null,
  createdBy: 'damalsab', submittedBy: null, status: 'CREATED', expectedAmount: inr(0), actualAmount: inr(0),
  paymentMethod: 'CASH', variance: inr(0), ttLink: null, stationVariance: null, ...over,
});

// Real PEUA data pasted on 2026-09-25 (v1 = tmSystem, legacy = cod).
const v1_AC651262 = row({ remittanceCode: 'AC651262', remittanceId: 'PEUA:1790219550000', creationDate: 1790219555708, submissionDate: 1790222211000, submittedBy: 'damalsab', status: 'SUBMITTED', expectedAmount: inr(44529.29), actualAmount: inr(44529) });
const legacy_AC651262 = row({ remittanceCode: 'AC651262', remittanceId: 'STATION-PEUA-1790219559000', creationDate: 1790219559000, submissionDate: 1790222212279, submittedBy: 'damalsab', status: 'SUBMITTED', expectedAmount: inr(44529.29), actualAmount: inr(44529) });
const v1_AC653610 = row({ remittanceCode: 'AC653610', remittanceId: 'PEUA:1790310480000', creationDate: 1790310486870, submissionDate: 1790310619000, submittedBy: 'damalsab', status: 'SUBMITTED', expectedAmount: inr(44197.68), actualAmount: inr(44197) });
const legacy_pending = row({ remittanceCode: null, remittanceId: 'STATION-PEUA-1790310488000', creationDate: 1790310488000, submissionDate: null, status: 'PENDING_SUBMISSION', expectedAmount: inr(44197.68), actualAmount: inr(44197.68) });

test('same remittance in both sources appears once (no double counting)', () => {
  const merged = mergeRemittanceSources([v1_AC651262, v1_AC653610], [legacy_AC651262, legacy_pending]);
  assert.equal(merged.length, 2);
  const total = merged.reduce((sum, r) => sum + r.actualAmount.value, 0);
  assert.equal(total, 44529 + 44197);
});

test('when legacy is behind (pending, no code), the submitted v1 copy wins', () => {
  const [merged] = mergeRemittanceSources([v1_AC653610], [legacy_pending]);
  assert.equal(merged.remittanceCode, 'AC653610');
  assert.equal(merged.status, 'SUBMITTED');
});

test('when v1 is behind, the further-along legacy copy wins and keeps its code', () => {
  const v1Pending = { ...legacy_pending, remittanceId: 'PEUA:1790310480000', creationDate: 1790310486870 };
  const legacySubmitted = { ...v1_AC653610, remittanceId: 'STATION-PEUA-1790310488000', creationDate: 1790310488000 };
  const [merged] = mergeRemittanceSources([v1Pending], [legacySubmitted]);
  assert.equal(merged.remittanceCode, 'AC653610');
  assert.equal(merged.status, 'SUBMITTED');
});

test('a record only one source has is kept (either source failing or lagging)', () => {
  assert.equal(mergeRemittanceSources([], [legacy_AC651262]).length, 1);
  assert.equal(mergeRemittanceSources([v1_AC653610], []).length, 1);
});

test('same code reused on another day stays a separate record', () => {
  const nextDay = { ...legacy_AC651262, remittanceId: 'STATION-PEUA-1790305959000', creationDate: 1790219559000 + 86_400_000 };
  assert.equal(mergeRemittanceSources([v1_AC651262], [nextDay]).length, 2);
});

test('different expected amounts are never paired', () => {
  const other = { ...legacy_AC651262, expectedAmount: inr(44529.3) };
  assert.equal(mergeRemittanceSources([v1_AC651262], [other]).length, 2);
});
