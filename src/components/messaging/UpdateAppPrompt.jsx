import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';

export default function UpdateAppPrompt({ message, onUpdate, onCancel }) {
  const [secondsLeft, setSecondsLeft] = useState(30);

  useEffect(() => {
    setSecondsLeft(30);

    const intervalId = window.setInterval(() => {
      setSecondsLeft((current) => {
        if (current <= 1) {
          window.clearInterval(intervalId);
          onUpdate();
          return 0;
        }
        return current - 1;
      });
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [onUpdate]);

  return (
    <div className="fixed inset-0 z-[10003] flex items-center justify-center bg-black/60 p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="w-full max-w-md rounded-2xl shadow-2xl p-6"
        style={{ background: 'var(--bg-white)', border: '1px solid var(--border-slate-200)' }}
      >
        <div className="space-y-3">
          <p className="text-lg font-semibold" style={{ color: 'var(--text-slate-900)' }}>
            App update available
          </p>
          <p className="text-sm leading-6" style={{ color: 'var(--text-slate-600)' }}>
            {message}
          </p>
          <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
            Auto-updating in {secondsLeft}s.
          </p>
        </div>

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onUpdate} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            Update ({secondsLeft})
          </Button>
        </div>
      </motion.div>
    </div>
  );
}