const crypto = require('crypto');

const BOOKING_TOKEN_SECRET = process.env.BOOKING_TOKEN_SECRET || null;

function buildBookingToken(bookingId) {
  if (!BOOKING_TOKEN_SECRET || !bookingId) {
    return null;
  }
  return crypto
    .createHmac('sha256', BOOKING_TOKEN_SECRET)
    .update(String(bookingId))
    .digest('hex');
}

function verifyBookingToken(bookingId, token) {
  if (!BOOKING_TOKEN_SECRET) {
    return true;
  }
  if (!token || !bookingId) {
    return false;
  }
  const expected = buildBookingToken(bookingId);
  const expectedBuffer = Buffer.from(expected || '', 'utf8');
  const providedBuffer = Buffer.from(String(token), 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

module.exports = {
  buildBookingToken,
  verifyBookingToken
};
