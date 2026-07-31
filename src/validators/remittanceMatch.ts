import type { RemittanceEntry } from '../types';
import type { DateRange } from '../utils/dateRange';
import { approxEqual, round2 } from '../utils/number';

export interface RemittanceMatchResult {
  passed: boolean;
  expectedTotal: number;
  denominationTotal: number;
  difference: number;
  matchedRemittances: { remittanceId: string; status: string; actualAmount: number }[];
}

const RELEVANT_STATUSES = new Set(['CREATED', 'SUBMITTED']);

/**
 * Step 2: sum every CREATED/SUBMITTED remittance created on the given
 * business day and require it to match the cash denomination total the
 * user is submitting. Anything else (REJECTED, etc.) is ignored.
 */
export function checkRemittanceMatch(
  remittances: RemittanceEntry[],
  range: DateRange,
  denominationTotal: number,
): RemittanceMatchResult {
  const dayRemittances = remittances.filter(
    (r) => RELEVANT_STATUSES.has(r.status) && r.creationDate >= range.startTime && r.creationDate <= range.endTime,
  );

  const expectedTotal = dayRemittances.reduce((sum, r) => sum + (r.actualAmount?.value ?? 0), 0);

  return {
    passed: approxEqual(expectedTotal, denominationTotal),
    expectedTotal: round2(expectedTotal),
    denominationTotal: round2(denominationTotal),
    difference: round2(denominationTotal - expectedTotal),
    matchedRemittances: dayRemittances.map((r) => ({
      remittanceId: r.remittanceId,
      status: r.status,
      actualAmount: round2(r.actualAmount?.value ?? 0),
    })),
  };
}
