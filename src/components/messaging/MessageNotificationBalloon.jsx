import React, { useState, useEffect, useRef } from 'react';
import { X, MessageCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { base44 } from '@/api/base44Client';

export default function MessageNotificationBalloon({ currentUser, onOpenConversation, onDismiss }) {
  const [notification, setNotification] = useState(null);
  const [lastSeenMessageId, setLastSeenMessageId] = useState(null);
  const autoDismissTimeoutRef = useRef(null);

  useEffect(() => {
    if (!currentUser?.id) return;

    // Load last seen message ID from localStorage
    const storedLastSeen = localStorage.getItem(`lastSeenMessageId_${currentUser.id}`);
    if (storedLastSeen) {
      setLastSeenMessageId(storedLastSeen);
    }

    let pollingInterval = null;

    // Simple polling function - no SSE to avoid auth issues
    // OPTIMIZED: Check localStorage first, skip API when recently checked
    const checkForNewMessages = async () => {
      try {
        // CRITICAL: Use localStorage check first to avoid unnecessary API calls
        const lastAPICheck = localStorage.getItem(`lastMessageAPICheck_${currentUser.id}`);
        const timeSinceLastCheck = Date.now() - (parseInt(lastAPICheck) || 0);
        
        // Skip API call if we checked within last 120 seconds (prevent rate limits)
        if (timeSinceLastCheck < 120000) {
          return;
        }

        const unreadMessages = await base44.entities.Message.filter({
          receiver_id: currentUser.id,
          read: false
        }, '-created_date', 1);

        // Record successful API call
        localStorage.setItem(`lastMessageAPICheck_${currentUser.id}`, Date.now().toString());

        if (unreadMessages.length > 0) {
          const latestMessage = unreadMessages[0];
          const currentLastSeen = localStorage.getItem(`lastSeenMessageId_${currentUser.id}`);
          
          if (latestMessage.id !== currentLastSeen) {
            setNotification(latestMessage);
            setLastSeenMessageId(latestMessage.id);
            localStorage.setItem(`lastSeenMessageId_${currentUser.id}`, latestMessage.id);
            
            if (autoDismissTimeoutRef.current) {
              clearTimeout(autoDismissTimeoutRef.current);
            }
            
            autoDismissTimeoutRef.current = setTimeout(() => {
              setNotification(null);
            }, 8000);
          }
        }
      } catch (error) {
        // Silently ignore errors to prevent auth issues
        console.warn('Message notification check failed:', error.message);
      }
    };

    // Initial check after a short delay to ensure auth is ready
    const initialTimeout = setTimeout(() => {
      checkForNewMessages();
      // Poll every 90 seconds to reduce API load (increased from 30s)
      pollingInterval = setInterval(checkForNewMessages, 90000);
    }, 3000);

    return () => {
      clearTimeout(initialTimeout);
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
      if (autoDismissTimeoutRef.current) {
        clearTimeout(autoDismissTimeoutRef.current);
      }
    };
  }, [currentUser?.id]);

  const handleClick = () => {
    if (notification) {
      const conversationId = [currentUser.id, notification.sender_id].sort().join('_');
      onOpenConversation(conversationId, notification.sender_id, notification.sender_name);
      setNotification(null);
    }
  };

  const handleDismiss = (e) => {
    e.stopPropagation();
    setNotification(null);
    if (onDismiss) onDismiss();
  };

  return (
    <AnimatePresence>
      {notification && (
        <motion.div
          initial={{ opacity: 0, y: -20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.95 }}
          transition={{ duration: 0.2 }}
          onClick={handleClick}
          className="fixed top-4 right-4 z-[10002] max-w-sm w-full cursor-pointer"
        >
          <div 
            className="rounded-xl shadow-2xl overflow-hidden hover:shadow-xl transition-shadow"
            style={{ background: 'var(--bg-white)', border: '1px solid var(--border-slate-200)' }}
          >
            {/* Header */}
            <div className="bg-gradient-to-r from-blue-500 to-blue-600 px-4 py-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MessageCircle className="w-4 h-4 text-white" />
                <span className="text-white text-sm font-medium">New Message</span>
              </div>
              <button
                onClick={handleDismiss}
                className="p-1 hover:bg-white/20 rounded-full transition-colors"
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
                  <p className="font-semibold text-sm" style={{ color: 'var(--text-slate-900)' }}>
                    {notification.sender_name || 'Unknown'}
                  </p>
                  <p className="text-sm mt-1 line-clamp-2" style={{ color: 'var(--text-slate-600)' }}>
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
  );
}