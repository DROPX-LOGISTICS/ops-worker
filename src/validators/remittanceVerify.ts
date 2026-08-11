import { REMITTANCE_CASH_TOLERANCE } from '../config';
import type { RemittanceEntry } from '../types';
import type { DateRange } from '../utils/dateRange';
import { ymdFromIstEpochMs } from '../utils/dateRange';
import { approxEqual, round2 } from '../utils/number';

const ACTIVE_STATUSES = new Set(['CREATED', 'SUBMITTED']);

export type RemittanceVerifyMatch = {
  remittanceId: string;
  remittanceCode: string | null;
  status: string;
  actualAmount: number;
  creationDate: number;
  submissionDate: number | null;
  matchedOn: 'creation_date' | 'submission_date' | 'lookback';
};

export type RemittanceVerifyResult = {
  verified: boolean;
  codeFound: boolean;
  amountMatched: boolean;
  matches: RemittanceVerifyMatch[];
  nearMisses: RemittanceVerifyMatch[];
};

function normalizeCode(code: string) {
  return code.trim().toUpperCase();
}

function toMatch(
  entry: RemittanceEntry,
  matchedOn: RemittanceVerifyMatch['matchedOn'],
): RemittanceVerifyMatch {
  return {
    remittanceId: entry.remittanceId,
    remittanceCode: entry.remittanceCode,
    status: entry.status,
    actualAmount: round2(entry.actualAmount?.value ?? 0),
    creationDate: entry.creationDate,
    submissionDate: entry.submissionDate,
    matchedOn,
  };
}

function amountOk(entry: RemittanceEntry, amount: number) {
  return approxEqual(entry.actualAmount?.value ?? 0, amount, REMITTANCE_CASH_TOLERANCE);
}

/**
 * Verify remittance code + amount.
 * 1) Same business day by creationDate
 * 2) Same business day by submissionDate
 * 3) Lookback across the portal remittance list (same source as ER remittance API)
 */
export function verifyRemittanceEntry(
  remittances: RemittanceEntry[],
  range: DateRange,
  remittanceCode: string,
  amount: number,
  depositYmd: string,
): RemittanceVerifyResult {
  const codeNorm = normalizeCode(remittanceCode);
  if (!codeNorm) {
    return { verified: false, codeFound: false, amountMatched: false, matches: [], nearMisses: [] };
  }

  const active = remittances.filter((r) => ACTIVE_STATUSES.has(r.status));
  const byCode = active.filter((r) => normalizeCode(r.remittanceCode ?? '') === codeNorm);

  const onCreationDay = byCode.filter(
    (r) => r.creationDate >= range.startTime && r.creationDate <= range.endTime,
  );
  const creationHits = onCreationDay.filter((r) => amountOk(r, amount));
  if (creationHits.length) {
    return {
      verified: true,
      codeFound: true,
      amountMatched: true,
      matches: creationHits.map((r) => toMatch(r, 'creation_date')),
      nearMisses: onCreationDay.filter((r) => !amountOk(r, amount)).map((r) => toMatch(r, 'creation_date')),
    };
  }

  const onSubmissionDay = byCode.filter((r) => {
    if (r.submissionDate == null) return false;
    return ymdFromIstEpochMs(r.submissionDate) === depositYmd;
  });
  const submissionHits = onSubmissionDay.filter((r) => amountOk(r, amount));
  if (submissionHits.length) {
    return {
      verified: true,
      codeFound: true,
      amountMatched: true,
      matches: submissionHits.map((r) => toMatch(r, 'submission_date')),
      nearMisses: onSubmissionDay.filter((r) => !amountOk(r, amount)).map((r) => toMatch(r, 'submission_date')),
    };
  }

  const lookbackHits = byCode.filter((r) => amountOk(r, amount));
  if (lookbackHits.length) {
    return {
      verified: true,
      codeFound: true,
      amountMatched: true,
      matches: lookbackHits.map((r) => toMatch(r, 'lookback')),
      nearMisses: byCode.filter((r) => !amountOk(r, amount)).map((r) => toMatch(r, 'lookback')),
    };
  }

  return {
    verified: false,
    codeFound: byCode.length > 0,
    amountMatched: false,
    matches: [],
    nearMisses: byCode.map((r) => toMatch(r, 'lookback')),
  };
}
