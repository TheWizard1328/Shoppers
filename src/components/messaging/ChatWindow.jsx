import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Send, ArrowLeft, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { parseEntityTimestamp } from '@/components/utils/localTimeHelper';
import {
  SYSTEM_UPDATES_SENDER_ID,
  isHiddenSystemBroadcastMessageForThisDevice,
} from './updateBroadcastConfig';

function ChatWindow({
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
  const inputRef = useRef(null);
  const focusRestoreTimeoutRef = useRef(null);
  const shouldRestoreFocusRef = useRef(false);
  const intentionalBlurRef = useRef(false);
  const lastFocusAtRef = useRef(0);
  const isMobileRef = useRef(false);
  const isSystemUpdatesConversation = otherUserId === SYSTEM_UPDATES_SENDER_ID;

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const restoreInputFocus = useCallback((delay = 0) => {
    if (focusRestoreTimeoutRef.current) {
      window.clearTimeout(focusRestoreTimeoutRef.current);
    }

    focusRestoreTimeoutRef.current = window.setTimeout(() => {
      if (!shouldRestoreFocusRef.current || intentionalBlurRef.current || isSystemUpdatesConversation) return;
      const inputElement = inputRef.current;
      if (!inputElement || document.activeElement === inputElement) return;

      inputElement.focus({ preventScroll: true });
      const cursorPosition = inputElement.value?.length || 0;
      try {
        inputElement.setSelectionRange(cursorPosition, cursorPosition);
      } catch (_error) {
        // Ignore selection restore failures on unsupported inputs
      }
    }, delay);
  }, [isSystemUpdatesConversation]);

  useEffect(() => {
    isMobileRef.current = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    return () => {
      if (focusRestoreTimeoutRef.current) {
        window.clearTimeout(focusRestoreTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!conversationId) return;

    const fetchMessages = async () => {
      try {
        const allMessages = await base44.entities.Message.filter(
          { conversation_id: conversationId },
          '-created_date'
        );
        console.log('📨 [ChatWindow] Fetched messages:', allMessages.length, 'for conversation:', conversationId);
        const visibleMessages = (allMessages || []).filter(
          (message) => !isHiddenSystemBroadcastMessageForThisDevice(message?.id)
        );
        // Reverse to show oldest first in thread, newest at bottom
        setMessages(visibleMessages.reverse());

        const latestSystemBroadcast = [...visibleMessages]
          .reverse()
          .find((message) => message?.sender_id === SYSTEM_UPDATES_SENDER_ID && message?.content?.trim?.().startsWith('Your app has just been updated.'));

        if (isSystemUpdatesConversation && latestSystemBroadcast?.id) {
          // Ack is sent only when the update action actually runs from the prompt button/timer.
        }

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

    const handleRealtimeMessage = (payload) => {
      const event = payload?.detail || payload;
      if (event.data?.conversation_id !== conversationId || isHiddenSystemBroadcastMessageForThisDevice(event.data?.id)) return;
      
      if (event.type === 'create' || event.type === 'update') {
        setMessages(prev => {
          const exists = prev.some(m => m.id === event.data.id);
          if (exists) {
            return prev.map(m => m.id === event.data.id ? event.data : m);
          } else {
            return [...prev, event.data];
          }
        });


        if (event.data.receiver_id === currentUser?.id && !event.data.read) {
          base44.entities.Message.update(event.data.id, { read: true }).catch(() => {});
          if (onMessagesRead) {
            onMessagesRead(1);
          }
        }
      }
    };

    const unsubscribe = base44.entities.Message.subscribe(handleRealtimeMessage);
    window.addEventListener('messageRealtimeUpdate', handleRealtimeMessage);

    return () => {
      unsubscribe();
      window.removeEventListener('messageRealtimeUpdate', handleRealtimeMessage);
    };
  }, [conversationId, currentUser?.id, onMessagesRead]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (!shouldRestoreFocusRef.current || isSending || isSystemUpdatesConversation) return;
    if (document.activeElement === inputRef.current) return;
    restoreInputFocus(isMobileRef.current ? 60 : 0);
  }, [messages.length, conversationId, isSending, isSystemUpdatesConversation, restoreInputFocus]);

  const handleSend = async () => {
    if (!newMessage.trim() || isSending) return;

    setIsSending(true);
    try {
      const messageContent = newMessage.trim();
      const createdMessage = await base44.entities.Message.create({
        sender_id: currentUser.id,
        sender_name: currentUser.user_name || currentUser.full_name,
        receiver_id: otherUserId,
        receiver_name: otherUserName,
        conversation_id: conversationId,
        content: messageContent,
        read: false,
      });
      // Fire-and-forget push notification to recipient
      const senderName = currentUser.user_name || currentUser.full_name || 'RxDeliver';
      base44.functions.invoke('sendPushNotification', {
        user_id: otherUserId,
        title: senderName,
        body: messageContent,
        tag: `chat-${conversationId}`,
        url: `/?openChat=${encodeURIComponent(currentUser.id)}&openChatName=${encodeURIComponent(senderName)}`
      }).catch((error) => console.warn('Push notification failed:', error?.message || error));
      setNewMessage('');
      setMessages((prev) => [...prev, createdMessage]);
      shouldRestoreFocusRef.current = true;
      restoreInputFocus(isMobileRef.current ? 60 : 0);
    } catch (error) {
      console.error('Error sending message:', error);
    } finally {
      setIsSending(false);
    }
  };

  const handleDeleteMessage = async (msgId) => {
    try {
      await base44.entities.Message.delete(msgId);
      setMessages(prev => prev.filter(m => m.id !== msgId));
    } catch (error) {
      console.error('Error deleting message:', error);
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
          <Button
            variant="ghost"
            size="icon"
            onMouseDown={() => {
              intentionalBlurRef.current = true;
              shouldRestoreFocusRef.current = false;
            }}
            onClick={onBack}
            className="lg:hidden"
          >
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
              className={`flex group ${isOwnMessage ? 'justify-end' : 'justify-start'}`}
            >
              {isOwnMessage && (
                <button
                  onClick={() => handleDeleteMessage(msg.id)}
                  className="opacity-0 group-hover:opacity-100 p-1 mr-1 self-center rounded hover:bg-red-100 transition-all"
                  title="Delete message"
                >
                  <Trash2 className="w-3.5 h-3.5 text-red-400" />
                </button>
              )}
              <div 
                className="rounded-2xl px-4 py-2 rounded-bl-sm max-w-[80%] shadow-sm"
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
                  {msg.created_date && format(parseEntityTimestamp(msg.created_date), 'h:mm a')}
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
            ref={inputRef}
            placeholder={isSystemUpdatesConversation ? "Replies are disabled for System Updates" : "Type a message..."}
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyPress={handleKeyPress}
            onFocus={() => {
              shouldRestoreFocusRef.current = true;
              intentionalBlurRef.current = false;
              lastFocusAtRef.current = Date.now();
            }}
            onBlur={(e) => {
              if (intentionalBlurRef.current) {
                shouldRestoreFocusRef.current = false;
                intentionalBlurRef.current = false;
                return;
              }

              const nextFocusedElement = e.relatedTarget;
              if (nextFocusedElement) {
                shouldRestoreFocusRef.current = false;
                return;
              }

              const recentlyFocused = Date.now() - lastFocusAtRef.current < 1500;
              if (recentlyFocused || isSending) {
                shouldRestoreFocusRef.current = true;
                restoreInputFocus(isMobileRef.current ? 80 : 0);
              } else {
                shouldRestoreFocusRef.current = false;
              }
            }}
            className="flex-1"
            disabled={isSending || isSystemUpdatesConversation}
          />
          <Button
            onMouseDown={() => {
              intentionalBlurRef.current = false;
            }}
            onClick={handleSend}
            disabled={!newMessage.trim() || isSending || isSystemUpdatesConversation}
            className="bg-emerald-500 hover:bg-emerald-600"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

const areChatWindowPropsEqual = (prevProps, nextProps) => {
  return (
    prevProps.conversationId === nextProps.conversationId &&
    prevProps.otherUserId === nextProps.otherUserId &&
    prevProps.otherUserName === nextProps.otherUserName &&
    prevProps.currentUser?.id === nextProps.currentUser?.id &&
    (prevProps.currentUser?.user_name || prevProps.currentUser?.full_name) === (nextProps.currentUser?.user_name || nextProps.currentUser?.full_name) &&
    prevProps.onBack === nextProps.onBack &&
    prevProps.onMessagesRead === nextProps.onMessagesRead
  );
};

export default memo(ChatWindow, areChatWindowPropsEqual);