import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db.js';

const router = Router();

const vibeSchema = z.enum(['Loud', 'Chill', 'Family', 'Women-only']);

const nearbyQuerySchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusKm: z.coerce.number().min(1).max(500).default(50),
    fixtureId: z.string().uuid().optional(),
    vibe: vibeSchema.optional(),
    limit: z.coerce.number().min(1).max(50).default(20),
  })
  .superRefine((value, ctx) => {
    if ((value.lat === undefined) !== (value.lng === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provide both lat and lng together.',
        path: ['lat'],
      });
    }
  });

const detailQuerySchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.lat === undefined) !== (value.lng === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provide both lat and lng together.',
        path: ['lat'],
      });
    }
  });

function mapFanRow(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    neighborhood: row.neighborhood,
    city: row.city,
    vibe: row.vibe,
    verified: row.verified,
    isHost: row.is_host,
    womenOnly: row.women_only,
    familyFriendly: row.family_friendly,
    rating: Number(row.rating ?? 0),
    ratingCount: Number(row.rating_count ?? 0),
    waveBackRate: Number(row.wave_back_rate ?? 0),
    hostWins: Number(row.host_wins ?? 0),
    matchDayModeFixtureId: row.match_day_mode_fixture_id,
    distanceKm: Number(row.distance_km ?? 0),
    initial: row.initial,
    setup: row.setup ?? null,
  };
}

function mapFanDetailRow(row) {
  return {
    ...mapFanRow(row),
    age: Number(row.age ?? 0),
    bio: row.bio ?? '',
    favouriteTeams: row.favourite_teams ?? [],
  };
}

router.get('/nearby', async (req, res, next) => {
  const parsed = nearbyQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid nearby search query.', details: parsed.error.flatten() });
  }

  const { lat, lng, radiusKm, fixtureId, vibe, limit } = parsed.data;

  if (lat === undefined && lng === undefined && !req.authUser?.id) {
    return res.status(400).json({ error: 'Provide lat/lng or authenticate with a saved profile location.' });
  }

  try {
    const { rows } = await db.query(
      `
        with origin as (
          select
            case
              when $1::double precision is not null and $2::double precision is not null
                then ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
              when $3::uuid is not null
                then (
                  select geog
                  from profiles
                  where auth_user_id = $3::uuid
                )
              else null::geography
            end as geog
        )
        select
          p.id,
          p.display_name,
          p.neighborhood,
          p.city,
          p.vibe,
          p.verified,
          p.is_host,
          p.women_only,
          p.family_friendly,
          p.rating,
          p.rating_count,
          p.wave_back_rate,
          p.host_wins,
          p.match_day_mode_fixture_id,
          p.setup,
          coalesce(nullif(left(p.display_name, 1), ''), '?') as initial,
          round((ST_Distance(p.geog, origin.geog) / 1000.0)::numeric, 1) as distance_km
        from profiles p
        cross join origin
        where origin.geog is not null
          and p.geog is not null
          and ($3::uuid is null or p.auth_user_id is distinct from $3::uuid)
          and ST_DWithin(p.geog, origin.geog, $4::double precision * 1000)
          and ($5::uuid is null or p.match_day_mode_fixture_id = $5::uuid)
          and ($6::text is null or p.vibe = $6::text)
        order by ST_Distance(p.geog, origin.geog) asc
        limit $7
      `,
      [lat ?? null, lng ?? null, req.authUser?.id ?? null, radiusKm, fixtureId ?? null, vibe ?? null, limit],
    );

    return res.json({
      data: rows.map(mapFanRow),
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/:fanId', async (req, res, next) => {
  const parsed = detailQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid fan detail query.', details: parsed.error.flatten() });
  }

  try {
    const { rows } = await db.query(
      `
        with origin as (
          select
            case
              when $2::double precision is not null and $3::double precision is not null
                then ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography
              when $4::uuid is not null
                then (
                  select geog
                  from profiles
                  where auth_user_id = $4::uuid
                )
              else null::geography
            end as geog
        )
        select
          p.id,
          p.display_name,
          p.age,
          p.bio,
          p.neighborhood,
          p.city,
          p.vibe,
          p.favourite_teams,
          p.verified,
          p.is_host,
          p.women_only,
          p.family_friendly,
          p.rating,
          p.rating_count,
          p.wave_back_rate,
          p.host_wins,
          p.match_day_mode_fixture_id,
          p.setup,
          coalesce(nullif(left(p.display_name, 1), ''), '?') as initial,
          case
            when origin.geog is not null and p.geog is not null
              then round((ST_Distance(p.geog, origin.geog) / 1000.0)::numeric, 1)
            else null
          end as distance_km
        from profiles p
        cross join origin
        where p.id = $1::uuid
        limit 1
      `,
      [req.params.fanId, parsed.data.lat ?? null, parsed.data.lng ?? null, req.authUser?.id ?? null],
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'Fan not found.' });
    }

    return res.json({ data: mapFanDetailRow(rows[0]) });
  } catch (error) {
    return next(error);
  }
});

export default router;
