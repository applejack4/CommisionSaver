const express = require('express');
const router = express.Router();
const operatorModel = require('../models/operator');
const bookingModel = require('../models/booking');
const routeModel = require('../models/route');
const tripModel = require('../models/trip');
const messageLogModel = require('../models/messageLog');
const operatorTakeoverModel = require('../models/operatorTakeover');
const whatsappService = require('../services/whatsapp');
const { parseBookingRequest, getHelpMessage } = require('../services/messageParser');
const { getDatabase } = require('../database');
const { createClient } = require('redis');
const { InventoryLockService } = require('../services/redis/InventoryLockService');
const { getLockKeysForBooking, releaseLockKeys } = require('../services/inventoryLocking');
const { acquireSeatLocks } = require('../services/inventory/seat_allocation_service');
const { withIdempotency } = require('../services/idempotency/with_idempotency');
const { RetryLaterError } = require('../services/idempotency/retry_later_error');
const { verifyWhatsAppWebhook } = require('../services/security/webhook_security');
const { rateLimit } = require('../services/security/rate_limiter');
const { RetryableError, NonRetryableError } = require('../services/errors');
const { getRedisClient } = require('../services/redis/redis_client');
const { createLogger } = require('../services/observability/logger');
const metrics = require('../services/observability/metrics');

const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const HOLD_DURATION_MINUTES = parseInt(process.env.HOLD_DURATION_MINUTES || '10', 10);
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const WHATSAPP_WEBHOOK_SECRET = process.env.WHATSAPP_WEBHOOK_SECRET;
const logger = createLogger({ source: 'whatsapp_webhook' });

/**
 * Normalize phone number for matching (remove +, spaces, etc.)
 * @param {string} phoneNumber - Phone number in any format
 * @returns {string} Normalized phone number
 */
function normalizePhoneNumber(phoneNumber) {
  return phoneNumber.replace(/[\s+\-()]/g, '');
}

async function isTakeoverActiveForCustomer(phoneNumber) {
  const bookings = await bookingModel.findByPhone(phoneNumber);
  if (!bookings || bookings.length === 0) {
    return false;
  }
  const latestBooking = bookings[0];
  const sessionId = `sess_${latestBooking.id}`;
  const activeTakeover = await operatorTakeoverModel.findActiveBySession(sessionId);
  return !!activeTakeover;
}

/**
 * Find route by source and destination (case-insensitive partial match)
 * @param {string} source - Source city
 * @param {string} destination - Destination city
 * @returns {Promise<Object|null>} Route object or null
 */
async function findRouteByCities(source, destination) {
  const db = await getDatabase();
  
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM routes 
       WHERE UPPER(source) LIKE UPPER(?) AND UPPER(destination) LIKE UPPER(?)
       ORDER BY id ASC LIMIT 1`,
      [`%${source}%`, `%${destination}%`],
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

/**
 * GET /whatsapp/webhook - Webhook verification endpoint
 */
router.get('/whatsapp/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
      console.log('Webhook verified');
      res.status(200).send(challenge);
    } else {
      console.log('Webhook verification failed: token mismatch');
      res.sendStatus(403);
    }
  } else {
    console.log('Webhook verification failed: missing parameters');
    res.sendStatus(400);
  }
});

/**
 * POST /whatsapp/webhook - Handle incoming WhatsApp messages
 */
router.post('/whatsapp/webhook', async (req, res) => {
  try {
    try {
      rateLimit({
        scope: 'whatsapp_webhook',
        identifier: req.ip,
        limit: Number.parseInt(process.env.RATE_LIMIT_WEBHOOKS || '60', 10),
        windowMs: 60000
      });
    } catch (error) {
      const status = error instanceof RetryableError ? 429 : 400;
      res.status(status).json({
        success: false,
        error: error.code || 'RATE_LIMITED'
      });
      return;
    }

    if (WHATSAPP_WEBHOOK_SECRET) {
      const rawBody = req.rawBody || JSON.stringify(req.body || {});
      const { client, close } = await getRedisClient();
      try {
        await verifyWhatsAppWebhook({
          rawBody,
          headers: req.headers,
          secret: WHATSAPP_WEBHOOK_SECRET,
          redisClient: client
        });
      } finally {
        await close();
      }
    }

    console.log("🔥 WEBHOOK HIT");
    console.log("Webhook payload:", JSON.stringify(req.body, null, 2));
    res.status(200).send('OK');

    const body = req.body;
    
    if (!body.entry || !body.entry[0] || !body.entry[0].changes || !body.entry[0].changes[0]) {
      console.log('Invalid webhook payload structure');
      console.log('Body structure:', {
        hasEntry: !!body.entry,
        entryLength: body.entry?.length,
        hasChanges: !!body.entry?.[0]?.changes,
        changesLength: body.entry?.[0]?.changes?.length
      });
      return;
    }

    const change = body.entry[0].changes[0];
    
    // Check if this is a messages webhook
    if (change.value && change.value.messages && change.value.messages[0]) {
      const message = change.value.messages[0];
      const from = message.from;
      const messageType = message.type;
      const normalizedFrom = normalizePhoneNumber(from);
      const wamid = message.id || message.wamid || message.message_id || 'unknown';
      const intent = messageType || 'unknown';
      const idempotencyKey = `${wamid}:${intent}`;

      console.log(`Received ${messageType} message from ${normalizedFrom} (original: ${from})`);
      metrics.increment('booking_attempts', 1, { source: 'whatsapp' });

      const handleMessageOnce = async () => {
        // Identify sender: operator or customer
        try {
          const operator = await operatorModel.findByPhone(normalizedFrom);

          if (operator) {
            console.log(`Identified as operator: ${operator.name} (ID: ${operator.id})`);
            // Operator message handling
            await handleOperatorMessage(normalizedFrom, message, messageType);
          } else {
            console.log(`Identified as customer: ${normalizedFrom}`);
            // Customer message handling
            if (messageType === 'text') {
              const messageText = message.text?.body || '';
              console.log(`Customer message text: "${messageText}"`);
              await handleCustomerMessage(normalizedFrom, messageText);
            } else {
              console.log(`Customer ${normalizedFrom} sent non-text message (${messageType}), ignoring`);
            }
          }
        } catch (handlerError) {
          console.error('Error in message handler:', handlerError);
          console.error('Stack trace:', handlerError.stack);
          // Try to send error notification to user
          try {
            await whatsappService.sendMessage(
              normalizedFrom,
              'Sorry, there was an error processing your message. Please try again later.'
            );
          } catch (notifyError) {
            console.error('Failed to send error notification:', notifyError.message);
          }
        }
      };

      try {
        await withIdempotency({
          source: 'whatsapp',
          eventType: intent,
          idempotencyKey,
          request: body,
          handler: handleMessageOnce
        });
      } catch (error) {
        if (error instanceof RetryLaterError) {
          console.warn('Duplicate WhatsApp message in-flight, skipping', {
            wamid,
            intent
          });
          return;
        }
        console.error('Idempotency wrapper error:', error);
      }
    } else {
      console.log('No messages in webhook payload');
      console.log('Change value:', JSON.stringify(change.value, null, 2));
    }
  } catch (error) {
    if (error instanceof RetryableError) {
      logger.warn('whatsapp_webhook_retryable_error', {
        error: error.message,
        code: error.code
      });
      if (!res.headersSent) {
        res.status(503).json({ success: false, error: error.code || 'RETRY_LATER' });
      }
      return;
    }
    if (error instanceof NonRetryableError) {
      logger.warn('whatsapp_webhook_rejected', {
        error: error.message,
        code: error.code
      });
      if (!res.headersSent) {
        res.status(401).json({ success: false, error: error.code || 'REJECTED' });
      }
      return;
    }
    console.error('Error processing webhook:', error);
    console.error('Error stack:', error.stack);
    console.error('Error details:', {
      message: error.message,
      name: error.name,
      code: error.code
    });
  }
});

/**
 * Handle customer messages
 * @param {string} phoneNumber - Customer phone number
 * @param {string} messageText - Message text
 */
async function handleCustomerMessage(phoneNumber, messageText) {
  console.log(`[handleCustomerMessage] Processing message from ${phoneNumber}: "${messageText}"`);
  const upperText = messageText.toUpperCase().trim();

  if (await isTakeoverActiveForCustomer(phoneNumber)) {
    console.log(`[handleCustomerMessage] Takeover active for ${phoneNumber}; skipping auto-reply.`);
    return;
  }
  
  // Check for help request
  if (upperText === 'HELP' || upperText === '?' || upperText.startsWith('HOW')) {
    console.log(`[handleCustomerMessage] Help request detected from ${phoneNumber}`);
    try {
      const helpMsg = getHelpMessage();
      console.log(`[handleCustomerMessage] Sending help message to ${phoneNumber}`);
      await whatsappService.sendMessage(phoneNumber, helpMsg);
      console.log(`[handleCustomerMessage] Help message sent successfully to ${phoneNumber}`);
    } catch (error) {
      console.error(`[handleCustomerMessage] Failed to send help message to ${phoneNumber}:`, error.message);
      console.error('Error stack:', error.stack);
      throw error; // Re-throw to be caught by outer handler
    }
    return;
  }

  // Parse booking request
  console.log(`[handleCustomerMessage] Parsing booking request from ${phoneNumber}`);
  const bookingRequest = parseBookingRequest(messageText);
  
  if (!bookingRequest) {
    console.log(`[handleCustomerMessage] Could not parse booking request from ${phoneNumber}`);
    try {
      const errorMsg = `I couldn't understand your booking request. Please use this format:\n\n${getHelpMessage()}`;
      console.log(`[handleCustomerMessage] Sending parse error message to ${phoneNumber}`);
      await whatsappService.sendMessage(phoneNumber, errorMsg);
      console.log(`[handleCustomerMessage] Parse error message sent successfully to ${phoneNumber}`);
    } catch (error) {
      console.error(`[handleCustomerMessage] Failed to send error message to ${phoneNumber}:`, error.message);
      console.error('Error stack:', error.stack);
      throw error;
    }
    return;
  }
  
  console.log(`[handleCustomerMessage] Parsed booking request:`, bookingRequest);

  // Validate parsed data
  if (!bookingRequest.source || !bookingRequest.destination || 
      !bookingRequest.date || !bookingRequest.time || !bookingRequest.seats) {
    try {
      await whatsappService.sendMessage(
        phoneNumber,
        'Please provide all details: source, destination, date, time, and number of seats.'
      );
    } catch (error) {
      console.error('Failed to send validation error:', error.message);
    }
    return;
  }

  if (bookingRequest.seats < 1) {
    try {
      await whatsappService.sendMessage(phoneNumber, 'Please request at least 1 seat.');
    } catch (error) {
      console.error('Failed to send validation error:', error.message);
    }
    return;
  }

  // Find matching route
  const route = await findRouteByCities(bookingRequest.source, bookingRequest.destination);
  
  if (!route) {
    try {
      await whatsappService.sendMessage(
        phoneNumber,
        `Sorry, no route found from ${bookingRequest.source} to ${bookingRequest.destination}. Please check and try again.`
      );
    } catch (error) {
      console.error('Failed to send route error:', error.message);
    }
    return;
  }

  // Find matching trip
  const trip = await tripModel.findByRouteDateTime(
    route.id,
    bookingRequest.date,
    bookingRequest.time
  );

  if (!trip) {
    try {
      await whatsappService.sendMessage(
        phoneNumber,
        `Sorry, no trip found for ${bookingRequest.date} at ${bookingRequest.time}. Please check the date and time.`
      );
    } catch (error) {
      console.error('Failed to send trip error:', error.message);
    }
    return;
  }

  // Check seat availability
  const availableSeats = await tripModel.getAvailableSeats(trip.id);
  
  if (availableSeats < bookingRequest.seats) {
    try {
      await whatsappService.sendMessage(
        phoneNumber,
        `Sorry, only ${availableSeats} seat(s) available for this trip. Please request fewer seats or try another trip.`
      );
    } catch (error) {
      console.error('Failed to send availability error:', error.message);
    }
    return;
  }

  // Create HOLD booking
  try {
    const holdExpiresAt = new Date(Date.now() + HOLD_DURATION_MINUTES * 60 * 1000);
    const ttlSeconds = Math.max(
      1,
      Math.ceil((holdExpiresAt.getTime() - Date.now()) / 1000)
    );
    const sessionId = `sess_${phoneNumber}_${Date.now()}`;

    // Acquire Redis locks before DB hold to enforce "no lock -> no hold".
    const redisHandle = await getRedisClient();
    const redisClient = redisHandle.client;
    const lockService = new InventoryLockService(redisClient);

    let lockPayload = null;
    let booking = null;
    try {
      lockPayload = await acquireSeatLocks({
        lockService,
        trip,
        seatCount: bookingRequest.seats,
        sessionId,
        ttlSeconds
      });

      if (!lockPayload.acquired) {
        try {
          await whatsappService.sendMessage(phoneNumber, 'Seats unavailable');
        } catch (error) {
          console.error('Failed to send lock failure message:', error.message);
        }
        return;
      }

      try {
        booking = await bookingModel.create({
          customer_phone: phoneNumber,
          trip_id: trip.id,
          seat_count: bookingRequest.seats,
          hold_duration_minutes: HOLD_DURATION_MINUTES,
          hold_expires_at: holdExpiresAt.toISOString(),
          seat_numbers: lockPayload.seatNumbers,
          lock_keys: lockPayload.lockKeys,
          lock_key: lockPayload.lockKeys[0]
        });
      } catch (error) {
        await releaseLockKeys(lockService, lockPayload.lockKeys, {
          bookingId: null,
          reason: 'hold-insert-failed'
        });
        throw error;
      }
    } finally {
      await redisHandle.close();
    }

    console.log(`Hold created: Booking ID ${booking.id} for ${bookingRequest.seats} seats`);
    metrics.increment('booking_success', 1, { source: 'whatsapp' });

    // Get operator phone
    const operatorPhone = process.env.OPERATOR_PHONE || '1234567890';
    const operator = await operatorModel.findByPhone(operatorPhone);

    // Notify customer
    try {
      const customerMessage = `✅ Seats available! Your booking request has been received.\n\n` +
        `Booking ID: ${booking.id}\n` +
        `Route: ${route.source} → ${route.destination}\n` +
        `Date: ${bookingRequest.date}\n` +
        `Time: ${bookingRequest.time}\n` +
        `Seats: ${bookingRequest.seats}\n` +
        `Price: ₹${route.price * bookingRequest.seats}\n\n` +
        `Your seats are on hold for ${HOLD_DURATION_MINUTES} minutes. ` +
        `The operator will contact you shortly to confirm.`;

      await whatsappService.sendMessage(phoneNumber, customerMessage);
      
      await messageLogModel.create({
        booking_id: booking.id,
        type: 'hold_notification'
      });
    } catch (whatsappError) {
      console.warn('Failed to notify customer:', whatsappError.message);
    }

    // Notify operator
    if (operator) {
      try {
        const operatorMessage = `🔔 New Booking Request!\n\n` +
          `Booking ID: ${booking.id}\n` +
          `Customer: ${phoneNumber}\n` +
          `Route: ${route.source} → ${route.destination}\n` +
          `Date: ${bookingRequest.date}\n` +
          `Time: ${bookingRequest.time}\n` +
          `Seats: ${bookingRequest.seats}\n` +
          `Price: ₹${route.price * bookingRequest.seats}\n\n` +
          `⚠️ Hold expires in ${HOLD_DURATION_MINUTES} minutes\n\n` +
          `Please contact the customer and send the ticket to confirm the booking.`;

        await whatsappService.sendMessage(operator.phone_number, operatorMessage);
        
        await messageLogModel.create({
          booking_id: booking.id,
          type: 'operator_notification'
        });
      } catch (whatsappError) {
        console.warn('Failed to notify operator:', whatsappError.message);
      }
    }
  } catch (error) {
    console.error('Error creating booking hold:', error);
    metrics.increment('booking_failures', 1, { source: 'whatsapp' });
    try {
      await whatsappService.sendMessage(
        phoneNumber,
        'Sorry, there was an error processing your booking request. Please try again later.'
      );
    } catch (notifyError) {
      console.error('Failed to notify customer of error:', notifyError);
    }
  }
}

/**
 * Handle operator messages (ticket detection and confirmation)
 * @param {string} phoneNumber - Operator phone number
 * @param {Object} message - WhatsApp message object
 * @param {string} messageType - Message type (text, image, document, etc.)
 */
async function handleOperatorMessage(phoneNumber, message, messageType) {
  console.log(`[handleOperatorMessage] Processing ${messageType} message from operator ${phoneNumber}`);
  
  // Check if operator sent a ticket (image or document)
  if (messageType === 'image' || messageType === 'document') {
    const mediaId = message.image?.id || message.document?.id;
    const mediaType = messageType;
    
    if (!mediaId) {
      console.log('Operator sent media but no media ID found');
      return;
    }

    // Find active holds for this operator's trips
    // For now, we'll find the most recent active hold
    const db = await getDatabase();
    
    // Get operator's routes
    const operator = await operatorModel.findByPhone(phoneNumber);
    if (!operator) {
      console.log('Operator not found');
      return;
    }

    // Find most recent active hold
    const activeHold = await new Promise((resolve, reject) => {
      db.get(
        `SELECT b.*, t.journey_date, t.departure_time, r.source, r.destination, r.operator_id
         FROM bookings b
         JOIN trips t ON b.trip_id = t.id
         JOIN routes r ON t.route_id = r.id
         WHERE r.operator_id = ? AND b.status = 'hold' AND b.hold_expires_at > datetime('now')
         ORDER BY b.created_at DESC LIMIT 1`,
        [operator.id],
        (err, row) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(row || null);
        }
      );
    });

    if (!activeHold) {
      try {
        await whatsappService.sendMessage(
          phoneNumber,
          'No active booking holds found. Please send the ticket for an active booking request.'
        );
      } catch (error) {
        console.error('Failed to notify operator:', error.message);
      }
      return;
    }

    // Confirm booking with ticket
    try {
      const lockKeys = getLockKeysForBooking(activeHold);
      const redisClient = createClient({ url: REDIS_URL });
      await redisClient.connect();
      const lockService = new InventoryLockService(redisClient);

      let confirmedBooking = null;
      try {
        confirmedBooking = await bookingModel.confirmWithTicket(activeHold.id, mediaId, {
          releaseInventoryLock: async () =>
            releaseLockKeys(lockService, lockKeys, {
              bookingId: activeHold.id,
              reason: 'confirm'
            })
        });
      } finally {
        try {
          await redisClient.quit();
        } catch (error) {
          redisClient.disconnect();
        }
      }
      
      if (!confirmedBooking) {
        throw new Error('Failed to confirm booking');
      }

      // Store ticket attachment
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO ticket_attachments (booking_id, media_id, media_type)
           VALUES (?, ?, ?)`,
          [activeHold.id, mediaId, mediaType],
          function (err) {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          }
        );
      });

      console.log(`Booking ${activeHold.id} confirmed with ticket (media ID: ${mediaId})`);

      // Notify customer
      try {
        const customerMessage = `🎉 Your booking has been confirmed!\n\n` +
          `Booking ID: ${activeHold.id}\n` +
          `Route: ${activeHold.source} → ${activeHold.destination}\n` +
          `Date: ${activeHold.journey_date}\n` +
          `Time: ${activeHold.departure_time}\n` +
          `Seats: ${activeHold.seat_count}\n\n` +
          `Thank you for choosing us!`;

        await whatsappService.sendMessage(activeHold.customer_phone, customerMessage);
        
        await messageLogModel.create({
          booking_id: activeHold.id,
          type: 'confirmation'
        });
      } catch (whatsappError) {
        console.warn('Failed to notify customer of confirmation:', whatsappError.message);
      }

      // Notify operator
      try {
        await whatsappService.sendMessage(
          phoneNumber,
          `✅ Booking ${activeHold.id} has been confirmed and customer has been notified.`
        );
      } catch (whatsappError) {
        console.warn('Failed to notify operator:', whatsappError.message);
      }
    } catch (error) {
      console.error('Error confirming booking with ticket:', error);
      try {
        await whatsappService.sendMessage(
          phoneNumber,
          'Sorry, there was an error confirming the booking. Please try again.'
        );
      } catch (notifyError) {
        console.error('Failed to notify operator of error:', notifyError);
      }
    }
  } else if (messageType === 'text') {
    // Operator sent text - send acknowledgment
    const messageText = message.text?.body || '';
    console.log(`[handleOperatorMessage] Operator ${phoneNumber} sent text: "${messageText}"`);
    
    
    try {
      console.log(`[handleOperatorMessage] Sending acknowledgment to operator ${phoneNumber}`);
      const result = await whatsappService.sendMessage(
        phoneNumber,
        '✅ Message received. Your message has been acknowledged.'
      );
      console.log(`[handleOperatorMessage] Acknowledgment sent successfully to operator ${phoneNumber}`, result);
    } catch (error) {
      console.error(`[handleOperatorMessage] Failed to send acknowledgment to operator ${phoneNumber}:`, error.message);
      console.error('Error stack:', error.stack);
      throw error; // Re-throw to be caught by outer handler
    }
  } else {
    // Operator sent other message type (audio, video, etc.)
    console.log(`Operator ${phoneNumber} sent ${messageType} message`);
    
    try {
      await whatsappService.sendMessage(
        phoneNumber,
        '✅ Message received. Your message has been acknowledged.'
      );
    } catch (error) {
      console.error('Failed to send acknowledgment to operator:', error.message);
    }
  }
}

module.exports = router;
