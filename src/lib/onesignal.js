import { config } from '../config.js';

const ONE_SIGNAL_NOTIFICATIONS_URL = 'https://api.onesignal.com/notifications';

export async function sendWavePushNotification({
  actorDisplayName,
  fanId,
  recipientExternalId,
  threadId = null,
}) {
  if (!config.oneSignalAppId || !config.oneSignalRestApiKey || !recipientExternalId) {
    return { skipped: true };
  }

  const isMutual = Boolean(threadId);
  const title = isMutual ? 'Mutual wave unlocked' : 'New wave on MatchBuddy';
  const body = isMutual
    ? `${actorDisplayName} waved back. Your chat is now open.`
    : `${actorDisplayName} waved at you. Open MatchBuddy to respond.`;

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
        external_id: [recipientExternalId],
      },
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
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`OneSignal request failed with ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}
