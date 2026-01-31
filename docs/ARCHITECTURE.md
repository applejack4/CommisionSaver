🔒 ARCHITECTURE FROZEN
Backend logic locked. Do not modify without explicit review.


❗This architecture is final. Do not redesign. Implement only.

You are a Senior Backend Engineer implementing a finalized system design.

Do NOT redesign the architecture.
Do NOT suggest alternative approaches unless a requirement is unsafe or impossible.

Below is a locked technical specification including:

dual state machines

Redis-based inventory locking

webhook-first payment confirmation

operator takeover + pricing override

append-only event logging

Your tasks:

1. Write the Redis Lua scripts for:

atomic lock acquisition validation

safe lock release (owner-only delete)

lock extension (optional, same owner only)

Include:

KEYS / ARGV structure

return codes

failure cases

2. Define idempotency strategy for:

WhatsApp webhook retries

payment gateway webhooks

operator override actions

Specify:

idempotency keys

storage location

TTL strategy

3. Provide pseudocode flows (not full code) for:

user selects slot → lock acquired → pay link generated

lock expiry → inventory release → user notification

payment webhook (on-time vs late)

operator takeover + resume

4. Call out critical failure scenarios, including:

Redis restart

webhook duplication

gateway delays

operator/browser crash mid-override

And how the system recovers safely.


function handleSlotSelection(event):

  # ---------- 0. Idempotency ----------
  idempotencyKey = "slot_select:" + event.message_id
  if Idempotency.exists(idempotencyKey):
      return Idempotency.previousResult(idempotencyKey)

  # ---------- 1. Load session ----------
  session = SessionManager.get(event.session_id)
  if session is null:
      emit EVENT_SESSION_INVALID
      result = error("SESSION_INVALID")
      Idempotency.store(idempotencyKey, result, TTL=24h)
      return result

  # ---------- 2. Conversation state check ----------
  if session.conversation_state not in [QUALIFYING, BOOKING_FLOW]:
      emit EVENT_INVALID_CONVERSATION_STATE
      result = error("INVALID_STATE")
      Idempotency.store(idempotencyKey, result, TTL=24h)
      return result

  # ---------- 3. Booking state check ----------
  booking = BookingService.getBySession(session.id)
  if booking exists and booking.state not in [DRAFT, EXPIRED]:
      emit EVENT_BOOKING_STATE_CONFLICT
      result = error("BOOKING_IN_PROGRESS")
      Idempotency.store(idempotencyKey, result, TTL=24h)
      return result

  # ---------- 4. Inventory lock (source of truth) ----------
  resourceType = "seat"
  lockKey = "lock:" + resourceType + ":" + event.resource_id + ":" + event.date + ":" + event.slot_id

  lockResult = InventoryLockService.acquireLock(
      key = lockKey,
      owner = session.id,    # Value = session_id
      ttl = 600
  )

  if lockResult == LOCK_ALREADY_HELD:
      emit EVENT_INVENTORY_LOCK_CONFLICT
      result = error("SLOT_UNAVAILABLE")
      Idempotency.store(idempotencyKey, result, TTL=24h)
      return result

  if lockResult != LOCK_ACQUIRED:
      emit EVENT_INVENTORY_LOCK_ERROR
      result = error("LOCK_FAILED")
      Idempotency.store(idempotencyKey, result, TTL=24h)
      return result

  emit EVENT_INVENTORY_LOCKED { session_id, lockKey }

  # ---------- 5. Booking → LOCKED ----------
  booking = BookingService.createOrUpdate(
      session_id = session.id,
      state = LOCKED,
      resource = event.slot
  )

  emit EVENT_BOOKING_LOCKED { booking_id = booking.id }

  # ---------- 6. Price resolution ----------
  price = PricingService.calculateDirectPrice(booking)
  if price is null:
      InventoryLockService.releaseLock(lockKey, session.id)
      BookingService.updateState(booking.id, EXPIRED)
      emit EVENT_PRICE_CALC_FAILED
      result = error("PRICE_FAILED")
      Idempotency.store(idempotencyKey, result, TTL=24h)
      return result

  # ---------- 7. Payment link generation ----------
  payLink = PaymentGateway.createPayLink(
      booking_id = booking.id,
      amount = price,
      expires_in = 15m
  )

  if payLink failed:
      InventoryLockService.releaseLock(lockKey, session.id)
      BookingService.updateState(booking.id, EXPIRED)
      emit EVENT_PAYLINK_FAILED
      result = error("PAYMENT_UNAVAILABLE")
      Idempotency.store(idempotencyKey, result, TTL=24h)
      return result

  emit EVENT_LINK_GENERATED { booking_id = booking.id, expires_at }

  # ---------- 8. State transitions ----------
  SessionManager.updateConversationState(session.id, PAY_LINK_SENT)
  BookingService.updateState(booking.id, PAYMENT_PENDING)

  emit EVENT_STATE_TRANSITION { booking_id = booking.id, conversation_state = PAY_LINK_SENT }

  # Idempotency.store MUST be called exactly once per execution path
  # with the terminal result (success or failure).
  result = success(payLink)
  Idempotency.store(idempotencyKey, result, TTL=24h)
  return result

  function handlePaymentWebhook(webhook):

  # ---------- 0. Verify webhook authenticity ----------
  if not PaymentGateway.verifySignature(webhook):
      Using docs/ARCHITECTURE.md:
Using docs/ARCHITECTURE.md:

Generate pseudocode-level implementation for:
Payment webhook handling (on-time vs late payment).

Constraints:
- Webhook-first source of truth
- Idempotent behavior required
- No new states
- Must align with existing booking & conversation state machines
- No UI logic

Return pseudocode only.

Generate pseudocode-level implementation for:
Payment webhook handling (on-time vs late payment).

Constraints:
- Webhook-first source of truth
- Idempotent behavior required
- No new states
- Must align with existing booking & conversation state machines
- No UI logic

Return pseudocode only.

      return HTTP 401

  # ---------- 1. Idempotency ----------
  idempotencyKey = "payment_webhook:" + webhook.gateway_event_id

  if Idempotency.exists(idempotencyKey):
      return HTTP 200   # already processed safely

  # ---------- 2. Extract core identifiers ----------
  bookingId   = webhook.metadata.booking_id
  gatewayRef  = webhook.transaction_id
  paymentStatus = webhook.status  # SUCCESS | FAILED | PENDING

  booking = BookingService.getById(bookingId)

  if booking is null:
      emit EVENT_PAYMENT_ORPHANED { gatewayRef }
      Idempotency.store(idempotencyKey, "ORPHAN", TTL=7d)
      return HTTP 200

  # ---------- 3. Terminal booking guard ----------
  if booking.state in [CONFIRMED, CANCELLED]:
      emit EVENT_PAYMENT_IGNORED { booking_id, reason="ALREADY_TERMINAL" }
      Idempotency.store(idempotencyKey, "IGNORED", TTL=7d)
      return HTTP 200

  # ---------- 4. ON-TIME PAYMENT PATH ----------
  if booking.state == PAYMENT_PENDING:

      if paymentStatus == SUCCESS:
          BookingService.updateState(booking.id, PAYMENT_PROCESSING)
          emit EVENT_PAYMENT_PROCESSING { booking_id }

          # Final confirmation
          BookingService.updateState(booking.id, CONFIRMED)
          emit EVENT_BOOKING_CONFIRMED { booking_id, gatewayRef }

          # Inventory already locked → now consumed
          InventoryService.consume(booking.resource)

          # Conversation update
          SessionManager.updateConversationState(
              booking.session_id,
              IDLE
          )

          emit EVENT_PAYMENT_SUCCESS { booking_id }

          Idempotency.store(idempotencyKey, "SUCCESS", TTL=7d)
          return HTTP 200

      if paymentStatus == FAILED:
          BookingService.updateState(booking.id, EXPIRED)
          emit EVENT_PAYMENT_FAILED { booking_id }

          InventoryLockService.releaseLock(
              booking.lock_key,
              booking.session_id
          )

          Idempotency.store(idempotencyKey, "FAILED", TTL=7d)
          return HTTP 200

  # ---------- 5. LATE PAYMENT PATH ----------
  # Booking already expired due to lock TTL

  if booking.state == EXPIRED and paymentStatus == SUCCESS:

      emit EVENT_LATE_PAYMENT_RECEIVED { booking_id, gatewayRef }

      # Attempt safe recovery
      recoveryResult = InventoryService.tryReacquire(
          booking.resource
      )

      if recoveryResult == REACQUIRED:
          BookingService.updateState(booking.id, CONFIRMED)
          emit EVENT_BOOKING_CONFIRMED_LATE { booking_id }

          Idempotency.store(idempotencyKey, "LATE_RECOVERED", TTL=7d)
          return HTTP 200

      # Cannot recover inventory → refund
      RefundService.initiate(
          gatewayRef,
          amount = webhook.amount
      )

      emit EVENT_REFUND_REQUIRED { booking_id }

      Idempotency.store(idempotencyKey, "REFUNDED", TTL=7d)
      return HTTP 200

  # ---------- 6. Unknown / pending states ----------
  emit EVENT_PAYMENT_UNHANDLED { booking_id, state=booking.state }
  Idempotency.store(idempotencyKey, "UNHANDLED", TTL=7d)
  return HTTP 200
