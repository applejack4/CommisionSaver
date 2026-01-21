const bookingModel = require('../models/booking');

/**
 * Expire all holds that have passed their expiration time
 * This releases seats back to the available pool
 */
async function expireHolds() {
  try {
    const expiredHolds = await bookingModel.findExpiredHolds();
    
    if (!expiredHolds.length) {
      return { expired: 0 };
    }

    let expiredCount = 0;
    for (const hold of expiredHolds) {
      try {
        await bookingModel.expireHold(hold.id);
        expiredCount++;
        console.log(`Expired hold for booking ${hold.id} (customer: ${hold.customer_phone})`);
      } catch (error) {
        console.error(`Failed to expire hold ${hold.id}:`, error.message);
      }
    }

    return { expired: expiredCount };
  } catch (error) {
    console.error('Error expiring holds:', error);
    throw error;
  }
}

module.exports = {
  expireHolds
};
