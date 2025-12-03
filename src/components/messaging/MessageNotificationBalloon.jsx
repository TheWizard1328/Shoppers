import React, { useState, useEffect } from 'react';
import { X, MessageCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { base44 } from '@/api/base44Client';

export default function MessageNotificationBalloon({ currentUser, onOpenConversation, onDismiss }) {
  const [notification, setNotification] = useState(null);
  const [lastSeenMessageId, setLastSeenMessageId] = useState(null);

  useEffect(() => {
    if (!currentUser?.id) return;

    // Load last seen message ID from localStorage
    const storedLastSeen = localStorage.getItem(`lastSeenMessageId_${currentUser.id}`);
    if (storedLastSeen) {
      setLastSeenMessageId(storedLastSeen);
    }

    const checkForNewMessages = async () => {
      try {
        const unreadMessages = await base44.entities.Message.filter({
          receiver_id: currentUser.id,
          read: false
        }, '-created_date', 1);

        if (unreadMessages.length > 0) {
          const latestMessage = unreadMessages[0];
          
          // Only show notification if this is a new message we haven't seen
          if (latestMessage.id !== lastSeenMessageId) {
            setNotification(latestMessage);
            setLastSeenMessageId(latestMessage.id);
            localStorage.setItem(`lastSeenMessageId_${currentUser.id}`, latestMessage.id);
            
            // Auto-dismiss after 8 seconds
            setTimeout(() => {
              setNotification(null);
            }, 8000);
          }
        }
      } catch (error) {
        console.error('Error checking for new messages:', error);
      }
    };

    // Check immediately
    checkForNewMessages();

    // Poll every 10 seconds
    const interval = setInterval(checkForNewMessages, 10000);

    return () => clearInterval(interval);
  }, [currentUser?.id, lastSeenMessageId]);

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
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden hover:shadow-xl transition-shadow">
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
                  <p className="font-semibold text-slate-900 text-sm">
                    {notification.sender_name || 'Unknown'}
                  </p>
                  <p className="text-slate-600 text-sm mt-1 line-clamp-2">
                    {notification.content}
                  </p>
                </div>
              </div>
              
              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-slate-400">Tap to reply</span>
                <span className="text-xs text-blue-500 font-medium">View →</span>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}