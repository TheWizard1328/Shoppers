import React from 'react';
import { Loader2 } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

/**
 * Global loading overlay that blocks all interactions during critical operations
 * Shows when operationInProgress is true to prevent race conditions
 */
export default function OperationLoadingOverlay({ isVisible }) {
  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center pointer-events-none"
          style={{ background: 'rgba(0, 0, 0, 0.15)' }}
        >
          <div className="bg-white rounded-full p-4 shadow-2xl border-2 border-emerald-500 pointer-events-none">
            <Loader2 className="w-8 h-8 text-emerald-600 animate-spin" />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}