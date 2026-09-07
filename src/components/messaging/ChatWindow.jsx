import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Send, ArrowLeft, Trash2, ImagePlus, X, Info, Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { parseEntityTimestamp } from '@/components/utils/localTimeHelper';
import MessageImageBubble from './MessageImageBubble';
import GroupMembersSheet from './GroupMembersSheet';
import { resolveGroupMemberIds } from './groupHelpers';
import { uploadImageFile, sendChatMessage } from './chatSendHelpers';
import {
  SYSTEM_UPDATES_SENDER_ID,
  isHiddenSystemBroadcastMessageForThisDevice,
} from './updateBroadcastConfig';

function ChatWindow({
  currentUser,
  conversationId,
  otherUserId,
  otherUserName,
  group,
  users,
  onBack,
  onMessagesRead,
  autoFocus
}) {
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [pendingImage, setPendingImage] = useState(null); // { file, previewUrl }
  const [isSending, setIsSending] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [resolvedGroup, setResolvedGroup] = useState(group || null);
  const [showMembersSheet, setShowMembersSheet] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const focusRestoreTimeoutRef = useRef(null);
  const shouldRestoreFocusRef = useRef(false);
  const intentionalBlurRef = useRef(false);
  const lastFocusAtRef = useRef(0);
  const isMobileRef = useRef(false);
  const isSystemUpdatesConversation = otherUserId === SYSTEM_UPDATES_SENDER_ID;
  const isGroupMode = !!(resolvedGroup && resolvedGroup.id);

  // Resolve the group record when opened via deep-link without a group prop.
  useEffect(() => {
    if (group) { setResolvedGroup(group); return; }
    if (otherUserId || !conversationId || isSystemUpdatesConversation) { setResolvedGroup(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const g = await base44.entities.ConversationGroup.get(conversationId);
        if (!cancelled && g?.id) setResolvedGroup(g);
      } catch (_e) {
        // not a group — leave as direct
      }
    })();
    return () => { cancelled = true; };
  }, [group, otherUserId, conversationId, isSystemUpdatesConversation]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const restoreInputFocus = useCallback((delay = 0) => {
    if (focusRestoreTimeoutRef.current) window.clearTimeout(focusRestoreTimeoutRef.current);
    focusRestoreTimeoutRef.current = window.setTimeout(() => {
      if (!shouldRestoreFocusRef.current || intentionalBlurRef.current || isSystemUpdatesConversation) return;
      const inputElement = inputRef.current;
      if (!inputElement || document.activeElement === inputElement) return;
      inputElement.focus({ preventScroll: true });
      const cursorPosition = inputElement.value?.length || 0;
      try { inputElement.setSelectionRange(cursorPosition, cursorPosition); } catch (_e) {}
    }, delay);
  }, [isSystemUpdatesConversation]);

  useEffect(() => {
    isMobileRef.current = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    return () => { if (focusRestoreTimeoutRef.current) window.clearTimeout(focusRestoreTimeoutRef.current); };
  }, []);

  // Mark a single message as read by the current user (group → append read_by; 1:1 → read=true)
  const markMessageRead = useCallback(async (msg) => {
    if (!msg?.id || !currentUser?.id) return;
    if (msg.sender_id === currentUser.id) return; // don't mark own messages
    try {
      if (msg.is_group) {
        const alreadyRead = Array.isArray(msg.read_by) && msg.read_by.includes(currentUser.id);
        if (alreadyRead) return;
        // Re-fetch to reduce lost-update risk, then append
        const fresh = await base44.entities.Message.get(msg.id);
        const readBy = Array.from(new Set([...(fresh?.read_by || []), currentUser.id]));
        if (readBy.length === (fresh?.read_by || []).length) return;
        await base44.entities.Message.update(msg.id, { read_by: readBy });
      } else if (!msg.read && msg.receiver_id === currentUser.id) {
        await base44.entities.Message.update(msg.id, { read: true });
      }
    } catch (_e) { /* non-critical */ }
  }, [currentUser?.id]);

  useEffect(() => {
    if (!conversationId) return;

    const fetchMessages = async () => {
      try {
        const allMessages = await base44.entities.Message.filter({ conversation_id: conversationId }, '-created_date');
        const visibleMessages = (allMessages || []).filter(
          (message) => !isHiddenSystemBroadcastMessageForThisDevice(message?.id)
        );
        setMessages(visibleMessages.reverse());

        // Mark unread messages as read
        const unreadMessages = visibleMessages.filter(
          (m) => !(m.is_group
            ? (Array.isArray(m.read_by) && m.read_by.includes(currentUser?.id))
            : m.read) &&
            (m.is_group ? true : m.receiver_id === currentUser?.id) &&
            m.sender_id !== currentUser?.id
        );
        if (unreadMessages.length > 0) {
          await Promise.allSettled(unreadMessages.map(msg => markMessageRead(msg)));
          if (onMessagesRead) onMessagesRead(unreadMessages.length);
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
          return exists ? prev.map(m => m.id === event.data.id ? event.data : m) : [...prev, event.data];
        });
        markMessageRead(event.data);
      }
    };

    const unsubscribe = base44.entities.Message.subscribe(handleRealtimeMessage);
    window.addEventListener('messageRealtimeUpdate', handleRealtimeMessage);
    return () => {
      unsubscribe();
      window.removeEventListener('messageRealtimeUpdate', handleRealtimeMessage);
    };
  }, [conversationId, currentUser?.id, onMessagesRead, markMessageRead]);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  useEffect(() => {
    if (!autoFocus || isSystemUpdatesConversation || isLoading) return;
    shouldRestoreFocusRef.current = true;
    intentionalBlurRef.current = false;
    const t = window.setTimeout(() => { if (!isMobileRef.current) restoreInputFocus(0); }, 120);
    return () => window.clearTimeout(t);
  }, [autoFocus, isSystemUpdatesConversation, isLoading, restoreInputFocus]);

  useEffect(() => {
    if (!shouldRestoreFocusRef.current || isSending || isSystemUpdatesConversation) return;
    if (document.activeElement === inputRef.current) return;
    restoreInputFocus(isMobileRef.current ? 60 : 0);
  }, [messages.length, conversationId, isSending, isSystemUpdatesConversation, restoreInputFocus]);

  const handlePickImage = () => {
    if (isSending || isSystemUpdatesConversation) return;
    fileInputRef.current?.click();
  };

  const handleFileSelected = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      alert('Please select an image file.');
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      alert('Image is too large (max 15MB).');
      return;
    }
    const previewUrl = URL.createObjectURL(file);
    setPendingImage({ file, previewUrl });
    // Reset input so the same file can be re-selected
    e.target.value = '';
  };

  const removePendingImage = () => {
    if (pendingImage?.previewUrl) URL.revokeObjectURL(pendingImage.previewUrl);
    setPendingImage(null);
  };

  const handleSend = async () => {
    const trimmedText = newMessage.trim();
    if (isSending || isSystemUpdatesConversation) return;
    const hasImage = !!pendingImage;
    if (!trimmedText && !hasImage) return;

    setIsSending(true);
    try {
      // Upload image if present
      let attachmentUrl = '';
      if (hasImage) {
        try {
          attachmentUrl = await uploadImageFile(pendingImage.file);
        } catch (uploadErr) {
          console.error('Image upload failed:', uploadErr);
          alert('Failed to upload image. Please try again.');
          return;
        }
      }

      const createdMessage = await sendChatMessage({
        currentUser,
        conversationId,
        otherUserId,
        otherUserName,
        group: isGroupMode ? resolvedGroup : null,
        users,
        content: trimmedText,
        attachmentUrl,
        isImage: hasImage,
      });

      setNewMessage('');
      removePendingImage();
      setMessages((prev) => [...prev, createdMessage].filter(Boolean));
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

  const canSend = (!isSending && !isSystemUpdatesConversation && (newMessage.trim() || pendingImage));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full bg-surface">
        <div className="animate-spin w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  // Group header display
  const headerName = isGroupMode ? resolvedGroup.name : (otherUserName || 'Unknown User');
  const groupMemberCount = isGroupMode ? resolveGroupMemberIds(resolvedGroup, users).length : 0;

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Header */}
      <div className="p-3 flex items-center gap-3 bg-surface" style={{ borderBottom: '1px solid var(--border-slate-200)' }}>
        {onBack && (
          <Button
            variant="ghost"
            size="icon"
            onMouseDown={() => { intentionalBlurRef.current = true; shouldRestoreFocusRef.current = false; }}
            onClick={onBack}
            className="lg:hidden"
          >
            <ArrowLeft className="w-5 h-5 text-body-2" />
          </Button>
        )}
        {isGroupMode ? (
          <button
            type="button"
            onClick={() => setShowMembersSheet(true)}
            className="flex items-center gap-3 flex-1 text-left min-w-0"
          >
            <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold flex-shrink-0" style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}>
              {(headerName || '?')[0].toUpperCase()}
            </div>
            <div className="min-w-0">
              <span className="font-semibold text-body block truncate">{headerName}</span>
              <span className="text-xs text-soft flex items-center gap-1">
                {groupMemberCount} member{groupMemberCount !== 1 ? 's' : ''}
                <Info className="w-3 h-3" />
              </span>
            </div>
          </button>
        ) : (
          <>
            <div className="w-10 h-10 rounded-full bg-emerald-500 flex items-center justify-center text-white font-semibold">
              {(otherUserName || '?')[0].toUpperCase()}
            </div>
            <span className="font-semibold text-body">{otherUserName || 'Unknown User'}</span>
          </>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ background: 'var(--bg-slate-50)' }}>
        {messages.length === 0 && (
          <div className="text-center py-8 text-soft">
            <p>{isGroupMode ? 'No messages yet — start the group conversation!' : 'No messages yet. Start the conversation!'}</p>
          </div>
        )}

        {messages.map((msg) => {
          const isOwnMessage = msg.sender_id === currentUser?.id;
          const isImage = msg.message_type === 'image' && msg.attachment_url;
          return (
            <div key={msg.id} className={`flex group ${isOwnMessage ? 'justify-end' : 'justify-start'}`}>
              {isOwnMessage && (
                <button
                  onClick={() => handleDeleteMessage(msg.id)}
                  className="opacity-0 group-hover:opacity-100 p-1 mr-1 self-center rounded hover:bg-red-100 transition-all"
                  title="Delete message"
                >
                  <Trash2 className="w-3.5 h-3.5 text-red-400" />
                </button>
              )}
              {isImage ? (
                <MessageImageBubble
                  message={msg}
                  isOwnMessage={isOwnMessage}
                  showSenderName={isGroupMode}
                />
              ) : (
                <div
                  className="rounded-2xl px-4 py-2 rounded-bl-sm max-w-[80%] shadow-sm"
                  style={{
                    background: isOwnMessage ? '#10b981' : 'var(--bg-white)',
                    color: isOwnMessage ? '#ffffff' : 'var(--text-slate-900)'
                  }}
                >
                  {isGroupMode && !isOwnMessage && (
                    <p className="text-xs font-semibold mb-1" style={{ color: 'var(--text-slate-500)' }}>
                      {msg.sender_name || 'Unknown'}
                    </p>
                  )}
                  <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                  <p className="text-xs mt-1" style={{ color: isOwnMessage ? 'rgba(255,255,255,0.7)' : 'var(--text-slate-400)' }}>
                    {msg.created_date && format(parseEntityTimestamp(msg.created_date), 'h:mm a')}
                    {isOwnMessage && isGroupMode && msg.read_by && msg.read_by.length > 1 && ` • Read by ${msg.read_by.length - 1}`}
                    {isOwnMessage && !isGroupMode && msg.read && ' • Read'}
                  </p>
                </div>
              )}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Pending image preview bar */}
      {pendingImage && (
        <div className="px-3 pt-2 bg-surface">
          <div className="flex items-center gap-2 rounded-xl border p-2" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-slate-50)' }}>
            <img src={pendingImage.previewUrl} alt="preview" className="w-12 h-12 rounded-lg object-cover" />
            <span className="text-xs text-label flex-1 truncate">Image ready to send{newMessage.trim() ? ` — caption: ${newMessage.trim().slice(0, 40)}` : ''}</span>
            <Button variant="ghost" size="icon" onClick={removePendingImage} disabled={isSending} className="h-8 w-8">
              <X className="w-4 h-4 text-body-2" />
            </Button>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="p-3 bg-surface" style={{ borderTop: '1px solid var(--border-slate-200)' }}>
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelected}
            className="hidden"
          />
          <Button
            variant="outline"
            size="icon"
            onClick={handlePickImage}
            disabled={isSending || isSystemUpdatesConversation}
            title="Attach image"
            className="flex-shrink-0"
          >
            {isSending && pendingImage ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImagePlus className="w-4 h-4 text-body-2" />}
          </Button>
          <Input
            ref={inputRef}
            placeholder={isSystemUpdatesConversation ? "Replies are disabled for System Updates" : (pendingImage ? "Add a caption (optional)..." : "Type a message...")}
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyPress={handleKeyPress}
            onFocus={() => { shouldRestoreFocusRef.current = true; intentionalBlurRef.current = false; lastFocusAtRef.current = Date.now(); }}
            onBlur={(e) => {
              if (intentionalBlurRef.current) { shouldRestoreFocusRef.current = false; intentionalBlurRef.current = false; return; }
              const nextFocusedElement = e.relatedTarget;
              if (nextFocusedElement) { shouldRestoreFocusRef.current = false; return; }
              const recentlyFocused = Date.now() - lastFocusAtRef.current < 1500;
              if (recentlyFocused || isSending) { shouldRestoreFocusRef.current = true; restoreInputFocus(isMobileRef.current ? 80 : 0); }
              else { shouldRestoreFocusRef.current = false; }
            }}
            className="flex-1"
            disabled={isSending || isSystemUpdatesConversation}
          />
          <Button
            onMouseDown={() => { intentionalBlurRef.current = false; }}
            onClick={handleSend}
            disabled={!canSend}
            className="bg-emerald-500 hover:bg-emerald-600"
          >
            {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
      </div>

      {showMembersSheet && isGroupMode && (
        <GroupMembersSheet
          group={resolvedGroup}
          currentUser={currentUser}
          appUsers={users}
          onLeave={(groupId) => {
            setShowMembersSheet(false);
            if (onBack) onBack();
          }}
          onDelete={(groupId) => {
            setShowMembersSheet(false);
            if (onBack) onBack();
          }}
          onClose={() => setShowMembersSheet(false)}
        />
      )}
    </div>
  );
}

const areChatWindowPropsEqual = (prevProps, nextProps) => {
  return (
    prevProps.conversationId === nextProps.conversationId &&
    prevProps.otherUserId === nextProps.otherUserId &&
    prevProps.otherUserName === nextProps.otherUserName &&
    prevProps.group?.id === nextProps.group?.id &&
    prevProps.currentUser?.id === nextProps.currentUser?.id &&
    (prevProps.currentUser?.user_name || prevProps.currentUser?.full_name) === (nextProps.currentUser?.user_name || nextProps.currentUser?.full_name) &&
    prevProps.onBack === nextProps.onBack &&
    prevProps.onMessagesRead === nextProps.onMessagesRead &&
    prevProps.autoFocus === nextProps.autoFocus
  );
};

export default memo(ChatWindow, areChatWindowPropsEqual);