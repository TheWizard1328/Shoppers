import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MessageCircle, Search, Trash2, ChevronUp, Loader2, Users } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { format, subDays } from 'date-fns';
import { parseEntityTimestamp } from '@/components/utils/localTimeHelper';
import { isHiddenSystemBroadcastMessageForThisDevice } from './updateBroadcastConfig';
import { loadGroupsWithPreview } from './groupConversationLoader';
import { resolveGroupMemberIds, PRESET_LABELS, PRESET_BADGE_STYLES } from './groupHelpers';
import NewGroupDialog from './NewGroupDialog';

export default function ConversationsList({ currentUser, users, onSelectConversation, selectedConversationId, onUnreadCountChange, pendingBlinkConversationId }) {
  const [messages, setMessages] = useState([]);
  const [groupPreviews, setGroupPreviews] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(true);
  const [loadedDays, setLoadedDays] = useState(1);
  const [showNewGroupDialog, setShowNewGroupDialog] = useState(false);

  const fetchGroups = useCallback(async () => {
    const previews = await loadGroupsWithPreview(currentUser, users);
    setGroupPreviews(previews);
  }, [currentUser, users]);

  const fetchMessages = useCallback(async (daysBack = 1, append = false) => {
    if (!currentUser?.id) return;

    try {
      if (append) {
        setIsLoadingMore(true);
      }

      const startDate = format(subDays(new Date(), daysBack), 'yyyy-MM-dd');
      const limit = append ? 50 : 20;

      const [sentMessages, receivedMessages] = await Promise.all([
        base44.entities.Message.filter({ sender_id: currentUser.id }, '-created_date', limit),
        base44.entities.Message.filter({ receiver_id: currentUser.id }, '-created_date', limit)
      ]);

      const messageMap = new Map();
      if (append) {
        messages.forEach(m => { if (m && m.id) messageMap.set(m.id, m); });
      }
      [...sentMessages, ...receivedMessages].forEach(m => {
        if (m && m.id) messageMap.set(m.id, m);
      });

      const userMessages = Array.from(messageMap.values()).filter(
        (message) => !isHiddenSystemBroadcastMessageForThisDevice(message?.id)
      );
      setMessages(userMessages);
      const totalFetched = sentMessages.length + receivedMessages.length;
      setHasMoreMessages(totalFetched >= limit);
    } catch (error) {
      if (!error.message?.includes('429') && !error.message?.includes('Rate limit')) {
        console.error('Error fetching messages:', error);
      }
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }, [currentUser?.id, messages]);

  useEffect(() => {
    if (!currentUser?.id) return;

    fetchMessages(loadedDays, false);
    fetchGroups();

    const handleRealtimeMessage = (payload) => {
      const event = payload?.detail || payload;
      if (event.type === 'create' || event.type === 'update') {
        const messageData = event.data;
        const isRelated = messageData?.receiver_id === currentUser.id || messageData?.sender_id === currentUser.id;
        // Also pick up group messages where I am the sender
        if (messageData?.is_group && messageData?.sender_id === currentUser.id) {
          // handled by isRelated check
        }
        if (!isRelated || isHiddenSystemBroadcastMessageForThisDevice(messageData?.id)) return;

        setMessages(prev => {
          const exists = prev.some(m => m.id === messageData.id);
          return exists ? prev.map(m => m.id === messageData.id ? messageData : m) : [...prev, messageData];
        });

        // If this is a new group message and it's not from me, refresh that group's preview
        if (messageData?.is_group && messageData?.sender_id !== currentUser.id) {
          fetchGroups();
        }
      }
    };

    const handleRealtimeGroup = (payload) => {
      const event = payload?.detail || payload;
      // Refresh group previews on any group create/update/delete (membership could have changed)
      if (['create', 'update', 'delete'].includes(event.type)) {
        fetchGroups();
      }
    };

    const unsubscribeMessages = base44.entities.Message.subscribe(handleRealtimeMessage);
    const unsubscribeGroups = base44.entities.ConversationGroup.subscribe(handleRealtimeGroup);
    window.addEventListener('messageRealtimeUpdate', handleRealtimeMessage);

    return () => {
      unsubscribeMessages();
      unsubscribeGroups();
      window.removeEventListener('messageRealtimeUpdate', handleRealtimeMessage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id]);

  const handleLoadMore = async () => {
    const newDays = loadedDays + 7;
    setLoadedDays(newDays);
    await fetchMessages(newDays, true);
  };

  const getUserName = (userId) => {
    if (!userId) return null;
    const user = (users || []).find(u => u?.id === userId || u?.user_id === userId);
    return user?.user_name || user?.full_name || null;
  };

  // Build 1:1 conversations from messages (existing logic)
  const directConversations = useMemo(() => {
    const convMap = new Map();

    messages.forEach(msg => {
      if (msg?.is_group) return; // group messages don't belong in direct conversations
      const convId = msg.conversation_id;
      const isCurrentUserSender = msg.sender_id === currentUser?.id;
      const otherUserId = isCurrentUserSender ? msg.receiver_id : msg.sender_id;
      let otherUserName = isCurrentUserSender ? msg.receiver_name : msg.sender_name;
      if (!otherUserName || otherUserName === currentUser?.user_name || otherUserName === currentUser?.full_name) {
        otherUserName = getUserName(otherUserId) || otherUserName;
      }

      if (!convMap.has(convId)) {
        convMap.set(convId, { id: convId, type: 'direct', messages: [], unreadCount: 0, otherUserId, otherUserName });
      }
      const conv = convMap.get(convId);
      conv.messages.push(msg);
      if (otherUserName && otherUserName !== currentUser?.user_name && otherUserName !== currentUser?.full_name &&
          (!conv.otherUserName || conv.otherUserName === 'Unknown User' || conv.otherUserName === currentUser?.user_name)) {
        conv.otherUserName = otherUserName;
      }
      if (!msg.read && msg.receiver_id === currentUser?.id) conv.unreadCount++;
    });

    convMap.forEach((conv, convId) => {
      if (!conv.otherUserName || conv.otherUserName === currentUser?.user_name || conv.otherUserName === currentUser?.full_name) {
        const lookedUpName = getUserName(conv.otherUserId);
        if (lookedUpName) conv.otherUserName = lookedUpName;
      }
    });

    return Array.from(convMap.values()).map(conv => ({
      ...conv,
      lastMessage: conv.messages.sort((a, b) =>
        (parseEntityTimestamp(b.created_date) || 0) - (parseEntityTimestamp(a.created_date) || 0)
      )[0]
    }));
  }, [messages, currentUser?.id, users]);

  // Build group conversations from previews
  const groupConversations = useMemo(() => {
    return groupPreviews
      .filter((p) => p?.group)
      .map(({ group, lastMessage, unreadCount }) => {
        const memberIds = resolveGroupMemberIds(group, users);
        return {
          id: group.id,
          type: 'group',
          group,
          groupName: group.name,
          memberCount: memberIds.length,
          presetType: group.preset_type,
          messages: lastMessage ? [lastMessage] : [],
          lastMessage,
          unreadCount,
          otherUserId: null,
          otherUserName: group.name,
        };
      });
  }, [groupPreviews, users]);

  // Merge + sort
  const conversations = useMemo(() => {
    return [...directConversations, ...groupConversations].sort((a, b) =>
      (parseEntityTimestamp(b.lastMessage?.created_date) || 0) - (parseEntityTimestamp(a.lastMessage?.created_date) || 0)
    );
  }, [directConversations, groupConversations]);

  // Notify parent of total unread count changes
  useEffect(() => {
    const totalUnread = conversations.reduce((sum, conv) => sum + conv.unreadCount, 0);
    if (onUnreadCountChange) onUnreadCountChange(totalUnread);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations]);

  // Filter by search
  const filteredConversations = useMemo(() => {
    if (!searchQuery.trim()) return conversations;
    const query = searchQuery.toLowerCase();
    return conversations.filter(conv => {
      const name = conv.type === 'group' ? conv.groupName : conv.otherUserName;
      return name?.toLowerCase().includes(query);
    });
  }, [conversations, searchQuery]);

  // Available users to start new conversation (shown when searching) — direct only
  const availableUsers = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const existingConvUserIds = new Set(directConversations.map(c => c.otherUserId));
    const query = searchQuery.toLowerCase();
    return (users || []).filter(u =>
      u.id !== currentUser?.id &&
      !existingConvUserIds.has(u.id) &&
      u.status === 'active' &&
      (u.user_name || u.full_name || '').toLowerCase().includes(query)
    );
  }, [users, directConversations, currentUser?.id, searchQuery]);

  const handleDeleteConversation = async (e, conv) => {
    e.stopPropagation();
    if (conv.type === 'group') {
      const group = conv.group;
      const isCreator = group?.created_by === currentUser?.id || group?.created_by === currentUser?.email;
      if (isCreator) {
        if (!window.confirm('Delete this group thread for everyone? All messages will be removed.')) return;
        try {
          const msgs = await base44.entities.Message.filter({ conversation_id: group.id }, '-created_date', 500);
          await Promise.allSettled((msgs || []).map(m => base44.entities.Message.delete(m.id)));
          await base44.entities.ConversationGroup.delete(group.id);
          setGroupPreviews(prev => prev.filter(p => p.group?.id !== group.id));
        } catch (error) {
          console.error('Error deleting group:', error);
          alert('Failed to delete the group. Please try again.');
        }
      } else {
        if (!window.confirm('Leave this group? You will no longer receive messages from it.')) return;
        try {
          const isPreset = group?.preset_type && group.preset_type !== 'custom';
          if (!isPreset) {
            const next = (group.member_ids || []).filter(id => id !== currentUser.id);
            await base44.entities.ConversationGroup.update(group.id, { member_ids: next });
          }
          setGroupPreviews(prev => prev.filter(p => p.group?.id !== group.id));
        } catch (error) {
          console.error('Error leaving group:', error);
          alert('Failed to leave the group. Please try again.');
        }
      }
      return;
    }
    if (!window.confirm('Delete this conversation? All messages will be removed.')) return;
    try {
      await Promise.allSettled(conv.messages.map(msg => base44.entities.Message.delete(msg.id)));
      setMessages(prev => prev.filter(m => m.conversation_id !== conv.id));
    } catch (error) {
      console.error('Error deleting conversation:', error);
    }
  };

  const handleGroupCreated = useCallback((groupRecord) => {
    setShowNewGroupDialog(false);
    // Refresh group previews then open the new conversation
    fetchGroups().then(() => {
      onSelectConversation(groupRecord.id, null, groupRecord.name, groupRecord);
    });
  }, [fetchGroups, onSelectConversation]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="animate-spin w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Search + New Group */}
      <div className="p-3 space-y-2" style={{ borderBottom: '1px solid var(--border-slate-200)' }}>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
          <Input
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-24"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2"
          onClick={() => setShowNewGroupDialog(true)}
        >
          <Users className="w-4 h-4" />
          New Group
        </Button>
      </div>

      {/* Conversations list */}
      <div className="flex-1 overflow-y-auto">
        {hasMoreMessages && !isLoading && filteredConversations.length > 0 && (
          <div className="p-2" style={{ background: 'var(--bg-slate-50)', borderBottom: '1px solid var(--border-slate-200)' }}>
            <Button variant="ghost" size="sm" onClick={handleLoadMore} disabled={isLoadingMore} className="w-full text-xs text-label">
              {isLoadingMore ? (
                <><Loader2 className="w-3 h-3 mr-2 animate-spin" />Loading older messages...</>
              ) : (
                <><ChevronUp className="w-3 h-3 mr-2" />Load older messages</>
              )}
            </Button>
          </div>
        )}

        {filteredConversations.length === 0 && availableUsers.length === 0 && (
          <div className="text-center py-8 text-soft">
            <MessageCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>{searchQuery ? 'No users found' : 'No conversations yet'}</p>
            {!searchQuery && <p className="text-xs mt-1">Search for a user or start a group</p>}
          </div>
        )}

        {filteredConversations.map(conv => {
          const isBlinking = conv.id === pendingBlinkConversationId && conv.unreadCount > 0 && selectedConversationId !== conv.id;
          const isGroup = conv.type === 'group';

          // Avatar rendering
          let avatar;
          if (isGroup) {
            const memberIds = resolveGroupMemberIds(conv.group, users);
            const others = memberIds.filter(id => id !== currentUser?.id).slice(0, 2);
            const initials = (others.length ? others : memberIds.slice(0, 1)).map(id => {
              const u = (users || []).find(x => x?.id === id || x?.user_id === id);
              return (u?.user_name || u?.full_name || '?')[0].toUpperCase();
            });
            avatar = (
              <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold flex-shrink-0 relative" style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}>
                <span className="text-xs leading-none flex items-center gap-0.5">
                  {initials.map((i, idx) => <span key={idx} style={{ marginLeft: idx > 0 ? -2 : 0 }}>{i}</span>)}
                </span>
              </div>
            );
          } else {
            avatar = (
              <div className="w-10 h-10 rounded-full bg-emerald-500 flex items-center justify-center text-white font-semibold flex-shrink-0">
                {(conv.otherUserName || '?')[0].toUpperCase()}
              </div>
            );
          }

          const lastMessagePreview = conv.lastMessage
            ? (conv.lastMessage.message_type === 'image'
                ? (conv.lastMessage.content?.trim() || '📷 Photo')
                : conv.lastMessage.content)
            : (isGroup ? 'New group — say hello!' : '');

          return (
            <div
              key={conv.id}
              onClick={() => onSelectConversation(conv.id, conv.otherUserId, conv.otherUserName, isGroup ? conv.group : undefined)}
              className={`p-3 cursor-pointer transition-colors group${isBlinking ? ' blink-new-message' : ''}`}
              style={{
                borderBottom: '1px solid var(--border-slate-200)',
                background: selectedConversationId === conv.id ? 'var(--bg-slate-100)' : 'transparent'
              }}
              onMouseEnter={(e) => { if (selectedConversationId !== conv.id) e.currentTarget.style.background = 'var(--bg-slate-50)'; }}
              onMouseLeave={(e) => { if (selectedConversationId !== conv.id) e.currentTarget.style.background = 'transparent'; }}
            >
              <div className="flex items-center gap-3">
                {avatar}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-medium truncate text-body">
                        {isGroup ? conv.groupName : (conv.otherUserName || 'Unknown User')}
                      </span>
                      {isGroup && conv.presetType && conv.presetType !== 'custom' && (
                        <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${PRESET_BADGE_STYLES[conv.presetType] || ''}`}>
                          {PRESET_LABELS[conv.presetType]}
                        </span>
                      )}
                      {isGroup && (
                        <span className="text-xs text-soft flex-shrink-0">{conv.memberCount}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {conv.unreadCount > 0 && (
                        <Badge className="bg-emerald-500 text-white">{conv.unreadCount}</Badge>
                      )}
                      <button
                        onClick={(e) => handleDeleteConversation(e, conv)}
                        className="p-1 opacity-0 group-hover:opacity-100 hover:bg-red-100 rounded transition-all"
                        title={isGroup ? 'Delete / leave group' : 'Delete conversation'}
                      >
                        <Trash2 className="w-4 h-4 text-red-500" />
                      </button>
                    </div>
                  </div>
                  <p className="text-sm truncate text-soft">{lastMessagePreview}</p>
                  <p className="text-xs" style={{ color: 'var(--text-slate-400)' }}>
                    {conv.lastMessage?.created_date && format(parseEntityTimestamp(conv.lastMessage.created_date), 'MMM d, h:mm a')}
                  </p>
                </div>
              </div>
            </div>
          );
        })}

        {/* New conversation options - only shown when searching */}
        {availableUsers.length > 0 && (
          <>
            <div className="px-3 py-2 text-xs font-semibold uppercase text-soft" style={{ background: 'var(--bg-slate-50)' }}>
              Start New Chat
            </div>
            {availableUsers.map(user => (
              <div
                key={user.id}
                onClick={() => {
                  const convId = [currentUser.id, user.id].sort().join('_');
                  onSelectConversation(convId, user.id, user.user_name || user.full_name);
                  setSearchQuery('');
                }}
                className="p-3 cursor-pointer transition-colors"
                style={{ borderBottom: '1px solid var(--border-slate-200)' }}
                onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-slate-50)'}
                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-slate-400 flex items-center justify-center text-white font-semibold flex-shrink-0">
                    {(user.user_name || user.full_name || '?')[0].toUpperCase()}
                  </div>
                  <span className="font-medium text-body-2">{user.user_name || user.full_name}</span>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {showNewGroupDialog && (
        <NewGroupDialog
          currentUser={currentUser}
          appUsers={users}
          onCreated={handleGroupCreated}
          onClose={() => setShowNewGroupDialog(false)}
        />
      )}
    </div>
  );
}