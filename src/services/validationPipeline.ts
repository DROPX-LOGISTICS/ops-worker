import type { Env, ValidateRequestBody, PipelineResult, StepResult, CheckName } from '../types';
import type { StationDataProvider } from '../providers/StationDataProvider';
import type { OverrideStore } from '../store/OverrideStore';
import { getBusinessDayRange } from '../utils/dateRange';
import { checkPendingRecon } from '../validators/pendingRecon';
import { checkRemittanceMatch } from '../validators/remittanceMatch';
import { checkLiability } from '../validators/liability';
import { enrichReconciliationWithAgeing } from '../utils/reconState';
import { ValidationInputError } from '../errors';
import { ALLOWED_STATIONS } from '../config';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertValidRequest(body: ValidateRequestBody): void {
  if (!body?.stationCode || !ALLOWED_STATIONS.has(body.stationCode)) {
    throw new ValidationInputError(`Unknown or missing station code: ${body?.stationCode}`);
  }
  if (!body.date || !DATE_RE.test(body.date)) {
    throw new ValidationInputError('date is required and must be in YYYY-MM-DD format');
  }
  if (!body.denomination || typeof body.denomination.total !== 'number' || Number.isNaN(body.denomination.total)) {
    throw new ValidationInputError('denomination.total is required and must be a number');
  }
  if (!body.auth?.cookie || !body.auth?.xApiUsageKey) {
    throw new ValidationInputError('auth.cookie and auth.xApiUsageKey are required to call the station portal');
  }
}

/**
 * Runs the three checks in order — pendingRecon, remittanceMatch, liability —
 * stopping at the first unresolved failure. A failure is "resolved" only if
 * the caller supplied a matching entry in `overrides` with a reason, which
 * gets persisted before the pipeline continues to the next step.
 *
 * All upstream data is fetched concurrently up front (driver list -> driver
 * reconciliation is the only dependent chain; liability and remittances are
 * independent) so the sequential nature of the checks doesn't cost extra
 * round-trip latency.
 *
 * Pending recon is corrected from ageing `state` for the requested date
 * (Cash In Associate = pending) because Amazon's overallPendingRecon is
 * cumulative and can include later days' open cash.
 */
export async function runValidationPipeline(
  body: ValidateRequestBody,
  provider: StationDataProvider,
  store: OverrideStore,
  env: Env,
): Promise<PipelineResult> {
  assertValidRequest(body);

  const { stationCode, date, denomination, overrides = {} } = body;
  const auth = body.auth!;
  const range = getBusinessDayRange(date, Number(env.BUSINESS_DAY_START_HOUR_IST ?? '0'));

  const [rawReconciliation, ageingPackages, liabilitySummary, remittanceList] = await Promise.all([
    provider.getActiveDrivers(stationCode, auth).then((drivers) =>
      provider.getDriverReconciliation(stationCode, range, drivers, auth),
    ),
    provider.getAgeingDrillDownData(stationCode, date, auth),
    provider.getStationLiabilitySummary(stationCode, range, auth),
    provider.getRemittances(stationCode, range, auth),
  ]);

  const { entries: reconciliationList } = enrichReconciliationWithAgeing(
    rawReconciliation,
    ageingPackages,
  );

  const steps: StepResult[] = [];

  const step1 = await evaluateStep(
    'pendingRecon',
    checkPendingRecon(reconciliationList),
    overrides.pendingRecon,
    stationCode,
    date,
    store,
  );
  steps.push(step1);
  if (step1.status === 'failed') return finalize(steps, 'pendingRecon');

  const step2 = await evaluateStep(
    'remittanceMatch',
    checkRemittanceMatch(remittanceList, range, denomination.total),
    overrides.remittanceMatch,
    stationCode,
    date,
    store,
  );
  steps.push(step2);
  if (step2.status === 'failed') return finalize(steps, 'remittanceMatch');

  const step3 = await evaluateStep(
    'liability',
    checkLiability(liabilitySummary),
    overrides.liability,
    stationCode,
    date,
    store,
  );
  steps.push(step3);
  if (step3.status === 'failed') return finalize(steps, 'liability');

  return finalize(steps);

  async function finalize(allSteps: StepResult[], blockedAt?: CheckName): Promise<PipelineResult> {
    const status = blockedAt ? 'blocked' : 'passed';
    const runId = await store.recordRun({
      stationCode,
      businessDate: date,
      denominationTotal: denomination.total,
      status,
      blockedAt,
      steps: allSteps,
    });
    return { status, stationCode, date, blockedAt, steps: allSteps, runId };
  }
}

async function evaluateStep<TResult extends { passed: boolean }>(
  name: CheckName,
  result: TResult,
  override: { reason: string; overriddenBy: string } | undefined,
  stationCode: string,
  businessDate: string,
  store: OverrideStore,
): Promise<StepResult> {
  if (result.passed) {
    return { name, status: 'passed', details: result };
  }

  if (override?.reason) {
    await store.recordOverride({
      stationCode,
      businessDate,
      checkName: name,
      reason: override.reason,
      overriddenBy: override.overriddenBy || 'unknown',
      details: result,
    });
    return { name, status: 'overridden', details: result };
  }

  return { name, status: 'failed', details: result };
}
