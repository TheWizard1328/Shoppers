import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, X, Loader2 } from 'lucide-react';

// Small inline "side-out" confirmation that appears next to the import button
// when the user clicks it. Replaces the native window.confirm() dialog.
// Two actions: Import (confirm) and Cancel.
const ImportConfirmInline = ({ show, stopOrder, onConfirm, onCancel, isImporting }) => {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, width: 0, x: -8 }}
          animate={{ opacity: 1, width: 'auto', x: 0 }}
          exit={{ opacity: 0, width: 0, x: -8 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="flex items-center gap-1.5 overflow-hidden flex-shrink-0"
        >
          <button
            title="Confirm import"
            onClick={(e) => { e.stopPropagation(); onConfirm(); }}
            disabled={isImporting}
            className="p-1.5 rounded bg-purple-600 hover:bg-purple-700 text-white disabled:opacity-50 transition-colors flex items-center justify-center"
          >
            {isImporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          </button>
          <button
            title="Cancel import"
            onClick={(e) => { e.stopPropagation(); onCancel(); }}
            disabled={isImporting}
            className="p-1.5 rounded bg-slate-200 hover:bg-slate-300 text-slate-700 dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-slate-200 disabled:opacity-50 transition-colors flex items-center justify-center"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default ImportConfirmInline;