import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db.js';
import { sendWavePushNotification } from '../lib/onesignal.js';
import { requireUser } from '../middleware/auth.js';
import {
  buildProfileAvatarUrl,
  buildProfileMetricsSql,
  ensureDirectThread,
  getCurrentProfileByAuthUserId,
  getProfileById,
} from '../lib/social.js';

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

const rateFanBodySchema = z.object({
  score: z.coerce.number().int().min(1).max(5),
});

function mapFanRow(row, socialState = null) {
  return {
    id: row.id,
    avatarUrl: buildProfileAvatarUrl(row.avatar_path),
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
    waveStatus: socialState?.waveStatus ?? 'none',
    directThreadId: socialState?.directThreadId ?? null,
  };
}

function mapFanDetailRow(row, socialState = null) {
  return {
    ...mapFanRow(row, socialState),
    age: Number(row.age ?? 0),
    bio: row.bio ?? '',
    favouriteTeams: row.favourite_teams ?? [],
    myRating: row.my_rating === null || row.my_rating === undefined ? null : Number(row.my_rating),
  };
}

async function fetchSocialStateForFanIds(currentProfileId, fanIds, client = db) {
  if (!currentProfileId || !fanIds.length) {
    return new Map();
  }

  const { rows } = await client.query(
    `
      with fan_ids as (
        select unnest($2::uuid[]) as fan_id
      )
      select
        fan_ids.fan_id,
        exists(
          select 1
          from waves outgoing
          where outgoing.sender_profile_id = $1::uuid
            and outgoing.receiver_profile_id = fan_ids.fan_id
        ) as has_outgoing_wave,
        exists(
          select 1
          from waves incoming
          where incoming.sender_profile_id = fan_ids.fan_id
            and incoming.receiver_profile_id = $1::uuid
        ) as has_incoming_wave,
        dt.id as direct_thread_id
      from fan_ids
      left join direct_threads dt
        on dt.profile_low_id = least($1::uuid, fan_ids.fan_id)
       and dt.profile_high_id = greatest($1::uuid, fan_ids.fan_id)
    `,
    [currentProfileId, fanIds],
  );

  return new Map(
    rows.map((row) => {
      let waveStatus = 'none';

      if (row.direct_thread_id) {
        waveStatus = 'mutual';
      } else if (row.has_outgoing_wave && row.has_incoming_wave) {
        waveStatus = 'mutual';
      } else if (row.has_outgoing_wave) {
        waveStatus = 'pending';
      } else if (row.has_incoming_wave) {
        waveStatus = 'received';
      }

      return [
        row.fan_id,
        {
          waveStatus,
          directThreadId: row.direct_thread_id,
        },
      ];
    }),
  );
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
    const currentProfile = req.authUser?.id ? await getCurrentProfileByAuthUserId(req.authUser.id) : null;
    const metricsSql = buildProfileMetricsSql('p');

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
          p.avatar_path,
          p.display_name,
          p.neighborhood,
          p.city,
          p.vibe,
          p.verified,
          p.is_host,
          p.women_only,
          p.family_friendly,
          ${metricsSql.selects},
          p.host_wins,
          p.match_day_mode_fixture_id,
          p.setup,
          coalesce(nullif(left(p.display_name, 1), ''), '?') as initial,
          round((ST_Distance(p.geog, origin.geog) / 1000.0)::numeric, 1) as distance_km
        from profiles p
        cross join origin
        ${metricsSql.joins}
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

    const socialState = await fetchSocialStateForFanIds(
      currentProfile?.id ?? null,
      rows.map((row) => row.id),
    );

    return res.json({
      data: rows.map((row) => mapFanRow(row, socialState.get(row.id))),
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
    const currentProfile = req.authUser?.id ? await getCurrentProfileByAuthUserId(req.authUser.id) : null;
    const metricsSql = buildProfileMetricsSql('p');

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
          p.avatar_path,
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
          ${metricsSql.selects},
          p.host_wins,
          p.match_day_mode_fixture_id,
          p.setup,
          my_rating.score as my_rating,
          coalesce(nullif(left(p.display_name, 1), ''), '?') as initial,
          case
            when origin.geog is not null and p.geog is not null
              then round((ST_Distance(p.geog, origin.geog) / 1000.0)::numeric, 1)
            else null
          end as distance_km
        from profiles p
        cross join origin
        ${metricsSql.joins}
        left join fan_ratings my_rating
          on my_rating.target_profile_id = p.id
         and my_rating.rater_profile_id = $5::uuid
        where p.id = $1::uuid
        limit 1
      `,
      [
        req.params.fanId,
        parsed.data.lat ?? null,
        parsed.data.lng ?? null,
        req.authUser?.id ?? null,
        currentProfile?.id ?? null,
      ],
    );

    if (!rows[0]) {
      return res.status(404).json({ error: 'Fan not found.' });
    }

    const socialState = await fetchSocialStateForFanIds(currentProfile?.id ?? null, [rows[0].id]);

    return res.json({ data: mapFanDetailRow(rows[0], socialState.get(rows[0].id)) });
  } catch (error) {
    return next(error);
  }
});

router.post('/:fanId/wave', requireUser, async (req, res, next) => {
  const client = await db.connect();

  try {
    const currentProfile = await getCurrentProfileByAuthUserId(req.authUser.id, client);

    if (!currentProfile) {
      return res.status(403).json({ error: 'Create your profile before sending waves.' });
    }

    const targetProfile = await getProfileById(req.params.fanId, client);

    if (!targetProfile) {
      return res.status(404).json({ error: 'Fan not found.' });
    }

    if (targetProfile.id === currentProfile.id) {
      return res.status(400).json({ error: 'You cannot wave at your own profile.' });
    }

    const fixtureId = currentProfile.matchDayModeFixtureId ?? targetProfile.matchDayModeFixtureId ?? null;

    await client.query('begin');

    await client.query(
      `
        insert into waves (
          sender_profile_id,
          receiver_profile_id,
          fixture_id
        ) values (
          $1::uuid,
          $2::uuid,
          $3::uuid
        )
        on conflict (sender_profile_id, receiver_profile_id) do update
          set fixture_id = coalesce(waves.fixture_id, excluded.fixture_id)
      `,
      [currentProfile.id, targetProfile.id, fixtureId],
    );

    if (!targetProfile.authUserId) {
      await client.query(
        `
          insert into waves (
            sender_profile_id,
            receiver_profile_id,
            fixture_id
          ) values (
            $1::uuid,
            $2::uuid,
            $3::uuid
          )
          on conflict (sender_profile_id, receiver_profile_id) do update
            set fixture_id = coalesce(waves.fixture_id, excluded.fixture_id)
        `,
        [targetProfile.id, currentProfile.id, fixtureId],
      );
    }

    const socialState = await fetchSocialStateForFanIds(currentProfile.id, [targetProfile.id], client);
    const state = socialState.get(targetProfile.id) ?? { waveStatus: 'pending', directThreadId: null };
    let directThreadId = state.directThreadId;

    if (state.waveStatus === 'mutual' && !directThreadId) {
      const thread = await ensureDirectThread(client, {
        profileAId: currentProfile.id,
        profileBId: targetProfile.id,
        fixtureId,
      });
      directThreadId = thread.id;
    }

    await client.query('commit');

    if (targetProfile.authUserId) {
      sendWavePushNotification({
        actorDisplayName: currentProfile.displayName,
        fanId: currentProfile.id,
        recipientExternalId: targetProfile.authUserId,
        threadId: directThreadId,
      }).catch((notificationError) => {
        console.warn('Unable to send wave push notification.', notificationError);
      });
    }

    return res.json({
      data: {
        status: directThreadId ? 'mutual' : state.waveStatus,
        threadId: directThreadId,
        fanId: targetProfile.id,
      },
    });
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    return next(error);
  } finally {
    client.release();
  }
});

router.post('/:fanId/rate', requireUser, async (req, res, next) => {
  const parsed = rateFanBodySchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid rating body.', details: parsed.error.flatten() });
  }

  const client = await db.connect();

  try {
    const currentProfile = await getCurrentProfileByAuthUserId(req.authUser.id, client);

    if (!currentProfile) {
      return res.status(403).json({ error: 'Create your profile before leaving a rating.' });
    }

    const targetProfile = await getProfileById(req.params.fanId, client);

    if (!targetProfile) {
      return res.status(404).json({ error: 'Fan not found.' });
    }

    if (targetProfile.id === currentProfile.id) {
      return res.status(400).json({ error: 'You cannot rate your own profile.' });
    }

    await client.query('begin');

    await client.query(
      `
        insert into fan_ratings (
          rater_profile_id,
          target_profile_id,
          score
        ) values (
          $1::uuid,
          $2::uuid,
          $3::integer
        )
        on conflict (rater_profile_id, target_profile_id) do update
          set score = excluded.score,
              updated_at = now()
      `,
      [currentProfile.id, targetProfile.id, parsed.data.score],
    );

    const ratedProfile = await getProfileById(targetProfile.id, client);

    await client.query('commit');

    return res.json({
      data: {
        fanId: targetProfile.id,
        rating: Number(ratedProfile?.rating ?? 0),
        ratingCount: Number(ratedProfile?.ratingCount ?? 0),
        myRating: parsed.data.score,
      },
    });
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    return next(error);
  } finally {
    client.release();
  }
});

export default router;
