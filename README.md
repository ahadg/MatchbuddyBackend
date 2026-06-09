# MatchBuddy Backend

Node.js API for MatchBuddy, designed for PostgreSQL with PostGIS, Supabase Auth, and Resend-powered OTP email delivery.

## What it provides

- `GET /health`
- `POST /api/auth/send-otp`
- `GET /api/fixtures`
- `GET /api/fans/nearby`
- `GET /api/fans/:fanId`
- `GET /api/listings`
- `GET /api/profile/me`
- `PUT /api/profile/me`

## Setup

1. Copy `.env.example` to `.env`.
2. Start the bundled Postgres + PostGIS database with `npm run db:up`.
3. Keep `DATABASE_URL` pointed at the container default unless you want a different port:

   ```bash
   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/matchbuddy
   ```

4. Point `SUPABASE_URL` and `SUPABASE_SECRET_KEY` to your Supabase project.
5. Set `RESEND_API_KEY` plus a verified `RESEND_FROM_EMAIL`.
6. Run `npm install`.
7. Run `npm run migrate`.
8. Run `npm run dev`.

## Local database

The backend includes [compose.yaml](./compose.yaml), which starts the official `postgis/postgis` image on host port `5433` by default so it does not collide with an existing local Postgres on `5432`.

On Apple Silicon Macs, this compose file pins the PostGIS service to `linux/amd64` because the current official `postgis/postgis` tags used here do not publish an `arm64` manifest.

Common commands:

- `npm run db:up`
- `npm run db:logs`
- `npm run db:down`

## Notes

- Nearby search uses `ST_DWithin` on a `geography(Point, 4326)` column so distance filters are in meters/kilometers.
- `POST /api/auth/send-otp` generates an email OTP through `supabase.auth.admin.generateLink()` and sends that code through Resend.
- Protected backend routes still accept Supabase access tokens via `Authorization: Bearer ...`.
- `profiles.auth_user_id` stores the Supabase user UUID without a database-level foreign key so the schema works in a standalone Postgres/PostGIS container.
- Seed data is included for fixtures, nearby fans, and listings.
