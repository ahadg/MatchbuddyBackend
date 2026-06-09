# API Notes

## Authentication

Request a sign-in code:

```http
POST /api/auth/send-otp
Content-Type: application/json
```

```json
{
  "email": "fan@example.com"
}
```

This endpoint generates an email OTP with Supabase Auth Admin and sends that code through Resend.

For authenticated requests after verification, send the Supabase access token as:

```http
Authorization: Bearer <access-token>
```

## Nearby fans

```http
GET /api/fans/nearby?radiusKm=50&lat=25.2854&lng=51.5310
```

Optional query parameters:

- `radiusKm`: default `50`, max `500`
- `lat` and `lng`: use these for public lookups
- `fixtureId`: filter by active match-day fixture
- `vibe`: `Loud`, `Chill`, `Family`, `Women-only`
- `limit`: default `20`, max `50`

If `lat` and `lng` are omitted, the API falls back to the authenticated user’s saved profile location.

Send a wave to a fan:

```http
POST /api/fans/:fanId/wave
Authorization: Bearer <access-token>
```

This returns `pending` until the wave is mutual, then upgrades to `mutual` and includes a direct thread ID.

## Listings

Browse listings near an origin:

```http
GET /api/listings?radiusKm=50&lat=25.2854&lng=51.5310
```

Get a single listing by UUID or slug:

```http
GET /api/listings/azteca-loft?lat=25.2854&lng=51.5310
```

Request a spot:

```http
POST /api/listings/:listingId/join-requests
Authorization: Bearer <access-token>
Content-Type: application/json
```

```json
{
  "message": "Would love to join if there is room."
}
```

Respond to a join request as the host:

```http
POST /api/listings/:listingId/join-requests/:requestId/respond
Authorization: Bearer <access-token>
Content-Type: application/json
```

```json
{
  "status": "approved"
}
```

Group room messages after approval:

```http
GET /api/listings/:listingId/messages
POST /api/listings/:listingId/messages
Authorization: Bearer <access-token>
```

## Chats

Unified inbox:

```http
GET /api/chats/inbox
Authorization: Bearer <access-token>
```

Direct thread messages:

```http
GET /api/chats/direct/:threadId/messages
POST /api/chats/direct/:threadId/messages
Authorization: Bearer <access-token>
```

## Profile upsert

```http
PUT /api/profile/me
Content-Type: application/json
```

```json
{
  "displayName": "Jamal R.",
  "age": 29,
  "bio": "Host loud watch-parties on my rooftop.",
  "neighborhood": "Westside",
  "city": "Dubai",
  "vibe": "Loud",
  "favouriteTeams": ["Real Madrid", "Argentina"],
  "isHost": true,
  "matchDayModeFixtureId": "00000000-0000-0000-0000-000000000101",
  "setup": {
    "screenSize": "75 in",
    "displayType": "4K OLED",
    "audio": "Dolby Atmos"
  },
  "location": {
    "latitude": 25.2048,
    "longitude": 55.2708
  }
}
```
