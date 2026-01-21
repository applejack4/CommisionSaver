const express = require('express');
const router = express.Router();
const tripModel = require('../models/trip');
const routeModel = require('../models/route');
const bookingModel = require('../models/booking');

/**
 * GET /trip - Get all trips (with optional date range filter)
 * Query params: startDate, endDate (YYYY-MM-DD)
 */
router.get('/', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    let trips;
    if (startDate && endDate) {
      trips = await tripModel.findByDateRange(startDate, endDate);
    } else {
      // Get trips for next 30 days by default
      const today = new Date();
      const future = new Date();
      future.setDate(future.getDate() + 30);
      trips = await tripModel.findByDateRange(
        today.toISOString().split('T')[0],
        future.toISOString().split('T')[0]
      );
    }

    // Get stats for each trip
    const tripsWithStats = await Promise.all(
      trips.map(async (trip) => {
        const stats = await tripModel.getTripStats(trip.id);
        return { ...trip, ...stats };
      })
    );

    res.status(200).json({
      success: true,
      trips: tripsWithStats
    });
  } catch (error) {
    console.error('Error fetching trips:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

/**
 * GET /trip/:id - Get trip by ID with stats
 */
router.get('/:id', async (req, res) => {
  try {
    const tripId = parseInt(req.params.id, 10);
    
    if (isNaN(tripId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid trip ID'
      });
    }

    const trip = await tripModel.findById(tripId);
    
    if (!trip) {
      return res.status(404).json({
        success: false,
        error: 'Trip not found'
      });
    }

    const stats = await tripModel.getTripStats(tripId);
    const bookings = await bookingModel.findByTripId(tripId);

    res.status(200).json({
      success: true,
      trip: { ...trip, ...stats },
      bookings
    });
  } catch (error) {
    console.error('Error fetching trip:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

/**
 * POST /trip - Create a new trip
 * Body: { route_id, journey_date, departure_time, whatsapp_seat_quota }
 */
router.post('/', async (req, res) => {
  try {
    const { route_id, journey_date, departure_time, whatsapp_seat_quota } = req.body;

    if (!route_id || !journey_date || !departure_time) {
      return res.status(400).json({
        success: false,
        error: 'route_id, journey_date, and departure_time are required'
      });
    }

    // Validate route exists
    const route = await routeModel.findById(route_id);
    if (!route) {
      return res.status(404).json({
        success: false,
        error: 'Route not found'
      });
    }

    // Check if trip already exists
    const existingTrip = await tripModel.findByRouteDateTime(route_id, journey_date, departure_time);
    if (existingTrip) {
      return res.status(409).json({
        success: false,
        error: 'Trip already exists for this route, date, and time'
      });
    }

    const trip = await tripModel.create({
      route_id,
      journey_date,
      departure_time,
      whatsapp_seat_quota: whatsapp_seat_quota || 0
    });

    res.status(201).json({
      success: true,
      trip
    });
  } catch (error) {
    console.error('Error creating trip:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

/**
 * PATCH /trip/:id/quota - Update seat quota for a trip
 * Body: { whatsapp_seat_quota }
 */
router.patch('/:id/quota', async (req, res) => {
  try {
    const tripId = parseInt(req.params.id, 10);
    const { whatsapp_seat_quota } = req.body;

    if (isNaN(tripId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid trip ID'
      });
    }

    if (whatsapp_seat_quota === undefined || whatsapp_seat_quota < 0) {
      return res.status(400).json({
        success: false,
        error: 'whatsapp_seat_quota must be a non-negative number'
      });
    }

    const trip = await tripModel.updateSeatQuota(tripId, whatsapp_seat_quota);
    
    if (!trip) {
      return res.status(404).json({
        success: false,
        error: 'Trip not found'
      });
    }

    res.status(200).json({
      success: true,
      trip
    });
  } catch (error) {
    console.error('Error updating trip quota:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

module.exports = router;
