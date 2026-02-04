import React, { useState, useEffect } from 'react';
import { Flag } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export default function StatusFlagIndicator() {
  const [status, setStatus] = useState('good'); // 'good', 'warning', 'error'
  const [lastEventTime, setLastEventTime] = useState(null);
  const [lastEventType, setLastEventType] = useState(null);

  useEffect(() => {
    // Listen for rate limit events
    const handleRateLimit = (hasError) => {
      if (hasError) {
        setStatus('error');
        setLastEventTime(Date.now());
        setLastEventType('Rate Limit');
      } else {
        setStatus('good');
        setLastEventTime(Date.now());
        setLastEventType('Good');
      }
    };

    // Listen for periodic sync events
    const handlePeriodicSync = (event) => {
      const { entity, isComplete } = event.detail;
      if (isComplete) {
        setStatus('good');
        setLastEventTime(Date.now());
        setLastEventType('Synced');
      }
    };

    // Listen for connection errors
    const handleConnectionError = (event) => {
      const { isRateLimit } = event.detail || {};
      if (isRateLimit) {
        setStatus('error');
        setLastEventTime(Date.now());
        setLastEventType('Rate Limit');
      } else {
        setStatus('warning');
        setLastEventTime(Date.now());
        setLastEventType('Connection Error');
      }
    };

    // Listen for connection restored
    const handleConnectionRestored = () => {
      setStatus('good');
      setLastEventTime(Date.now());
      setLastEventType('Restored');
    };

    // CRITICAL: Listen to smartRefreshManager via window events
    if (window._setRateLimitError) {
      const originalFn = window._setRateLimitError;
      window._setRateLimitError = (hasError) => {
        originalFn(hasError);
        handleRateLimit(hasError);
      };
    }

    window.addEventListener('periodicSyncProgress', handlePeriodicSync);
    window.addEventListener('connectionError', handleConnectionError);
    window.addEventListener('connectionRestored', handleConnectionRestored);

    // Auto-clear status after 5 seconds of inactivity
    const interval = setInterval(() => {
      if (lastEventTime && Date.now() - lastEventTime > 5000) {
        setStatus('good');
        setLastEventType(null);
      }
    }, 1000);

    return () => {
      window.removeEventListener('periodicSyncProgress', handlePeriodicSync);
      window.removeEventListener('connectionError', handleConnectionError);
      window.removeEventListener('connectionRestored', handleConnectionRestored);
      clearInterval(interval);
    };
  }, [lastEventTime]);

  const getFlagColor = () => {
    switch (status) {
      case 'error':
        return 'text-red-500';
      case 'warning':
        return 'text-yellow-500';
      case 'good':
      default:
        return 'text-green-500';
    }
  };

  const getTooltipText = () => {
    if (status === 'error') return '⚠️ Rate limit detected';
    if (status === 'warning') return '⚠️ Minor connection issues';
    return '✅ All systems operational';
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center">
            <Flag className={`w-3.5 h-3.5 ${getFlagColor()} transition-colors duration-300`} />
          </div>
        </TooltipTrigger>
        <TooltipContent className="z-[9999]">
          <p>{getTooltipText()}</p>
          {lastEventType && (
            <p className="text-xs text-slate-500 mt-1">Last: {lastEventType}</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}