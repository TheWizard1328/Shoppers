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
      const isMobileView = isMobileDevice || isTabletPortrait;
      setIsMobile(isMobileView);

      const mobileHeader = document.querySelector('[data-mobile-header]');
      if (mobileHeader) {
        const headerHeight = mobileHeader.getBoundingClientRect().height;
        // On mobile: position lower to align with stats card (headerHeight + 180px)
        // On desktop: just below header
        setTopOffset(isMobileView ? headerHeight + 180 : headerHeight + 8);
      } else {
        setTopOffset(isMobileView ? 240 : 72); // Default fallback
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
    const handleWebSocketEvent = (e) => {
      const { data, type, id, updatedBy, changedFields } = e.detail || {};
      const actionType = type || 'update';
      if (!data && actionType !== 'delete') return;
      
      // Extract entity name from event target
      const eventType = e.type; // e.g., 'realtimeUpdate_Delivery'
      const entityName = eventType.replace('realtimeUpdate_', '');
      
      // Determine what to display based on entity type
      let displayInfo = {
        source: 'WebSocket',
        entityType: entityName || 'Unknown',
        updatedBy: updatedBy || 'System',
        actionType,
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
        const meaningfulFields = (changedFields || []).filter((field) => ![
          'proof_photo_urls',
          'cod_payments',
          'receipt_barcode_values',
          'barcode_values',
          'updated_date'
        ].includes(field));

        const fieldLabels = {
          delivery_time_end: 'delivery end time',
          delivery_time_start: 'delivery start time',
          delivery_time_eta: 'ETA',
          status: 'status',
          driver_id: 'driver',
          driver_name: 'driver',
          stop_order: 'stop order',
          delivery_notes: 'delivery notes',
          delivery_instructions: 'delivery instructions',
          tracking_number: 'tracking number',
          actual_delivery_time: 'actual delivery time',
          arrival_time: 'arrival time'
        };

        const changedLabel = meaningfulFields.length > 0
          ? meaningfulFields.map((field) => fieldLabels[field] || field.replace(/_/g, ' ')).join(', ')
          : null;

        const deliveryName = data?.patient_name || data?.patient?.full_name || data?.delivery_id || `Delivery ${id || ''}`.trim();
        displayInfo.title = deliveryName;
        displayInfo.details = actionType === 'create'
          ? 'Delivery added'
          : actionType === 'delete'
            ? 'Delivery deleted'
            : changedLabel
              ? `Updated: ${changedLabel}`
              : 'Delivery updated';
      }
      // Handle Patient updates
      else if (entityName === 'Patient') {
        const patientName = data?.full_name || `Patient ${id || ''}`.trim();
        displayInfo.title = patientName;
        displayInfo.details = actionType === 'create'
          ? 'Patient added'
          : actionType === 'delete'
            ? 'Patient deleted'
            : changedFields?.length > 0
              ? `Updated: ${changedFields.join(', ')}`
              : 'Patient information updated';
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

  if (!event) return null;

  return (
    <Card 
      className={`fixed ${isMobile ? 'left-1/2 -translate-x-1/2' : 'right-4'} w-80 p-3 bg-blue-50 border-blue-200 shadow-lg z-[9999] animate-in fade-in slide-in-from-top-2`}
      style={{ top: `${topOffset}px` }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <div className="text-xs font-semibold text-blue-900">
              {event.entityType}
            </div>
            <div className="text-[10px] text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded capitalize">
              {event.actionType}
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