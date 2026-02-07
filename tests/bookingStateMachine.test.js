const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bookingModel = require('../models/booking');
const tripModel = require('../models/trip');
const { getDatabase } = require('../database');
const { processPaymentEvent } = require('../services/payment/payment_processor');

async function getAnyTripId() {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.get('SELECT id FROM trips LIMIT 1', (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      if (!row) {
        reject(new Error('No trips available for booking test data'));
        return;
      }
      resolve(row.id);
    });
  });
}

async function resetBookingData() {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('DELETE FROM bookings', (bookingErr) => {
        if (bookingErr) {
          reject(bookingErr);
          return;
        }
        db.run('DELETE FROM audit_events', (auditErr) => {
          if (auditErr) {
            reject(auditErr);
            return;
          }
          resolve();
        });
      });
    });
  });
}

function listJsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

async function createHoldBooking(trip, overrides = {}) {
  const lockKey = `lock:trip:${trip.id}:seat:1`;
  return bookingModel.create({
    customer_name: overrides.customer_name || 'State Machine',
    customer_phone: overrides.customer_phone || `900${Date.now()}`,
    trip_id: trip.id,
    seat_count: overrides.seat_count || 1,
    hold_duration_minutes: overrides.hold_duration_minutes || 10,
    lock_key: lockKey
  });
}

beforeEach(async () => {
  await resetBookingData();
});

test('booking transitions allow hold -> confirmed/cancelled/expired', async () => {
  const tripId = await getAnyTripId();
  const trip = await tripModel.findById(tripId);

  const holdForConfirm = await createHoldBooking(trip, { customer_phone: `901${Date.now()}` });
  const confirmed = await bookingModel.transitionStatus(holdForConfirm.id, 'confirmed');
  assert.strictEqual(confirmed.status, 'confirmed');

  const holdForCancel = await createHoldBooking(trip, { customer_phone: `902${Date.now()}` });
  const cancelled = await bookingModel.transitionStatus(holdForCancel.id, 'cancelled');
  assert.strictEqual(cancelled.status, 'cancelled');

  const holdForExpire = await createHoldBooking(trip, { customer_phone: `903${Date.now()}` });
  const expired = await bookingModel.transitionStatus(holdForExpire.id, 'expired');
  assert.strictEqual(expired.status, 'expired');
});

test('booking transitions reject invalid state changes', async () => {
  const tripId = await getAnyTripId();
  const trip = await tripModel.findById(tripId);

  const hold = await createHoldBooking(trip, { customer_phone: `904${Date.now()}` });
  await bookingModel.transitionStatus(hold.id, 'confirmed');

  await assert.rejects(
    () => bookingModel.transitionStatus(hold.id, 'expired'),
    /Disallowed booking status transition/
  );

  const holdToCancel = await createHoldBooking(trip, { customer_phone: `905${Date.now()}` });
  await bookingModel.transitionStatus(holdToCancel.id, 'cancelled');

  await assert.rejects(
    () => bookingModel.transitionStatus(holdToCancel.id, 'confirmed'),
    /Disallowed booking status transition/
  );
});

test('seat availability releases only on cancel/expire transitions', async () => {
  const tripId = await getAnyTripId();
  const trip = await tripModel.findById(tripId);
  const baseline = await tripModel.getAvailableSeats(tripId);

  const holdToConfirm = await createHoldBooking(trip, { customer_phone: `906${Date.now()}` });
  const afterHold = await tripModel.getAvailableSeats(tripId);
  assert.strictEqual(afterHold, baseline - 1);

  await bookingModel.transitionStatus(holdToConfirm.id, 'confirmed');
  const afterConfirm = await tripModel.getAvailableSeats(tripId);
  assert.strictEqual(afterConfirm, baseline - 1);

  await bookingModel.transitionStatus(holdToConfirm.id, 'cancelled');
  const afterCancel = await tripModel.getAvailableSeats(tripId);
  assert.strictEqual(afterCancel, baseline);

  await resetBookingData();
  const holdToCancel = await createHoldBooking(trip, { customer_phone: `907${Date.now()}` });
  await bookingModel.transitionStatus(holdToCancel.id, 'cancelled');
  const afterHoldCancel = await tripModel.getAvailableSeats(tripId);
  assert.strictEqual(afterHoldCancel, baseline);

  await resetBookingData();
  const holdToExpire = await createHoldBooking(trip, { customer_phone: `908${Date.now()}` });
  await bookingModel.transitionStatus(holdToExpire.id, 'expired');
  const afterHoldExpire = await tripModel.getAvailableSeats(tripId);
  assert.strictEqual(afterHoldExpire, baseline);
});

test('payment webhook is idempotent when booking is not in hold', async () => {
  const tripId = await getAnyTripId();
  const trip = await tripModel.findById(tripId);
  const hold = await createHoldBooking(trip, { customer_phone: `909${Date.now()}` });
  await bookingModel.transitionStatus(hold.id, 'confirmed');

  const result = await processPaymentEvent(
    {
      gateway_event_id: `evt_repeat_${hold.id}`,
      status: 'SUCCESS',
      metadata: { booking_id: hold.id }
    },
    { redisClient: {} }
  );

  assert.strictEqual(result.idempotent, true);
  const refreshed = await bookingModel.findById(hold.id);
  assert.strictEqual(refreshed.status, 'confirmed');
});

test('booking status updates flow through transitionStatus', async () => {
  const repoRoot = path.join(__dirname, '..');
  const files = listJsFiles(repoRoot);
  const directUpdates = [];

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (/UPDATE\s+bookings\s+SET\s+status/i.test(content)) {
      directUpdates.push(path.relative(repoRoot, filePath));
    }
  }

  assert.deepStrictEqual(directUpdates, ['database.js']);

  const bookingSource = fs.readFileSync(
    path.join(repoRoot, 'models', 'booking.js'),
    'utf8'
  );
  assert.match(bookingSource, /function updateStatus[\s\S]*transitionStatus/);
  assert.match(bookingSource, /function confirmWithTicket[\s\S]*transitionStatus/);
  assert.match(bookingSource, /function expireHold[\s\S]*transitionStatus/);
});
