import React, { useState, useEffect } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

/**
 * Lightweight toast that appears when offline DB reconciliation updates data.
 * Fires on the custom 'offlineDBReconciled' event and auto-dismisses after 5s.
 */
export default function ReconcileToast() {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    const handler = (e) => {
      const { entity, date, count } = e.detail || {};
      const label = entity === 'Delivery'
        ? `${count} deliveries synced${date ? ` for ${date}` : ''}`
        : entity === 'AppUser'
        ? `${count} drivers refreshed`
        : `${entity} data refreshed`;

      const id = Date.now();
      setToasts(prev => [...prev, { id, label }]);

      // Auto-dismiss after 5 seconds
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, 5000);
    };

    window.addEventListener('offlineDBReconciled', handler);
    return () => window.removeEventListener('offlineDBReconciled', handler);
  }, []);

  const dismiss = (id) => setToasts(prev => prev.filter(t => t.id !== id));

  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[99999] flex flex-col gap-2 pointer-events-none">
      <AnimatePresence>
        {toasts.map(t => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-full shadow-lg text-white text-sm font-medium"
            style={{ background: 'rgba(30, 64, 175, 0.92)', backdropFilter: 'blur(6px)' }}
          >
            <RefreshCw className="w-4 h-4 animate-spin" />
            <span>{t.label}</span>
            <button onClick={() => dismiss(t.id)} className="ml-1 opacity-70 hover:opacity-100">
              <X className="w-3.5 h-3.5" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}