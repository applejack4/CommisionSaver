console.log("SERVER.JS LOADED FROM:", __filename);

const express = require('express');
const cron = require('node-cron');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const { initializeDatabase } = require('./database');
const webhookRoutes = require('./routes/webhook');
const bookingRoutes = require('./routes/booking');
const bookingsRoutes = require('./routes/bookings');
const tripRoutes = require('./routes/trip');
const routesRoutes = require('./routes/routes');
const operatorRoutes = require('./routes/operator');
const operatorDashboardRoutes = require('./routes/operator/dashboard');
const inventoryRoutes = require('./routes/inventory');

const paymentWebhookHandler = require(
  './services/payment/payment_webhook_handler'
);
const { withContext, buildRequestContext, buildRequestId } = require('./services/observability/request_context');
const { createLogger } = require('./services/observability/logger');
const metrics = require('./services/observability/metrics');
const { rateLimit } = require('./services/security/rate_limiter');
const { RetryableError } = require('./services/errors');

const { sendReminders } = require('./services/reminder');
const { expireHolds } = require('./services/holdExpiration');

const app = express();
const logger = createLogger({ source: 'http' });

metrics.setAlertHook((alert) => {
  logger.warn('metric_alert', alert);
});

app.use((req, res, next) => {
  const context = buildRequestContext(req);
  return withContext(context, () => {
    res.set('x-request-id', context.request_id);
    const startedAt = Date.now();
    logger.info('request_start', {
      method: req.method,
      path: req.originalUrl
    });
    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      metrics.recordLatency('request_duration_ms', durationMs, {
        method: req.method,
        path: req.route?.path || req.originalUrl
      });
      logger.info('request_end', {
        status: res.statusCode,
        duration_ms: durationMs
      });
    });
    next();
  });
});

/**
 * 🔐 Payment webhook MUST use raw body
 * This MUST come before express.json()
 */
app.use(
  '/webhooks/payment',
  express.raw({ type: 'application/json' })
);

app.use('/webhooks/payment', (req, res, next) => {
  try {
    rateLimit({
      scope: 'payment_webhook',
      identifier: req.ip,
      limit: Number.parseInt(process.env.RATE_LIMIT_WEBHOOKS || '60', 10),
      windowMs: 60000
    });
    next();
  } catch (error) {
    const status = error instanceof RetryableError ? 429 : 400;
    res.status(status).json({
      success: false,
      error: error.code || 'RATE_LIMITED'
    });
  }
});

console.log("Registering payment webhook route");

app.post('/webhooks/payment', paymentWebhookHandler);

/**
 * Normal JSON parsing for all other routes
 */
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

/**
 * Static UI
 */
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Application routes
 * (must come AFTER payment webhook)
 */
app.use('/', webhookRoutes);
app.use('/booking', bookingRoutes);
app.use('/bookings', bookingsRoutes);
app.use('/trip', tripRoutes);
app.use('/routes', routesRoutes);
app.use('/operator', operatorRoutes);
app.use('/operator/dashboard', operatorDashboardRoutes);
app.use('/inventory', inventoryRoutes);

/**
 * Health check
 */
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initializeDatabase();

    const server = app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

    // Reminder job every 30 minutes
    cron.schedule('*/30 * * * *', async () => {
      await withContext(
        { request_id: buildRequestId(), source: 'cron', job: 'reminder' },
        async () => {
          try {
            await sendReminders();
          } catch (error) {
            console.error('Reminder job failed:', error.message);
          }
        }
      );
    });

    // Hold expiration job every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
      await withContext(
        { request_id: buildRequestId(), source: 'cron', job: 'hold_expiration' },
        async () => {
          try {
            const result = await expireHolds();
            if (result.expired > 0) {
              console.log(`Expired ${result.expired} hold(s)`);
            }
          } catch (error) {
            console.error('Hold expiration job failed:', error.message);
          }
        }
      );
    });

    process.on('SIGINT', () => {
      console.log('Shutting down...');
      server.close(() => process.exit(0));
    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();
