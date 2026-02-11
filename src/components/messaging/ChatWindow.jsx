import React, { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Send, ArrowLeft } from 'lucide-react';
import { format } from 'date-fns';
import { parseLocalTimestamp } from '@/components/utils/localTimeHelper';

export default function ChatWindow({
  currentUser,
  conversationId,
  otherUserId,
  otherUserName,
  onBack,
  onMessagesRead
}) {
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (!conversationId) return;

    const fetchMessages = async () => {
      try {
        const allMessages = await base44.entities.Message.filter(
          { conversation_id: conversationId },
          'created_date'
        );
        console.log('📨 [ChatWindow] Fetched messages:', allMessages.length, 'for conversation:', conversationId);
        setMessages(allMessages || []);

        // Mark unread messages as read (in parallel for speed)
        const unreadMessages = allMessages.filter(
          (m) => !m.read && m.receiver_id === currentUser?.id
        );
        if (unreadMessages.length > 0) {
          await Promise.all(
            unreadMessages.map(msg => base44.entities.Message.update(msg.id, { read: true }))
          );
          // Notify parent immediately that messages were read
          if (onMessagesRead) {
            onMessagesRead(unreadMessages.length);
          }
        }
      } catch (error) {
        console.error('Error fetching messages:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchMessages();

    // Subscribe to real-time message updates
    const unsubscribe = base44.entities.Message.subscribe((event) => {
      // Only process messages for this conversation
      if (event.data?.conversation_id !== conversationId) return;
      
      if (event.type === 'create' || event.type === 'update') {
        setMessages(prev => {
          const exists = prev.some(m => m.id === event.data.id);
          if (exists) {
            return prev.map(m => m.id === event.data.id ? event.data : m);
          } else {
            return [...prev, event.data];
          }
        });

        // Mark as read if this message is for the current user and is unread
        if (event.data.receiver_id === currentUser?.id && !event.data.read) {
          base44.entities.Message.update(event.data.id, { read: true });
          if (onMessagesRead) {
            onMessagesRead(1);
          }
        }
      }
    });

    return () => unsubscribe();
  }, [conversationId, currentUser?.id, onMessagesRead]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async () => {
    if (!newMessage.trim() || isSending) return;

    setIsSending(true);
    try {
      await base44.entities.Message.create({
        sender_id: currentUser.id,
        sender_name: currentUser.user_name || currentUser.full_name,
        receiver_id: otherUserId,
        receiver_name: otherUserName,
        conversation_id: conversationId,
        content: newMessage.trim(),
        read: false
      });
      setNewMessage('');

      // Immediately fetch to show the new message
      const updatedMessages = await base44.entities.Message.filter(
        { conversation_id: conversationId },
        'created_date'
      );
      setMessages(updatedMessages);
    } catch (error) {
      console.error('Error sending message:', error);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full" style={{ background: 'var(--bg-white)' }}>
        <div className="animate-spin w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-white)' }}>
      {/* Header */}
      <div className="p-3 flex items-center gap-3" style={{ background: 'var(--bg-white)', borderBottom: '1px solid var(--border-slate-200)' }}>
        {onBack && (
          <Button variant="ghost" size="icon" onClick={onBack} className="lg:hidden">
            <ArrowLeft className="w-5 h-5" style={{ color: 'var(--text-slate-700)' }} />
          </Button>
        )}
        <div className="w-10 h-10 rounded-full bg-emerald-500 flex items-center justify-center text-white font-semibold">
          {(otherUserName || '?')[0].toUpperCase()}
        </div>
        <span className="font-semibold" style={{ color: 'var(--text-slate-900)' }}>{otherUserName || 'Unknown User'}</span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ background: 'var(--bg-slate-50)' }}>
        {messages.length === 0 && (
          <div className="text-center py-8" style={{ color: 'var(--text-slate-500)' }}>
            <p>No messages yet. Start the conversation!</p>
          </div>
        )}
        
        {messages.map((msg) => {
          const isOwnMessage = msg.sender_id === currentUser?.id;
          return (
            <div
              key={msg.id}
              className={`flex ${isOwnMessage ? 'justify-end' : 'justify-start'}`}
            >
              <div 
                className="rounded-2xl px-4 py-2 rounded-bl-sm max-w-[100%] shadow-sm"
                style={{ 
                  background: isOwnMessage ? '#10b981' : 'var(--bg-white)', 
                  color: isOwnMessage ? '#ffffff' : 'var(--text-slate-900)' 
                }}
              >
                <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                <p 
                  className="text-xs mt-1"
                  style={{ color: isOwnMessage ? 'rgba(255,255,255,0.7)' : 'var(--text-slate-400)' }}
                >
                  {msg.created_date && format(new Date(msg.created_date), 'h:mm a')}
                  {isOwnMessage && msg.read && ' • Read'}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3" style={{ background: 'var(--bg-white)', borderTop: '1px solid var(--border-slate-200)' }}>
        <div className="flex gap-2">
          <Input
            placeholder="Type a message..."
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyPress={handleKeyPress}
            className="flex-1"
            disabled={isSending}
          />
          <Button
            onClick={handleSend}
            disabled={!newMessage.trim() || isSending}
            className="bg-emerald-500 hover:bg-emerald-600"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}