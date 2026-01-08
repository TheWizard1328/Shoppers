import React, { useState, useEffect } from 'react';
import { WifiOff, RefreshCw, CheckCircle, AlertTriangle, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { smartRefreshManager } from '../utils/smartRefreshManager';

/**
 * Banner that appears when connection issues are detected
 * Shows recovery status and allows manual retry
 */
export default function ConnectionRecoveryBanner() {
  const [isVisible, setIsVisible] = useState(false);
  const [status, setStatus] = useState('error'); // 'error', 'recovering', 'restored'
  const [errorCount, setErrorCount] = useState(0);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [maxAttempts, setMaxAttempts] = useState(5);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Listen for connection errors
    const handleConnectionError = (event) => {
      const { errorCount: count, willRetryIn } = event.detail || {};
      setErrorCount(count || 0);
      setStatus('error');
      setIsVisible(true);
      setDismissed(false);
    };

    // Listen for recovery attempts
    const handleRecoveryAttempt = (event) => {
      const { attempt, maxAttempts: max } = event.detail || {};
      setRecoveryAttempt(attempt || 0);
      setMaxAttempts(max || 5);
      setStatus('recovering');
      setIsVisible(true);
    };

    // Listen for connection restored
    const handleConnectionRestored = () => {
      setStatus('restored');
      // Auto-hide after 3 seconds when restored
      setTimeout(() => {
        setIsVisible(false);
      }, 3000);
    };

    // Listen for browser online/offline events
    const handleOnline = () => {
      setIsOnline(true);
      // Trigger manual recovery when browser comes back online
      smartRefreshManager.triggerManualRecovery();
    };

    const handleOffline = () => {
      setIsOnline(false);
      setStatus('error');
      setIsVisible(true);
      setDismissed(false);
    };

    window.addEventListener('connectionError', handleConnectionError);
    window.addEventListener('recoveryAttempt', handleRecoveryAttempt);
    window.addEventListener('connectionRestored', handleConnectionRestored);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Check initial online status
    if (!navigator.onLine) {
      setIsOnline(false);
      setStatus('error');
      setIsVisible(true);
    }

    return () => {
      window.removeEventListener('connectionError', handleConnectionError);
      window.removeEventListener('recoveryAttempt', handleRecoveryAttempt);
      window.removeEventListener('connectionRestored', handleConnectionRestored);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleRetry = () => {
    setStatus('recovering');
    smartRefreshManager.triggerManualRecovery();
  };

  const handleDismiss = () => {
    setDismissed(true);
    setIsVisible(false);
  };

  // Don't show if dismissed or not visible
  if (!isVisible || dismissed) return null;

  const getStatusConfig = () => {
    if (!isOnline) {
      return {
        icon: WifiOff,
        bgColor: 'bg-red-500',
        textColor: 'text-white',
        message: 'You are offline. Data will sync when connection is restored.',
        showRetry: false
      };
    }

    switch (status) {
      case 'error':
        return {
          icon: AlertTriangle,
          bgColor: 'bg-amber-500',
          textColor: 'text-white',
          message: `Connection issues detected (${errorCount} errors). Attempting to reconnect...`,
          showRetry: true
        };
      case 'recovering':
        return {
          icon: RefreshCw,
          bgColor: 'bg-blue-500',
          textColor: 'text-white',
          message: `Reconnecting... (attempt ${recoveryAttempt}/${maxAttempts})`,
          showRetry: false,
          iconSpin: true
        };
      case 'restored':
        return {
          icon: CheckCircle,
          bgColor: 'bg-green-500',
          textColor: 'text-white',
          message: 'Connection restored! Data is being refreshed.',
          showRetry: false
        };
      default:
        return {
          icon: AlertTriangle,
          bgColor: 'bg-amber-500',
          textColor: 'text-white',
          message: 'Connection issues detected.',
          showRetry: true
        };
    }
  };

  const config = getStatusConfig();
  const Icon = config.icon;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -50 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -50 }}
        transition={{ duration: 0.3 }}
        className={`fixed top-0 left-0 right-0 z-[10002] ${config.bgColor} ${config.textColor} px-4 py-2 shadow-lg`}
      >
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Icon 
              className={`w-5 h-5 flex-shrink-0 ${config.iconSpin ? 'animate-spin' : ''}`} 
            />
            <span className="text-sm font-medium">{config.message}</span>
          </div>
          
          <div className="flex items-center gap-2">
            {config.showRetry && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleRetry}
                className="h-7 px-3 bg-white/20 border-white/30 text-white hover:bg-white/30"
              >
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                Retry Now
              </Button>
            )}
            
            {status !== 'recovering' && (
              <button
                onClick={handleDismiss}
                className="p-1 hover:bg-white/20 rounded transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}