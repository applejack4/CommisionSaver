const express = require('express');
const router = express.Router();
const bookingModel = require('../models/booking');
const { getDatabase } = require('../database');
const operatorTakeoverModel = require('../models/operatorTakeover');
const auditEventModel = require('../models/auditEvent');
const { buildSeatLockKey, getLockKeysForBooking } = require('../services/inventoryLocking');
const { withIdempotency } = require('../services/idempotency/with_idempotency');
const { RetryLaterError } = require('../services/idempotency/retry_later_error');

const DEFAULT_LIMIT = 50;

function requireIdempotencyKey(req, res) {
  const key = req.get('X-Idempotency-Key');
  if (!key) {
    res.status(400).json({
      success: false,
      error: 'IDEMPOTENCY_KEY_REQUIRED'
    });
    return null;
  }
  return key;
}

function toIsoTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    if (value.includes('T')) {
      return value.endsWith('Z') ? value : `${value}Z`;
    }
    // SQLite timestamps use "YYYY-MM-DD HH:MM:SS"
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)) {
      return value.replace(' ', 'T') + 'Z';
    }
  }
  return new Date(value).toISOString();
}

function mapBookingState(status) {
  switch ((status || '').toLowerCase()) {
    case 'hold':
      return 'LOCKED';
    case 'confirmed':
      return 'CONFIRMED';
    case 'expired':
      return 'EXPIRED';
    case 'cancelled':
      return 'EXPIRED';
    default:
      return 'DRAFT';
  }
}

function derivePaymentStatus(bookingState) {
  switch (bookingState) {
    case 'LOCKED':
      return 'PENDING';
    case 'CONFIRMED':
      return 'SUCCESS';
    case 'EXPIRED':
      return 'FAILED';
    default:
      return null;
  }
}

function buildRouteLabel(booking) {
  if (!booking || !booking.source || !booking.destination) {
    return null;
  }
  return `${booking.source} \u2192 ${booking.destination}`;
}

function buildSessionId(bookingId) {
  if (!bookingId) return 'sess_mock';
  return `sess_${bookingId}`;
}

function parseBookingIdFromSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  if (!sessionId.startsWith('sess_')) return null;
  const numeric = parseInt(sessionId.replace('sess_', ''), 10);
  return Number.isNaN(numeric) ? null : numeric;
}

function buildSessionFromBooking(booking) {
  const bookingState = mapBookingState(booking?.status);
  const paymentStatus = derivePaymentStatus(bookingState);
  const lastMessageAt = toIsoTimestamp(booking?.created_at) || new Date().toISOString();

  return {
    session_id: buildSessionId(booking?.id),
    customer_phone: booking?.customer_phone || '+910000000000',
    customer_name: booking?.customer_name || null,
    last_message_excerpt: booking?.status
      ? `Booking status: ${booking.status}`
      : 'Booking request received',
    last_message_at: lastMessageAt,
    conversation_state: 'BOOKING_FLOW',
    booking_state: bookingState,
    booking_id: booking?.id ? `book_${booking.id}` : null,
    payment_status: paymentStatus,
    payment_amount: booking?.price ?? null,
    payment_currency: booking?.price != null ? 'INR' : null,
    payment_expires_at: booking?.hold_expires_at
      ? toIsoTimestamp(booking.hold_expires_at)
      : null,
    takeover_status: 'AVAILABLE',
    assigned_operator_id: null,
    unread_count: 0,
    requires_action: false
  };
}

function applyTakeoverToSession(session, takeover) {
  const updated = { ...session };
  if (!takeover) {
    updated.takeover_status = 'AVAILABLE';
    updated.assigned_operator_id = null;
    return updated;
  }
  if (takeover.status === 'ACTIVE') {
    updated.takeover_status = 'ACTIVE';
    updated.assigned_operator_id = takeover.operator_id;
    return updated;
  }
  updated.takeover_status = 'RELEASED';
  updated.assigned_operator_id = null;
  return updated;
}

function buildTakeoverPayload(takeover, overrideStatus = null) {
  const status = overrideStatus || takeover.status;
  const payload = {
    takeover_id: `to_${takeover.id}`,
    status,
    operator_id: takeover.operator_id
  };

  if (status === 'ACTIVE') {
    payload.started_at = toIsoTimestamp(takeover.started_at);
  }

  if (status === 'RELEASED') {
    payload.ended_at = toIsoTimestamp(takeover.ended_at);
  }

  return payload;
}

function buildBookingSummary(booking) {
  if (!booking) return null;

  return {
    booking_id: `book_${booking.id}`,
    booking_state: mapBookingState(booking.status),
    seat_count: booking.seat_count,
    trip_id: booking.trip_id ? `trip_${booking.trip_id}` : null,
    route_label: buildRouteLabel(booking),
    journey_date: booking.journey_date || null,
    departure_time: booking.departure_time || null,
    price_amount: booking.price ?? null,
    price_currency: booking.price != null ? 'INR' : null,
    lock_expires_at: booking.hold_expires_at
      ? toIsoTimestamp(booking.hold_expires_at)
      : null
  };
}

function buildPaymentSummary(booking) {
  const bookingState = mapBookingState(booking?.status);
  const paymentStatus = derivePaymentStatus(bookingState);

  return {
    status: paymentStatus,
    gateway_ref: paymentStatus ? `pay_${booking?.id || 'mock'}` : null,
    pay_link_url: paymentStatus === 'PENDING'
      ? `https://pay.example/${booking?.id || 'mock'}`
      : null,
    pay_link_expires_at: paymentStatus === 'PENDING'
      ? toIsoTimestamp(booking?.hold_expires_at) || null
      : null,
    last_event_at: toIsoTimestamp(booking?.created_at) || new Date().toISOString()
  };
}

function buildMessagesForBooking(booking) {
  const baseTime = toIsoTimestamp(booking?.created_at) || new Date().toISOString();
  const customerPhone = booking?.customer_phone || '+910000000000';
  const messageIdSuffix = booking?.id || 'mock';

  return [
    {
      message_id: `msg_in_${messageIdSuffix}`,
      direction: 'INBOUND',
      from: customerPhone,
      to: 'whatsapp:+910000000001',
      type: 'text',
      text: 'Need seats for tomorrow',
      media: null,
      timestamp: baseTime,
      status: 'DELIVERED',
      wa_message_id: `wamid.mock.${messageIdSuffix}.in`,
      error: null
    },
    {
      message_id: `msg_out_${messageIdSuffix}`,
      direction: 'OUTBOUND',
      from: 'whatsapp:+910000000001',
      to: customerPhone,
      type: 'text',
      text: 'Got it. Confirming availability now.',
      media: null,
      timestamp: new Date(new Date(baseTime).getTime() + 60000).toISOString(),
      status: 'SENT',
      wa_message_id: `wamid.mock.${messageIdSuffix}.out`,
      error: null
    }
  ];
}

async function getRecentBookings(limit) {
  const db = await getDatabase();
  const safeLimit = Number.isFinite(limit) ? limit : DEFAULT_LIMIT;

  return new Promise((resolve, reject) => {
    db.all(
      `SELECT b.*, t.journey_date, t.departure_time, r.source, r.destination, r.price
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       JOIN routes r ON t.route_id = r.id
       ORDER BY b.created_at DESC
       LIMIT ?`,
      [safeLimit],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(rows || []);
      }
    );
  });
}

function applySessionFilters(sessions, query) {
  let filtered = sessions;

  if (query.conversation_state) {
    filtered = filtered.filter(
      session => session.conversation_state === query.conversation_state
    );
  }

  if (query.booking_state) {
    filtered = filtered.filter(
      session => session.booking_state === query.booking_state
    );
  }

  if (query.payment_status) {
    filtered = filtered.filter(
      session => session.payment_status === query.payment_status
    );
  }

  if (query.has_takeover !== undefined) {
    const hasTakeover = query.has_takeover === 'true' || query.has_takeover === true;
    filtered = filtered.filter(
      session => (session.takeover_status === 'ACTIVE') === hasTakeover
    );
  }

  if (query.search) {
    const search = query.search.toLowerCase();
    filtered = filtered.filter(session => {
      const phone = (session.customer_phone || '').toLowerCase();
      const name = (session.customer_name || '').toLowerCase();
      return phone.includes(search) || name.includes(search);
    });
  }

  if (query.status) {
    if (query.status === 'closed') {
      filtered = filtered.filter(session => session.booking_state === 'EXPIRED');
    } else if (query.status === 'active') {
      filtered = filtered.filter(session => session.booking_state !== 'EXPIRED');
    }
  }

  return filtered;
}

function buildMockSession() {
  const now = new Date().toISOString();
  return {
    is_mock: true,
    session_id: 'sess_mock_1',
    customer_phone: '+910000000000',
    customer_name: 'Mock Customer',
    last_message_excerpt: 'Need 2 seats',
    last_message_at: now,
    conversation_state: 'BOOKING_FLOW',
    booking_state: 'PAYMENT_PENDING',
    booking_id: 'book_mock_1',
    payment_status: 'PENDING',
    payment_amount: 1200,
    payment_currency: 'INR',
    payment_expires_at: now,
    takeover_status: 'AVAILABLE',
    assigned_operator_id: null,
    unread_count: 0,
    requires_action: true
  };
}

function buildMockBooking(bookingId) {
  const now = new Date().toISOString();
  return {
    is_mock: true,
    booking_id: `book_${bookingId || 'mock'}`,
    session_id: buildSessionId(bookingId),
    booking_state: 'PAYMENT_PENDING',
    seat_count: 2,
    customer_phone: '+910000000000',
    trip_id: 'trip_mock_1',
    route_label: `CityA \u2192 CityB`,
    journey_date: now.split('T')[0],
    departure_time: '09:00',
    price_amount: 1200,
    price_currency: 'INR',
    lock_key: `lock:trip:mock:seat:1`,
    lock_expires_at: now,
    ticket_media_id: null,
    created_at: now,
    updated_at: now
  };
}

function buildMockPayment() {
  return {
    data_source: 'stub',
    status: 'PENDING',
    gateway_ref: 'pay_mock',
    pay_link_url: 'https://pay.example/mock',
    pay_link_expires_at: new Date().toISOString(),
    last_event_at: new Date().toISOString()
  };
}

function dedupeSessionsById(sessions) {
  const unique = new Map();
  sessions.forEach(session => {
    if (!unique.has(session.session_id)) {
      unique.set(session.session_id, session);
    }
  });
  return Array.from(unique.values());
}

/**
 * GET /operator/sessions - List recent/active WhatsApp sessions for operators
 */
router.get('/sessions', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || DEFAULT_LIMIT;
    const bookings = await getRecentBookings(limit);
    const sessions = bookings.map(buildSessionFromBooking);

    const sourceSessions = sessions.length ? sessions : [buildMockSession()];
    const deduped = dedupeSessionsById(sourceSessions);
    const sessionIds = deduped.map(session => session.session_id);
    const takeoverMap = await operatorTakeoverModel.findLatestBySessionIds(sessionIds);
    const enriched = deduped.map(session => applyTakeoverToSession(
      session,
      takeoverMap.get(session.session_id) || null
    ));
    const filtered = applySessionFilters(enriched, req.query);

    res.status(200).json({
      success: true,
      sessions: filtered,
      next_cursor: null
    });
  } catch (error) {
    console.error('Error fetching operator sessions:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

/**
 * GET /operator/sessions/:session_id - Session header + booking/payment summary
 */
router.get('/sessions/:session_id', async (req, res) => {
  try {
    const sessionId = req.params.session_id;
    const bookingId = parseBookingIdFromSessionId(sessionId);
    const booking = bookingId ? await bookingModel.findById(bookingId) : null;

    const baseSession = booking ? buildSessionFromBooking(booking) : buildMockSession();
    const latestTakeover = await operatorTakeoverModel.findLatestBySession(sessionId);
    const session = applyTakeoverToSession(baseSession, latestTakeover);
    const bookingSummary = booking ? buildBookingSummary(booking) : buildMockBooking(bookingId);
    const paymentSummary = booking ? buildPaymentSummary(booking) : buildMockPayment();

    res.status(200).json({
      success: true,
      session: {
        session_id: session.session_id,
        customer_phone: session.customer_phone,
        customer_name: session.customer_name,
        conversation_state: session.conversation_state,
        takeover_status: session.takeover_status,
        assigned_operator_id: session.assigned_operator_id,
        last_message_at: session.last_message_at
      },
      booking: {
        booking_id: bookingSummary.booking_id,
        booking_state: bookingSummary.booking_state,
        seat_count: bookingSummary.seat_count,
        trip_id: bookingSummary.trip_id,
        route_label: bookingSummary.route_label,
        journey_date: bookingSummary.journey_date,
        departure_time: bookingSummary.departure_time,
        price_amount: bookingSummary.price_amount,
        price_currency: bookingSummary.price_currency,
        lock_expires_at: bookingSummary.lock_expires_at
      },
      payment: paymentSummary
    });
  } catch (error) {
    console.error('Error fetching session detail:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

/**
 * GET /operator/sessions/:session_id/messages - Message timeline
 */
router.get('/sessions/:session_id/messages', async (req, res) => {
  try {
    const sessionId = req.params.session_id;
    const bookingId = parseBookingIdFromSessionId(sessionId);
    const booking = bookingId ? await bookingModel.findById(bookingId) : null;
    const messages = buildMessagesForBooking(booking);

    res.status(200).json({
      success: true,
      messages,
      next_cursor: null
    });
  } catch (error) {
    console.error('Error fetching session messages:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

/**
 * GET /operator/bookings/:booking_id - Full booking detail for the card
 */
router.get('/bookings/:booking_id', async (req, res) => {
  try {
    const bookingId = parseInt(req.params.booking_id, 10);
    const booking = Number.isNaN(bookingId)
      ? null
      : await bookingModel.findById(bookingId);

    if (!booking) {
      res.status(200).json({
        success: true,
        booking: buildMockBooking(req.params.booking_id)
      });
      return;
    }

    res.status(200).json({
      success: true,
      booking: {
        booking_id: `book_${booking.id}`,
        session_id: buildSessionId(booking.id),
        booking_state: mapBookingState(booking.status),
        seat_count: booking.seat_count,
        customer_phone: booking.customer_phone,
        trip_id: booking.trip_id ? `trip_${booking.trip_id}` : null,
        route_label: buildRouteLabel(booking),
        journey_date: booking.journey_date || null,
        departure_time: booking.departure_time || null,
        price_amount: booking.price ?? null,
        price_currency: booking.price != null ? 'INR' : null,
        lock_key: (() => {
          const lockKeys = getLockKeysForBooking(booking);
          if (lockKeys.length > 0) {
            return lockKeys[0];
          }
          if (booking.trip_id) {
            return buildSeatLockKey(booking.trip_id, 1);
          }
          return 'lock:trip:unknown:seat:unknown';
        })(),
        lock_expires_at: booking.hold_expires_at
          ? toIsoTimestamp(booking.hold_expires_at)
          : null,
        ticket_media_id: booking.ticket_attachment_id || null,
        created_at: toIsoTimestamp(booking.created_at),
        updated_at: toIsoTimestamp(booking.ticket_received_at || booking.created_at)
      }
    });
  } catch (error) {
    console.error('Error fetching operator booking:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

/**
 * POST /operator/sessions/:session_id/takeover - Start operator takeover
 */
router.post('/sessions/:session_id/takeover', async (req, res) => {
  const idempotencyKey = requireIdempotencyKey(req, res);
  if (!idempotencyKey) return;

  try {
    const response = await withIdempotency({
      source: 'operator',
      eventType: 'takeover_start',
      idempotencyKey,
      request: { params: req.params, body: req.body },
      handler: async () => {
        const sessionId = req.params.session_id;
        const { operator_id: operatorId, reason = null } = req.body || {};

        if (!operatorId) {
          return {
            status: 400,
            body: { success: false, error: 'operator_id is required' }
          };
        }

        if (!sessionId) {
          return {
            status: 400,
            body: { success: false, error: 'session_id is required' }
          };
        }

        const activeTakeover = await operatorTakeoverModel.findActiveBySession(sessionId);
        if (activeTakeover) {
          if (activeTakeover.operator_id !== operatorId) {
            return {
              status: 409,
              body: {
                success: false,
                error: 'TAKEOVER_ALREADY_ACTIVE',
                assigned_operator_id: activeTakeover.operator_id
              }
            };
          }

          const takeoverPayload = buildTakeoverPayload(activeTakeover, 'ACTIVE');
          return {
            status: 200,
            body: { success: true, takeover: takeoverPayload }
          };
        }

        const bookingId = parseBookingIdFromSessionId(sessionId);
        const takeover = await operatorTakeoverModel.createTakeover({
          session_id: sessionId,
          booking_id: bookingId,
          operator_id: operatorId,
          reason
        });

        const takeoverPayload = buildTakeoverPayload(takeover, 'ACTIVE');
        await auditEventModel.create({
          event_type: 'TAKEOVER_STARTED',
          session_id: sessionId,
          operator_id: operatorId,
          takeover_id: takeover.id,
          idempotency_key: idempotencyKey,
          payload: takeoverPayload
        });

        return {
          status: 200,
          body: { success: true, takeover: takeoverPayload }
        };
      }
    });

    res.status(response.status).json(response.body);
  } catch (error) {
    if (error instanceof RetryLaterError) {
      res.status(error.statusCode || 409).json({
        success: false,
        error: 'RETRY_LATER'
      });
      return;
    }
    console.error('Error starting operator takeover:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

/**
 * PATCH /operator/sessions/:session_id/takeover - Update takeover (release/resume)
 */
router.patch('/sessions/:session_id/takeover', async (req, res) => {
  const idempotencyKey = requireIdempotencyKey(req, res);
  if (!idempotencyKey) return;

  try {
    const sessionId = req.params.session_id;
    const { action } = req.body || {};
    const eventType = action === 'release' ? 'takeover_release' : 'takeover_resume';

    const response = await withIdempotency({
      source: 'operator',
      eventType,
      idempotencyKey,
      request: { params: req.params, body: req.body },
      handler: async () => {
        if (!sessionId) {
          return {
            status: 400,
            body: { success: false, error: 'session_id is required' }
          };
        }

        if (!action || !['release', 'resume'].includes(action)) {
          return {
            status: 400,
            body: { success: false, error: 'action must be release or resume' }
          };
        }

        const activeTakeover = await operatorTakeoverModel.findActiveBySession(sessionId);
        if (action === 'release') {
          if (!activeTakeover) {
            const latest = await operatorTakeoverModel.findLatestBySession(sessionId);
            if (!latest) {
              return {
                status: 404,
                body: { success: false, error: 'TAKEOVER_NOT_FOUND' }
              };
            }
            const takeoverPayload = buildTakeoverPayload(latest, 'RELEASED');
            return {
              status: 200,
              body: { success: true, takeover: takeoverPayload }
            };
          }

          const released = await operatorTakeoverModel.releaseTakeover(activeTakeover.id);
          const takeoverPayload = buildTakeoverPayload(released, 'RELEASED');
          await auditEventModel.create({
            event_type: 'TAKEOVER_RELEASED',
            session_id: sessionId,
            operator_id: released.operator_id,
            takeover_id: released.id,
            idempotency_key: idempotencyKey,
            payload: takeoverPayload
          });

          return {
            status: 200,
            body: { success: true, takeover: takeoverPayload }
          };
        }

        if (action === 'resume') {
          if (activeTakeover) {
            const takeoverPayload = buildTakeoverPayload(activeTakeover, 'ACTIVE');
            return {
              status: 200,
              body: { success: true, takeover: takeoverPayload }
            };
          }

          const latest = await operatorTakeoverModel.findLatestBySession(sessionId);
          if (!latest) {
            return {
              status: 404,
              body: { success: false, error: 'TAKEOVER_NOT_FOUND' }
            };
          }

          const bookingId = parseBookingIdFromSessionId(sessionId);
          const resumed = await operatorTakeoverModel.createTakeover({
            session_id: sessionId,
            booking_id: bookingId,
            operator_id: latest.operator_id,
            reason: 'resume'
          });
          const takeoverPayload = buildTakeoverPayload(resumed, 'ACTIVE');
          await auditEventModel.create({
            event_type: 'TAKEOVER_RESUMED',
            session_id: sessionId,
            operator_id: resumed.operator_id,
            takeover_id: resumed.id,
            idempotency_key: idempotencyKey,
            payload: takeoverPayload
          });

          return {
            status: 200,
            body: { success: true, takeover: takeoverPayload }
          };
        }

        return {
          status: 400,
          body: { success: false, error: 'action must be release or resume' }
        };
      }
    });

    res.status(response.status).json(response.body);
  } catch (error) {
    if (error instanceof RetryLaterError) {
      res.status(error.statusCode || 409).json({
        success: false,
        error: 'RETRY_LATER'
      });
      return;
    }
    console.error('Error updating operator takeover:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

module.exports = router;
