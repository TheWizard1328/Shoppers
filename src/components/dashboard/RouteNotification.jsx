import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MapPin, Navigation, AlertTriangle, CheckCircle, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function RouteNotification({ notification, onDismiss, onNavigate, isOptimizing = false }) {
  // Visual notifier globally disabled
  return null;
  const [isVisible, setIsVisible] = useState(false);
  
  useEffect(() => {
    // Don't show notifications while route optimization is in progress
    if (notification && !isOptimizing) {
      setIsVisible(true);
      
      // Auto-dismiss after 8 seconds
      const timer = setTimeout(() => {
        setIsVisible(false);
        setTimeout(() => onDismiss?.(), 300);
      }, 8000);
      
      return () => clearTimeout(timer);
    } else if (isOptimizing && isVisible) {
      // Hide notification immediately when optimization starts
      setIsVisible(false);
    }
  }, [notification, onDismiss, isOptimizing]);
  
  if (!notification) return null;
  
  const getIcon = () => {
    switch (notification.type) {
      case 'route_complete':
        return <CheckCircle className="w-5 h-5 text-emerald-500" />;
      case 'route_optimized':
        return <RefreshCw className="w-5 h-5 text-blue-500" />;
      case 'next_stop':
        return <Navigation className="w-5 h-5 text-blue-500" />;
      case 'route_updated':
        return <MapPin className="w-5 h-5 text-amber-500" />;
      default:
        return <MapPin className="w-5 h-5 text-slate-500" />;
    }
  };
  
  const getBgColor = () => {
    switch (notification.type) {
      case 'route_complete':
        return 'bg-emerald-50 border-emerald-200';
      case 'route_optimized':
      case 'next_stop':
        return 'bg-blue-50 border-blue-200';
      case 'route_updated':
        return 'bg-amber-50 border-amber-200';
      default:
        return 'bg-white border-slate-200';
    }
  };
  
  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, y: -50, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.95 }}
          className={`fixed top-4 left-1/2 -translate-x-1/2 z-[9999] max-w-md w-[calc(100%-2rem)] rounded-xl border shadow-lg ${getBgColor()}`}
        >
          <div className="p-4">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 mt-0.5">
                {getIcon()}
              </div>
              
              <div className="flex-1 min-w-0">
                <h4 className="font-semibold text-slate-900 text-sm">
                  {notification.title}
                </h4>
                <p className="text-sm text-slate-600 mt-0.5">
                  {notification.message}
                </p>
                
                {notification.aiSuggestion && (
                  <div className="mt-2 p-2 bg-white/50 rounded-lg border border-slate-200">
                    <p className="text-xs text-slate-600 flex items-start gap-1">
                      <span className="text-purple-500">💡</span>
                      {notification.aiSuggestion}
                    </p>
                  </div>
                )}
                
                {notification.alerts?.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {notification.alerts.map((alert, idx) => (
                      <div key={idx} className="flex items-center gap-1 text-xs text-amber-700">
                        <AlertTriangle className="w-3 h-3" />
                        {alert}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 flex-shrink-0"
                onClick={() => {
                  setIsVisible(false);
                  setTimeout(() => onDismiss?.(), 300);
                }}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
            
            {onNavigate && notification.type !== 'route_complete' && (
              <div className="mt-3 flex justify-end">
                <Button
                  size="sm"
                  className="bg-blue-600 hover:bg-blue-700 text-white"
                  onClick={() => {
                    onNavigate();
                    setIsVisible(false);
                    setTimeout(() => onDismiss?.(), 300);
                  }}
                >
                  <Navigation className="w-3 h-3 mr-1" />
                  Navigate to Next Stop
                </Button>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}