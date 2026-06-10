import { Router } from 'express';
import { z } from 'zod';

import { config } from '../config.js';
import { db } from '../db.js';
import { buildProfileMetricsSql } from '../lib/social.js';
import { requireUser } from '../middleware/auth.js';
import { supabaseAdmin } from '../supabase.js';

const router = Router();

const vibeSchema = z.enum(['Loud', 'Chill', 'Family', 'Women-only']);
const avatarUploadLimitBytes = 5 * 1024 * 1024;
const allowedAvatarMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];

const setupSchema = z
  .object({
    screenSize: z.string().min(1).max(40),
    displayType: z.string().min(1).max(40),
    audio: z.string().min(1).max(80),
  })
  .nullable()
  .optional();

const locationSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  .nullable()
  .optional();

const profileBodySchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  age: z.number().int().min(18).max(100).optional(),
  bio: z.string().max(280).optional(),
  neighborhood: z.string().max(80).optional(),
  city: z.string().max(80).optional(),
  vibe: vibeSchema.optional(),
  favouriteTeams: z.array(z.string().min(1).max(50)).max(8).optional(),
  verified: z.boolean().optional(),
  isHost: z.boolean().optional(),
  womenOnly: z.boolean().optional(),
  familyFriendly: z.boolean().optional(),
  matchDayModeFixtureId: z.string().uuid().nullable().optional(),
  setup: setupSchema,
  location: locationSchema,
});

const profileAvatarBodySchema = z.object({
  base64: z.string().min(1),
  contentType: z.enum(allowedAvatarMimeTypes).optional(),
});

function defaultDisplayName(email) {
  const localPart = email?.split('@')[0] ?? 'MatchBuddy fan';
  return localPart
    .split(/[._-]/g)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function getAvatarExtension(contentType) {
  switch (contentType) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/jpeg':
    default:
      return 'jpg';
  }
}

function buildAvatarUrl(avatarPath) {
  if (!avatarPath) {
    return null;
  }

  const { data } = supabaseAdmin.storage
    .from(config.supabaseProfilePhotoBucket)
    .getPublicUrl(avatarPath);

  return data.publicUrl ?? null;
}

function normalizeBase64(base64) {
  return base64.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
}

async function ensureProfilePhotoBucket() {
  const { data: buckets, error } = await supabaseAdmin.storage.listBuckets();

  if (error) {
    throw error;
  }

  const existingBucket = buckets.find(
    (bucket) =>
      bucket.name === config.supabaseProfilePhotoBucket ||
      bucket.id === config.supabaseProfilePhotoBucket,
  );

  if (!existingBucket) {
    const { error: createError } = await supabaseAdmin.storage.createBucket(
      config.supabaseProfilePhotoBucket,
      {
        public: true,
        allowedMimeTypes: allowedAvatarMimeTypes,
      },
    );

    if (createError && !/already exists/i.test(createError.message ?? '')) {
      throw createError;
    }

    return;
  }

  if (!existingBucket.public) {
    const { error: updateError } = await supabaseAdmin.storage.updateBucket(
      config.supabaseProfilePhotoBucket,
      {
        public: true,
        allowedMimeTypes: allowedAvatarMimeTypes,
      },
    );

    if (updateError) {
      throw updateError;
    }
  }
}

function mapProfileRow(row) {
  return {
    id: row.id,
    authUserId: row.auth_user_id,
    email: row.email,
    avatarUrl: buildAvatarUrl(row.avatar_path),
    displayName: row.display_name,
    age: Number(row.age ?? 0),
    bio: row.bio ?? '',
    neighborhood: row.neighborhood ?? '',
    city: row.city ?? '',
    vibe: row.vibe,
    favouriteTeams: row.favourite_teams ?? [],
    verified: row.verified,
    rating: Number(row.rating ?? 0),
    ratingCount: Number(row.rating_count ?? 0),
    waveBackRate: Number(row.wave_back_rate ?? 0),
    hostWins: Number(row.host_wins ?? 0),
    isHost: row.is_host,
    womenOnly: row.women_only,
    familyFriendly: row.family_friendly,
    matchDayModeFixtureId: row.match_day_mode_fixture_id,
    setup: row.setup ?? null,
    location:
      row.latitude !== null && row.longitude !== null
        ? {
            latitude: Number(row.latitude),
            longitude: Number(row.longitude),
          }
        : null,
  };
}

async function fetchProfileByAuthUserId(authUserId) {
  const metricsSql = buildProfileMetricsSql('p');
  const { rows } = await db.query(
    `
      select
        id,
        auth_user_id,
        email,
        avatar_path,
        display_name,
        age,
        bio,
        neighborhood,
        city,
        vibe,
        favourite_teams,
        verified,
        ${metricsSql.selects},
        host_wins,
        is_host,
        women_only,
        family_friendly,
        match_day_mode_fixture_id,
        setup,
        ST_Y(geog::geometry) as latitude,
        ST_X(geog::geometry) as longitude
      from profiles p
      ${metricsSql.joins}
      where auth_user_id = $1::uuid
      limit 1
    `,
    [authUserId],
  );

  return rows[0] ? mapProfileRow(rows[0]) : null;
}

async function fetchAvatarPathByAuthUserId(authUserId) {
  const { rows } = await db.query(
    `
      select avatar_path
      from profiles
      where auth_user_id = $1::uuid
      limit 1
    `,
    [authUserId],
  );

  return rows[0]?.avatar_path ?? null;
}

router.use(requireUser);

router.get('/me', async (req, res, next) => {
  try {
    const profile = await fetchProfileByAuthUserId(req.authUser.id);

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found. Create one first.' });
    }

    return res.json({ data: profile });
  } catch (error) {
    return next(error);
  }
});

router.post('/me/avatar', async (req, res, next) => {
  const parsed = profileAvatarBodySchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid avatar upload body.', details: parsed.error.flatten() });
  }

  try {
    const existingProfile = await fetchProfileByAuthUserId(req.authUser.id);

    if (!existingProfile) {
      return res.status(404).json({ error: 'Profile not found. Create one first.' });
    }

    const contentType = parsed.data.contentType ?? 'image/jpeg';
    const normalizedBase64 = normalizeBase64(parsed.data.base64);
    const buffer = Buffer.from(normalizedBase64, 'base64');

    if (!buffer.byteLength) {
      return res.status(400).json({ error: 'Profile photo is empty.' });
    }

    if (buffer.byteLength > avatarUploadLimitBytes) {
      return res.status(400).json({ error: 'Profile photo must be 5 MB or smaller.' });
    }

    await ensureProfilePhotoBucket();

    const previousAvatarPath = await fetchAvatarPathByAuthUserId(req.authUser.id);
    const avatarPath = `${req.authUser.id}/avatar-${Date.now()}.${getAvatarExtension(contentType)}`;
    const bucket = supabaseAdmin.storage.from(config.supabaseProfilePhotoBucket);

    const { error: uploadError } = await bucket.upload(avatarPath, buffer, {
      contentType,
      upsert: true,
    });

    if (uploadError) {
      throw uploadError;
    }

    await db.query(
      `
        update profiles
        set avatar_path = $2::text,
            updated_at = now()
        where auth_user_id = $1::uuid
      `,
      [req.authUser.id, avatarPath],
    );

    if (previousAvatarPath && previousAvatarPath !== avatarPath) {
      const { error: removeError } = await bucket.remove([previousAvatarPath]);

      if (removeError) {
        console.warn('Unable to remove previous profile photo from storage.', removeError);
      }
    }

    const refreshedProfile = await fetchProfileByAuthUserId(req.authUser.id);
    return res.json({ data: refreshedProfile });
  } catch (error) {
    return next(error);
  }
});

router.put('/me', async (req, res, next) => {
  const parsed = profileBodySchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid profile body.', details: parsed.error.flatten() });
  }

  try {
    const existingProfile = await fetchProfileByAuthUserId(req.authUser.id);
    const body = parsed.data;
    const merged = {
      email: req.authUser.email ?? existingProfile?.email ?? null,
      displayName: body.displayName ?? existingProfile?.displayName ?? defaultDisplayName(req.authUser.email),
      age: body.age ?? existingProfile?.age ?? 29,
      bio: body.bio ?? existingProfile?.bio ?? '',
      neighborhood: body.neighborhood ?? existingProfile?.neighborhood ?? '',
      city: body.city ?? existingProfile?.city ?? '',
      vibe: body.vibe ?? existingProfile?.vibe ?? 'Chill',
      favouriteTeams: body.favouriteTeams ?? existingProfile?.favouriteTeams ?? [],
      verified: body.verified ?? existingProfile?.verified ?? false,
      rating: existingProfile?.rating ?? 0,
      ratingCount: existingProfile?.ratingCount ?? 0,
      waveBackRate: existingProfile?.waveBackRate ?? 0,
      hostWins: existingProfile?.hostWins ?? 0,
      isHost: body.isHost ?? existingProfile?.isHost ?? false,
      womenOnly: body.womenOnly ?? existingProfile?.womenOnly ?? false,
      familyFriendly: body.familyFriendly ?? existingProfile?.familyFriendly ?? false,
      matchDayModeFixtureId: body.matchDayModeFixtureId ?? existingProfile?.matchDayModeFixtureId ?? null,
      setup: body.setup ?? existingProfile?.setup ?? null,
      location: body.location ?? existingProfile?.location ?? null,
    };

    await db.query(
      `
        insert into profiles (
          auth_user_id,
          email,
          display_name,
          age,
          bio,
          neighborhood,
          city,
          vibe,
          favourite_teams,
          verified,
          rating,
          rating_count,
          wave_back_rate,
          host_wins,
          is_host,
          women_only,
          family_friendly,
          match_day_mode_fixture_id,
          setup,
          geog
        ) values (
          $1::uuid,
          $2::text,
          $3::text,
          $4::integer,
          $5::text,
          $6::text,
          $7::text,
          $8::text,
          $9::text[],
          $10::boolean,
          $11::numeric,
          $12::integer,
          $13::integer,
          $14::integer,
          $15::boolean,
          $16::boolean,
          $17::boolean,
          $18::uuid,
          $19::jsonb,
          case
            when $20::double precision is not null and $21::double precision is not null
              then ST_SetSRID(ST_MakePoint($21, $20), 4326)::geography
            else null::geography
          end
        )
        on conflict (auth_user_id) do update
          set email = excluded.email,
              display_name = excluded.display_name,
              age = excluded.age,
              bio = excluded.bio,
              neighborhood = excluded.neighborhood,
              city = excluded.city,
              vibe = excluded.vibe,
              favourite_teams = excluded.favourite_teams,
              verified = excluded.verified,
              rating = excluded.rating,
              rating_count = excluded.rating_count,
              wave_back_rate = excluded.wave_back_rate,
              host_wins = excluded.host_wins,
              is_host = excluded.is_host,
              women_only = excluded.women_only,
              family_friendly = excluded.family_friendly,
              match_day_mode_fixture_id = excluded.match_day_mode_fixture_id,
              setup = excluded.setup,
              geog = coalesce(excluded.geog, profiles.geog),
              updated_at = now()
      `,
      [
        req.authUser.id,
        merged.email,
        merged.displayName,
        merged.age,
        merged.bio,
        merged.neighborhood,
        merged.city,
        merged.vibe,
        merged.favouriteTeams,
        merged.verified,
        merged.rating,
        merged.ratingCount,
        merged.waveBackRate,
        merged.hostWins,
        merged.isHost,
        merged.womenOnly,
        merged.familyFriendly,
        merged.matchDayModeFixtureId,
        merged.setup ? JSON.stringify(merged.setup) : null,
        merged.location?.latitude ?? null,
        merged.location?.longitude ?? null,
      ],
    );

    const refreshedProfile = await fetchProfileByAuthUserId(req.authUser.id);
    return res.json({ data: refreshedProfile });
  } catch (error) {
    return next(error);
  }
});

export default router;
