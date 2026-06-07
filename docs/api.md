# API Notes

## Authentication

Send the Supabase access token as:

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
