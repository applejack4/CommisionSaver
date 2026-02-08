const express = require('express');
const router = express.Router();
const {
  getDashboardBookings,
  getDashboardTrips
} = require('../../services/operator/dashboard_service');

function requireOperatorId(req, res) {
  const operatorId = req.query.operator_id || req.query.operatorId;
  if (!operatorId) {
    res.status(400).json({
      success: false,
      error: 'OPERATOR_ID_REQUIRED'
    });
    return null;
  }
  return operatorId;
}

router.get('/bookings', async (req, res) => {
  try {
    const operatorId = requireOperatorId(req, res);
    if (!operatorId) return;
    const limit = Number.parseInt(req.query.limit || '50', 10);
    const bookings = await getDashboardBookings({ operatorId, limit });
    res.json({ success: true, bookings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/trips', async (req, res) => {
  try {
    const operatorId = requireOperatorId(req, res);
    if (!operatorId) return;
    const { start_date: startDate, end_date: endDate } = req.query;
    if (!startDate || !endDate) {
      res.status(400).json({
        success: false,
        error: 'DATE_RANGE_REQUIRED'
      });
      return;
    }
    const trips = await getDashboardTrips({ operatorId, startDate, endDate });
    res.json({ success: true, trips });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
