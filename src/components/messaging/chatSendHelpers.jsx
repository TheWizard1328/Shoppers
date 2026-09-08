import { base44 } from '@/api/base44Client';
import { resolveGroupMemberIds } from './groupHelpers';

/**
 * Upload an image File via the Core UploadFile integration.
 * @returns {Promise<string>} file_url
 * @throws on upload failure or empty url
 */
export const uploadImageFile = async (file) => {
  const uploadRes = await base44.integrations.Core.UploadFile({ file });
  const fileUrl = uploadRes?.file_url || '';
  if (!fileUrl) throw new Error('Upload failed');
  return fileUrl;
};

const firePushToRecipient = (recipientId, title, body, tag, url, messageId) => {
  base44.functions.invoke('sendPushNotification', {
    user_id: recipientId,
    title,
    body,
    tag,
    url,
    actions: [{ action: 'mark_read', title: 'Mark as Read' }],
    data: { message_id: messageId },
    force: true,
  }).catch((error) => console.warn('Push notification failed:', error?.message || error));
};

/**
 * Create + send a chat message (text or image) for either a 1:1 or group thread,
 * and fire push notifications to all relevant recipients.
 *
 * @param {Object} params
 * @param {Object} params.currentUser
 * @param {string} params.conversationId
 * @param {string|null} params.otherUserId  — receiver for 1:1 (null/empty for groups)
 * @param {string} params.otherUserName
 * @param {Object|null} params.group         — ConversationGroup record (group mode)
 * @param {Array} params.users               — for group member resolution
 * @param {string} params.content           — text or caption (may be empty for image-only)
 * @param {string} params.attachmentUrl     — image url (empty for text)
 * @param {boolean} params.isImage
 * @returns {Promise<Object>} created Message record
 */
export const sendChatMessage = async ({
  currentUser,
  conversationId,
  otherUserId,
  otherUserName,
  group,
  users,
  content,
  attachmentUrl = '',
  isImage = false,
}) => {
  const senderName = currentUser.user_name || currentUser.full_name || 'RxDeliver';
  const isGroup = !!(group && group.id);

  let createdMessage;
  if (isGroup) {
    const memberIds = resolveGroupMemberIds(group, users);
    createdMessage = await base44.entities.Message.create({
      sender_id: currentUser.id,
      sender_name: senderName,
      receiver_id: '',
      receiver_name: '',
      conversation_id: group.id,
      content,
      read: false,
      message_type: isImage ? 'image' : 'text',
      attachment_url: attachmentUrl,
      is_group: true,
      group_id: group.id,
      group_name: group.name,
      group_member_ids: memberIds,
      read_by: [currentUser.id],
    });
    const pushBody = isImage ? (content || '📷 Photo') : content;
    Promise.allSettled(
      memberIds
        .filter((id) => id !== currentUser.id)
        .map((uid) =>
          firePushToRecipient(
            uid,
            group.name,
            `${senderName}: ${pushBody}`,
            `chat-${group.id}`,
            `/?openChat=${group.id}&openChatName=${encodeURIComponent(group.name)}&openChatType=group`,
            createdMessage?.id
          )
        )
    );
  } else {
    createdMessage = await base44.entities.Message.create({
      sender_id: currentUser.id,
      sender_name: senderName,
      receiver_id: otherUserId,
      receiver_name: otherUserName,
      conversation_id: conversationId,
      content,
      read: false,
      message_type: isImage ? 'image' : 'text',
      attachment_url: attachmentUrl,
      is_group: false,
    });
    const pushBody = isImage ? (content || '📷 Photo') : content;
    firePushToRecipient(
      otherUserId,
      senderName,
      pushBody,
      `chat-${conversationId}`,
      `/?openChat=${encodeURIComponent(currentUser.id)}&openChatName=${encodeURIComponent(senderName)}`,
      createdMessage?.id
    );
  }

  return createdMessage;
};