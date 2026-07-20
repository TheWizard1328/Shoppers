/**
 * InAppMessageDialog.jsx
 * Auto-opens for dispatchers and admins when a new in-app message arrives
 * from a driver or admin. Shows sender, message content, and action buttons:
 * Quick Reply, Open Conversation, Close (marks as read).
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageCircle, X, Send, ExternalLink } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { isAppOwner, userHasRole } from '@/components/utils/userRoles';
import {
  isAppUpdateBroadcast,
  isHiddenSystemBroadcastMessageForThisDevice,
} from './updateBroadcastConfig';

export default function InAppMessageDialog({ currentUser, onOpenConversation }) {
  const [message, setMessage] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [showReply, setShowReply] = useState(false);
  const autoDismissRef = useRef(null);
  const inputRef = useRef(null);

  // Only show for dispatchers and admins
  const isEligible = currentUser && (
    isAppOwner(currentUser) ||
    userHasRole(currentUser, 'dispatcher') ||
    userHasRole(currentUser, 'admin')
  );

  const dismiss = useCallback(async (markRead = true) => {
    if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
    if (markRead && message?.id) {
      try {
        await base44.entities.Message.update(message.id, { read: true });
      } catch { /* non-critical */ }
    }
    setMessage(null);
    setReplyText('');
    setShowReply(false);
  }, [message]);

  useEffect(() => {
    if (!isEligible || !currentUser?.id) return;

    const handleNewMessage = (payload) => {
      const event = payload?.detail || payload;
      if (!event?.data) return;
      const msg = event.data;

      // Only intercept messages addressed to this user
      if (msg.receiver_id !== currentUser.id) return;

      // Skip system broadcasts
      if (isHiddenSystemBroadcastMessageForThisDevice(msg.id)) return;
      if (isAppUpdateBroadcast(msg.content)) return;

      // Only show on create events (new messages)
      if (event.type !== 'create') return;

      // Skip already-read messages
      if (msg.read) return;

      if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
      setMessage(msg);
      setReplyText('');
      setShowReply(false);

      // Auto-dismiss after 15 seconds if no interaction
      autoDismissRef.current = setTimeout(() => {
        setMessage(null);
      }, 15000);
    };

    const unsubscribe = base44.entities.Message.subscribe(handleNewMessage);
    window.addEventListener('messageRealtimeUpdate', handleNewMessage);

    return () => {
      unsubscribe();
      window.removeEventListener('messageRealtimeUpdate', handleNewMessage);
      if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
    };
  }, [currentUser?.id, isEligible]);

  // Focus reply input when reply box opens
  useEffect(() => {
    if (showReply && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [showReply]);

  const handleOpenConversation = useCallback(() => {
    if (!message) return;
    onOpenConversation(message.conversation_id, message.sender_id, message.sender_name);
    dismiss(true);
  }, [message, onOpenConversation, dismiss]);

  const handleSendReply = useCallback(async () => {
    if (!replyText.trim() || !message || isSending) return;
    setIsSending(true);
    try {
      await base44.entities.Message.create({
        sender_id: currentUser.id,
        sender_name: currentUser.user_name || currentUser.full_name || 'Dispatcher',
        receiver_id: message.sender_id,
        receiver_name: message.sender_name,
        conversation_id: message.conversation_id,
        content: replyText.trim(),
        read: false,
      });
      // Mark original as read
      await base44.entities.Message.update(message.id, { read: true }).catch(() => {});
      dismiss(false); // already marked read above
    } catch { /* ignore */ } finally {
      setIsSending(false);
    }
  }, [replyText, message, isSending, currentUser, dismiss]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendReply();
    }
    if (e.key === 'Escape') dismiss(true);
  };

  if (!isEligible || !message) return null;

  const senderInitial = (message.sender_name || 'U').charAt(0).toUpperCase();

  return (
    <AnimatePresence>
      {message && (
        <motion.div
          initial={{ opacity: 0, y: 30, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 30, scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 300, damping: 26 }}
          className="fixed bottom-24 left-1/2 z-[10050] w-[calc(100%-2rem)] max-w-md"
          style={{ transform: 'translateX(-50%)' }}
        >
          <div
            className="rounded-2xl shadow-2xl overflow-hidden"
            style={{ background: 'var(--bg-white)', border: '1px solid var(--border-slate-200)' }}
          >
            {/* Header */}
            <div className="bg-gradient-to-r from-blue-600 to-blue-500 px-4 py-2.5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MessageCircle className="w-4 h-4 text-white" />
                <span className="text-white text-sm font-semibold">New Message</span>
              </div>
              <button
                onClick={() => dismiss(true)}
                className="p-1 rounded-full hover:bg-white/20 transition-colors"
                aria-label="Close and mark as read"
              >
                <X className="w-4 h-4 text-white" />
              </button>
            </div>

            {/* Body */}
            <div className="p-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center flex-shrink-0 text-white font-bold text-sm">
                  {senderInitial}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm" style={{ color: 'var(--text-slate-900)' }}>
                    {message.sender_name || 'Unknown'}
                  </p>
                  <p className="text-sm mt-1 leading-relaxed" style={{ color: 'var(--text-slate-700)' }}>
                    {message.content}
                  </p>
                </div>
              </div>

              {/* Quick Reply input */}
              {showReply && (
                <div className="mt-3 flex gap-2 items-center">
                  <input
                    ref={inputRef}
                    type="text"
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={`Reply to ${message.sender_name || 'sender'}...`}
                    className="flex-1 px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-2"
                    style={{
                      backgroundColor: 'var(--bg-slate-100)',
                      color: 'var(--text-slate-900)',
                      border: '1px solid var(--border-slate-200)',
                    }}
                  />
                  <button
                    onClick={handleSendReply}
                    disabled={!replyText.trim() || isSending}
                    className="flex items-center justify-center w-9 h-9 rounded-lg transition-colors flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed bg-blue-600"
                  >
                    <Send className="w-4 h-4 text-white" />
                  </button>
                </div>
              )}

              {/* Action buttons */}
              <div className="mt-3 flex gap-2">
                {!showReply ? (
                  <button
                    onClick={() => setShowReply(true)}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                  >
                    <Send className="w-3.5 h-3.5" />
                    Quick Reply
                  </button>
                ) : (
                  <button
                    onClick={() => setShowReply(false)}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                    style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)' }}
                  >
                    Cancel
                  </button>
                )}
                <button
                  onClick={handleOpenConversation}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)', border: '1px solid var(--border-slate-200)' }}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open
                </button>
                <button
                  onClick={() => dismiss(true)}
                  className="flex items-center justify-center px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-500)', border: '1px solid var(--border-slate-200)' }}
                  title="Mark as read & close"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}