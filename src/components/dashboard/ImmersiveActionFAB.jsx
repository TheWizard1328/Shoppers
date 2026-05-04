import React from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';

export default function ImmersiveActionFAB({ icon: Icon, title, onClick, disabled = false, bottom, right, opacity = 1, className = '' }) {
  return (
    <motion.div
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 20 }}
      className="z-[100]"
      style={{ position: 'absolute', bottom, right, pointerEvents: 'auto' }}
    >
      <Button
        onClick={onClick}
        disabled={disabled}
        title={title}
        className={`inline-flex items-center justify-center h-10 w-10 rounded-full shadow-2xl p-0 transition-all duration-200 !text-white ${className}`}
        style={{ pointerEvents: 'auto', touchAction: 'manipulation', opacity }}
      >
        <Icon className="w-5 h-5 text-white" />
      </Button>
    </motion.div>
  );
}