console.log("SERVER.JS LOADED FROM:", __filename);

const express = require('express');
const cron = require('node-cron');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const { initializeDatabase } = require('./database');
const webhookRoutes = require('./routes/webhook');
const bookingRoutes = require('./routes/booking');
const tripRoutes = require('./routes/trip');
const routesRoutes = require('./routes/routes');
const operatorRoutes = require('./routes/operator');

const paymentWebhookHandler = require(
  './services/payment/payment_webhook_handler'
);

const { sendReminders } = require('./services/reminder');
const { expireHolds } = require('./services/holdExpiration');

const app = express();

/**
 * 🔐 Payment webhook MUST use raw body
 * This MUST come before express.json()
 */
app.use(
  '/webhooks/payment',
  express.raw({ type: 'application/json' })
);

console.log("Registering payment webhook route");

app.post('/webhooks/payment', paymentWebhookHandler);

/**
 * Normal JSON parsing for all other routes
 */
app.use(express.json());

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
app.use('/trip', tripRoutes);
app.use('/routes', routesRoutes);
app.use('/operator', operatorRoutes);

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
      try {
        await sendReminders();
      } catch (error) {
        console.error('Reminder job failed:', error.message);
      }
    });

    // Hold expiration job every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
      try {
        const result = await expireHolds();
        if (result.expired > 0) {
          console.log(`Expired ${result.expired} hold(s)`);
        }
      } catch (error) {
        console.error('Hold expiration job failed:', error.message);
      }
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
