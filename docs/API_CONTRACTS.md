🔒 API CONTRACTS FROZEN (V1)
UI and backend must conform to this document.
Changes require explicit review.

# Operator Dashboard API Contracts

These contracts define the required backend APIs for the Operator Dashboard UI.
Backend logic is frozen. Do not redesign state machines or flows.

## Enums

### `takeover_status`
- `AVAILABLE` (no operator)
- `ACTIVE` (operator controlling)
- `RELEASED` (operator released, bot resumes)

## Sessions List

### Endpoint
| Method | Path | Purpose | Polling vs Real-time |
|---|---|---|---|
| GET | `/operator/sessions` | List recent/active WhatsApp sessions for operators | Polling every 10–30s; optional SSE/WebSocket push. |

### Request Parameters
| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `status` | query | string | Optional | `active`, `needs_attention`, `closed` |
| `conversation_state` | query | string | Optional | e.g., `QUALIFYING`, `BOOKING_FLOW`, `PAY_LINK_SENT`, `IDLE` |
| `booking_state` | query | string | Optional | e.g., `DRAFT`, `LOCKED`, `PAYMENT_PENDING`, `CONFIRMED`, `EXPIRED` |
| `payment_status` | query | string | Optional | `PENDING`, `SUCCESS`, `FAILED`, `REFUNDED` |
| `has_takeover` | query | boolean | Optional | true/false |
| `search` | query | string | Optional | phone/name partial |
| `limit` | query | number | Optional | default 50 |
| `cursor` | query | string | Optional | for pagination |

### Response JSON Shape
```json
{
  "success": true,
  "sessions": [
    {
      "session_id": "sess_123",
      "customer_phone": "+91xxxxxxxxxx",
      "customer_name": "Ravi",
      "last_message_excerpt": "I want 2 seats",
      "last_message_at": "2026-01-31T09:12:33Z",
      "conversation_state": "BOOKING_FLOW",
      "booking_state": "PAYMENT_PENDING",
      "booking_id": "book_456",
      "payment_status": "PENDING",
      "payment_amount": 1200,
      "payment_currency": "INR",
      "payment_expires_at": "2026-01-31T09:25:00Z",
      "takeover_status": "AVAILABLE",
      "assigned_operator_id": null,
      "unread_count": 2,
      "requires_action": true
    }
  ],
  "next_cursor": "cursor_abc"
}
```

### Field Requirements
| Field | Required | Notes |
|---|---|---|
| `session_id` | Required | Unique conversation/session id |
| `customer_phone` | Required | E.164 |
| `customer_name` | Optional | From WhatsApp profile |
| `last_message_excerpt` | Optional | UI preview |
| `last_message_at` | Required | ISO timestamp |
| `conversation_state` | Required | From frozen state machine |
| `booking_state` | Optional | null if no booking |
| `booking_id` | Optional | null if no booking |
| `payment_status` | Optional | null if no payment flow |
| `payment_amount` | Optional | currency minor/major per backend convention |
| `payment_currency` | Optional | e.g., `INR` |
| `payment_expires_at` | Optional | for pay-link timeout |
| `takeover_status` | Required | see `takeover_status` enum |
| `assigned_operator_id` | Optional | present when active |
| `unread_count` | Optional | derived from message read markers |
| `requires_action` | Optional | server-calculated flag |

## Conversation Detail View

### Endpoints
| Method | Path | Purpose | Polling vs Real-time |
|---|---|---|---|
| GET | `/operator/sessions/{session_id}` | Session header + current booking/payment summary | Polling 10–15s; optional realtime. |
| GET | `/operator/sessions/{session_id}/messages` | Message timeline | Polling 2–5s while open; optional realtime stream. |
| POST | `/operator/sessions/{session_id}/messages` | Operator sends outbound message | Immediate response; status updates via polling/stream. |

### GET `/operator/sessions/{session_id}` Response
```json
{
  "success": true,
  "session": {
    "session_id": "sess_123",
    "customer_phone": "+91xxxxxxxxxx",
    "customer_name": "Ravi",
    "conversation_state": "BOOKING_FLOW",
    "takeover_status": "ACTIVE",
    "assigned_operator_id": "op_1",
    "last_message_at": "2026-01-31T09:12:33Z"
  },
  "booking": {
    "booking_id": "book_456",
    "booking_state": "PAYMENT_PENDING",
    "seat_count": 2,
    "trip_id": "trip_77",
    "route_label": "CityA → CityB",
    "journey_date": "2026-02-02",
    "departure_time": "09:00",
    "price_amount": 1200,
    "price_currency": "INR",
    "lock_expires_at": "2026-01-31T09:25:00Z"
  },
  "payment": {
    "status": "PENDING",
    "gateway_ref": "pay_999",
    "pay_link_url": "https://pay.example/...",
    "pay_link_expires_at": "2026-01-31T09:25:00Z",
    "last_event_at": "2026-01-31T09:10:00Z"
  }
}
```

### GET `/operator/sessions/{session_id}/messages` Request Params
| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `limit` | query | number | Optional | default 50 |
| `before` | query | string | Optional | message_id cursor |
| `after` | query | string | Optional | message_id cursor |

### Messages Response
```json
{
  "success": true,
  "messages": [
    {
      "message_id": "msg_1",
      "direction": "INBOUND",
      "from": "+91xxxxxxxxxx",
      "to": "whatsapp:+91yyyyyyyyyy",
      "type": "text",
      "text": "Need 2 seats",
      "media": null,
      "timestamp": "2026-01-31T09:11:00Z",
      "status": "DELIVERED",
      "wa_message_id": "wamid.HBg...",
      "error": null
    }
  ],
  "next_cursor": "cursor_xyz"
}
```

### POST `/operator/sessions/{session_id}/messages` Request
| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `type` | body | string | Required | `text`, `image`, `document`, `interactive` |
| `text` | body | string | Optional | required if `type=text` |
| `media_id` | body | string | Optional | WhatsApp media id |
| `caption` | body | string | Optional | for media |
| `idempotency_key` | body | string | Optional | to avoid duplicate sends |
| `is_system_message` | body | boolean | Optional | true only for system/notification messages |

#### Constraint (Guardrail)
Operators may send outbound messages **only** when:
- `takeover_status = ACTIVE`, **or**
- message is explicitly marked as system/notification (`is_system_message = true`)

### POST Response
```json
{
  "success": true,
  "message_id": "msg_999",
  "wa_message_id": "wamid.HBg...",
  "status": "SENT"
}
```

## Booking Detail Card

### Endpoint
| Method | Path | Purpose | Polling vs Real-time |
|---|---|---|---|
| GET | `/operator/bookings/{booking_id}` | Full booking detail for the card | Polling 10–30s; optional realtime. |

### Response JSON Shape
```json
{
  "success": true,
  "booking": {
    "booking_id": "book_456",
    "session_id": "sess_123",
    "booking_state": "PAYMENT_PENDING",
    "seat_count": 2,
    "customer_phone": "+91xxxxxxxxxx",
    "trip_id": "trip_77",
    "route_label": "CityA → CityB",
    "journey_date": "2026-02-02",
    "departure_time": "09:00",
    "price_amount": 1200,
    "price_currency": "INR",
    "lock_key": "lock:trip:{tripId}:seat:{seatNumber}",
    "lock_expires_at": "2026-01-31T09:25:00Z",
    "ticket_media_id": null,
    "created_at": "2026-01-31T09:05:00Z",
    "updated_at": "2026-01-31T09:12:00Z"
  }
}
```

### Field Requirements
| Field | Required | Notes |
|---|---|---|
| `booking_id` | Required | |
| `session_id` | Required | |
| `booking_state` | Required | Must align with existing state machine |
| `seat_count` | Required | |
| `customer_phone` | Required | |
| `trip_id` | Required | |
| `route_label` | Required | UI-friendly string |
| `journey_date` | Required | |
| `departure_time` | Required | |
| `price_amount` | Required | |
| `price_currency` | Required | |
| `lock_key` | Optional | null if no active lock |
| `lock_expires_at` | Optional | null if no active lock |
| `ticket_media_id` | Optional | set when ticket is confirmed |
| `created_at` | Required | |
| `updated_at` | Required | |

## Payment Status Badges

### Endpoint
| Method | Path | Purpose | Polling vs Real-time |
|---|---|---|---|
| GET | `/operator/bookings/{booking_id}/payment` | Payment status for badge | Polling 5–15s during payment; else 30s. |

### Response JSON Shape
```json
{
  "success": true,
  "payment": {
    "status": "PENDING",
    "amount": 1200,
    "currency": "INR",
    "pay_link_url": "https://pay.example/...",
    "pay_link_expires_at": "2026-01-31T09:25:00Z",
    "gateway_ref": "pay_999",
    "last_event_at": "2026-01-31T09:10:00Z",
    "is_late_payment": false,
    "refund_status": null
  }
}
```

### Field Requirements
| Field | Required | Notes |
|---|---|---|
| `status` | Required | `PENDING`, `SUCCESS`, `FAILED`, `REFUNDED` |
| `amount` | Required | |
| `currency` | Required | |
| `pay_link_url` | Optional | visible only if still valid |
| `pay_link_expires_at` | Optional | |
| `gateway_ref` | Optional | |
| `last_event_at` | Optional | |
| `is_late_payment` | Optional | for late webhook handling |
| `refund_status` | Optional | if refund path triggered |

## Operator Takeover Controls

### Endpoints
| Method | Path | Purpose | Polling vs Real-time |
|---|---|---|---|
| POST | `/operator/sessions/{session_id}/takeover` | Start operator takeover | Immediate; refresh session header. |
| PATCH | `/operator/sessions/{session_id}/takeover` | Update takeover (release/resume) | Immediate. |
| POST | `/operator/bookings/{booking_id}/price-override` | Operator pricing override | Immediate. |

### POST `/operator/sessions/{session_id}/takeover` Request
| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `operator_id` | body | string | Required | |
| `reason` | body | string | Optional | |
| `idempotency_key` | body | string | Optional | |

Response:
```json
{
  "success": true,
  "takeover": {
    "takeover_id": "to_1",
    "status": "ACTIVE",
    "operator_id": "op_1",
    "started_at": "2026-01-31T09:12:00Z"
  }
}
```

### PATCH `/operator/sessions/{session_id}/takeover` Request
| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `action` | body | string | Required | `release`, `resume` |
| `idempotency_key` | body | string | Optional | |

Response:
```json
{
  "success": true,
  "takeover": {
    "takeover_id": "to_1",
    "status": "RELEASED",
    "operator_id": "op_1",
    "ended_at": "2026-01-31T09:20:00Z"
  }
}
```

### POST `/operator/bookings/{booking_id}/price-override` Request
| Name | In | Type | Required | Notes |
|---|---|---|---|---|
| `amount` | body | number | Required | |
| `currency` | body | string | Required | |
| `reason` | body | string | Optional | |
| `idempotency_key` | body | string | Optional | |

#### Enforcement Note (Doc-level)
Backend enforces:
- ±15% cap for operator role
- higher variance requires supervisor role
- violations return `403`

Response:
```json
{
  "success": true,
  "booking_id": "book_456",
  "price_amount": 1100,
  "price_currency": "INR",
  "updated_at": "2026-01-31T09:15:00Z"
}
```