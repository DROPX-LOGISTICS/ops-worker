import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { validateHandler } from './routes/validate';
import { healthHandler } from './routes/health';
import {
  uploadSessionHandler,
  sessionStatusHandler,
  refreshSessionHandler,
  ensureSessionHandler,
} from './routes/adminSession';
import { getCredentialsHandler, upsertCredentialsHandler } from './routes/adminCredentials';
import { liabilitySummaryHandler } from './routes/adminAmazonProbe';
import {
  driverReconciliationHandler,
  liabilitySummaryExecutiveHandler,
  remittanceHandler,
  remittanceVerifyHandler,
} from './routes/executiveAmazon';
import {
  ciaStationHandler,
  ciaNetworkHandler,
  ciaDailyLedgerHandler,
  ciaRefreshHandler,
  ciaNextStationHandler,
  ciaContinueHandler,
  ciaReleaseClaimHandler,
  ciaTouchClaimHandler,
} from './routes/cashInAssociate';
import { ciaDailyCron, ciaTickerCron } from './services/ciaSnapshotRunner';
import { dbDiagHandler } from './routes/dbDiag';
import { listNotificationsHandler, acknowledgeNotificationHandler } from './routes/notifications';
import {
  uploadWorkforceSessionHandler,
  workforceSessionStatusHandler,
  ensureWorkforceSessionHandler,
  refreshWorkforceSessionHandler,
  syncWorkforceRosterHandler,
  listWorkforceAssociatesHandler,
  getWorkforceAssociateHandler,
} from './routes/adminWorkforce';
import { adminAuth } from './middleware/adminAuth';
import { errorHandler } from './middleware/errorHandler';
import { ALLOWED_STATIONS } from './config';

const app = new Hono<{ Bindings: Env }>();

app.use(
  '*',
  cors({
    // TODO: lock this down to your frontend's actual origin(s) before going
    // to production, e.g. ['https://your-frontend.example.com'].
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-admin-key'],
    maxAge: 86400,
  }),
);

app.onError(errorHandler);

app.get('/api/health', healthHandler);
app.get('/api/stations', (c) => c.json({ stations: Array.from(ALLOWED_STATIONS) }));

// All Amazon-backed routes require x-admin-key.
app.use('/api/admin/*', adminAuth);

// Which Supabase project is wired up, and is its schema complete? Feature
// endpoints degrade to empty results when a table is missing, so this is the
// only place that separates "not migrated" from "migrated but no data yet".
app.get('/api/admin/diag/db', dbDiagHandler);

app.post('/api/admin/validate', validateHandler);
app.post('/api/admin/session', uploadSessionHandler);
app.get('/api/admin/session/status', sessionStatusHandler);
app.post('/api/admin/session/ensure', ensureSessionHandler);
app.post('/api/admin/session/refresh', refreshSessionHandler);
app.post('/api/admin/amazon/liability-summary', liabilitySummaryHandler);
app.post('/api/admin/executive/driver-reconciliation', driverReconciliationHandler);
app.post('/api/admin/executive/liability-summary', liabilitySummaryExecutiveHandler);
app.post('/api/admin/executive/remittance', remittanceHandler);
app.post('/api/admin/executive/remittance/verify', remittanceVerifyHandler);
app.get('/api/admin/executive/cash-in-associate/network', ciaNetworkHandler);
app.get('/api/admin/executive/cash-in-associate/daily-ledger', ciaDailyLedgerHandler);
app.get('/api/admin/executive/cash-in-associate', ciaStationHandler);
app.post('/api/admin/executive/cash-in-associate/refresh', ciaRefreshHandler);
app.get('/api/admin/internal/cia-snapshot/next-station', ciaNextStationHandler);
app.post('/api/admin/internal/cia-snapshot/next-station', ciaNextStationHandler);
app.post('/api/admin/internal/cia-snapshot/release-claim', ciaReleaseClaimHandler);
app.post('/api/admin/internal/cia-snapshot/touch-claim', ciaTouchClaimHandler);
app.post('/api/admin/internal/cia-snapshot/continue', ciaContinueHandler);

// Common mix-up: Ops Pulse BFF paths are on the Next.js app, not this Worker.
app.all('/api/ops-pulse/*', (c) =>
  c.json(
    {
      error: 'Not found on cash-recon-worker',
      code: 'NOT_FOUND',
      hint:
        'Use /api/admin/executive/cash-in-associate?stationCode=&fromDate=&toDate= with header x-admin-key. '
        + 'Browser calls should go through dropx-ops-pulse /api/ops-pulse/cod/cash-recon/*.',
    },
    404,
  ),
);
app.get('/api/admin/credentials', getCredentialsHandler);
app.put('/api/admin/credentials', upsertCredentialsHandler);
app.get('/api/admin/notifications', listNotificationsHandler);
app.post('/api/admin/notifications/:id/ack', acknowledgeNotificationHandler);

// Workforce portal (logistics.amazon.in) — separate cookie jar from station portal.
app.put('/api/admin/workforce/session', uploadWorkforceSessionHandler);
app.get('/api/admin/workforce/session/status', workforceSessionStatusHandler);
app.post('/api/admin/workforce/session/ensure', ensureWorkforceSessionHandler);
app.post('/api/admin/workforce/session/refresh', refreshWorkforceSessionHandler);
app.post('/api/admin/workforce/roster/sync', syncWorkforceRosterHandler);
app.get('/api/admin/workforce/associates', listWorkforceAssociatesHandler);
app.get('/api/admin/workforce/associates/:transporterId', getWorkforceAssociateHandler);

app.notFound((c) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404));

/** Cron that starts the daily Cash In Associate run (06:00 IST). */
const CIA_DAILY_CRON = '30 0 * * *';

/**
 * Cash In Associate snapshots:
 * - 00:30 UTC (06:00 IST): start/resume the daily run + first 7-day chunk.
 * - Every 3 minutes: one 7-day chunk of the next unfinished station (in-process,
 *   no nested Worker HTTP — that path hits Cloudflare 1042).
 */
async function scheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const job =
    event.cron === CIA_DAILY_CRON
      ? ciaDailyCron(env).then((run) => {
          console.log(`CIA daily run ${run.id} status=${run.status}`);
        })
      : ciaTickerCron(env).then((tick) => {
          if (tick.processedStation) {
            console.log(
              `CIA tick processed ${tick.processedStation} (done=${tick.done})`,
            );
          }
        });
  ctx.waitUntil(
    job.catch((err) => {
      console.error('CIA scheduled job failed', err);
    }),
  );
}

export default {
  fetch: app.fetch,
  scheduled,
};
