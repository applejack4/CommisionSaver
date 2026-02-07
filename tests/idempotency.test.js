const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { getDatabase } = require('../database');
const { withIdempotency } = require('../services/idempotency/with_idempotency');

async function resetAuditEvents() {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM audit_events', (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function countAuditEvents({ source, eventType, idempotencyKey }) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT COUNT(*) as count
       FROM audit_events
       WHERE source = ? AND event_type = ? AND idempotency_key = ?`,
      [source, eventType, idempotencyKey],
      (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row?.count || 0);
      }
    );
  });
}

beforeEach(async () => {
  await resetAuditEvents();
});

test('idempotency: whatsapp webhook replay executes once', async () => {
  const key = 'wamid.12345:text';
  const request = { body: { text: 'Book 2 seats' }, meta: { wamid: 'wamid.12345' } };
  let executions = 0;

  const response1 = await withIdempotency({
    source: 'whatsapp',
    eventType: 'text',
    idempotencyKey: key,
    request,
    handler: async () => {
      executions += 1;
      return { success: true, booking_id: 'book_1' };
    }
  });

  const response2 = await withIdempotency({
    source: 'whatsapp',
    eventType: 'text',
    idempotencyKey: key,
    request,
    handler: async () => {
      executions += 1;
      return { success: true, booking_id: 'book_1' };
    }
  });

  assert.strictEqual(executions, 1);
  assert.deepEqual(response2, response1);
  assert.strictEqual(
    await countAuditEvents({ source: 'whatsapp', eventType: 'text', idempotencyKey: key }),
    1
  );
});

test('idempotency: operator double-submit executes once', async () => {
  const key = 'op-req-1';
  const request = { params: { session_id: 'sess_10' }, body: { action: 'release' } };
  let executions = 0;

  const response1 = await withIdempotency({
    source: 'operator',
    eventType: 'takeover_release',
    idempotencyKey: key,
    request,
    handler: async () => {
      executions += 1;
      return { success: true, takeover_id: 'to_10' };
    }
  });

  const response2 = await withIdempotency({
    source: 'operator',
    eventType: 'takeover_release',
    idempotencyKey: key,
    request,
    handler: async () => {
      executions += 1;
      return { success: true, takeover_id: 'to_10' };
    }
  });

  assert.strictEqual(executions, 1);
  assert.deepEqual(response2, response1);
  assert.strictEqual(
    await countAuditEvents({ source: 'operator', eventType: 'takeover_release', idempotencyKey: key }),
    1
  );
});

test('idempotency: payment webhook replay executes once', async () => {
  const key = 'pay-event-1';
  const request = { gateway_event_id: key, status: 'SUCCESS' };
  let executions = 0;

  const response1 = await withIdempotency({
    source: 'payment',
    eventType: 'payment_success',
    idempotencyKey: key,
    request,
    handler: async () => {
      executions += 1;
      return { success: true, booking_id: 'book_5' };
    }
  });

  const response2 = await withIdempotency({
    source: 'payment',
    eventType: 'payment_success',
    idempotencyKey: key,
    request,
    handler: async () => {
      executions += 1;
      return { success: true, booking_id: 'book_5' };
    }
  });

  assert.strictEqual(executions, 1);
  assert.deepEqual(response2, response1);
  assert.strictEqual(
    await countAuditEvents({ source: 'payment', eventType: 'payment_success', idempotencyKey: key }),
    1
  );
});
