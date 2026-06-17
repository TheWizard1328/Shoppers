/**
 * Connection Quality Indicator
 * Shows green (good) / amber (fair) / red (poor) connection status
 * App Owner only
 */

import React, { useState, useEffect } from 'react';
import { connectionMonitor } from '../utils/connectionMonitor';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export default function ConnectionIndicator() {
  const [quality, setQuality] = useState('good');
  const [isOnline, setIsOnline] = useState(true);
  const [avgResponseTime, setAvgResponseTime] = useState(null);
  
  useEffect(() => {
    const unsubscribe = connectionMonitor.subscribe((status) => {
      setQuality(status.quality);
      setIsOnline(status.isOnline);
      setAvgResponseTime(status.avgResponseTime);
    });
    
    // Initial state
    const initial = connectionMonitor.getQuality();
    setQuality(initial.quality);
    setIsOnline(initial.isOnline);
    setAvgResponseTime(initial.avgResponseTime);
    
    return unsubscribe;
  }, []);
  
  const colorClass = !isOnline || quality === 'poor' 
    ? 'bg-red-500' 
    : quality === 'fair' 
      ? 'bg-amber-500' 
      : 'bg-green-500';
  
  const label = !isOnline 
    ? 'Offline' 
    : quality === 'poor' 
      ? 'Poor Connection' 
      : quality === 'fair' 
        ? 'Fair Connection' 
        : 'Good Connection';
  
  const tooltipText = !isOnline 
    ? 'No internet connection' 
    : avgResponseTime 
      ? `${label} (avg: ${avgResponseTime}ms)` 
      : label;
  
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full ${colorClass} animate-pulse`} />
          </div>
        </TooltipTrigger>
        <TooltipContent className="z-[9999]">
          <p className="text-xs">{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}