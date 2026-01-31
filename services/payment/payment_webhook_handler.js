/*
PSEUDOCODE: Payment webhook handling (on-time vs late payment)

function handlePaymentWebhook(webhook):

  # ---------- 0. Verify webhook authenticity ----------
  if not PaymentGateway.verifySignature(webhook):
      return HTTP 401

  # ---------- 1. Idempotency ----------
  idempotencyKey = "payment_webhook:" + webhook.gateway_event_id
  if Idempotency.exists(idempotencyKey):
      return HTTP 200  # already processed

  # ---------- 2. Extract core identifiers ----------
  bookingId = webhook.metadata.booking_id
  paymentStatus = webhook.status  # SUCCESS | FAILED | PENDING

  booking = BookingService.getById(bookingId)
  if booking is null:
      emit EVENT_PAYMENT_ORPHANED { gateway_event_id }
      Idempotency.store(idempotencyKey, "ORPHAN", TTL=7d)
      return HTTP 200

  session = SessionManager.get(booking.session_id)
  if session is null:
      emit EVENT_SESSION_INVALID
      Idempotency.store(idempotencyKey, "SESSION_MISSING", TTL=7d)
      return HTTP 200

  # ---------- 3. Conversation state alignment ----------
  if session.conversation_state != PAY_LINK_SENT:
      emit EVENT_CONVERSATION_STATE_MISMATCH { booking_id = booking.id }

  # ---------- 4. On-time payment path ----------
  if booking.state == PAYMENT_PENDING:
      if paymentStatus == SUCCESS:
          BookingService.updateState(booking.id, PAYMENT_PROCESSING)
          emit EVENT_PAYMENT_PROCESSING { booking_id = booking.id }

          BookingService.updateState(booking.id, CONFIRMED)
          emit EVENT_BOOKING_CONFIRMED { booking_id = booking.id }

          Idempotency.store(idempotencyKey, "SUCCESS", TTL=7d)
          return HTTP 200

      if paymentStatus == FAILED:
          BookingService.updateState(booking.id, EXPIRED)
          InventoryLockService.releaseLock(booking.lock_key, booking.session_id)
          emit EVENT_PAYMENT_FAILED { booking_id = booking.id }

          Idempotency.store(idempotencyKey, "FAILED", TTL=7d)
          return HTTP 200

  # ---------- 5. Late payment path ----------
  if booking.state == EXPIRED and paymentStatus == SUCCESS:
      emit EVENT_LATE_PAYMENT_RECEIVED { booking_id = booking.id }

      # Inventory may already be released; do not create new states
      Idempotency.store(idempotencyKey, "LATE_SUCCESS", TTL=7d)
      return HTTP 200

  # ---------- 6. Unhandled / pending ----------
  emit EVENT_PAYMENT_UNHANDLED { booking_id = booking.id, state = booking.state }
  Idempotency.store(idempotencyKey, "UNHANDLED", TTL=7d)
  return HTTP 200
*/
