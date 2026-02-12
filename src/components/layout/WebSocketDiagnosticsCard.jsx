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
        const { deviceManager } = await import('@/components/utils/deviceManager');
        const settings = await deviceManager.getUserSettings();
        const devices = settings?.device_settings_profiles || {};
        const currentDeviceId = deviceManager.getDeviceIdentifier();
        const currentDevice = devices[currentDeviceId];
        setIsPrimaryDevice(currentDevice?.is_primary_tracker !== true);
      } catch (error) {
        setIsPrimaryDevice(true);
      }
    };

    checkPrimaryDevice();
  }, []);

  useEffect(() => {
    if (isPrimaryDevice) return; // Don't show on primary device

    const handleDeliveryUpdate = (e) => {
      const { delivery, type, source } = e.detail;
      
      setEvent({
        type,
        patientName: delivery.patient_name || delivery.id,
        status: delivery.status,
        timestamp: Date.now()
      });

      // Auto-dismiss after 3 seconds
      const timeout = setTimeout(() => {
        setEvent(null);
      }, 3000);

      return () => clearTimeout(timeout);
    };

    window.addEventListener('deliveryUpdated', handleDeliveryUpdate);
    return () => window.removeEventListener('deliveryUpdated', handleDeliveryUpdate);
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