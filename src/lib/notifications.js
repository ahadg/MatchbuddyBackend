import { db } from '../db.js';
import { buildBlockedRelationSql } from './safety.js';
import { buildProfileAvatarUrl } from './social.js';

function mapNotificationRow(row) {
  return {
    id: row.id,
    recipientProfileId: row.recipient_profile_id,
    actorProfileId: row.actor_profile_id,
    actorDisplayName: row.actor_display_name ?? null,
    actorAvatarUrl: buildProfileAvatarUrl(row.actor_avatar_path),
    actorInitial: row.actor_initial ?? null,
    type: row.type,
    title: row.title,
    body: row.body,
    threadId: row.thread_id ?? null,
    listingId: row.listing_id ?? null,
    fanId: row.fan_id ?? null,
    metadata: row.metadata ?? {},
    readAt: row.read_at ?? null,
    createdAt: row.created_at,
  };
}

export async function createNotification(client, input) {
  const {
    recipientProfileId,
    actorProfileId = null,
    type,
    title,
    body,
    threadId = null,
    listingId = null,
    fanId = null,
    metadata = {},
  } = input;

  const { rows } = await client.query(
    `
      insert into app_notifications (
        recipient_profile_id,
        actor_profile_id,
        type,
        title,
        body,
        thread_id,
        listing_id,
        fan_id,
        metadata
      ) values (
        $1::uuid,
        $2::uuid,
        $3::text,
        $4::text,
        $5::text,
        $6::uuid,
        $7::uuid,
        $8::uuid,
        $9::jsonb
      )
      returning
        id,
        recipient_profile_id,
        actor_profile_id,
        type,
        title,
        body,
        thread_id,
        listing_id,
        fan_id,
        metadata,
        read_at,
        created_at
    `,
    [
      recipientProfileId,
      actorProfileId,
      type,
      title,
      body,
      threadId,
      listingId,
      fanId,
      JSON.stringify(metadata),
    ],
  );

  return rows[0] ?? null;
}

export async function createNotifications(client, notifications) {
  const created = [];

  for (const notification of notifications) {
    const row = await createNotification(client, notification);
    if (row) {
      created.push(row);
    }
  }

  return created;
}

export async function fetchNotificationsForProfile(profileId, { limit = 30 } = {}, client = db) {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const [notificationResult, unreadResult] = await Promise.all([
    client.query(
      `
        select
          n.id,
          n.recipient_profile_id,
          n.actor_profile_id,
          n.type,
          n.title,
          n.body,
          n.thread_id,
          n.listing_id,
          n.fan_id,
          n.metadata,
          n.read_at,
          n.created_at,
          actor.display_name as actor_display_name,
          actor.avatar_path as actor_avatar_path,
          coalesce(nullif(left(actor.display_name, 1), ''), '?') as actor_initial
        from app_notifications n
        left join profiles actor on actor.id = n.actor_profile_id
        where n.recipient_profile_id = $1::uuid
          and not ${buildBlockedRelationSql('n.actor_profile_id', '$1::uuid')}
        order by n.created_at desc
        limit $2::integer
      `,
      [profileId, safeLimit],
    ),
    client.query(
      `
        select count(*)::int as unread_count
        from app_notifications
        where recipient_profile_id = $1::uuid
          and read_at is null
          and not ${buildBlockedRelationSql('actor_profile_id', '$1::uuid')}
      `,
      [profileId],
    ),
  ]);

  return {
    items: notificationResult.rows.map(mapNotificationRow),
    unreadCount: unreadResult.rows[0]?.unread_count ?? 0,
  };
}

export async function markAllNotificationsRead(profileId, client = db) {
  await client.query(
    `
      update app_notifications
      set read_at = now()
      where recipient_profile_id = $1::uuid
        and read_at is null
    `,
    [profileId],
  );
}
