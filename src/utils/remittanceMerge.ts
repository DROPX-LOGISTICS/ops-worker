import type { RemittanceEntry } from '../types';

/**
 * Amazon exposes the same bank-deposit remittances through two endpoints that
 * can disagree for hours: `/v1/getRemittance` (`tmSystem`, what the portal UI
 * reads) and the legacy `/getRemittance` (`cod`). Observed for PEUA on
 * 2026-09-25: AC653610 was SUBMITTED with its code in v1 while legacy still
 * showed the same record as PENDING_SUBMISSION with no code.
 *
 * The two copies of one record share nothing reliable except the expected
 * amount and roughly the creation time - the ids differ
 * ("PEUA:1790219550000" vs "STATION-PEUA-1790219559000"), creationDate
 * differs by a few seconds, and actualAmount can differ while one side is
 * still pending (44197.0 vs 44197.68). So a pair is: identical expected
 * amount (to the paisa) and creation within SAME_RECORD_WINDOW_MS. Two real,
 * separate deposits with the same expected amount created within minutes of
 * each other at one station do not happen in practice; the same remittance
 * CODE is reused across days (one record per creation day), which this keeps
 * as separate records because their creation dates are days apart.
 */
export const SAME_RECORD_WINDOW_MS = 10 * 60 * 1000;

const STATUS_RANK: Record<string, number> = {
  SUBMITTED: 3,
  CREATED: 2,
  PENDING_SUBMISSION: 1,
};

function rank(row: RemittanceEntry): number {
  return STATUS_RANK[String(row.status ?? '').toUpperCase()] ?? 0;
}

function paise(value: number | undefined): number {
  return Math.round((Number(value) || 0) * 100);
}

function isSameRemittance(a: RemittanceEntry, b: RemittanceEntry): boolean {
  return (
    paise(a.expectedAmount?.value) === paise(b.expectedAmount?.value)
    && Math.abs(Number(a.creationDate) - Number(b.creationDate)) <= SAME_RECORD_WINDOW_MS
  );
}

/** The copy that is further along wins (tie -> `preferred`); its gaps are filled from the other. */
function combine(preferred: RemittanceEntry, other: RemittanceEntry): RemittanceEntry {
  const [base, fill] = rank(other) > rank(preferred) ? [other, preferred] : [preferred, other];
  return {
    ...base,
    remittanceCode: base.remittanceCode ?? fill.remittanceCode,
    submissionDate: base.submissionDate ?? fill.submissionDate,
    submittedBy: base.submittedBy ?? fill.submittedBy,
    createdBy: base.createdBy || fill.createdBy,
    stationVariance: base.stationVariance ?? fill.stationVariance ?? null,
    ttLink: base.ttLink ?? fill.ttLink ?? null,
  };
}

/**
 * Union of both sources with each real remittance appearing exactly once, so
 * totals are never double counted. `primary` (v1) wins ties.
 */
export function mergeRemittanceSources(
  primary: RemittanceEntry[],
  secondary: RemittanceEntry[],
): RemittanceEntry[] {
  const merged = [...primary];
  const paired = new Set<number>();
  for (const row of secondary) {
    const index = merged.findIndex((candidate, i) => !paired.has(i) && i < primary.length && isSameRemittance(candidate, row));
    if (index === -1) {
      merged.push(row);
      continue;
    }
    paired.add(index);
    merged[index] = combine(merged[index] as RemittanceEntry, row);
  }
  return merged;
}
