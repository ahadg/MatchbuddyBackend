import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db.js';

const router = Router();

const querySchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusKm: z.coerce.number().min(1).max(500).default(50),
    fixtureId: z.string().uuid().optional(),
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

router.get('/', async (req, res, next) => {
  const parsed = querySchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid listing query.', details: parsed.error.flatten() });
  }

  const { lat, lng, radiusKm, fixtureId } = parsed.data;

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
          l.id,
          l.slug,
          l.fixture_id,
          l.host_id,
          p.display_name as host_name,
          l.neighborhood,
          l.vibe,
          l.max_guests,
          l.approved_guests,
          l.extras,
          l.house_rules,
          l.join_message,
          l.price_note,
          l.is_open,
          round((ST_Distance(l.geog, origin.geog) / 1000.0)::numeric, 1) as distance_km
        from listings l
        inner join profiles p on p.id = l.host_id
        cross join origin
        where origin.geog is not null
          and l.geog is not null
          and l.is_open = true
          and ST_DWithin(l.geog, origin.geog, $4::double precision * 1000)
          and ($5::uuid is null or l.fixture_id = $5::uuid)
        order by ST_Distance(l.geog, origin.geog) asc
      `,
      [lat ?? null, lng ?? null, req.authUser?.id ?? null, radiusKm, fixtureId ?? null],
    );

    return res.json({
      data: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        fixtureId: row.fixture_id,
        hostId: row.host_id,
        hostName: row.host_name,
        neighborhood: row.neighborhood,
        vibe: row.vibe,
        maxGuests: Number(row.max_guests ?? 0),
        approvedGuests: Number(row.approved_guests ?? 0),
        extras: row.extras ?? [],
        houseRules: row.house_rules ?? [],
        joinMessage: row.join_message ?? '',
        priceNote: row.price_note ?? 'Free',
        distanceKm: Number(row.distance_km ?? 0),
        isOpen: row.is_open,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
