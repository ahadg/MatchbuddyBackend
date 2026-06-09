import { db } from '../db.js';

function mapProfile(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    authUserId: row.auth_user_id,
    displayName: row.display_name,
    neighborhood: row.neighborhood,
    city: row.city,
    vibe: row.vibe,
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
    initial: row.initial ?? '?',
  };
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function sortProfileIds(profileAId, profileBId) {
  return profileAId.localeCompare(profileBId) <= 0 ? [profileAId, profileBId] : [profileBId, profileAId];
}

export function fixtureSummaryFromRow(row) {
  if (!row?.home_code || !row?.away_code) {
    return null;
  }

  return `${row.home_code}-${row.away_code}`;
}

export async function getCurrentProfileByAuthUserId(authUserId, client = db) {
  const { rows } = await client.query(
    `
      select
        id,
        auth_user_id,
        display_name,
        neighborhood,
        city,
        vibe,
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
        coalesce(nullif(left(display_name, 1), ''), '?') as initial
      from profiles
      where auth_user_id = $1::uuid
      limit 1
    `,
    [authUserId],
  );

  return mapProfile(rows[0]);
}

export async function getProfileById(profileId, client = db) {
  const { rows } = await client.query(
    `
      select
        id,
        auth_user_id,
        display_name,
        neighborhood,
        city,
        vibe,
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
        coalesce(nullif(left(display_name, 1), ''), '?') as initial
      from profiles
      where id = $1::uuid
      limit 1
    `,
    [profileId],
  );

  return mapProfile(rows[0]);
}

export async function ensureDirectThread(client, { profileAId, profileBId, fixtureId = null }) {
  const [profileLowId, profileHighId] = sortProfileIds(profileAId, profileBId);
  const { rows } = await client.query(
    `
      insert into direct_threads (
        profile_low_id,
        profile_high_id,
        fixture_id
      ) values (
        $1::uuid,
        $2::uuid,
        $3::uuid
      )
      on conflict (profile_low_id, profile_high_id) do update
        set fixture_id = coalesce(direct_threads.fixture_id, excluded.fixture_id),
            updated_at = now()
      returning id, profile_low_id, profile_high_id, fixture_id, unlocked_at, created_at, updated_at
    `,
    [profileLowId, profileHighId, fixtureId],
  );

  return rows[0];
}

export async function createDirectMessage(client, { threadId, senderProfileId, body }) {
  const trimmedBody = body.trim();
  const { rows } = await client.query(
    `
      insert into direct_messages (
        thread_id,
        sender_profile_id,
        body
      ) values (
        $1::uuid,
        $2::uuid,
        $3::text
      )
      returning id, thread_id, sender_profile_id, body, created_at
    `,
    [threadId, senderProfileId, trimmedBody],
  );

  await client.query(
    `
      update direct_threads
      set updated_at = now()
      where id = $1::uuid
    `,
    [threadId],
  );

  return rows[0];
}

export async function createListingMessage(client, { listingId, senderProfileId, body }) {
  const trimmedBody = body.trim();
  const { rows } = await client.query(
    `
      insert into listing_messages (
        listing_id,
        sender_profile_id,
        body
      ) values (
        $1::uuid,
        $2::uuid,
        $3::text
      )
      returning id, listing_id, sender_profile_id, body, created_at
    `,
    [listingId, senderProfileId, trimmedBody],
  );

  return rows[0];
}

export async function adjustListingApprovedGuests(client, listingId, delta) {
  if (!delta) {
    return;
  }

  await client.query(
    `
      update listings
      set approved_guests = greatest(0, approved_guests + $2::integer),
          updated_at = now()
      where id = $1::uuid
    `,
    [listingId, delta],
  );
}
