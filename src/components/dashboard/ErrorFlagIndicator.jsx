/**
 * Error Flag Indicator
 * Shows red/yellow/green flag based on recent errors
 * Red: Rate limit in last 5 seconds
 * Yellow: Minor errors in last 5 seconds
 * Green: No errors
 * App Owner only
 */

import React, { useState, useEffect } from 'react';
import { Flag, FlagTriangleRight } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export default function ErrorFlagIndicator() {
  const [flagStatus, setFlagStatus] = useState('green'); // green, yellow, red, sync
  const [lastError, setLastError] = useState(null);
  const [lastErrorTime, setLastErrorTime] = useState(null);
  const [isDeliveryPatientSyncing, setIsDeliveryPatientSyncing] = useState(false);
  
  useEffect(() => {
    // Listen for rate limit errors
    const handleRateLimit = (event) => {
      const hasError = event.detail?.hasError ?? true;
      if (hasError) {
        setFlagStatus('red');
        setLastError('Rate limit hit');
        setLastErrorTime(Date.now());
        console.log('🚩 [ErrorFlag] Rate limit detected - RED FLAG');
      }
    };
    
    // Listen for connection errors
    const handleConnectionError = (event) => {
      const { isRateLimit, errorCount } = event.detail || {};
      if (isRateLimit) {
        setFlagStatus('red');
        setLastError('Rate limit error');
        setLastErrorTime(Date.now());
        console.log('🚩 [ErrorFlag] Rate limit error - RED FLAG');
      } else {
        setFlagStatus('yellow');
        setLastError(`Connection error (${errorCount})`);
        setLastErrorTime(Date.now());
        console.log('🚩 [ErrorFlag] Connection error - YELLOW FLAG');
      }
    };
    
    // Listen for successful calls (recovery)
    const handleConnectionRestored = () => {
      setFlagStatus('green');
      setLastError(null);
      setLastErrorTime(null);
      console.log('🚩 [ErrorFlag] Connection restored - GREEN FLAG');
    };
    
    const handleSyncStatus = (event) => {
      const detail = event.detail || {};
      const entity = detail.entity;
      const status = detail.status;
      const isRelevantSync = entity === 'Deliveries' || entity === 'Patients' || entity === 'deliveries' || entity === 'patients' || detail.phase === 'deliveries' || detail.phase === 'patients';

      if (!isRelevantSync) return;

      if (status === 'syncing' || status === 'force_syncing' || status === 'background_syncing' || status === 'priority_sync') {
        setIsDeliveryPatientSyncing(true);
      }

      if (status === 'complete' || status === 'synced' || status === 'error') {
        setIsDeliveryPatientSyncing(false);
      }
    };

    const handleOfflineSyncComplete = () => {
      setIsDeliveryPatientSyncing(false);
    };

    // Auto-clear flag after 5 seconds
    const interval = setInterval(() => {
      if (lastErrorTime && (Date.now() - lastErrorTime > 5000)) {
        setFlagStatus('green');
        setLastError(null);
        setLastErrorTime(null);
        console.log('🚩 [ErrorFlag] Auto-cleared to GREEN after 5s');
      }
    }, 1000);
    
    window.addEventListener('rateLimitDetected', handleRateLimit);
    window.addEventListener('connectionError', handleConnectionError);
    window.addEventListener('connectionRestored', handleConnectionRestored);
    window.addEventListener('periodicSyncProgress', handleSyncStatus);
    window.addEventListener('offlineSyncComplete', handleOfflineSyncComplete);
    
    return () => {
      clearInterval(interval);
      window.removeEventListener('rateLimitDetected', handleRateLimit);
      window.removeEventListener('connectionError', handleConnectionError);
      window.removeEventListener('connectionRestored', handleConnectionRestored);
      window.removeEventListener('periodicSyncProgress', handleSyncStatus);
      window.removeEventListener('offlineSyncComplete', handleOfflineSyncComplete);
    };
  }, [lastErrorTime]);
  
  const colorClass = isDeliveryPatientSyncing
    ? 'text-blue-500'
    : flagStatus === 'red' 
      ? 'text-red-500' 
      : flagStatus === 'yellow' 
        ? 'text-yellow-500' 
        : 'text-green-500';
  
  const tooltipText = isDeliveryPatientSyncing
    ? 'Delivery and patient sync in progress'
    : flagStatus === 'red' 
      ? `Rate Limit Hit (${lastError || 'Unknown'})` 
      : flagStatus === 'yellow' 
        ? `Minor Error (${lastError || 'Unknown'})` 
        : 'All Systems Normal';
  
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center">
            {isDeliveryPatientSyncing ? (
              <FlagTriangleRight className={`w-3.5 h-3.5 ${colorClass} fill-current`} />
            ) : (
              <Flag className={`w-3.5 h-3.5 ${colorClass}`} />
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent className="z-[9999]">
          <p className="text-xs">{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}