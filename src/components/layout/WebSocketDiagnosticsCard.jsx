import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { Card } from '@/components/ui/card';

export default function WebSocketDiagnosticsCard() {
  const [event, setEvent] = useState(null);
  const [isPrimaryDevice, setIsPrimaryDevice] = useState(true);
  const [topOffset, setTopOffset] = useState(72);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    // Check if this is the primary device
    const checkPrimaryDevice = async () => {
      try {
        const { isPrimaryTracker } = await import('@/components/utils/deviceManager');
        const isTracking = await isPrimaryTracker();
        setIsPrimaryDevice(isTracking);
      } catch (error) {
        console.log('⚠️ [WebSocketDiagnosticsCard] Failed to check primary device status:', error.message);
        setIsPrimaryDevice(true);
      }
    };

    checkPrimaryDevice();
  }, []);

  // Detect mobile device and calculate top offset
  useEffect(() => {
    const updateLayout = () => {
      const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      const isTabletPortrait = window.matchMedia('(max-width: 767px)').matches;
      setIsMobile(isMobileDevice || isTabletPortrait);

      const mobileHeader = document.querySelector('[data-mobile-header]');
      if (mobileHeader) {
        const headerHeight = mobileHeader.getBoundingClientRect().height;
        setTopOffset(headerHeight + 8); // Add 8px buffer
      } else {
        setTopOffset(72); // Default fallback
      }
    };

    updateLayout();
    
    // Update on resize/orientation change
    window.addEventListener('resize', updateLayout);
    window.addEventListener('orientationchange', updateLayout);
    
    return () => {
      window.removeEventListener('resize', updateLayout);
      window.removeEventListener('orientationchange', updateLayout);
    };
  }, []);

  useEffect(() => {
    if (isPrimaryDevice) return; // Only show on non-primary devices

    const handleWebSocketEvent = (e) => {
      const { data, type, id, updatedBy, changedFields } = e.detail || {};
      if (!data) return;
      
      // Extract entity name from event target
      const eventType = e.type; // e.g., 'realtimeUpdate_Delivery'
      const entityName = eventType.replace('realtimeUpdate_', '');
      
      // Determine what to display based on entity type
      let displayInfo = {
        source: 'WebSocket',
        entityType: entityName || 'Unknown',
        updatedBy: updatedBy || 'System',
        timestamp: Date.now()
      };

      // Handle AppUser updates
      if (entityName === 'AppUser') {
        displayInfo.title = data.user_name || data.full_name || 'User Update';
        displayInfo.details = changedFields?.length > 0 
          ? changedFields.join(', ') 
          : 'Status updated';
      } 
      // Handle Delivery updates
      else if (entityName === 'Delivery') {
        displayInfo.title = data.patient_name || data.patient?.full_name || 'Delivery Update';
        displayInfo.details = data.status ? `→ ${data.status}` : 'Updated';
      }
      // Handle Patient updates
      else if (entityName === 'Patient') {
        displayInfo.title = data.full_name || 'Patient Update';
        displayInfo.details = 'Patient information updated';
      }
      // Generic fallback
      else {
        displayInfo.title = data.name || data.patient_name || 'Update';
        displayInfo.details = data.status || 'Updated';
      }
      
      setEvent(displayInfo);

      // Auto-dismiss after 5 seconds
      const timeout = setTimeout(() => {
        setEvent(null);
      }, 5000);

      return () => clearTimeout(timeout);
    };

    // Listen to specific real-time update events
    window.addEventListener('realtimeUpdate_Delivery', handleWebSocketEvent);
    window.addEventListener('realtimeUpdate_Patient', handleWebSocketEvent);
    window.addEventListener('realtimeUpdate_AppUser', handleWebSocketEvent);
    
    return () => {
      window.removeEventListener('realtimeUpdate_Delivery', handleWebSocketEvent);
      window.removeEventListener('realtimeUpdate_Patient', handleWebSocketEvent);
      window.removeEventListener('realtimeUpdate_AppUser', handleWebSocketEvent);
    };
  }, [isPrimaryDevice]);

  if (!event || isPrimaryDevice) return null;

  return (
    <Card 
      className={`fixed ${isMobile ? 'left-1/2 -translate-x-1/2' : 'right-4'} w-80 p-3 bg-blue-50 border-blue-200 shadow-lg z-[9999] animate-in fade-in slide-in-from-top-2`}
      style={{ top: `${topOffset}px` }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <div className="text-xs font-semibold text-blue-900">
              {event.entityType}
            </div>
            <div className="text-[10px] text-blue-500 bg-blue-100 px-1.5 py-0.5 rounded">
              {event.updatedBy}
            </div>
          </div>
          <div className="text-xs text-blue-700">
            <div className="font-medium">{event.title}</div>
            <div className="text-xs text-blue-600 mt-1">{event.details}</div>
          </div>
        </div>
        <button
          onClick={() => setEvent(null)}
          className="text-blue-400 hover:text-blue-600 flex-shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </Card>
  );
}