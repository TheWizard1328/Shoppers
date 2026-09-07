import { base44 } from '@/api/base44Client';
import { resolveGroupMemberIds } from './groupHelpers';
import { isHiddenSystemBroadcastMessageForThisDevice } from './updateBroadcastConfig';

/**
 * Whether the current user is considered a member of a group (preset resolves live).
 */
export const isGroupMember = (group, currentUser, appUsers = []) => {
  if (!group || !currentUser?.id) return false;
  return resolveGroupMemberIds(group, appUsers).includes(currentUser.id);
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
export const loadGroupsWithPreview = async (currentUser, appUsers = []) => {
  let allGroups = [];
  try {
    allGroups = await base44.entities.ConversationGroup.list('-created_date', 100);
  } catch (err) {
    console.warn('Error loading conversation groups:', err?.message || err);
    return [];
  }

  const myGroups = (allGroups || []).filter((g) => isGroupMember(g, currentUser, appUsers));

  const previews = await Promise.all(
    myGroups.map(async (group) => {
      try {
        const msgs = await base44.entities.Message.filter({ conversation_id: group.id }, '-created_date', 20);
        const visible = (msgs || []).filter((m) => !isHiddenSystemBroadcastMessageForThisDevice(m?.id));
        const unreadCount = visible.filter(
          (m) => m.sender_id !== currentUser.id && !isReadByMe(m, currentUser)
        ).length;
        const lastMessage = visible[0] || null; // sorted -created_date → [0] is newest
        return { group, lastMessage, unreadCount };
      } catch (e) {
        return { group, lastMessage: null, unreadCount: 0 };
      }
    })
  );

  return previews;
};