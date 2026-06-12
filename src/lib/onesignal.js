import { config } from '../config.js';

const ONE_SIGNAL_NOTIFICATIONS_URL = 'https://api.onesignal.com/notifications';

async function sendPushNotification({
  contents,
  data,
  headings,
  name,
  recipientExternalIds,
}) {
  const targets = recipientExternalIds.filter(Boolean);

  if (!config.oneSignalAppId || !config.oneSignalRestApiKey || targets.length === 0) {
    return { skipped: true };
  }

  const response = await fetch(ONE_SIGNAL_NOTIFICATIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Key ${config.oneSignalRestApiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      app_id: config.oneSignalAppId,
      target_channel: 'push',
      include_aliases: {
        external_id: targets,
      },
      name,
      headings,
      contents,
      data,
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`OneSignal request failed with ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

export async function sendWavePushNotification({
  actorDisplayName,
  fanId,
  recipientExternalId,
  threadId = null,
}) {
  const isMutual = Boolean(threadId);
  const title = isMutual ? 'Mutual wave unlocked' : 'New wave on MatchBuddy';
  const body = isMutual
    ? `${actorDisplayName} waved back. Your chat is now open.`
    : `${actorDisplayName} waved at you. Open MatchBuddy to respond.`;

  return sendPushNotification({
    recipientExternalIds: [recipientExternalId],
    name: isMutual ? 'Mutual wave' : 'Wave received',
    headings: {
      en: title,
    },
    contents: {
      en: body,
    },
    data: {
      fanId,
      threadId,
      type: isMutual ? 'mutual_wave' : 'wave',
    },
  });
}

export async function sendDirectMessagePushNotification({
  actorDisplayName,
  body,
  recipientExternalId,
  threadId,
}) {
  const preview = body.trim().slice(0, 120);

  return sendPushNotification({
    recipientExternalIds: [recipientExternalId],
    name: 'Direct message',
    headings: {
      en: actorDisplayName,
    },
    contents: {
      en: preview || 'Sent you a new message on MatchBuddy.',
    },
    data: {
      threadId,
      type: 'direct_message',
    },
  });
}

export async function sendListingRoomPushNotification({
  actorDisplayName,
  body,
  listingId,
  recipientExternalIds,
}) {
  const preview = body.trim().slice(0, 120);

  return sendPushNotification({
    recipientExternalIds,
    name: 'Listing room message',
    headings: {
      en: `${actorDisplayName} sent a room update`,
    },
    contents: {
      en: preview || 'Open MatchBuddy to read the latest room message.',
    },
    data: {
      listingId,
      type: 'listing_message',
    },
  });
}
