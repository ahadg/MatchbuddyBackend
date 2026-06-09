import { Router } from 'express';
import { z } from 'zod';

import { db } from '../db.js';
import { createDirectMessage, fixtureSummaryFromRow, getCurrentProfileByAuthUserId } from '../lib/social.js';
import { requireUser } from '../middleware/auth.js';

const router = Router();

const messageBodySchema = z.object({
  body: z.string().trim().min(1).max(1000),
});

function mapDirectMessageRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    senderProfileId: row.sender_profile_id,
    senderDisplayName: row.sender_display_name,
    senderInitial: row.sender_initial,
    body: row.body,
    createdAt: row.created_at,
  };
}

async function fetchDirectThreadForProfile(threadId, currentProfileId, client = db) {
  const { rows } = await client.query(
    `
      select
        dt.id,
        dt.profile_low_id,
        dt.profile_high_id,
        dt.fixture_id,
        dt.unlocked_at,
        dt.updated_at,
        other.id as other_profile_id,
        other.display_name as other_display_name,
        other.vibe as other_vibe,
        other.neighborhood as other_neighborhood,
        coalesce(nullif(left(other.display_name, 1), ''), '?') as other_initial,
        fx.stage,
        fx.home_code,
        fx.away_code
      from direct_threads dt
      inner join profiles other
        on other.id = case
          when dt.profile_low_id = $2::uuid then dt.profile_high_id
          else dt.profile_low_id
        end
      left join fixtures fx on fx.id = dt.fixture_id
      where dt.id = $1::uuid
        and (dt.profile_low_id = $2::uuid or dt.profile_high_id = $2::uuid)
      limit 1
    `,
    [threadId, currentProfileId],
  );

  return rows[0] ?? null;
}

async function fetchDirectMessages(threadId, client = db) {
  const { rows } = await client.query(
    `
      select
        dm.id,
        dm.thread_id,
        dm.sender_profile_id,
        dm.body,
        dm.created_at,
        sender.display_name as sender_display_name,
        coalesce(nullif(left(sender.display_name, 1), ''), '?') as sender_initial
      from direct_messages dm
      inner join profiles sender on sender.id = dm.sender_profile_id
      where dm.thread_id = $1::uuid
      order by dm.created_at asc
    `,
    [threadId],
  );

  return rows.map(mapDirectMessageRow);
}

router.use(requireUser);

router.get('/inbox', async (req, res, next) => {
  try {
    const currentProfile = await getCurrentProfileByAuthUserId(req.authUser.id);

    if (!currentProfile) {
      return res.status(403).json({ error: 'Create your profile before opening chats.' });
    }

    const [directThreadResult, incomingWaveResult, groupRoomResult] = await Promise.all([
      db.query(
        `
          select
            dt.id,
            other.id as other_profile_id,
            other.display_name as other_display_name,
            other.vibe as other_vibe,
            other.neighborhood as other_neighborhood,
            coalesce(nullif(left(other.display_name, 1), ''), '?') as other_initial,
            fx.stage,
            fx.home_code,
            fx.away_code,
            last_message.body as last_message_body,
            last_message.created_at as last_message_at,
            dt.unlocked_at
          from direct_threads dt
          inner join profiles other
            on other.id = case
              when dt.profile_low_id = $1::uuid then dt.profile_high_id
              else dt.profile_low_id
            end
          left join fixtures fx on fx.id = dt.fixture_id
          left join lateral (
            select body, created_at
            from direct_messages
            where thread_id = dt.id
            order by created_at desc
            limit 1
          ) last_message on true
          where dt.profile_low_id = $1::uuid or dt.profile_high_id = $1::uuid
          order by coalesce(last_message.created_at, dt.updated_at, dt.unlocked_at) desc
        `,
        [currentProfile.id],
      ),
      db.query(
        `
          select
            w.id,
            w.sender_profile_id as from_profile_id,
            sender.neighborhood as from_neighborhood,
            sender.city as from_city,
            fx.home_code,
            fx.away_code,
            w.created_at
          from waves w
          inner join profiles sender on sender.id = w.sender_profile_id
          left join fixtures fx on fx.id = w.fixture_id
          where w.receiver_profile_id = $1::uuid
            and not exists (
              select 1
              from waves reciprocal
              where reciprocal.sender_profile_id = $1::uuid
                and reciprocal.receiver_profile_id = w.sender_profile_id
            )
          order by w.created_at desc
        `,
        [currentProfile.id],
      ),
      db.query(
        `
          select
            l.id,
            l.slug,
            l.vibe,
            l.approved_guests,
            l.max_guests,
            host.id as host_id,
            host.display_name as host_name,
            fx.stage,
            fx.home_code,
            fx.away_code,
            req.status as my_request_status,
            last_message.body as last_message_body,
            last_message.created_at as last_message_at
          from listings l
          inner join profiles host on host.id = l.host_id
          inner join fixtures fx on fx.id = l.fixture_id
          left join listing_join_requests req
            on req.listing_id = l.id
           and req.guest_profile_id = $1::uuid
          left join lateral (
            select body, created_at
            from listing_messages
            where listing_id = l.id
            order by created_at desc
            limit 1
          ) last_message on true
          where l.host_id = $1::uuid
             or req.status = 'approved'
          order by coalesce(last_message.created_at, l.updated_at, l.created_at) desc
        `,
        [currentProfile.id],
      ),
    ]);

    return res.json({
      data: {
        directThreads: directThreadResult.rows.map((row) => ({
          id: row.id,
          otherProfileId: row.other_profile_id,
          otherDisplayName: row.other_display_name,
          otherInitial: row.other_initial,
          otherVibe: row.other_vibe,
          otherNeighborhood: row.other_neighborhood,
          fixtureSummary: fixtureSummaryFromRow(row),
          fixtureStage: row.stage,
          lastMessage: row.last_message_body ?? null,
          lastMessageAt: row.last_message_at ?? row.unlocked_at,
        })),
        incomingWaves: incomingWaveResult.rows.map((row) => ({
          id: row.id,
          fromProfileId: row.from_profile_id,
          fromNeighborhood: row.from_neighborhood,
          fromCity: row.from_city,
          fixtureSummary: fixtureSummaryFromRow(row),
          createdAt: row.created_at,
        })),
        groupRooms: groupRoomResult.rows.map((row) => ({
          listingId: row.id,
          slug: row.slug,
          vibe: row.vibe,
          hostId: row.host_id,
          hostName: row.host_name,
          isHost: row.host_id === currentProfile.id,
          attendeeCount: Number(row.approved_guests ?? 0) + 1,
          maxGuests: Number(row.max_guests ?? 0),
          fixtureSummary: fixtureSummaryFromRow(row),
          fixtureStage: row.stage,
          lastMessage: row.last_message_body ?? null,
          lastMessageAt: row.last_message_at ?? null,
          myRequestStatus: row.host_id === currentProfile.id ? 'host' : row.my_request_status,
        })),
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/direct/:threadId/messages', async (req, res, next) => {
  try {
    const currentProfile = await getCurrentProfileByAuthUserId(req.authUser.id);

    if (!currentProfile) {
      return res.status(403).json({ error: 'Create your profile before opening chats.' });
    }

    const thread = await fetchDirectThreadForProfile(req.params.threadId, currentProfile.id);

    if (!thread) {
      return res.status(404).json({ error: 'Direct thread not found.' });
    }

    const messages = await fetchDirectMessages(thread.id);

    return res.json({
      data: {
        thread: {
          id: thread.id,
          otherProfileId: thread.other_profile_id,
          otherDisplayName: thread.other_display_name,
          otherInitial: thread.other_initial,
          otherVibe: thread.other_vibe,
          otherNeighborhood: thread.other_neighborhood,
          fixtureSummary: fixtureSummaryFromRow(thread),
          fixtureStage: thread.stage,
        },
        messages,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/direct/:threadId/messages', async (req, res, next) => {
  const parsed = messageBodySchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid message body.', details: parsed.error.flatten() });
  }

  const client = await db.connect();

  try {
    const currentProfile = await getCurrentProfileByAuthUserId(req.authUser.id, client);

    if (!currentProfile) {
      return res.status(403).json({ error: 'Create your profile before sending messages.' });
    }

    const thread = await fetchDirectThreadForProfile(req.params.threadId, currentProfile.id, client);

    if (!thread) {
      return res.status(404).json({ error: 'Direct thread not found.' });
    }

    await client.query('begin');
    const message = await createDirectMessage(client, {
      threadId: thread.id,
      senderProfileId: currentProfile.id,
      body: parsed.data.body,
    });
    await client.query('commit');

    return res.status(201).json({
      data: mapDirectMessageRow({
        ...message,
        sender_display_name: currentProfile.displayName,
        sender_initial: currentProfile.initial,
      }),
    });
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    return next(error);
  } finally {
    client.release();
  }
});

export default router;
