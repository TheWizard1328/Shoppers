import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { X, Bell } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { initPushNotifications } from '@/components/utils/pushNotifications';
import { isNativePushAvailable, checkNativePushPermission } from '@/components/utils/nativePushNotifications';

const STORAGE_KEY = 'push_prompt_dismissed';

export default function PushNotificationPrompt({ userId }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!userId) return;

    const checkPermission = async () => {
      if (typeof Notification === 'undefined' && !isNativePushAvailable()) return;
      const perm = isNativePushAvailable()
        ? await checkNativePushPermission()
        : (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
      if (perm !== 'prompt') return; // already granted, denied, or unsupported
      if (localStorage.getItem(STORAGE_KEY) === 'true') return;

      // Show after a short delay so it doesn't compete with the loading screen
      const timer = setTimeout(() => setShow(true), 3000);
      return () => clearTimeout(timer);
    };
    checkPermission();
  }, [userId]);

  const handleAllow = async () => {
    setShow(false);
    await initPushNotifications(userId);
  };

  const handleDismiss = () => {
    setShow(false);
    localStorage.setItem(STORAGE_KEY, 'true');
  };

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: 'spring', damping: 20, stiffness: 300 }}
          className="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)] left-4 right-4 md:left-auto md:right-6 md:bottom-6 md:w-96 z-[10001]"
        >
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 p-5">
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center flex-shrink-0">
                <Bell className="w-6 h-6 text-emerald-600" />
              </div>

              <div className="flex-1 min-w-0">
                <h4 className="font-semibold text-slate-900 dark:text-slate-100 mb-1">Enable Notifications</h4>
                <p className="text-sm text-slate-500 dark:text-slate-400 dark:text-slate-500 mb-4">
                  Get instant alerts for new chat messages and delivery updates — even when the app is closed.
                </p>

                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={handleAllow}
                    className="bg-emerald-600 hover:bg-emerald-700 flex-1 text-white"
                  >
                    Allow Notifications
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleDismiss}
                  >
                    Not Now
                  </Button>
                </div>
              </div>

              <button
                onClick={handleDismiss}
                className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:text-slate-400 dark:text-slate-500 dark:hover:text-slate-300 flex-shrink-0 mt-0.5"
                aria-label="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}