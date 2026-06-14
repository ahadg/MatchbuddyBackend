import { db } from '../db.js';

const MODERATION_PATTERNS = [
  /\bkill yourself\b/i,
  /\bi(?:\s+am|'m|\s*will)?\s+kill\s+you\b/i,
  /\brape\b/i,
  /\bsend\s+nudes?\b/i,
  /\bnudes?\b/i,
  /https?:\/\//i,
  /\bwww\./i,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /\+?\d[\d\s().-]{7,}\d/,
];

export function buildBlockedRelationSql(profileAExpr, profileBExpr) {
  return `exists (
    select 1
    from blocked_profiles bp
    where (bp.blocker_profile_id = ${profileAExpr} and bp.blocked_profile_id = ${profileBExpr})
       or (bp.blocker_profile_id = ${profileBExpr} and bp.blocked_profile_id = ${profileAExpr})
  )`;
}

export async function areProfilesBlocked(profileAId, profileBId, client = db) {
  if (!profileAId || !profileBId) {
    return false;
  }

  const { rows } = await client.query(
    `
      select 1
      from blocked_profiles
      where (blocker_profile_id = $1::uuid and blocked_profile_id = $2::uuid)
         or (blocker_profile_id = $2::uuid and blocked_profile_id = $1::uuid)
      limit 1
    `,
    [profileAId, profileBId],
  );

  return Boolean(rows[0]);
}

export async function createProfileBlock(
  client,
  { blockerProfileId, blockedProfileId, reason = '' },
) {
  const { rows } = await client.query(
    `
      insert into blocked_profiles (
        blocker_profile_id,
        blocked_profile_id,
        reason
      ) values (
        $1::uuid,
        $2::uuid,
        $3::text
      )
      on conflict (blocker_profile_id, blocked_profile_id) do update
        set reason = excluded.reason,
            updated_at = now()
      returning id, blocker_profile_id, blocked_profile_id, reason, created_at
    `,
    [blockerProfileId, blockedProfileId, reason.trim()],
  );

  await client.query(
    `
      delete from waves
      where (sender_profile_id = $1::uuid and receiver_profile_id = $2::uuid)
         or (sender_profile_id = $2::uuid and receiver_profile_id = $1::uuid)
    `,
    [blockerProfileId, blockedProfileId],
  );

  return rows[0] ?? null;
}

export async function createSafetyReport(
  client,
  {
    reporterProfileId,
    targetProfileId = null,
    targetListingId = null,
    targetDirectMessageId = null,
    targetListingMessageId = null,
    category,
    details = '',
  },
) {
  const { rows } = await client.query(
    `
      insert into safety_reports (
        reporter_profile_id,
        target_profile_id,
        target_listing_id,
        target_direct_message_id,
        target_listing_message_id,
        category,
        details
      ) values (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::uuid,
        $5::uuid,
        $6::text,
        $7::text
      )
      returning id, category, details, status, created_at
    `,
    [
      reporterProfileId,
      targetProfileId,
      targetListingId,
      targetDirectMessageId,
      targetListingMessageId,
      category,
      details.trim(),
    ],
  );

  return rows[0] ?? null;
}

export function moderateChatBody(body) {
  const normalized = body.trim();

  for (const pattern of MODERATION_PATTERNS) {
    if (pattern.test(normalized)) {
      return 'This message was blocked by MatchBuddy safety filters. Remove abusive or unsafe content and try again.';
    }
  }

  return null;
}
