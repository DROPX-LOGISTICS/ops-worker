import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { validateHandler } from './routes/validate';
import { healthHandler } from './routes/health';
import { uploadSessionHandler, sessionStatusHandler } from './routes/adminSession';
import { listNotificationsHandler, acknowledgeNotificationHandler } from './routes/notifications';
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
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-admin-key'],
    maxAge: 86400,
  }),
);

app.onError(errorHandler);

app.get('/api/health', healthHandler);
app.get('/api/stations', (c) => c.json({ stations: Array.from(ALLOWED_STATIONS) }));
app.post('/api/validate', validateHandler);

// Owner-only: session upload/status + notification inbox. Gated behind
// ADMIN_API_KEY rather than the wide-open CORS policy above.
app.use('/api/admin/*', adminAuth);
app.post('/api/admin/session', uploadSessionHandler);
app.get('/api/admin/session/status', sessionStatusHandler);
app.get('/api/admin/notifications', listNotificationsHandler);
app.post('/api/admin/notifications/:id/ack', acknowledgeNotificationHandler);

app.notFound((c) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404));

export default app;