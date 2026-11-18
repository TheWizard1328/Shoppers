import React, { useCallback, useEffect, useRef, useState } from 'react';
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

  // Keep the latest handler in a ref so the countdown interval below does NOT
  // depend on the callback's identity. A direct dep on handleUpdateClick caused
  // the effect to re-run (and reset the timer to 30) every time any of its
  // inputs (currentUser, messageId, conversationId, onUpdate) changed identity
  // between renders — which made the countdown loop endlessly.
  const handleUpdateClickRef = useRef(handleUpdateClick);
  useEffect(() => {
    handleUpdateClickRef.current = handleUpdateClick;
  }, [handleUpdateClick]);

  // OWNER REPORT Nov 17 2026: the 30s auto-update never fired on backgrounded or
  // minimized web views / PWAs. A setInterval countdown is throttled or frozen
  // by the browser while the page is hidden, so it only "ticked" after the user
  // came back. The deadline is now an absolute wall-clock time: every tick (and
  // every visibility/focus/pageshow event) recomputes remaining = deadline - now,
  // so the instant the app is foregrounded past the deadline it updates at once.
  const deadlineRef = useRef(Date.now() + 30000);
  const firedRef = useRef(false);

  useEffect(() => {
    deadlineRef.current = Date.now() + 30000;
    firedRef.current = false;
    setSecondsLeft(30);

    const check = () => {
      const remaining = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining <= 0 && !firedRef.current) {
        firedRef.current = true;
        window.clearInterval(intervalId);
        handleUpdateClickRef.current?.();
      }
    };

    const intervalId = window.setInterval(check, 1000);
    const onResume = () => { if (!document.hidden) check(); };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('focus', onResume);
    window.addEventListener('pageshow', onResume);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('focus', onResume);
      window.removeEventListener('pageshow', onResume);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`fixed inset-0 z-[70000] p-4 ${isTopStatsCardPosition ? 'pointer-events-none' : 'flex items-center justify-center bg-black/60'}`}>
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