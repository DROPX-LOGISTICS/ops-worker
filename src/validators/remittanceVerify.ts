import { REMITTANCE_CASH_TOLERANCE } from '../config';
import type { RemittanceEntry } from '../types';
import { ymdFromIstEpochMs } from '../utils/dateRange';
import { approxEqual, round2 } from '../utils/number';

const ACTIVE_STATUSES = new Set(['CREATED', 'SUBMITTED']);

export type RemittanceVerifyMatch = {
  remittanceId: string;
  remittanceCode: string | null;
  status: string;
  actualAmount: number;
  creationDate: number;
  creationDateIst: string;
  submissionDate: number | null;
  submissionDateIst: string | null;
  submittedBy: string | null;
  createdBy: string | null;
};

export type RemittanceVerifyResult = {
  verified: boolean;
  codeFound: boolean;
  amountMatched: boolean;
  depositDateMatched: boolean;
  creationPeriodMatched: boolean;
  submitterMatched: boolean;
  matches: RemittanceVerifyMatch[];
  nearMisses: RemittanceVerifyMatch[];
  failureReason: string | null;
};

function normalizeCode(code: string) {
  return code.trim().toUpperCase();
}

function normalizePerson(value: string | null | undefined) {
  return String(value ?? '').trim().toLowerCase();
}

function toMatch(entry: RemittanceEntry): RemittanceVerifyMatch {
  const submissionDate = entry.submissionDate;
  return {
    remittanceId: entry.remittanceId,
    remittanceCode: entry.remittanceCode,
    status: entry.status,
    actualAmount: round2(entry.actualAmount?.value ?? 0),
    creationDate: entry.creationDate,
    creationDateIst: ymdFromIstEpochMs(entry.creationDate),
    submissionDate,
    submissionDateIst: submissionDate == null ? null : ymdFromIstEpochMs(submissionDate),
    submittedBy: entry.submittedBy ?? null,
    createdBy: entry.createdBy ?? null,
  };
}

/**
 * COD Submission verify rules (IST dates):
 * - remittanceCode must match
 * - depositDate must equal submissionDate (IST day)
 * - creationDate (IST) must fall within COD From..COD To
 * - amount must match the TOTAL actualAmount.value across every remittance record sharing
 *   this code within the window (± ₹1) — see note below
 * - submittedBy (optional) compared case-insensitively
 *
 * Amazon reuses the same remittanceCode across multiple remittance records within one
 * deposit window — one record per creation day, all sharing a code and typically
 * submitted together in the same batch (near-identical submissionDate). The deposited
 * amount ops enters on one bank slip is the SUM across all of those records, not any
 * single one's actualAmount, so matching amount per-record here always failed for a
 * multi-day COD period even though the total was exactly right.
 */
export function verifyRemittanceEntry(
  remittances: RemittanceEntry[],
  remittanceCode: string,
  amount: number,
  depositYmd: string,
  codFromYmd: string,
  codToYmd: string,
  submittedBy?: string | null,
): RemittanceVerifyResult {
  const codeNorm = normalizeCode(remittanceCode);
  const empty: RemittanceVerifyResult = {
    verified: false,
    codeFound: false,
    amountMatched: false,
    depositDateMatched: false,
    creationPeriodMatched: false,
    submitterMatched: true,
    matches: [],
    nearMisses: [],
    failureReason: null,
  };

  if (!codeNorm) {
    return { ...empty, failureReason: 'Remittance code is required.' };
  }

  const active = remittances.filter((r) => ACTIVE_STATUSES.has(r.status));
  const byCode = active.filter((r) => normalizeCode(r.remittanceCode ?? '') === codeNorm);
  if (!byCode.length) {
    return {
      ...empty,
      failureReason: `Remittance code ${codeNorm} was not found on Amazon portal.`,
    };
  }

  const nearMisses = byCode.map(toMatch);
  const wantSubmitter = normalizePerson(submittedBy);

  // Every record under this code whose deposit date, COD period and submitter line up —
  // amount is checked afterward against their combined total, not per record.
  const eligible = byCode.filter((entry) => {
    const creationIst = ymdFromIstEpochMs(entry.creationDate);
    const submissionIst = entry.submissionDate == null ? null : ymdFromIstEpochMs(entry.submissionDate);
    const depositOk = submissionIst === depositYmd;
    const periodOk = Boolean(creationIst && creationIst >= codFromYmd && creationIst <= codToYmd);
    const submitterOk =
      !wantSubmitter ||
      normalizePerson(entry.submittedBy) === wantSubmitter ||
      normalizePerson(entry.createdBy) === wantSubmitter;
    return depositOk && periodOk && submitterOk;
  });

  if (eligible.length) {
    const totalActual = round2(
      eligible.reduce((sum, entry) => sum + (entry.actualAmount?.value ?? 0), 0),
    );
    const amountMatched = approxEqual(totalActual, amount, REMITTANCE_CASH_TOLERANCE);
    if (amountMatched) {
      return {
        verified: true,
        codeFound: true,
        amountMatched: true,
        depositDateMatched: true,
        creationPeriodMatched: true,
        submitterMatched: true,
        matches: eligible.map(toMatch),
        nearMisses: [],
        failureReason: null,
      };
    }
    return {
      verified: false,
      codeFound: true,
      amountMatched: false,
      depositDateMatched: true,
      creationPeriodMatched: true,
      submitterMatched: true,
      matches: [],
      nearMisses,
      failureReason: `Amount does not match the portal total for ${codeNorm} across ${eligible.length} remittance${eligible.length === 1 ? '' : 's'} (portal total: ${totalActual}, entered: ${round2(amount)}).`,
    };
  }

  // Nothing lined up on date/submitter at all — build a precise reason from the closest
  // single candidate (prefer submission-date match).
  const byDeposit = byCode.filter((entry) => {
    if (entry.submissionDate == null) return false;
    return ymdFromIstEpochMs(entry.submissionDate) === depositYmd;
  });
  const candidate = byDeposit[0] ?? byCode[0];
  // byCode is non-empty above; guard satisfies noUncheckedIndexedAccess.
  if (!candidate) {
    return {
      ...empty,
      codeFound: true,
      nearMisses,
      failureReason: `Remittance code ${codeNorm} found but details do not match.`,
    };
  }
  const creationIst = ymdFromIstEpochMs(candidate.creationDate);
  const submissionIst =
    candidate.submissionDate == null ? null : ymdFromIstEpochMs(candidate.submissionDate);
  const depositDateMatched = submissionIst === depositYmd;
  const creationPeriodMatched = Boolean(
    creationIst && creationIst >= codFromYmd && creationIst <= codToYmd,
  );
  const submitterMatched =
    !wantSubmitter ||
    normalizePerson(candidate.submittedBy) === wantSubmitter ||
    normalizePerson(candidate.createdBy) === wantSubmitter;

  let failureReason = `Remittance code ${codeNorm} found but details do not match.`;
  if (!depositDateMatched) {
    failureReason = `Deposit date ${depositYmd} must match remittance submission date (portal: ${submissionIst ?? 'missing'}).`;
  } else if (!creationPeriodMatched) {
    failureReason = `COD period ${codFromYmd} → ${codToYmd} must cover remittance creation date (portal: ${creationIst}).`;
  } else if (!submitterMatched) {
    failureReason = `Submitted by does not match portal submittedBy (portal: ${candidate.submittedBy ?? candidate.createdBy ?? '—'}).`;
  }

  return {
    verified: false,
    codeFound: true,
    amountMatched: false,
    depositDateMatched,
    creationPeriodMatched,
    submitterMatched,
    matches: [],
    nearMisses,
    failureReason,
  };
}
