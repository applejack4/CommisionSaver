const { createClient } = require('redis');
const bookingModel = require('../models/booking');
const { InventoryLockService } = require('./redis/InventoryLockService');
const { getLockKeysForBooking, releaseLockKeys } = require('./inventoryLocking');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

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

    const redisClient = createClient({ url: REDIS_URL });
    await redisClient.connect();
    const lockService = new InventoryLockService(redisClient);

    let expiredCount = 0;
    try {
      for (const hold of expiredHolds) {
        try {
          const lockKeys = getLockKeysForBooking(hold);
          await bookingModel.expireHold(hold.id, {
            releaseInventoryLock: async () =>
              releaseLockKeys(lockService, lockKeys, {
                bookingId: hold.id,
                reason: 'expiry'
              })
          });
          expiredCount++;
          console.log(`Expired hold for booking ${hold.id} (customer: ${hold.customer_phone})`);
        } catch (error) {
          console.error(`Failed to expire hold ${hold.id}:`, error.message);
        }
      }
    } finally {
      try {
        await redisClient.quit();
      } catch (error) {
        redisClient.disconnect();
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
