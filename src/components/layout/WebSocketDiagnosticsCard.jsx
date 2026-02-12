import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { Card } from '@/components/ui/card';

export default function WebSocketDiagnosticsCard() {
  const [event, setEvent] = useState(null);
  const [isPrimaryDevice, setIsPrimaryDevice] = useState(true);

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

  useEffect(() => {
    if (isPrimaryDevice) return; // Only show on non-primary devices

    const handleWebSocketEvent = (e) => {
      const { data } = e.detail || {};
      if (!data) return;
      
      setEvent({
        source: 'WebSocket',
        patientName: data.patient_name || data.name || 'Update',
        status: data.status,
        timestamp: Date.now()
      });

      // Auto-dismiss after 3 seconds
      const timeout = setTimeout(() => {
        setEvent(null);
      }, 3000);

      return () => clearTimeout(timeout);
    };

    window.addEventListener('deliveryUpdated', handleWebSocketEvent);
    window.addEventListener('driverLocationsUpdated', handleWebSocketEvent);
    
    return () => {
      window.removeEventListener('deliveryUpdated', handleWebSocketEvent);
      window.removeEventListener('driverLocationsUpdated', handleWebSocketEvent);
    };
  }, [isPrimaryDevice]);

  if (!event || isPrimaryDevice) return null;

  return (
    <Card className="fixed top-4 right-4 w-72 p-3 bg-blue-50 border-blue-200 shadow-lg z-50 animate-in fade-in slide-in-from-top-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="text-xs font-semibold text-blue-900">WebSocket Event</div>
          <div className="text-xs text-blue-700 mt-1">
            <div><span className="font-mono">{event.type}</span></div>
            <div className="text-xs text-blue-600 mt-1">{event.patientName}</div>
            <div className="text-xs text-blue-600">→ {event.status}</div>
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