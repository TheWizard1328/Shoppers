import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MessageCircle, Search, Trash2, ChevronUp, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { format, subDays } from 'date-fns';
import { parseLocalTimestamp } from '@/components/utils/localTimeHelper';

export default function ConversationsList({ currentUser, users, onSelectConversation, selectedConversationId, onUnreadCountChange }) {
  const [messages, setMessages] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(true);
  const [loadedDays, setLoadedDays] = useState(1); // Start with just today/yesterday

  const fetchMessages = useCallback(async (daysBack = 1, append = false) => {
    if (!currentUser?.id) return;
    
    try {
      if (append) {
        setIsLoadingMore(true);
      }
      
      // Calculate date range - only fetch messages from the last N days
      const startDate = format(subDays(new Date(), daysBack), 'yyyy-MM-dd');
      
      // Fetch only recent messages (limit to 20 initially, more when loading more)
      const limit = append ? 50 : 20;
      
      const [sentMessages, receivedMessages] = await Promise.all([
        base44.entities.Message.filter({ 
          sender_id: currentUser.id 
        }, '-created_date', limit),
        base44.entities.Message.filter({ 
          receiver_id: currentUser.id 
        }, '-created_date', limit)
      ]);
      
      // Merge and deduplicate
      const messageMap = new Map();
      
      // If appending, keep existing messages
      if (append) {
        messages.forEach(m => {
          if (m && m.id) messageMap.set(m.id, m);
        });
      }
      
      [...sentMessages, ...receivedMessages].forEach(m => {
        if (m && m.id) messageMap.set(m.id, m);
      });
      
      const userMessages = Array.from(messageMap.values());
      setMessages(userMessages);
      
      // Check if there might be more messages
      const totalFetched = sentMessages.length + receivedMessages.length;
      setHasMoreMessages(totalFetched >= limit);
      
    } catch (error) {
      // Silently handle rate limits
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
    
    // Load initial messages
    fetchMessages(loadedDays, false);

    // Subscribe to real-time message updates - only for messages where user is the receiver
    const unsubscribe = base44.entities.Message.subscribe((event) => {
      // Only process new messages where current user is the receiver
      if (event.data?.receiver_id !== currentUser.id) return;
      
      if (event.type === 'create') {
        setMessages(prev => {
          const exists = prev.some(m => m.id === event.data.id);
          return exists ? prev : [...prev, event.data];
        });
      } else if (event.type === 'update') {
        setMessages(prev => prev.map(m => m.id === event.data.id ? event.data : m));
      }
    });
    
    return () => unsubscribe();
  }, [currentUser?.id]);

  const handleLoadMore = async () => {
    const newDays = loadedDays + 7; // Load 7 more days
    setLoadedDays(newDays);
    await fetchMessages(newDays, true);
  };

  // Helper to look up user name from users array
  const getUserName = (userId) => {
    if (!userId) return null;
    const user = (users || []).find(u => u?.id === userId);
    return user?.user_name || user?.full_name || null;
  };

  // Group messages by conversation and get latest + unread count
  const conversations = useMemo(() => {
    const convMap = new Map();
    
    messages.forEach(msg => {
      const convId = msg.conversation_id;
      
      // Determine who the OTHER user is (not the current user)
      const isCurrentUserSender = msg.sender_id === currentUser?.id;
      const otherUserId = isCurrentUserSender ? msg.receiver_id : msg.sender_id;
      
      // Get the other user's name - first try from message, then lookup from users array
      let otherUserName = isCurrentUserSender ? msg.receiver_name : msg.sender_name;
      
      // Fallback: lookup from users array if message doesn't have correct name
      if (!otherUserName || otherUserName === currentUser?.user_name || otherUserName === currentUser?.full_name) {
        otherUserName = getUserName(otherUserId) || otherUserName;
      }
      
      if (!convMap.has(convId)) {
        convMap.set(convId, {
          id: convId,
          messages: [],
          unreadCount: 0,
          otherUserId: otherUserId,
          otherUserName: otherUserName
        });
      }
      const conv = convMap.get(convId);
      conv.messages.push(msg);
      
      // Update otherUserName if we have a better value (non-empty and not current user's name)
      if (otherUserName && 
          otherUserName !== currentUser?.user_name && 
          otherUserName !== currentUser?.full_name &&
          (!conv.otherUserName || conv.otherUserName === 'Unknown User' || conv.otherUserName === currentUser?.user_name)) {
        conv.otherUserName = otherUserName;
      }
      
      if (!msg.read && msg.receiver_id === currentUser?.id) {
        conv.unreadCount++;
      }
    });

    // Final pass: ensure we have the correct name from users array
    convMap.forEach((conv, convId) => {
      if (!conv.otherUserName || conv.otherUserName === currentUser?.user_name || conv.otherUserName === currentUser?.full_name) {
        const lookedUpName = getUserName(conv.otherUserId);
        if (lookedUpName) {
          conv.otherUserName = lookedUpName;
        }
      }
    });

    // Sort conversations by latest message
    return Array.from(convMap.values())
      .map(conv => ({
        ...conv,
        lastMessage: conv.messages.sort((a, b) => 
          new Date(b.created_date) - new Date(a.created_date)
        )[0]
      }))
      .sort((a, b) => new Date(b.lastMessage?.created_date) - new Date(a.lastMessage?.created_date));
  }, [messages, currentUser?.id, users]);

  // Notify parent of total unread count changes
  useEffect(() => {
    const totalUnread = conversations.reduce((sum, conv) => sum + conv.unreadCount, 0);
    if (onUnreadCountChange) {
      onUnreadCountChange(totalUnread);
    }
  }, [conversations, onUnreadCountChange]);

  // Filter by search
  const filteredConversations = useMemo(() => {
    if (!searchQuery.trim()) return conversations;
    const query = searchQuery.toLowerCase();
    return conversations.filter(conv => 
      conv.otherUserName?.toLowerCase().includes(query)
    );
  }, [conversations, searchQuery]);

  // Available users to start new conversation (shown when searching)
  const availableUsers = useMemo(() => {
    if (!searchQuery.trim()) return []; // Only show when searching
    const existingConvUserIds = new Set(conversations.map(c => c.otherUserId));
    const query = searchQuery.toLowerCase();
    return (users || []).filter(u => 
      u.id !== currentUser?.id && 
      !existingConvUserIds.has(u.id) &&
      u.status === 'active' &&
      (u.user_name || u.full_name || '').toLowerCase().includes(query)
    );
  }, [users, conversations, currentUser?.id, searchQuery]);

  const handleDeleteConversation = async (e, convId, convMessages) => {
    e.stopPropagation();
    if (!window.confirm('Delete this conversation? All messages will be removed.')) return;
    
    try {
      await Promise.all(convMessages.map(msg => base44.entities.Message.delete(msg.id)));
      setMessages(prev => prev.filter(m => m.conversation_id !== convId));
    } catch (error) {
      console.error('Error deleting conversation:', error);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="animate-spin w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-white)' }}>
      {/* Search */}
      <div className="p-3" style={{ borderBottom: '1px solid var(--border-slate-200)' }}>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
          <Input
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Conversations list */}
      <div className="flex-1 overflow-y-auto">
        {/* Load More button at top */}
        {hasMoreMessages && !isLoading && filteredConversations.length > 0 && (
          <div className="p-2" style={{ background: 'var(--bg-slate-50)', borderBottom: '1px solid var(--border-slate-200)' }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLoadMore}
              disabled={isLoadingMore}
              className="w-full text-xs"
              style={{ color: 'var(--text-slate-600)' }}
            >
              {isLoadingMore ? (
                <>
                  <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                  Loading older messages...
                </>
              ) : (
                <>
                  <ChevronUp className="w-3 h-3 mr-2" />
                  Load older messages
                </>
              )}
            </Button>
          </div>
        )}

        {filteredConversations.length === 0 && availableUsers.length === 0 && (
          <div className="text-center py-8" style={{ color: 'var(--text-slate-500)' }}>
            <MessageCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>{searchQuery ? 'No users found' : 'No conversations yet'}</p>
            {!searchQuery && <p className="text-xs mt-1">Search for a user to start chatting</p>}
          </div>
        )}

        {filteredConversations.map(conv => (
          <div
            key={conv.id}
            onClick={() => onSelectConversation(conv.id, conv.otherUserId, conv.otherUserName)}
            className="p-3 cursor-pointer transition-colors group"
            style={{ 
              borderBottom: '1px solid var(--border-slate-200)',
              background: selectedConversationId === conv.id ? 'var(--bg-slate-100)' : 'transparent'
            }}
            onMouseEnter={(e) => { if (selectedConversationId !== conv.id) e.currentTarget.style.background = 'var(--bg-slate-50)'; }}
            onMouseLeave={(e) => { if (selectedConversationId !== conv.id) e.currentTarget.style.background = 'transparent'; }}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-emerald-500 flex items-center justify-center text-white font-semibold flex-shrink-0">
                {(conv.otherUserName || '?')[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="font-medium truncate" style={{ color: 'var(--text-slate-900)' }}>
                    {conv.otherUserName || 'Unknown User'}
                  </span>
                  <div className="flex items-center gap-2">
                    {conv.unreadCount > 0 && (
                      <Badge className="bg-emerald-500 text-white">
                        {conv.unreadCount}
                      </Badge>
                    )}
                    <button
                      onClick={(e) => handleDeleteConversation(e, conv.id, conv.messages)}
                      className="p-1 opacity-0 group-hover:opacity-100 hover:bg-red-100 rounded transition-all"
                      title="Delete conversation"
                    >
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </button>
                  </div>
                </div>
                <p className="text-sm truncate" style={{ color: 'var(--text-slate-500)' }}>
                  {conv.lastMessage?.content}
                </p>
                <p className="text-xs" style={{ color: 'var(--text-slate-400)' }}>
                  {conv.lastMessage?.created_date && format(new Date(conv.lastMessage.created_date), 'MMM d, h:mm a')}
                </p>
              </div>
            </div>
          </div>
        ))}

        {/* New conversation options - only shown when searching */}
        {availableUsers.length > 0 && (
          <>
            <div className="px-3 py-2 text-xs font-semibold uppercase" style={{ background: 'var(--bg-slate-50)', color: 'var(--text-slate-500)' }}>
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
                  <span className="font-medium" style={{ color: 'var(--text-slate-700)' }}>
                    {user.user_name || user.full_name}
                  </span>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}