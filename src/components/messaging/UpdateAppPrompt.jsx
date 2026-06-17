import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import {
  UPDATE_BROADCAST_PROMPT_POSITION,
  UPDATE_BROADCAST_PROMPT_THEME,
  sendSystemBroadcastAckIfNeeded,
} from './updateBroadcastConfig';

export default function UpdateAppPrompt({ message, onUpdate, onCancel, currentUser, messageId, conversationId }) {
  const [secondsLeft, setSecondsLeft] = useState(30);
  const isMobile = window.innerWidth < 768;
  const isTopStatsCardPosition = isMobile && UPDATE_BROADCAST_PROMPT_POSITION.mobile === 'top-stats-card';

  const sendDeviceUpdatedMessage = useCallback(async () => {
    await sendSystemBroadcastAckIfNeeded({ currentUser, messageId, conversationId });
  }, [currentUser, messageId, conversationId]);

  const handleUpdateClick = useCallback(async () => {
    await sendDeviceUpdatedMessage();
    await onUpdate?.();
  }, [sendDeviceUpdatedMessage, onUpdate]);

  useEffect(() => {
    setSecondsLeft(30);

    const intervalId = window.setInterval(() => {
      setSecondsLeft((current) => {
        if (current <= 1) {
          window.clearInterval(intervalId);
          handleUpdateClick();
          return 0;
        }
        return current - 1;
      });
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [handleUpdateClick]);

  return (
    <div className={`fixed inset-0 z-[10003] p-4 ${isTopStatsCardPosition ? 'pointer-events-none' : 'flex items-center justify-center bg-black/60'}`}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className={`w-full rounded-2xl shadow-2xl p-6 ${isTopStatsCardPosition ? 'pointer-events-auto mx-auto mt-24 max-w-[345px]' : 'max-w-md'}`}
        style={{
          background: UPDATE_BROADCAST_PROMPT_THEME.surface,
          border: `1px solid ${UPDATE_BROADCAST_PROMPT_THEME.border}`,
          color: UPDATE_BROADCAST_PROMPT_THEME.title
        }}
      >
        <div className="space-y-3">
          <p className="text-lg font-semibold" style={{ color: UPDATE_BROADCAST_PROMPT_THEME.title }}>
            App update available
          </p>
          <p className="text-sm leading-6" style={{ color: UPDATE_BROADCAST_PROMPT_THEME.body }}>
            {message}
          </p>
          <p className="text-xs" style={{ color: UPDATE_BROADCAST_PROMPT_THEME.meta }}>
            Auto-updating in {secondsLeft}s.
          </p>
        </div>

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleUpdateClick} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            Update ({secondsLeft})
          </Button>
        </div>
      </motion.div>
    </div>
  );
}