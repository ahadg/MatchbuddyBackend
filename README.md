# MatchBuddy Backend

Node.js API for MatchBuddy, designed for PostgreSQL with PostGIS and Supabase Auth.

## What it provides

- `GET /health`
- `GET /api/fixtures`
- `GET /api/fans/nearby`
- `GET /api/fans/:fanId`
- `GET /api/listings`
- `GET /api/profile/me`
- `PUT /api/profile/me`

## Setup

1. Copy `.env.example` to `.env`.
2. Point `DATABASE_URL` to a PostgreSQL database with PostGIS available.
3. Point `SUPABASE_URL` and `SUPABASE_SECRET_KEY` to your Supabase project.
4. Run `npm install`.
5. Run `npm run migrate`.
6. Run `npm run dev`.

## Notes

- Nearby search uses `ST_DWithin` on a `geography(Point, 4326)` column so distance filters are in meters/kilometers.
- The backend accepts Supabase access tokens via `Authorization: Bearer ...`.
- Seed data is included for fixtures, nearby fans, and listings.
