import { REMITTANCE_CASH_TOLERANCE } from '../config';
import type { RemittanceEntry } from '../types';
import type { DateRange } from '../utils/dateRange';
import { approxEqual, round2 } from '../utils/number';

const ACTIVE_STATUSES = new Set(['CREATED', 'SUBMITTED']);

export type RemittanceVerifyMatch = {
  remittanceId: string;
  remittanceCode: string | null;
  status: string;
  actualAmount: number;
  creationDate: number;
  submissionDate: number | null;
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

function toMatch(entry: RemittanceEntry): RemittanceVerifyMatch {
  return {
    remittanceId: entry.remittanceId,
    remittanceCode: entry.remittanceCode,
    status: entry.status,
    actualAmount: round2(entry.actualAmount?.value ?? 0),
    creationDate: entry.creationDate,
    submissionDate: entry.submissionDate,
  };
}

/**
 * Verify a specific CMS/bank remittance code + amount for a business day.
 * Prefers SUBMITTED rows (codes usually appear there) but also accepts
 * CREATED when a remittanceCode is present.
 */
export function verifyRemittanceEntry(
  remittances: RemittanceEntry[],
  range: DateRange,
  remittanceCode: string,
  amount: number,
): RemittanceVerifyResult {
  const codeNorm = normalizeCode(remittanceCode);
  if (!codeNorm) {
    return { verified: false, codeFound: false, amountMatched: false, matches: [], nearMisses: [] };
  }

  const dayActive = remittances.filter(
    (r) =>
      ACTIVE_STATUSES.has(r.status) &&
      r.creationDate >= range.startTime &&
      r.creationDate <= range.endTime,
  );

  const candidates = dayActive.filter(
    (r) => normalizeCode(r.remittanceCode ?? '') === codeNorm,
  );

  const amountHits = candidates.filter((r) =>
    approxEqual(r.actualAmount?.value ?? 0, amount, REMITTANCE_CASH_TOLERANCE),
  );

  return {
    verified: amountHits.length > 0,
    codeFound: candidates.length > 0,
    amountMatched: amountHits.length > 0,
    matches: amountHits.map(toMatch),
    nearMisses: candidates.filter((r) => !amountHits.includes(r)).map(toMatch),
  };
}
