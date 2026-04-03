import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { isMobileDevice } from '@/components/utils/deviceUtils';
import { isAppOwner } from '@/components/utils/userRoles';
import { base44 } from '@/api/base44Client';

export default function WebSocketDiagnosticsCard() {
  const [event, setEvent] = useState(null);
  const [disableForMobileOwner, setDisableForMobileOwner] = useState(false);
  const [isPrimaryDevice, setIsPrimaryDevice] = useState(true);
  const [patientNameCache, setPatientNameCache] = useState({});
  const [storeNameCache, setStoreNameCache] = useState({});

  useEffect(() => {
    const checkDisableState = async () => {
      try {
        const user = await base44.auth.me();
        setDisableForMobileOwner(isMobileDevice() && isAppOwner(user));
      } catch (_) {
        setDisableForMobileOwner(false);
      }
    };

    checkDisableState();
  }, []);

  useEffect(() => {
    // Check if this is the primary device
    const checkPrimaryDevice = async () => {
      try {
        const user = await base44.auth.me();
        if (!user?.id) {
          setIsPrimaryDevice(true);
          return;
        }
        const { getCurrentDevice } = await import('@/components/utils/deviceManager');
        const device = await getCurrentDevice(user.id);
        const isPrimary = device === null || device?.status !== 'inactive' && device?.is_primary_tracker !== false;
        setIsPrimaryDevice(isPrimary);
      } catch (error) {
        console.log('⚠️ [WebSocketDiagnosticsCard] Failed to check primary device status:', error.message);
        setIsPrimaryDevice(true);
      }
    };

    checkPrimaryDevice();
  }, []);


  useEffect(() => {
    if (disableForMobileOwner) return;

    const resolvePatientName = async (patientId) => {
      if (!patientId || patientNameCache[patientId]) return patientNameCache[patientId] || null;
      const patient = await offlineDB.getById(offlineDB.STORES.PATIENTS, patientId);
      const resolvedName = patient?.full_name || null;
      if (resolvedName) {
        setPatientNameCache((prev) => ({ ...prev, [patientId]: resolvedName }));
      }
      return resolvedName;
    };

    const resolveStoreName = async (storeId) => {
      if (!storeId || storeNameCache[storeId]) return storeNameCache[storeId] || null;
      const store = await offlineDB.getById(offlineDB.STORES.STORES, storeId);
      const resolvedName = store?.name || null;
      if (resolvedName) {
        setStoreNameCache((prev) => ({ ...prev, [storeId]: resolvedName }));
      }
      return resolvedName;
    };

    const handleWebSocketEvent = async (e) => {
      const { data, type, id, updatedBy, changedFields } = e.detail || {};
      const actionType = type || 'update';
      const deletedName = e.detail?.deletedName || e.detail?.patientName || e.detail?.deliveryName || null;
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

      // Handle Delivery updates
      if (entityName === 'Delivery') {
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

        const deliveryName = data?.patient_name || data?.patient?.full_name || await resolvePatientName(data?.patient_id) || await resolveStoreName(data?.store_id) || deletedName || 'Unnamed delivery';
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
        const patientName = data?.full_name || deletedName || 'Unnamed patient';
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
    
    return () => {
      window.removeEventListener('realtimeUpdate_Delivery', handleWebSocketEvent);
      window.removeEventListener('realtimeUpdate_Patient', handleWebSocketEvent);
    };
  }, [disableForMobileOwner, isPrimaryDevice, patientNameCache, storeNameCache]);

  if (disableForMobileOwner || !event) return null;

  return (
    <Card 
      className="fixed top-3 right-4 w-80 p-3 bg-blue-50 border-blue-200 text-blue-950 shadow-lg z-[9999] animate-in fade-in slide-in-from-top-2 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <div className="text-xs font-semibold text-blue-900 dark:text-slate-100">
              {event.entityType}
            </div>
            <div className="text-[10px] text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded capitalize dark:bg-slate-800 dark:text-slate-200">
              {event.actionType}
            </div>
            <div className="text-[10px] text-blue-500 bg-blue-100 px-1.5 py-0.5 rounded dark:bg-slate-800 dark:text-slate-300">
              {event.updatedBy}
            </div>
          </div>
          <div className="text-xs text-blue-700 dark:text-slate-200">
            <div className="font-medium">{event.title}</div>
            <div className="text-xs text-blue-600 mt-1 dark:text-slate-300">{event.details}</div>
          </div>
        </div>
        <button
          onClick={() => setEvent(null)}
          className="text-blue-400 hover:text-blue-600 flex-shrink-0 dark:text-slate-400 dark:hover:text-slate-200"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </Card>
  );
}