const express = require('express');
const router = express.Router();
const operatorModel = require('../models/operator');
const bookingModel = require('../models/booking');
const routeModel = require('../models/route');
const tripModel = require('../models/trip');
const messageLogModel = require('../models/messageLog');
const whatsappService = require('../services/whatsapp');
const { parseBookingRequest, getHelpMessage } = require('../services/messageParser');
const { getDatabase } = require('../database');

const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const HOLD_DURATION_MINUTES = parseInt(process.env.HOLD_DURATION_MINUTES || '10', 10);

/**
 * Normalize phone number for matching (remove +, spaces, etc.)
 * @param {string} phoneNumber - Phone number in any format
 * @returns {string} Normalized phone number
 */
function normalizePhoneNumber(phoneNumber) {
  return phoneNumber.replace(/[\s+\-()]/g, '');
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
    // Always return 200 to WhatsApp to avoid retries
    res.status(200).send('OK');

    const body = req.body;
    
    if (!body.entry || !body.entry[0] || !body.entry[0].changes || !body.entry[0].changes[0]) {
      console.log('Invalid webhook payload structure');
      return;
    }

    const change = body.entry[0].changes[0];
    
    // Check if this is a messages webhook
    if (change.value && change.value.messages && change.value.messages[0]) {
      const message = change.value.messages[0];
      const from = message.from;
      const messageType = message.type;
      const normalizedFrom = normalizePhoneNumber(from);

      console.log(`Received ${messageType} message from ${normalizedFrom}`);

      // Identify sender: operator or customer
      const operator = await operatorModel.findByPhone(normalizedFrom);
      
      if (operator) {
        // Operator message handling
        await handleOperatorMessage(normalizedFrom, message, messageType);
      } else {
        // Customer message handling
        if (messageType === 'text') {
          const messageText = message.text?.body || '';
          await handleCustomerMessage(normalizedFrom, messageText);
        } else {
          console.log(`Customer ${normalizedFrom} sent non-text message, ignoring`);
        }
      }
    } else {
      console.log('No messages in webhook payload');
    }
  } catch (error) {
    console.error('Error processing webhook:', error);
  }
});

/**
 * Handle customer messages
 * @param {string} phoneNumber - Customer phone number
 * @param {string} messageText - Message text
 */
async function handleCustomerMessage(phoneNumber, messageText) {
  const upperText = messageText.toUpperCase().trim();
  
  // Check for help request
  if (upperText === 'HELP' || upperText === '?' || upperText.startsWith('HOW')) {
    try {
      await whatsappService.sendMessage(phoneNumber, getHelpMessage());
    } catch (error) {
      console.error('Failed to send help message:', error.message);
    }
    return;
  }

  // Parse booking request
  const bookingRequest = parseBookingRequest(messageText);
  
  if (!bookingRequest) {
    try {
      await whatsappService.sendMessage(
        phoneNumber,
        `I couldn't understand your booking request. Please use this format:\n\n${getHelpMessage()}`
      );
    } catch (error) {
      console.error('Failed to send error message:', error.message);
    }
    return;
  }

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
    const booking = await bookingModel.create({
      customer_phone: phoneNumber,
      trip_id: trip.id,
      seat_count: bookingRequest.seats,
      hold_duration_minutes: HOLD_DURATION_MINUTES
    });

    console.log(`Hold created: Booking ID ${booking.id} for ${bookingRequest.seats} seats`);

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
      const confirmedBooking = await bookingModel.confirmWithTicket(activeHold.id, mediaId);
      
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
    // Operator sent text - could be commands or just communication
    const messageText = message.text?.body || '';
    console.log(`Operator ${phoneNumber} sent text: ${messageText}`);
    // For now, we don't process operator text commands
    // This could be extended for manual confirmation/rejection if needed
  }
}

module.exports = router;
