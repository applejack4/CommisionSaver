const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { getDatabase } = require('../database');
const { withIdempotency } = require('../services/idempotency/with_idempotency');
const { RetryLaterError } = require('../services/idempotency/retry_later_error');
const { STARTED_TTL_SECONDS } = require('../services/idempotency/audit_repo');

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

// ---------------------------------------------------------------------------
// Crash-recovery: stuck 'started' rows
// ---------------------------------------------------------------------------

async function insertStuckStartedRow({ source, eventType, idempotencyKey, ageSeconds }) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO audit_events
        (id, source, event_type, idempotency_key, status, created_at)
       VALUES (?, ?, ?, ?, 'started', datetime('now', ?))`,
      [
        `stuck_${Date.now()}`,
        source,
        eventType,
        idempotencyKey,
        `-${ageSeconds} seconds`
      ],
      (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      }
    );
  });
}

async function getAuditRow({ source, eventType, idempotencyKey }) {
  const db = await getDatabase();
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT id, status, response_snapshot, created_at
       FROM audit_events
       WHERE source = ? AND event_type = ? AND idempotency_key = ?
       LIMIT 1`,
      [source, eventType, idempotencyKey],
      (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row || null);
      }
    );
  });
}

test('crash-recovery: stuck started row is taken over after TTL', async () => {
  const key = `stuck_takeover_${Date.now()}`;
  const ageSeconds = STARTED_TTL_SECONDS + 60; // well past TTL

  await insertStuckStartedRow({
    source: 'payment',
    eventType: 'payment_success',
    idempotencyKey: key,
    ageSeconds
  });

  // Verify row exists as 'started'
  const before = await getAuditRow({
    source: 'payment',
    eventType: 'payment_success',
    idempotencyKey: key
  });
  assert.strictEqual(before.status, 'started');

  // Handler should run because the stuck row is taken over
  let executions = 0;
  const response = await withIdempotency({
    source: 'payment',
    eventType: 'payment_success',
    idempotencyKey: key,
    request: { gateway_event_id: key, status: 'SUCCESS' },
    handler: async () => {
      executions += 1;
      return { recovered: true, booking_id: 'book_recovered' };
    }
  });

  assert.strictEqual(executions, 1);
  assert.deepStrictEqual(response, { recovered: true, booking_id: 'book_recovered' });

  // Row should now be completed
  const after = await getAuditRow({
    source: 'payment',
    eventType: 'payment_success',
    idempotencyKey: key
  });
  assert.strictEqual(after.status, 'completed');

  // Still exactly one row
  assert.strictEqual(
    await countAuditEvents({
      source: 'payment',
      eventType: 'payment_success',
      idempotencyKey: key
    }),
    1
  );
});

test('crash-recovery: recent started row is NOT taken over (throws RetryLaterError)', async () => {
  const key = `recent_started_${Date.now()}`;

  // Insert a row that is only 5 seconds old — well within the TTL
  await insertStuckStartedRow({
    source: 'payment',
    eventType: 'payment_success',
    idempotencyKey: key,
    ageSeconds: 5
  });

  await assert.rejects(
    () =>
      withIdempotency({
        source: 'payment',
        eventType: 'payment_success',
        idempotencyKey: key,
        request: { gateway_event_id: key, status: 'SUCCESS' },
        handler: async () => ({ should_not_run: true })
      }),
    (err) => {
      assert.strictEqual(err.name, 'RetryLaterError');
      return true;
    }
  );

  // Row should still be 'started' — not taken over
  const row = await getAuditRow({
    source: 'payment',
    eventType: 'payment_success',
    idempotencyKey: key
  });
  assert.strictEqual(row.status, 'started');
});

test('crash-recovery: takeover then duplicate returns cached response', async () => {
  const key = `takeover_then_dup_${Date.now()}`;
  const ageSeconds = STARTED_TTL_SECONDS + 60;

  await insertStuckStartedRow({
    source: 'payment',
    eventType: 'payment_success',
    idempotencyKey: key,
    ageSeconds
  });

  let executions = 0;
  const handlerFn = async () => {
    executions += 1;
    return { recovered: true };
  };

  // First call: takeover and run handler
  const response1 = await withIdempotency({
    source: 'payment',
    eventType: 'payment_success',
    idempotencyKey: key,
    request: { test: true },
    handler: handlerFn
  });

  // Second call: should return cached response, NOT run handler again
  const response2 = await withIdempotency({
    source: 'payment',
    eventType: 'payment_success',
    idempotencyKey: key,
    request: { test: true },
    handler: handlerFn
  });

  assert.strictEqual(executions, 1);
  assert.deepStrictEqual(response1, { recovered: true });
  assert.deepStrictEqual(response2, response1);
});

test('crash-recovery: handler failure after takeover marks row failed', async () => {
  const key = `takeover_fail_${Date.now()}`;
  const ageSeconds = STARTED_TTL_SECONDS + 60;

  await insertStuckStartedRow({
    source: 'payment',
    eventType: 'payment_success',
    idempotencyKey: key,
    ageSeconds
  });

  await assert.rejects(
    () =>
      withIdempotency({
        source: 'payment',
        eventType: 'payment_success',
        idempotencyKey: key,
        request: { test: true },
        handler: async () => {
          throw new Error('handler crashed on retry');
        }
      }),
    /handler crashed on retry/
  );

  const row = await getAuditRow({
    source: 'payment',
    eventType: 'payment_success',
    idempotencyKey: key
  });
  assert.strictEqual(row.status, 'failed');
});
