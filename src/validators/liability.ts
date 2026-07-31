import type { LiabilitySummary } from '../types';
import { isZero, round2 } from '../utils/number';

export interface LiabilityFieldCheck {
  field: string;
  value: number;
}

export interface LiabilityResult {
  passed: boolean;
  nonZeroFields: LiabilityFieldCheck[];
}

/**
 * Step 3: cashSummary + mposSummary must be entirely zeroed out — nothing
 * outstanding in expected/actual/short-excess amounts or counts, on either
 * side (cash or mPOS).
 */
export function checkLiability(summary: LiabilitySummary): LiabilityResult {
  const checks: LiabilityFieldCheck[] = [
    { field: 'cashSummary.expectedAmount', value: summary.cashSummary.expectedAmount.value },
    { field: 'cashSummary.actualAmount', value: summary.cashSummary.actualAmount.value },
    { field: 'cashSummary.shortExcessAmount', value: summary.cashSummary.shortExcessAmount.value },
    { field: 'cashSummary.count', value: summary.cashSummary.count },
    { field: 'mposSummary.amount', value: summary.mposSummary.amount.value },
    { field: 'mposSummary.count', value: summary.mposSummary.count },
  ];

  const nonZeroFields = checks
    .filter((c) => !isZero(c.value))
    .map((c) => ({ field: c.field, value: round2(c.value) }));

  return { passed: nonZeroFields.length === 0, nonZeroFields };
}
