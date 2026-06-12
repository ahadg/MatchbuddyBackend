import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db.js';
import { createNotifications } from '../lib/notifications.js';
import { sendListingRoomPushNotification } from '../lib/onesignal.js';
import { broadcastListingMessageCreated } from '../lib/realtime.js';
import {
  adjustListingApprovedGuests,
  buildProfileAvatarUrl,
  buildProfileMetricsSql,
  createListingMessage,
  fixtureSummaryFromRow,
  getCurrentProfileByAuthUserId,
} from '../lib/social.js';
import { requireUser } from '../middleware/auth.js';

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

const joinRequestBodySchema = z.object({
  message: z.string().trim().max(300).optional(),
});

const joinRequestResponseSchema = z.object({
  status: z.enum(['approved', 'declined']),
});

const roomMessageBodySchema = z.object({
  body: z.string().trim().min(1).max(1000),
});

function approvedGuestDelta(previousStatus, nextStatus) {
  const wasApproved = previousStatus === 'approved';
  const willBeApproved = nextStatus === 'approved';

  if (!wasApproved && willBeApproved) {
    return 1;
  }

  if (wasApproved && !willBeApproved) {
    return -1;
  }

  return 0;
}

function canAccessRoom({ isHost, requestStatus }) {
  return isHost || requestStatus === 'approved';
}

function mapListingRow(row, socialState = null) {
  const approvedGuests = Number(row.approved_guests ?? 0);
  const maxGuests = Number(row.max_guests ?? 0);
  const requestStatus = socialState?.requestStatus ?? 'none';
  const isHost = Boolean(socialState?.isHost);

  return {
    id: row.id,
    slug: row.slug,
    fixtureId: row.fixture_id,
    fixtureSummary: fixtureSummaryFromRow(row),
    fixtureStage: row.fixture_stage,
    hostId: row.host_id,
    hostName: row.host_name,
    hostInitial: row.host_initial,
    hostVerified: row.host_verified,
    hostRating: Number(row.host_rating ?? 0),
    hostHostWins: Number(row.host_host_wins ?? 0),
    neighborhood: row.neighborhood,
    vibe: row.vibe,
    maxGuests,
    approvedGuests,
    spotsLeft: Math.max(0, maxGuests - approvedGuests),
    extras: row.extras ?? [],
    houseRules: row.house_rules ?? [],
    joinMessage: row.join_message ?? '',
    priceNote: row.price_note ?? 'Free',
    distanceKm: row.distance_km === null ? null : Number(row.distance_km ?? 0),
    isOpen: row.is_open,
    myRequestStatus: requestStatus,
    isHost,
    canOpenRoom: canAccessRoom({ isHost, requestStatus }),
  };
}

function mapRoomMessageRow(row) {
  return {
    id: row.id,
    listingId: row.listing_id,
    senderProfileId: row.sender_profile_id,
    senderAvatarUrl: buildProfileAvatarUrl(row.sender_avatar_path),
    senderDisplayName: row.sender_display_name,
    senderInitial: row.sender_initial,
    body: row.body,
    createdAt: row.created_at,
  };
}

async function fetchListingRequestStates(currentProfileId, listingIds, client = db) {
  if (!currentProfileId || !listingIds.length) {
    return new Map();
  }

  const { rows } = await client.query(
    `
      select
        listing_id,
        status
      from listing_join_requests
      where guest_profile_id = $1::uuid
        and listing_id = any($2::uuid[])
    `,
    [currentProfileId, listingIds],
  );

  return new Map(rows.map((row) => [row.listing_id, row.status]));
}

async function fetchListingByIdentifier(listingIdentifier, options = {}, client = db) {
  const { lat = null, lng = null, authUserId = null } = options;
  const hostMetricsSql = buildProfileMetricsSql('host', {
    ratingAlias: 'host_rating',
    ratingCountAlias: 'host_rating_count',
    waveBackRateAlias: 'host_wave_back_rate',
  });

  const { rows } = await client.query(
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
        l.id,
        l.slug,
        l.fixture_id,
        l.host_id,
        host.auth_user_id as host_auth_user_id,
        host.display_name as host_name,
        host.bio as host_bio,
        host.setup as host_setup,
        host.verified as host_verified,
        ${hostMetricsSql.selects},
        host.host_wins as host_host_wins,
        coalesce(nullif(left(host.display_name, 1), ''), '?') as host_initial,
        l.neighborhood,
        l.vibe,
        l.max_guests,
        l.approved_guests,
        l.extras,
        l.house_rules,
        l.join_message,
        l.price_note,
        l.is_open,
        fx.stage as fixture_stage,
        fx.home_code,
        fx.home_team,
        fx.away_code,
        fx.away_team,
        fx.venue,
        case
          when origin.geog is not null and l.geog is not null
            then round((ST_Distance(l.geog, origin.geog) / 1000.0)::numeric, 1)
          else null
        end as distance_km
      from listings l
      inner join profiles host on host.id = l.host_id
      inner join fixtures fx on fx.id = l.fixture_id
      cross join origin
      ${hostMetricsSql.joins}
      where l.id::text = $1::text or l.slug = $1::text
      limit 1
    `,
    [listingIdentifier, lat, lng, authUserId],
  );

  return rows[0] ?? null;
}

async function fetchRoomForProfile(listingIdentifier, currentProfileId, client = db) {
  const { rows } = await client.query(
    `
      select
        l.id,
        l.slug,
        l.host_id,
        l.vibe,
        l.approved_guests,
        l.max_guests,
        l.join_message,
        host.avatar_path as host_avatar_path,
        host.display_name as host_name,
        fx.stage as fixture_stage,
        fx.home_code,
        fx.away_code,
        req.status as request_status
      from listings l
      inner join profiles host on host.id = l.host_id
      inner join fixtures fx on fx.id = l.fixture_id
      left join listing_join_requests req
        on req.listing_id = l.id
       and req.guest_profile_id = $2::uuid
      where l.id::text = $1::text or l.slug = $1::text
      limit 1
    `,
    [listingIdentifier, currentProfileId],
  );

  return rows[0] ?? null;
}

async function fetchRoomNotificationRecipients(listingId, senderProfileId, client = db) {
  const { rows } = await client.query(
    `
      select distinct
        p.id,
        p.auth_user_id,
        p.display_name
      from profiles p
      where p.id in (
        select l.host_id
        from listings l
        where l.id = $1::uuid

        union

        select req.guest_profile_id
        from listing_join_requests req
        where req.listing_id = $1::uuid
          and req.status = 'approved'
      )
        and p.id <> $2::uuid
    `,
    [listingId, senderProfileId],
  );

  return rows;
}

async function fetchListingMessages(listingId, client = db) {
  const { rows } = await client.query(
    `
      select
        lm.id,
        lm.listing_id,
        lm.sender_profile_id,
        lm.body,
        lm.created_at,
        sender.avatar_path as sender_avatar_path,
        sender.display_name as sender_display_name,
        coalesce(nullif(left(sender.display_name, 1), ''), '?') as sender_initial
      from listing_messages lm
      inner join profiles sender on sender.id = lm.sender_profile_id
      where lm.listing_id = $1::uuid
      order by lm.created_at asc
    `,
    [listingId],
  );

  return rows.map(mapRoomMessageRow);
}

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
    const currentProfile = req.authUser?.id ? await getCurrentProfileByAuthUserId(req.authUser.id) : null;
    const hostMetricsSql = buildProfileMetricsSql('host', {
      ratingAlias: 'host_rating',
      ratingCountAlias: 'host_rating_count',
      waveBackRateAlias: 'host_wave_back_rate',
    });

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
          host.display_name as host_name,
          host.verified as host_verified,
          ${hostMetricsSql.selects},
          host.host_wins as host_host_wins,
          coalesce(nullif(left(host.display_name, 1), ''), '?') as host_initial,
          l.neighborhood,
          l.vibe,
          l.max_guests,
          l.approved_guests,
          l.extras,
          l.house_rules,
          l.join_message,
          l.price_note,
          l.is_open,
          fx.stage as fixture_stage,
          fx.home_code,
          fx.away_code,
          round((ST_Distance(l.geog, origin.geog) / 1000.0)::numeric, 1) as distance_km
        from listings l
        inner join profiles host on host.id = l.host_id
        inner join fixtures fx on fx.id = l.fixture_id
        cross join origin
        ${hostMetricsSql.joins}
        where origin.geog is not null
          and l.geog is not null
          and l.is_open = true
          and ST_DWithin(l.geog, origin.geog, $4::double precision * 1000)
          and ($5::uuid is null or l.fixture_id = $5::uuid)
        order by ST_Distance(l.geog, origin.geog) asc
      `,
      [lat ?? null, lng ?? null, req.authUser?.id ?? null, radiusKm, fixtureId ?? null],
    );

    const requestStates = await fetchListingRequestStates(
      currentProfile?.id ?? null,
      rows.map((row) => row.id),
    );

    return res.json({
      data: rows.map((row) =>
        mapListingRow(row, {
          requestStatus: requestStates.get(row.id) ?? 'none',
          isHost: currentProfile?.id === row.host_id,
        }),
      ),
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/:listingId/messages', requireUser, async (req, res, next) => {
  try {
    const currentProfile = await getCurrentProfileByAuthUserId(req.authUser.id);

    if (!currentProfile) {
      return res.status(403).json({ error: 'Create your profile before opening listing rooms.' });
    }

    const room = await fetchRoomForProfile(req.params.listingId, currentProfile.id);

    if (!room) {
      return res.status(404).json({ error: 'Listing not found.' });
    }

    const isHost = room.host_id === currentProfile.id;

    if (!canAccessRoom({ isHost, requestStatus: room.request_status })) {
      return res.status(403).json({ error: 'Room access unlocks only after approval.' });
    }

    const messages = await fetchListingMessages(room.id);

    return res.json({
      data: {
        room: {
          listingId: room.id,
          slug: room.slug,
          hostAvatarUrl: buildProfileAvatarUrl(room.host_avatar_path),
          hostName: room.host_name,
          isHost,
          vibe: room.vibe,
          attendeeCount: Number(room.approved_guests ?? 0) + 1,
          maxGuests: Number(room.max_guests ?? 0),
          joinMessage: room.join_message,
          fixtureSummary: fixtureSummaryFromRow(room),
          fixtureStage: room.fixture_stage,
        },
        messages,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/:listingId/messages', requireUser, async (req, res, next) => {
  const parsed = roomMessageBodySchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid room message body.', details: parsed.error.flatten() });
  }

  const client = await db.connect();

  try {
    const currentProfile = await getCurrentProfileByAuthUserId(req.authUser.id, client);

    if (!currentProfile) {
      return res.status(403).json({ error: 'Create your profile before sending room messages.' });
    }

    const room = await fetchRoomForProfile(req.params.listingId, currentProfile.id, client);

    if (!room) {
      return res.status(404).json({ error: 'Listing not found.' });
    }

    const isHost = room.host_id === currentProfile.id;

    if (!canAccessRoom({ isHost, requestStatus: room.request_status })) {
      return res.status(403).json({ error: 'Room access unlocks only after approval.' });
    }

    await client.query('begin');
    const message = await createListingMessage(client, {
      listingId: room.id,
      senderProfileId: currentProfile.id,
      body: parsed.data.body,
    });
    const recipients = await fetchRoomNotificationRecipients(room.id, currentProfile.id, client);
    const responseMessage = {
      id: message.id,
      listingId: message.listing_id,
      senderProfileId: message.sender_profile_id,
      senderAvatarUrl: currentProfile.avatarUrl,
      senderDisplayName: currentProfile.displayName,
      senderInitial: currentProfile.initial,
      body: message.body,
      createdAt: message.created_at,
    };

    await createNotifications(
      client,
      recipients.map((recipient) => ({
        recipientProfileId: recipient.id,
        actorProfileId: currentProfile.id,
        type: 'listing_message',
        title: `${currentProfile.displayName} sent a room update`,
        body: message.body,
        listingId: room.id,
        fanId: currentProfile.id,
        metadata: {
          listingId: room.id,
        },
      })),
    );
    await client.query('commit');

    const recipientExternalIds = recipients
      .map((recipient) => recipient.auth_user_id)
      .filter(Boolean);

    if (recipientExternalIds.length) {
      sendListingRoomPushNotification({
        actorDisplayName: currentProfile.displayName,
        body: message.body,
        listingId: room.id,
        recipientExternalIds,
      }).catch((notificationError) => {
        console.warn('Unable to send listing room push notification.', notificationError);
      });
    }

    broadcastListingMessageCreated(room.id, responseMessage, {
      excludeProfileId: currentProfile.id,
    });

    return res.status(201).json({
      data: responseMessage,
    });
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    return next(error);
  } finally {
    client.release();
  }
});

router.post('/:listingId/join-requests', requireUser, async (req, res, next) => {
  const parsed = joinRequestBodySchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid join request body.', details: parsed.error.flatten() });
  }

  const client = await db.connect();

  try {
    const currentProfile = await getCurrentProfileByAuthUserId(req.authUser.id, client);

    if (!currentProfile) {
      return res.status(403).json({ error: 'Create your profile before requesting a spot.' });
    }

    const listing = await fetchListingByIdentifier(req.params.listingId, {}, client);

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found.' });
    }

    if (listing.host_id === currentProfile.id) {
      return res.status(400).json({ error: 'Hosts cannot request their own listing.' });
    }

    if (!listing.is_open) {
      return res.status(400).json({ error: 'This listing is no longer open.' });
    }

    const { rows: existingRows } = await client.query(
      `
        select id, status
        from listing_join_requests
        where listing_id = $1::uuid
          and guest_profile_id = $2::uuid
        limit 1
      `,
      [listing.id, currentProfile.id],
    );

    const existingRequest = existingRows[0] ?? null;
    const nextStatus = listing.host_auth_user_id ? 'pending' : 'approved';
    const delta = approvedGuestDelta(existingRequest?.status ?? null, nextStatus);

    if (delta > 0 && Number(listing.approved_guests ?? 0) >= Number(listing.max_guests ?? 0)) {
      return res.status(409).json({ error: 'This listing is already full.' });
    }

    await client.query('begin');

    const { rows } = await client.query(
      `
        insert into listing_join_requests (
          listing_id,
          guest_profile_id,
          message,
          status,
          responded_by_profile_id,
          responded_at
        ) values (
          $1::uuid,
          $2::uuid,
          $3::text,
          $4::text,
          $5::uuid,
          $6::timestamptz
        )
        on conflict (listing_id, guest_profile_id) do update
          set message = excluded.message,
              status = excluded.status,
              responded_by_profile_id = excluded.responded_by_profile_id,
              responded_at = excluded.responded_at,
              updated_at = now()
        returning id, listing_id, guest_profile_id, message, status, responded_at
      `,
      [
        listing.id,
        currentProfile.id,
        parsed.data.message ?? '',
        nextStatus,
        nextStatus === 'approved' ? listing.host_id : null,
        nextStatus === 'approved' ? new Date().toISOString() : null,
      ],
    );

    await adjustListingApprovedGuests(client, listing.id, delta);

    if (nextStatus === 'approved' && delta > 0) {
      await createListingMessage(client, {
        listingId: listing.id,
        senderProfileId: listing.host_id,
        body: listing.join_message || 'You are approved. Keep arrival updates in this room.',
      });
    }

    await client.query('commit');

    return res.status(201).json({
      data: {
        id: rows[0].id,
        listingId: rows[0].listing_id,
        guestProfileId: rows[0].guest_profile_id,
        message: rows[0].message,
        status: rows[0].status,
        respondedAt: rows[0].responded_at,
      },
    });
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    return next(error);
  } finally {
    client.release();
  }
});

router.post('/:listingId/join-requests/:requestId/respond', requireUser, async (req, res, next) => {
  const parsed = joinRequestResponseSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid join request response body.', details: parsed.error.flatten() });
  }

  const client = await db.connect();

  try {
    const currentProfile = await getCurrentProfileByAuthUserId(req.authUser.id, client);

    if (!currentProfile) {
      return res.status(403).json({ error: 'Create your profile before responding to requests.' });
    }

    const { rows: requestRows } = await client.query(
      `
        select
          req.id,
          req.listing_id,
          req.guest_profile_id,
          req.status,
          l.host_id,
          l.max_guests,
          l.approved_guests,
          l.join_message
        from listing_join_requests req
        inner join listings l on l.id = req.listing_id
        where req.id = $1::uuid
          and (l.id::text = $2::text or l.slug = $2::text)
        limit 1
      `,
      [req.params.requestId, req.params.listingId],
    );

    const joinRequest = requestRows[0] ?? null;

    if (!joinRequest) {
      return res.status(404).json({ error: 'Join request not found.' });
    }

    if (joinRequest.host_id !== currentProfile.id) {
      return res.status(403).json({ error: 'Only the host can respond to this request.' });
    }

    const delta = approvedGuestDelta(joinRequest.status, parsed.data.status);

    if (delta > 0 && Number(joinRequest.approved_guests ?? 0) >= Number(joinRequest.max_guests ?? 0)) {
      return res.status(409).json({ error: 'This listing is already full.' });
    }

    await client.query('begin');

    const { rows } = await client.query(
      `
        update listing_join_requests
        set status = $2::text,
            responded_by_profile_id = $3::uuid,
            responded_at = now(),
            updated_at = now()
        where id = $1::uuid
        returning id, listing_id, guest_profile_id, message, status, responded_at
      `,
      [joinRequest.id, parsed.data.status, currentProfile.id],
    );

    await adjustListingApprovedGuests(client, joinRequest.listing_id, delta);

    if (parsed.data.status === 'approved' && delta > 0) {
      await createListingMessage(client, {
        listingId: joinRequest.listing_id,
        senderProfileId: currentProfile.id,
        body: joinRequest.join_message || 'Spot approved. Share arrival timing here.',
      });
    }

    await client.query('commit');

    return res.json({
      data: {
        id: rows[0].id,
        listingId: rows[0].listing_id,
        guestProfileId: rows[0].guest_profile_id,
        message: rows[0].message,
        status: rows[0].status,
        respondedAt: rows[0].responded_at,
      },
    });
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    return next(error);
  } finally {
    client.release();
  }
});

router.get('/:listingId', async (req, res, next) => {
  const parsed = detailQuerySchema.safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid listing detail query.', details: parsed.error.flatten() });
  }

  try {
    const currentProfile = req.authUser?.id ? await getCurrentProfileByAuthUserId(req.authUser.id) : null;
    const listing = await fetchListingByIdentifier(
      req.params.listingId,
      {
        lat: parsed.data.lat ?? null,
        lng: parsed.data.lng ?? null,
        authUserId: req.authUser?.id ?? null,
      },
      db,
    );

    if (!listing) {
      return res.status(404).json({ error: 'Listing not found.' });
    }

    const requestStates = await fetchListingRequestStates(currentProfile?.id ?? null, [listing.id], db);
    const summary = mapListingRow(listing, {
      requestStatus: requestStates.get(listing.id) ?? 'none',
      isHost: currentProfile?.id === listing.host_id,
    });

    return res.json({
      data: {
        ...summary,
        hostBio: listing.host_bio ?? '',
        hostSetup: listing.host_setup ?? null,
        homeCode: listing.home_code,
        homeTeam: listing.home_team,
        awayCode: listing.away_code,
        awayTeam: listing.away_team,
        venue: listing.venue,
      },
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
