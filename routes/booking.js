const express = require('express');
const router = express.Router();
const operatorModel = require('../models/operator');
const bookingModel = require('../models/booking');
const routeModel = require('../models/route');
const messageLogModel = require('../models/messageLog');
const whatsappService = require('../services/whatsapp');
const { getDatabase } = require('../database');

/**
 * Get the first route from database (default route for bookings)
 * @returns {Promise<Object|null>} First route object or null if not found
 */
async function getFirstRoute() {
  const db = await getDatabase();
  
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM routes ORDER BY id ASC LIMIT 1',
      [],
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
 * Find the latest pending booking
 * @param {number} bookingId - Optional booking ID to find specific booking
 * @returns {Promise<Object|null>} Latest pending booking or null if not found
 */
async function getLatestPendingBooking(bookingId = null) {
  const db = await getDatabase();
  
  if (bookingId) {
    return bookingModel.findById(bookingId);
  }
  
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM bookings WHERE status = ? ORDER BY created_at DESC LIMIT 1',
      ['pending'],
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
 * POST /booking/create - Create a new booking (internal endpoint)
 * Request body:
 * - customer_phone (required): Customer phone number
 * - customer_name (optional): Customer name (defaults to "Customer")
 * - route_id (optional): Route ID (defaults to first route)
 * - journey_date (optional): Journey date in YYYY-MM-DD format (defaults to tomorrow)
 * - seat_count (optional): Number of seats (defaults to 1)
 */
router.post('/create', async (req, res) => {
  try {
    const { customer_phone, customer_name, route_id, journey_date, seat_count } = req.body;

    if (!customer_phone) {
      return res.status(400).json({
        success: false,
        error: 'customer_phone is required'
      });
    }

    // Get route (use provided route_id or default to first route)
    let route;
    if (route_id) {
      route = await routeModel.findById(route_id);
      if (!route) {
        return res.status(404).json({
          success: false,
          error: 'Route not found'
        });
      }
    } else {
      route = await getFirstRoute();
      if (!route) {
        return res.status(404).json({
          success: false,
          error: 'No routes found in database. Cannot create booking.'
        });
      }
    }

    // Calculate journey date (use provided date or default to tomorrow)
    let journeyDate;
    if (journey_date) {
      journeyDate = journey_date;
    } else {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      journeyDate = tomorrow.toISOString().split('T')[0]; // YYYY-MM-DD format
    }

    // Create booking
    const booking = await bookingModel.create({
      customer_name: customer_name || 'Customer', // Default name
      customer_phone: customer_phone,
      route_id: route.id,
      journey_date: journeyDate,
      seat_count: seat_count || 1, // Default seat count
      status: 'pending'
    });

    console.log(`Booking created: ID ${booking.id} for customer ${customer_phone}`);

    // Get operator phone number (from env or use default)
    const operatorPhone = process.env.OPERATOR_PHONE || '1234567890';
    const operator = await operatorModel.findByPhone(operatorPhone);
    
    if (!operator) {
      console.error('No operator found. Cannot send notification.');
      // Still return success for booking creation, but log the error
      return res.status(200).json({
        success: true,
        booking: booking,
        warning: 'Booking created but operator notification failed - operator not found'
      });
    }

    // Get route details for notification
    const routeDetails = await routeModel.findById(route.id);
    
    // Send notification to operator (optional - don't fail if WhatsApp is not configured)
    try {
      const operatorMessage = `New Booking Request!\n\n` +
        `Booking ID: ${booking.id}\n` +
        `Customer: ${customer_phone}\n` +
        `Route: ${routeDetails.source} → ${routeDetails.destination}\n` +
        `Date: ${journeyDate}\n` +
        `Time: ${routeDetails.departure_time}\n` +
        `Seats: ${booking.seat_count}\n` +
        `Price: ₹${routeDetails.price}\n\n` +
        `Reply YES to confirm or NO to reject.`;

      await whatsappService.sendMessage(operator.phone_number, operatorMessage);
      
      // Log notification message
      await messageLogModel.create({
        booking_id: booking.id,
        type: 'notification'
      });
      
      console.log(`Booking notification sent to operator`);
    } catch (whatsappError) {
      console.warn('WhatsApp notification to operator failed (booking still created):', whatsappError.message);
    }

    // Send confirmation to customer (optional - don't fail if WhatsApp is not configured)
    try {
      const customerMessage = `Your booking request has been received!\n\n` +
        `Booking ID: ${booking.id}\n` +
        `Route: ${routeDetails.source} → ${routeDetails.destination}\n` +
        `Date: ${journeyDate}\n` +
        `Time: ${routeDetails.departure_time}\n` +
        `Seats: ${booking.seat_count}\n` +
        `Price: ₹${routeDetails.price}\n\n` +
        `We will confirm your booking shortly.`;

      await whatsappService.sendMessage(customer_phone, customerMessage);
      console.log(`Booking acknowledgment sent to customer`);
    } catch (whatsappError) {
      console.warn('WhatsApp acknowledgment to customer failed (booking still created):', whatsappError.message);
    }

    res.status(201).json({
      success: true,
      booking: booking,
      message: 'Booking created successfully'
    });
  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error while creating booking',
      details: error.message
    });
  }
});

/**
 * POST /booking/confirm - Confirm a booking (internal endpoint)
 * Request body:
 * - operator_phone (optional): Operator phone number (for logging)
 * - booking_id (optional): Specific booking ID to confirm (defaults to latest pending booking)
 */
router.post('/confirm', async (req, res) => {
  try {
    const { operator_phone, booking_id } = req.body;

    // Find pending booking (use provided booking_id or default to latest)
    const booking = await getLatestPendingBooking(booking_id);
    
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: 'No pending bookings found for confirmation'
      });
    }

    if (booking.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `Booking ${booking.id} is not in pending status (current status: ${booking.status})`
      });
    }

    // Update booking status
    const updatedBooking = await bookingModel.updateStatus(booking.id, 'confirmed');
    
    if (!updatedBooking) {
      return res.status(500).json({
        success: false,
        error: 'Failed to update booking status'
      });
    }

    console.log(`Booking ${booking.id} confirmed${operator_phone ? ` by operator ${operator_phone}` : ''}`);

    // Get route details
    const route = await routeModel.findById(booking.route_id);
    
    if (!route) {
      return res.status(404).json({
        success: false,
        error: 'Route not found for booking'
      });
    }

    // Send confirmation to customer (optional - don't fail if WhatsApp is not configured)
    try {
      const customerMessage = `✅ Your booking has been confirmed!\n\n` +
        `Booking ID: ${booking.id}\n` +
        `Route: ${route.source} → ${route.destination}\n` +
        `Date: ${booking.journey_date}\n` +
        `Time: ${route.departure_time}\n` +
        `Seats: ${booking.seat_count}\n` +
        `Price: ₹${route.price}\n\n` +
        `Thank you for choosing us!`;

      await whatsappService.sendMessage(booking.customer_phone, customerMessage);
      
      // Log confirmation message
      await messageLogModel.create({
        booking_id: booking.id,
        type: 'confirmation'
      });
      
      console.log(`Booking confirmation sent to customer ${booking.customer_phone}`);
    } catch (whatsappError) {
      console.warn('WhatsApp confirmation to customer failed (booking still confirmed):', whatsappError.message);
    }

    // Notify operator if phone number provided (optional - don't fail if WhatsApp is not configured)
    if (operator_phone) {
      try {
        await whatsappService.sendMessage(
          operator_phone,
          `Booking ${booking.id} has been confirmed and customer has been notified.`
        );
      } catch (whatsappError) {
        console.warn('WhatsApp notification to operator failed:', whatsappError.message);
      }
    }

    res.status(200).json({
      success: true,
      booking: updatedBooking,
      message: 'Booking confirmed successfully'
    });
  } catch (error) {
    console.error('Error confirming booking:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error while confirming booking',
      details: error.message
    });
  }
});

/**
 * POST /booking/reject - Reject a booking (internal endpoint)
 * Request body:
 * - operator_phone (optional): Operator phone number (for logging)
 * - booking_id (optional): Specific booking ID to reject (defaults to latest pending booking)
 */
router.post('/reject', async (req, res) => {
  try {
    const { operator_phone, booking_id } = req.body;

    // Find pending booking (use provided booking_id or default to latest)
    const booking = await getLatestPendingBooking(booking_id);
    
    if (!booking) {
      return res.status(404).json({
        success: false,
        error: 'No pending bookings found for rejection'
      });
    }

    if (booking.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `Booking ${booking.id} is not in pending status (current status: ${booking.status})`
      });
    }

    // Update booking status
    const updatedBooking = await bookingModel.updateStatus(booking.id, 'rejected');
    
    if (!updatedBooking) {
      return res.status(500).json({
        success: false,
        error: 'Failed to update booking status'
      });
    }

    console.log(`Booking ${booking.id} rejected${operator_phone ? ` by operator ${operator_phone}` : ''}`);

    // Get route details
    const route = await routeModel.findById(booking.route_id);
    
    if (!route) {
      return res.status(404).json({
        success: false,
        error: 'Route not found for booking'
      });
    }

    // Send rejection to customer (optional - don't fail if WhatsApp is not configured)
    try {
      const customerMessage = `❌ Your booking request has been rejected.\n\n` +
        `Booking ID: ${booking.id}\n` +
        `Route: ${route.source} → ${route.destination}\n` +
        `Date: ${booking.journey_date}\n\n` +
        `We apologize for the inconvenience. Please contact us for alternative options.`;

      await whatsappService.sendMessage(booking.customer_phone, customerMessage);
      
      // Log rejection message
      await messageLogModel.create({
        booking_id: booking.id,
        type: 'rejection'
      });
      
      console.log(`Booking rejection sent to customer ${booking.customer_phone}`);
    } catch (whatsappError) {
      console.warn('WhatsApp rejection to customer failed (booking still rejected):', whatsappError.message);
    }

    // Notify operator if phone number provided (optional - don't fail if WhatsApp is not configured)
    if (operator_phone) {
      try {
        await whatsappService.sendMessage(
          operator_phone,
          `Booking ${booking.id} has been rejected and customer has been notified.`
        );
      } catch (whatsappError) {
        console.warn('WhatsApp notification to operator failed:', whatsappError.message);
      }
    }

    res.status(200).json({
      success: true,
      booking: updatedBooking,
      message: 'Booking rejected successfully'
    });
  } catch (error) {
    console.error('Error rejecting booking:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error while rejecting booking',
      details: error.message
    });
  }
});

module.exports = router;
