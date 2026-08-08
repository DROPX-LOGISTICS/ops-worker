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
} from './routes/executiveAmazon';
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
app.post('/api/admin/validate', validateHandler);
app.post('/api/admin/session', uploadSessionHandler);
app.get('/api/admin/session/status', sessionStatusHandler);
app.post('/api/admin/session/ensure', ensureSessionHandler);
app.post('/api/admin/session/refresh', refreshSessionHandler);
app.post('/api/admin/amazon/liability-summary', liabilitySummaryHandler);
app.post('/api/admin/executive/driver-reconciliation', driverReconciliationHandler);
app.post('/api/admin/executive/liability-summary', liabilitySummaryExecutiveHandler);
app.post('/api/admin/executive/remittance', remittanceHandler);
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

export default app;
