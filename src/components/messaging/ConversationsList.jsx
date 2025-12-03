import React, { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { Badge } from '@/components/ui/badge';
import { MessageCircle, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { format } from 'date-fns';

export default function ConversationsList({ currentUser, users, onSelectConversation, selectedConversationId, onUnreadCountChange }) {
  const [messages, setMessages] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!currentUser?.id) return;
    
    const fetchMessages = async () => {
      try {
        // OPTIMIZED: Only fetch messages for current user (not all messages)
        // This reduces API load significantly
        const [sentMessages, receivedMessages] = await Promise.all([
          base44.entities.Message.filter({ sender_id: currentUser.id }, '-created_date', 100),
          base44.entities.Message.filter({ receiver_id: currentUser.id }, '-created_date', 100)
        ]);
        
        // Merge and dedupe messages
        const allUserMessages = [...sentMessages, ...receivedMessages];
        const uniqueMessages = allUserMessages.filter((msg, index, self) => 
          index === self.findIndex(m => m.id === msg.id)
        );
        
        setMessages(uniqueMessages);
      } catch (error) {
        console.error('Error fetching messages:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchMessages();
    // Poll every 60 seconds (reduced from 20s to prevent rate limiting)
    const interval = setInterval(fetchMessages, 60000);
    return () => clearInterval(interval);
  }, [currentUser?.id]);

  // Group messages by conversation and get latest + unread count
  const conversations = useMemo(() => {
    const convMap = new Map();
    
    messages.forEach(msg => {
      const convId = msg.conversation_id;
      if (!convMap.has(convId)) {
        convMap.set(convId, {
          id: convId,
          messages: [],
          unreadCount: 0,
          otherUserId: msg.sender_id === currentUser?.id ? msg.receiver_id : msg.sender_id,
          otherUserName: msg.sender_id === currentUser?.id ? msg.receiver_name : msg.sender_name
        });
      }
      const conv = convMap.get(convId);
      conv.messages.push(msg);
      if (!msg.read && msg.receiver_id === currentUser?.id) {
        conv.unreadCount++;
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
  }, [messages, currentUser?.id]);

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

  // Available users to start new conversation
  const availableUsers = useMemo(() => {
    const existingConvUserIds = new Set(conversations.map(c => c.otherUserId));
    return (users || []).filter(u => 
      u.id !== currentUser?.id && 
      !existingConvUserIds.has(u.id) &&
      u.status === 'active'
    );
  }, [users, conversations, currentUser?.id]);

  const filteredAvailableUsers = useMemo(() => {
    if (!searchQuery.trim()) return availableUsers;
    const query = searchQuery.toLowerCase();
    return availableUsers.filter(u => 
      (u.user_name || u.full_name || '').toLowerCase().includes(query)
    );
  }, [availableUsers, searchQuery]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="animate-spin w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="p-3 border-b">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
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
        {filteredConversations.length === 0 && filteredAvailableUsers.length === 0 && (
          <div className="text-center text-slate-500 py-8">
            <MessageCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p>No conversations yet</p>
          </div>
        )}

        {filteredConversations.map(conv => (
          <div
            key={conv.id}
            onClick={() => onSelectConversation(conv.id, conv.otherUserId, conv.otherUserName)}
            className={`p-3 border-b cursor-pointer hover:bg-slate-50 transition-colors ${
              selectedConversationId === conv.id ? 'bg-slate-100' : ''
            }`}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-emerald-500 flex items-center justify-center text-white font-semibold flex-shrink-0">
                {(conv.otherUserName || '?')[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-900 truncate">
                    {conv.otherUserName || 'Unknown User'}
                  </span>
                  {conv.unreadCount > 0 && (
                    <Badge className="bg-emerald-500 text-white ml-2">
                      {conv.unreadCount}
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-slate-500 truncate">
                  {conv.lastMessage?.content}
                </p>
                <p className="text-xs text-slate-400">
                  {conv.lastMessage?.created_date && format(new Date(conv.lastMessage.created_date), 'MMM d, h:mm a')}
                </p>
              </div>
            </div>
          </div>
        ))}

        {/* New conversation options */}
        {filteredAvailableUsers.length > 0 && (
          <>
            <div className="px-3 py-2 bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
              Start New Conversation
            </div>
            {filteredAvailableUsers.map(user => (
              <div
                key={user.id}
                onClick={() => {
                  const convId = [currentUser.id, user.id].sort().join('_');
                  onSelectConversation(convId, user.id, user.user_name || user.full_name);
                }}
                className="p-3 border-b cursor-pointer hover:bg-slate-50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-slate-400 flex items-center justify-center text-white font-semibold flex-shrink-0">
                    {(user.user_name || user.full_name || '?')[0].toUpperCase()}
                  </div>
                  <span className="font-medium text-slate-700">
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