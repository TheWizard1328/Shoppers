import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Bot, Sparkles } from 'lucide-react';

export default function AIAssistantFAB({ onClick, hasUnreadAlerts, hasVisibleCards = false }) {
  const [isPulsing, setIsPulsing] = useState(false);

  useEffect(() => {
    if (hasUnreadAlerts) {
      setIsPulsing(true);
      const timer = setTimeout(() => setIsPulsing(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [hasUnreadAlerts]);

  // Dynamic bottom position: above cards if they exist, otherwise near bottom edge
  const bottomPosition = hasVisibleCards ? 'bottom-[250px]' : 'bottom-[75px]';

  return (
    <motion.div
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 20 }}
      className={`fixed ${bottomPosition} right-4 z-[100]`}>
      
      <div className="relative">
        <Button
          onClick={onClick} 
          className="inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 text-primary-foreground hover:bg-primary/90 h-10 w-10 rounded-full shadow-2xl bg-gradient-to-br from-purple-500 to-blue-600 hover:from-purple-600 hover:to-blue-700 p-0 relative z-10">
          <Bot className="w-7 h-7 text-white" />
        </Button>

        {/* Pulse ring animation - FIXED: Added pointer-events-none */}
        {hasUnreadAlerts &&
          <div className="absolute inset-0 rounded-full bg-purple-500 opacity-75 animate-ping pointer-events-none"></div>
        }

        {/* Notification badge */}
        <AnimatePresence>
          {hasUnreadAlerts &&
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              className="absolute -top-1 -right-1 pointer-events-none z-20">
              <Badge className="h-6 w-6 rounded-full p-0 flex items-center justify-center bg-red-500 text-white border-2 border-white">
                <Sparkles className="w-3 h-3" />
              </Badge>
            </motion.div>
          }
        </AnimatePresence>
      </div>
    </motion.div>
  );
}