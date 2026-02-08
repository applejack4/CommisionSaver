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
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'run1',hypothesisId:'B',location:'booking_tokens.js:18',message:'booking token missing',data:{hasBookingId:Boolean(bookingId),hasToken:Boolean(token)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return false;
  }
  const expected = buildBookingToken(bookingId);
  const expectedBuffer = Buffer.from(expected || '', 'utf8');
  const providedBuffer = Buffer.from(String(token), 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) {
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/55a6a436-bb9c-4a9d-bfba-30e3149e9c98',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'run1',hypothesisId:'B',location:'booking_tokens.js:25',message:'booking token length mismatch',data:{bookingId},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

module.exports = {
  buildBookingToken,
  verifyBookingToken
};
