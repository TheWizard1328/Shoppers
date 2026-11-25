import React, { useState, useEffect, useRef } from 'react';
import { X, MessageCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { base44 } from '@/api/base44Client';
import UpdateAppPrompt from './UpdateAppPrompt';
import {
  AUTO_UPDATE_PROMPT_ENABLED,
  isAppUpdateBroadcast,
  isHiddenSystemBroadcastMessageForThisDevice,
  hasSystemBroadcastBeenAckedForThisDevice,
  hideSystemBroadcastMessageForThisDevice,
  SYSTEM_UPDATES_SENDER_ID,
} from './updateBroadcastConfig';

const UPDATE_PROMPT_WINDOW_MS = 30000;

export default function MessageNotificationBalloon({ currentUser, onOpenConversation, onDismiss, suppressBalloon }) {
  const [notification, setNotification] = useState(null);
  const [updatePromptMessage, setUpdatePromptMessage] = useState(null);
  const [updatePromptMeta, setUpdatePromptMeta] = useState(null);
  const [lastSeenMessageId, setLastSeenMessageId] = useState(null);
  const autoDismissTimeoutRef = useRef(null);

  useEffect(() => {
    if (!currentUser?.id) return;

    // Load last seen message ID from localStorage
    const storedLastSeen = localStorage.getItem(`lastSeenMessageId_${currentUser.id}`);
    if (storedLastSeen) {
      setLastSeenMessageId(storedLastSeen);
    }

    const handleRealtimeMessage = (payload) => {
      const event = payload?.detail || payload;
      if (event?.data?.receiver_id !== currentUser.id || isHiddenSystemBroadcastMessageForThisDevice(event?.data?.id)) return;

      if (event.type === 'create' && isAppUpdateBroadcast(event.data.content)) {
        // Master switch OFF (Nov 17 2026): the Broadcast Update button is gone, so
        // a broadcast-driven update dialog must never block the app. Hide the
        // message for this device and do nothing else.
        if (!AUTO_UPDATE_PROMPT_ENABLED) {
          hideSystemBroadcastMessageForThisDevice(event.data.id);
          return;
        }
        setUpdatePromptMessage(event.data.content);
        setUpdatePromptMeta({ messageId: event.data.id, conversationId: event.data.conversation_id });
        setNotification(null);
        if (autoDismissTimeoutRef.current) {
          clearTimeout(autoDismissTimeoutRef.current);
        }
        return;
      }

      if (event.type === 'create' || (event.type === 'update' && !event.data.read)) {
        // Dispatchers use the auto-open in-app messaging flow; suppress the toast
        // balloon for them. App-update broadcasts are handled above via UpdateAppPrompt
        // regardless of this flag, so the update prompt still reaches everyone.
        if (suppressBalloon) return;
        const currentLastSeen = localStorage.getItem(`lastSeenMessageId_${currentUser.id}`);

        if (event.data.id !== currentLastSeen) {
          setNotification(event.data);
          setLastSeenMessageId(event.data.id);
          localStorage.setItem(`lastSeenMessageId_${currentUser.id}`, event.data.id);

          if (autoDismissTimeoutRef.current) {
            clearTimeout(autoDismissTimeoutRef.current);
          }

          autoDismissTimeoutRef.current = setTimeout(() => {
            setNotification(null);
          }, 8000);
        }
      }
    };

    const unsubscribe = base44.entities.Message.subscribe(handleRealtimeMessage);
    window.addEventListener('messageRealtimeUpdate', handleRealtimeMessage);

    return () => {
      unsubscribe();
      window.removeEventListener('messageRealtimeUpdate', handleRealtimeMessage);
      if (autoDismissTimeoutRef.current) {
        clearTimeout(autoDismissTimeoutRef.current);
      }
    };
  }, [currentUser?.id]);

  // OWNER REPORT Nov 17 2026: backgrounded / minimized web views and PWAs never
  // updated. The browser freezes the page (and its websocket) while hidden, so the
  // broadcast message is never delivered live and no prompt (or 30s timer) ever
  // exists. On every return to the foreground, look for an update broadcast sent to
  // this user that this device has not acknowledged yet:
  //  - sent < 30s ago  -> show the prompt for the time that is left
  //  - sent >= 30s ago -> its countdown already ran out, so update right away
  useEffect(() => {
    if (!currentUser?.id) return undefined;
    // Master switch OFF: no catch-up prompt and no forced reload. Sweep the
    // thread once and hide any stale broadcast for this device so nothing can
    // re-arm the dialog later (this is what kept pop-up-ing every few minutes).
    if (!AUTO_UPDATE_PROMPT_ENABLED) {
      let stop = false;
      (async () => {
        try {
          const conversationId = [SYSTEM_UPDATES_SENDER_ID, currentUser.id].sort().join('_');
          const recent = await base44.entities.Message.filter(
            { conversation_id: conversationId, receiver_id: currentUser.id },
            '-created_date',
            5
          );
          if (stop) return;
          const list = Array.isArray(recent) ? recent : (recent?.items || []);
          for (const m of list) {
            if (m?.id && isAppUpdateBroadcast(m.content || '')) hideSystemBroadcastMessageForThisDevice(m.id);
          }
        } catch { /* non-critical */ }
      })();
      return () => { stop = true; };
    }
    let cancelled = false;
    let running = false;

    const catchUpOnMissedUpdateBroadcast = async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        const conversationId = [SYSTEM_UPDATES_SENDER_ID, currentUser.id].sort().join('_');
        const recent = await base44.entities.Message.filter(
          { conversation_id: conversationId, receiver_id: currentUser.id },
          '-created_date',
          5
        );
        if (cancelled) return;
        const list = Array.isArray(recent) ? recent : (recent?.items || []);
        const missed = list.find((m) =>
          m && isAppUpdateBroadcast(m.content || '') &&
          !isHiddenSystemBroadcastMessageForThisDevice(m.id) &&
          !hasSystemBroadcastBeenAckedForThisDevice(m.id)
        );
        if (!missed) return;

        const age = Date.now() - new Date(missed.created_date).getTime();
        // Ignore stale broadcasts (e.g. from days ago on a device that was off).
        if (!Number.isFinite(age) || age > 6 * 60 * 60 * 1000) return;

        if (age >= UPDATE_PROMPT_WINDOW_MS) {
          const { sendSystemBroadcastAckIfNeeded } = await import('./updateBroadcastConfig');
          await sendSystemBroadcastAckIfNeeded({
            currentUser, messageId: missed.id, conversationId: missed.conversation_id,
          }).catch(() => {});
          window.location.reload();
          return;
        }
        setUpdatePromptMessage(missed.content);
        setUpdatePromptMeta({ messageId: missed.id, conversationId: missed.conversation_id });
      } catch (_) {
        // Non-critical; the next foreground event retries.
      } finally {
        running = false;
      }
    };

    const onResume = () => { if (!document.hidden) catchUpOnMissedUpdateBroadcast(); };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('focus', onResume);
    window.addEventListener('pageshow', onResume);
    window.addEventListener('online', onResume);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('focus', onResume);
      window.removeEventListener('pageshow', onResume);
      window.removeEventListener('online', onResume);
    };
  }, [currentUser?.id]);

  const handleClick = () => {
    if (notification) {
      onOpenConversation(notification.conversation_id, notification.sender_id, notification.sender_name);
      setNotification(null);
    }
  };

  const handleDismiss = (e) => {
    e.stopPropagation();
    setNotification(null);
    if (onDismiss) onDismiss();
  };

  const handleUpdateApp = () => {
    window.location.reload();
  };

  const handleCancelUpdatePrompt = () => {
    setUpdatePromptMessage(null);
    setUpdatePromptMeta(null);
  };

  return (
    <>
      {updatePromptMessage && (
        <UpdateAppPrompt
          message={updatePromptMessage}
          currentUser={currentUser}
          messageId={updatePromptMeta?.messageId}
          conversationId={updatePromptMeta?.conversationId}
          onUpdate={handleUpdateApp}
          onCancel={handleCancelUpdatePrompt}
        />
      )}
      <AnimatePresence>
      {notification && (
        <motion.div
          initial={{ opacity: 0, y: -20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.95 }}
          transition={{ duration: 0.2 }}
          onClick={handleClick}
          /* OWNER REPORT (Nov 25 2026): on a phone the balloon's top edge and the
             close X sat behind the mobile header bar. It now clears the 54px
             header (68px from the inset) and rides above every app overlay
             (dialogs top out at 99999, the portal debug badge at 2147483000). */
          className="fixed top-[calc(var(--app-inset-top)+4.25rem)] md:top-[calc(var(--app-inset-top)+1rem)] right-4 z-[2147480000] max-w-sm w-full cursor-pointer"
        >
          <div 
            className="rounded-xl shadow-2xl overflow-hidden hover:shadow-xl transition-shadow bg-surface" style={{ border: '1px solid var(--border-slate-200)' }}
          >
            {/* Header */}
            <div className="bg-gradient-to-r from-blue-500 to-blue-600 px-4 py-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MessageCircle className="w-4 h-4 text-white" />
                <span className="text-white text-sm font-medium">New Message</span>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); handleDismiss(e); }}
                className="p-1 hover:bg-white dark:bg-slate-900 dark:hover:bg-slate-800/20 rounded-full transition-colors"
              >
                <X className="w-4 h-4 text-white" />
              </button>
            </div>
            
            {/* Content */}
            <div className="p-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center flex-shrink-0">
                  <span className="text-white font-bold text-sm">
                    {(notification.sender_name || 'U').charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm text-body">
                    {notification.sender_name || 'Unknown'}
                  </p>
                  <p className="text-sm mt-1 line-clamp-2 text-label">
                    {notification.content}
                  </p>
                </div>
              </div>
              
              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs" style={{ color: 'var(--text-slate-400)' }}>Tap to reply</span>
                <span className="text-xs text-blue-500 font-medium">View →</span>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
    </>
  );
}