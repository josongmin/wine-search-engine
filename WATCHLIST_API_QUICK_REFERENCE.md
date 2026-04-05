# Watchlist API — Quick Reference

## Environment Setup

```bash
# Required for production
export WEBHOOK_SECRET="your-32-char-secret-min-16-chars!!!!!"  # HMAC signing
export REDIS_URL="redis://localhost:6379"                       # Redis connection
```

## API Endpoints

### Create Watchlist Entry
```http
POST /v1/watchlist HTTP/1.1
Content-Type: application/json

{
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "entity_id": "wine-opus-one-2018",
  "trigger_conditions": [
    {
      "type": "price_drop",
      "threshold": 10,
      "baselinePrice": 150.00
    },
    {
      "type": "critic_score_above",
      "threshold": 90
    }
  ],
  "callback_url": "https://example.com/webhooks/watchlist",
  "expires_at": "2026-07-06T00:00:00Z"  // Optional; null = never expires
}

HTTP/1.1 201 Created
{
  "watchlist_id": "tnz_p7q9k2m4r5s..."
}
```

### Get Watchlist Entry
```http
GET /v1/watchlist/tnz_p7q9k2m4r5s HTTP/1.1

HTTP/1.1 200 OK
{
  "id": "tnz_p7q9k2m4r5s",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "entity_id": "wine-opus-one-2018",
  "trigger_conditions": [...],
  "callback_url": "https://example.com/webhooks/watchlist",
  "created_at": "2026-04-06T10:30:00Z",
  "expires_at": "2026-07-06T00:00:00Z"
}
```

### Delete Watchlist Entry
```http
DELETE /v1/watchlist/tnz_p7q9k2m4r5s HTTP/1.1

HTTP/1.1 204 No Content
```

### List Delivery Logs
```http
GET /v1/watchlist/tnz_p7q9k2m4r5s/deliveries HTTP/1.1

HTTP/1.1 200 OK
{
  "deliveries": [
    {
      "id": "dl_xyz123",
      "watchlist_id": "tnz_p7q9k2m4r5s",
      "attempt": 1,
      "status_code": 200,
      "error_message": null,
      "delivered_at": "2026-04-06T10:30:15Z"
    }
  ],
  "total": 1
}
```

## Webhook Payload Format

**Incoming Webhook (to your callback URL)**:

```json
{
  "watchlist_id": "tnz_p7q9k2m4r5s",
  "entity_id": "wine-opus-one-2018",
  "event_type": "price_updated",
  "event_data": {
    "newPrice": 135.00,
    "oldPrice": 150.00,
    "percentageDrop": 10
  },
  "triggered_at": "2026-04-06T10:30:15Z"
}
```

**Signature Verification**:

```typescript
import { createHmac } from 'crypto';

const signature = request.headers['x-wine-watchlist-signature'];
const payload = JSON.stringify(request.body);
const watchlistId = request.body.watchlist_id;

const expected = createHmac('sha256', process.env.WEBHOOK_SECRET)
  .update(`${watchlistId}.${payload}`)
  .digest('hex');

if (signature !== expected) {
  return res.status(401).send('Invalid signature');
}
```

## Trigger Types

### `new_vintage`
Triggers when a wine with vintage >= minVintage is released.
```json
{
  "type": "new_vintage",
  "minVintage": 2025
}
```

### `price_drop`
Triggers when price drops >= threshold % from baseline.
```json
{
  "type": "price_drop",
  "threshold": 10,
  "baselinePrice": 150.00
}
```

### `stock_available`
Triggers when stock >= minQty becomes available.
```json
{
  "type": "stock_available",
  "minQty": 5
}
```

### `critic_score_above`
Triggers when critic score >= threshold.
```json
{
  "type": "critic_score_above",
  "threshold": 90
}
```

## Error Responses

### Validation Error
```json
HTTP/1.1 400 Bad Request
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "details": [
      {
        "validation": "uuid",
        "code": "invalid_string",
        "message": "Invalid uuid",
        "path": ["user_id"]
      }
    ]
  }
}
```

### Not Found
```json
HTTP/1.1 404 Not Found
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Watchlist entry tnz_xyz not found"
  }
}
```

### Internal Error
```json
HTTP/1.1 500 Internal Server Error
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Failed to create watchlist"
  }
}
```

## Integration Example (Node.js)

```typescript
import fetch from 'node-fetch';

// 1. Create watchlist
const createResp = await fetch('http://localhost:3000/v1/watchlist', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    user_id: '550e8400-e29b-41d4-a716-446655440000',
    entity_id: 'wine-opus-one-2018',
    trigger_conditions: [
      { type: 'price_drop', threshold: 10, baselinePrice: 150 }
    ],
    callback_url: 'https://myserver.com/webhooks/wine'
  })
});
const { watchlist_id } = await createResp.json();

// 2. Handle incoming webhook
app.post('/webhooks/wine', express.json(), (req, res) => {
  const signature = req.headers['x-wine-watchlist-signature'];
  const payload = JSON.stringify(req.body);
  const watchlistId = req.body.watchlist_id;
  
  const expected = createHmac('sha256', process.env.WEBHOOK_SECRET)
    .update(`${watchlistId}.${payload}`)
    .digest('hex');
  
  if (signature !== expected) {
    return res.status(401).send('Invalid signature');
  }
  
  console.log(`Event: ${req.body.event_type} for ${req.body.entity_id}`);
  console.log('Data:', req.body.event_data);
  
  res.json({ success: true });
});

// 3. Check delivery history
const deliveriesResp = await fetch(
  `http://localhost:3000/v1/watchlist/${watchlist_id}/deliveries`
);
const { deliveries, total } = await deliveriesResp.json();
console.log(`${total} delivery attempts`);

// 4. Delete when no longer needed
await fetch(`http://localhost:3000/v1/watchlist/${watchlist_id}`, {
  method: 'DELETE'
});
```

## Retry Behavior

Watchlist webhook delivery automatically retries with exponential backoff:

| Attempt | Backoff | Total Wait |
|---------|---------|-----------|
| 1       | 0s      | 0s        |
| 2       | 1s      | 1s        |
| 3       | 5s      | 6s        |
| 4       | 30s     | 36s       |

After 3 failed attempts, the webhook is marked as failed. Manual retry via a future admin API (not implemented in v0.1).

## Performance Notes

- **Latency**: Webhook delivery is fire-and-forget; returns immediately
- **Timeout**: Each webhook request has 5s timeout
- **Concurrency**: Multiple webhooks for same entity can fire in parallel
- **Storage**: In-memory for v0.1 (not suitable for production scale)
  - Production: Use PostgreSQL with indexes on `(userId, entityId, expiresAt)`
  - Migrations: Create `pg_watchlist_entries` and `pg_watchlist_deliveries` tables

## Testing Locally

```bash
# 1. Start Redis
docker run -d -p 6379:6379 redis:latest

# 2. Set webhook secret
export WEBHOOK_SECRET="test-secret-min-16-characters!!!!!"

# 3. Run server
npm run dev

# 4. In another terminal, test API
curl -X POST http://localhost:3000/v1/watchlist \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "entity_id": "wine-test-123",
    "trigger_conditions": [{"type": "new_vintage", "minVintage": 2025}],
    "callback_url": "https://webhook.site/unique-uuid"
  }'

# 5. Run tests
npm test -- src/__tests__/watchlist-routes.test.ts
```

---

For detailed implementation docs, see `IMPLEMENTATION_EPIC_17_1.md`.
