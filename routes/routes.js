const express = require('express');
const router = express.Router();
const routeModel = require('../models/route');

/**
 * GET /routes - Get all routes
 */
router.get('/', async (req, res) => {
  try {
    const routes = await routeModel.findAll();
    
    res.status(200).json({
      success: true,
      routes
    });
  } catch (error) {
    console.error('Error fetching routes:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

module.exports = router;
