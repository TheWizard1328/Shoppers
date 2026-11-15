import { base44 } from '@/api/base44Client';
import { resolveGroupMemberIds } from './groupHelpers';
import { isHiddenSystemBroadcastMessageForThisDevice } from './updateBroadcastConfig';

/**
 * Whether the current user is considered a member of a group (preset resolves live).
 */
export const isGroupMember = (group, currentUser, appUsers = []) => {
  if (!group || !currentUser?.id) return false;
  if (resolveGroupMemberIds(group, appUsers).includes(currentUser.id)) return true;
  // The group creator always counts as a member (so they can see their own
  // group thread + replies), even for preset groups whose role doesn't match.
  // created_by may be stored as either the user's ObjectId or their email
  // (legacy), so match against both.
  const createdById = group.created_by;
  if (!createdById) return false;
  return createdById === currentUser.id || createdById === currentUser.email;
};

const isReadByMe = (msg, currentUser) => {
  if (!msg || !currentUser?.id) return false;
  if (msg.is_group) {
    return Array.isArray(msg.read_by) && msg.read_by.includes(currentUser.id);
  }
  return !!msg.read;
};

/**
 * Load all ConversationGroup records the current user belongs to, each with its
 * latest message preview + unread count.
 *
 * @returns {Promise<Array<{ group, lastMessage, unreadCount }>>}
 */
// GROUP PREVIEW CACHE + ONE-QUERY LOADER (rate-limit fix Nov 14 2026)
//
// The old loader issued ONE Message.filter per group, and ConversationsList
// called it on every realtime message event. Sending a single message therefore
// cost 1 + N reads (N = groups), and opening the panel cost them again — that
// burst is what tripped the platform's 210 requests/60s per-caller limit and
// surfaced as RATE LIMIT toasts for ConversationGroup, Message, Payroll and
// Patient at once.
//
// Now: newest messages for ALL my groups come back in ONE query, results are
// cached for 20s, concurrent callers share the same in-flight promise, and a
// new group message patches the cache in place instead of refetching.
const PREVIEW_CACHE_TTL_MS = 20000;
const PREVIEW_QUERY_LIMIT = 400; // newest rows across all my groups
const FALLBACK_GROUPS = 12;      // per-group fallback stays capped
const FALLBACK_CONCURRENCY = 3;

let previewCache = { key: null, at: 0, data: null };
let previewInFlight = null;

const previewCacheKey = (currentUser, appUsers) =>
  `${currentUser?.id || 'anon'}::${Array.isArray(appUsers) ? appUsers.length : 0}`;

const newestFirst = (a, b) => {
  const ta = Date.parse(a?.created_date || '') || 0;
  const tb = Date.parse(b?.created_date || '') || 0;
  return tb - ta;
};

const buildPreviews = (myGroups, rowsByGroup, currentUser) => myGroups.map((group) => {
  // The server already sorts -created_date; sorting the merged bucket client-side
  // too means the preview is still right if a row arrives out of order.
  const msgs = (rowsByGroup.get(group.id) || [])
    .slice()
    .sort(newestFirst)
    .filter((m) => !isHiddenSystemBroadcastMessageForThisDevice(m?.id));
  const unreadCount = msgs.filter((m) => m.sender_id !== currentUser.id && !isReadByMe(m, currentUser)).length;
  return { group, lastMessage: msgs[0] || null, unreadCount };
});

const fetchRowsPerGroup = async (myGroups) => {
  const rowsByGroup = new Map();
  const ids = myGroups.map((g) => g.id).filter(Boolean);
  if (ids.length === 0) return rowsByGroup;

  // One query for every group. Sorted newest-first, so each group's first row is
  // its last message; the unread count is exact as long as a group has fewer
  // than PREVIEW_QUERY_LIMIT unread rows.
  try {
    const rows = await base44.entities.Message.filter(
      { conversation_id: { $in: ids } },
      '-created_date',
      PREVIEW_QUERY_LIMIT
    );
    if (Array.isArray(rows)) {
      rows.forEach((m) => {
        const cid = m?.conversation_id;
        if (!cid) return;
        if (!rowsByGroup.has(cid)) rowsByGroup.set(cid, []);
        rowsByGroup.get(cid).push(m);
      });
      return rowsByGroup;
    }
  } catch (err) {
    console.warn('[GroupPreviews] combined query failed, falling back per group:', err?.message || err);
  }

  // Fallback (older backends without $in on this field): capped, 3 at a time.
  const capped = myGroups.slice(0, FALLBACK_GROUPS);
  for (let i = 0; i < capped.length; i += FALLBACK_CONCURRENCY) {
    await Promise.all(capped.slice(i, i + FALLBACK_CONCURRENCY).map(async (group) => {
      try {
        const msgs = await base44.entities.Message.filter({ conversation_id: group.id }, '-created_date', 20);
        rowsByGroup.set(group.id, msgs || []);
      } catch {
        rowsByGroup.set(group.id, []);
      }
    }));
  }
  return rowsByGroup;
};

/**
 * Load all ConversationGroup records the current user belongs to, each with its
 * latest message preview + unread count.
 *
 * @param {object} currentUser
 * @param {Array} appUsers
 * @param {{ force?: boolean }} [options] force bypasses the 20s cache
 * @returns {Promise<Array<{ group, lastMessage, unreadCount }>>}
 */
export const loadGroupsWithPreview = async (currentUser, appUsers = [], options = {}) => {
  if (!currentUser?.id) return [];
  const force = options?.force === true;
  const key = previewCacheKey(currentUser, appUsers);
  const fresh = previewCache.key === key && (Date.now() - previewCache.at) < PREVIEW_CACHE_TTL_MS;
  if (!force && fresh && previewCache.data) return previewCache.data;
  if (previewInFlight && previewInFlight.key === key) return previewInFlight.promise;

  const promise = (async () => {
    let allGroups = [];
    try {
      allGroups = await base44.entities.ConversationGroup.list('-created_date', 100);
    } catch (err) {
      console.warn('Error loading conversation groups:', err?.message || err);
      return previewCache.data || [];
    }
    const myGroups = (allGroups || []).filter((g) => isGroupMember(g, currentUser, appUsers));
    if (myGroups.length === 0) {
      previewCache = { key, at: Date.now(), data: [] };
      return [];
    }
    const rowsByGroup = await fetchRowsPerGroup(myGroups);
    const previews = buildPreviews(myGroups, rowsByGroup, currentUser);
    previewCache = { key, at: Date.now(), data: previews };
    return previews;
  })();

  previewInFlight = { key, promise };
  promise.then(() => {
    if (previewInFlight && previewInFlight.key === key && previewInFlight.promise === promise) previewInFlight = null;
  }).catch(() => {
    if (previewInFlight && previewInFlight.key === key && previewInFlight.promise === promise) previewInFlight = null;
  });
  return promise;
};

/**
 * Fold one incoming group message into the cached previews instead of refetching
 * everything. Returns the updated list, or null when the cache does not know
 * that conversation (a brand new group → caller should do a real refresh).
 */
export const patchGroupPreviewCache = (currentUserId, message) => {
  if (!previewCache.data || !message?.conversation_id) return null;
  const index = previewCache.data.findIndex((p) => p?.group?.id === message.conversation_id);
  if (index === -1) return null;
  if (isHiddenSystemBroadcastMessageForThisDevice(message?.id)) return previewCache.data;
  const prev = previewCache.data[index];
  const isUnread = message.sender_id !== currentUserId && !isReadByMe(message, { id: currentUserId });
  const next = previewCache.data.slice();
  next[index] = {
    ...prev,
    lastMessage: message,
    unreadCount: isUnread ? (Number(prev.unreadCount) || 0) + 1 : (Number(prev.unreadCount) || 0)
  };
  previewCache = { ...previewCache, at: Date.now(), data: next };
  return next;
};

/**
 * Opening a group marks it read in the database; clear the cached badge at the
 * same time so the list does not keep showing unread for up to 20s.
 */
export const clearGroupUnread = (groupId) => {
  if (!previewCache.data || !groupId) return null;
  const index = previewCache.data.findIndex((p) => p?.group?.id === groupId);
  if (index === -1) return previewCache.data;
  const next = previewCache.data.slice();
  next[index] = { ...previewCache.data[index], unreadCount: 0 };
  previewCache = { ...previewCache, data: next };
  return next;
};

/** Force the next load to hit the server (membership changes, group deleted). */
export const invalidateGroupPreviewCache = () => {
  previewCache = { key: null, at: 0, data: null };
  previewInFlight = null;
};
