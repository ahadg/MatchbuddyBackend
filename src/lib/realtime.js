import { WebSocketServer } from 'ws';

import { db } from '../db.js';
import { supabaseAdmin } from '../supabase.js';
import { buildBlockedRelationSql } from './safety.js';
import { getCurrentProfileByAuthUserId } from './social.js';

const directThreadSubscribers = new Map();
const listingRoomSubscribers = new Map();
const socketState = new WeakMap();

function sendJson(socket, payload) {
  if (socket.readyState !== 1) {
    return;
  }

  socket.send(JSON.stringify(payload));
}

function removeSocketFromSubscriptionMap(map, key, socket) {
  if (!key) {
    return;
  }

  const subscribers = map.get(key);
  if (!subscribers) {
    return;
  }

  subscribers.delete(socket);

  if (subscribers.size === 0) {
    map.delete(key);
  }
}

function clearSocketSubscriptions(socket) {
  const state = socketState.get(socket);
  if (!state) {
    return;
  }

  for (const threadId of state.directThreadIds) {
    removeSocketFromSubscriptionMap(directThreadSubscribers, threadId, socket);
  }

  for (const listingId of state.listingIds) {
    removeSocketFromSubscriptionMap(listingRoomSubscribers, listingId, socket);
  }

  state.directThreadIds.clear();
  state.listingIds.clear();
}

async function authenticateSocket(token) {
  if (!token) {
    return null;
  }

  const {
    data: { user },
    error,
  } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    return null;
  }

  const profile = await getCurrentProfileByAuthUserId(user.id);

  if (!profile) {
    return null;
  }

  return { profile, user };
}

async function canAccessDirectThread(threadId, profileId) {
  const { rows } = await db.query(
    `
      select 1
      from direct_threads dt
      where dt.id = $1::uuid
        and (dt.profile_low_id = $2::uuid or dt.profile_high_id = $2::uuid)
        and not ${buildBlockedRelationSql(
          `case
            when dt.profile_low_id = $2::uuid then dt.profile_high_id
            else dt.profile_low_id
          end`,
          '$2::uuid',
        )}
      limit 1
    `,
    [threadId, profileId],
  );

  return Boolean(rows[0]);
}

async function canAccessListingRoom(listingId, profileId) {
  const { rows } = await db.query(
    `
      select 1
      from listings l
      inner join profiles host on host.id = l.host_id
      left join listing_join_requests req
        on req.listing_id = l.id
       and req.guest_profile_id = $2::uuid
      where (l.id::text = $1::text or l.slug = $1::text)
        and (
          l.host_id = $2::uuid
          or req.status = 'approved'
        )
        and not ${buildBlockedRelationSql('host.id', '$2::uuid')}
      limit 1
    `,
    [listingId, profileId],
  );

  return Boolean(rows[0]);
}

async function handleSocketMessage(socket, rawMessage) {
  let message;

  try {
    message = JSON.parse(String(rawMessage));
  } catch {
    sendJson(socket, { type: 'error', error: 'Invalid realtime payload.' });
    return;
  }

  const state = socketState.get(socket);

  if (!state) {
    sendJson(socket, { type: 'error', error: 'Realtime session not initialized.' });
    return;
  }

  if (message.type === 'authenticate') {
    const authPromise = authenticateSocket(message.token);
    state.authPromise = authPromise;
    const auth = await authPromise;

    if (!auth) {
      state.authPromise = null;
      sendJson(socket, { type: 'error', error: 'Realtime authentication failed.' });
      return;
    }

    state.profileId = auth.profile.id;
    state.authUserId = auth.user.id;
    state.authPromise = null;

    sendJson(socket, {
      type: 'auth_ack',
      profileId: auth.profile.id,
      authUserId: auth.user.id,
    });
    return;
  }

  if (!state.profileId && state.authPromise) {
    await state.authPromise.catch(() => null);
  }

  if (!state.profileId) {
    sendJson(socket, { type: 'error', error: 'Authenticate before subscribing.' });
    return;
  }

  if (message.type === 'subscribe_direct_thread') {
    const threadId = typeof message.threadId === 'string' ? message.threadId : null;

    if (!threadId || !(await canAccessDirectThread(threadId, state.profileId))) {
      sendJson(socket, { type: 'error', error: 'Direct thread access denied.' });
      return;
    }

    let subscribers = directThreadSubscribers.get(threadId);
    if (!subscribers) {
      subscribers = new Set();
      directThreadSubscribers.set(threadId, subscribers);
    }

    subscribers.add(socket);
    state.directThreadIds.add(threadId);
    sendJson(socket, { type: 'subscribed', channel: 'direct_thread', threadId });
    return;
  }

  if (message.type === 'subscribe_listing_room') {
    const listingId = typeof message.listingId === 'string' ? message.listingId : null;

    if (!listingId || !(await canAccessListingRoom(listingId, state.profileId))) {
      sendJson(socket, { type: 'error', error: 'Listing room access denied.' });
      return;
    }

    let subscribers = listingRoomSubscribers.get(listingId);
    if (!subscribers) {
      subscribers = new Set();
      listingRoomSubscribers.set(listingId, subscribers);
    }

    subscribers.add(socket);
    state.listingIds.add(listingId);
    sendJson(socket, { type: 'subscribed', channel: 'listing_room', listingId });
  }
}

export function attachRealtimeServer(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket) => {
    socketState.set(socket, {
      authUserId: null,
      authPromise: null,
      profileId: null,
      directThreadIds: new Set(),
      listingIds: new Set(),
    });

    socket.on('message', (message) => {
      handleSocketMessage(socket, message).catch((error) => {
        console.warn('Realtime socket handler failed.', error);
        sendJson(socket, { type: 'error', error: 'Realtime handler failed.' });
      });
    });

    socket.on('close', () => {
      clearSocketSubscriptions(socket);
      socketState.delete(socket);
    });

    socket.on('error', () => {
      clearSocketSubscriptions(socket);
      socketState.delete(socket);
    });
  });

  return wss;
}

export function broadcastDirectMessageCreated(threadId, message, { excludeProfileId = null } = {}) {
  const subscribers = directThreadSubscribers.get(threadId);

  if (!subscribers?.size) {
    return;
  }

  for (const socket of subscribers) {
    const state = socketState.get(socket);

    if (!state || (excludeProfileId && state.profileId === excludeProfileId)) {
      continue;
    }

    sendJson(socket, {
      type: 'direct_message_created',
      threadId,
      message,
    });
  }
}

export function broadcastListingMessageCreated(listingId, message, { excludeProfileId = null } = {}) {
  const subscribers = listingRoomSubscribers.get(listingId);

  if (!subscribers?.size) {
    return;
  }

  for (const socket of subscribers) {
    const state = socketState.get(socket);

    if (!state || (excludeProfileId && state.profileId === excludeProfileId)) {
      continue;
    }

    sendJson(socket, {
      type: 'listing_message_created',
      listingId,
      message,
    });
  }
}
