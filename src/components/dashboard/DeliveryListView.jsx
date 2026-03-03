import { useState, useMemo, useCallback, memo } from 'react';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { CheckCircle, Clock, Package, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import StopDetailsPanel from '../deliveries/StopDetailsPanel';

// Memoized row component to prevent re-renders
const DeliveryRow = memo(({ 
  delivery, 
  patient, 
  store, 
  isSelected, 
  onSelect,
  getStatusBadge,
  getTimeDisplay,
  getCODDisplay,
  isMobile
}) => {
  const isPickup = !delivery.patient_id;
  const isNextDelivery = delivery.isNextDelivery === true;

  return (
    isMobile ? (
      <div
        onClick={() => onSelect(delivery.id)}
        className={`px-4 py-3 border-b cursor-pointer transition-colors ${
          isNextDelivery ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-slate-50'
        } ${isSelected ? 'bg-slate-100' : ''}`}
        style={{ borderColor: 'var(--border-slate-200)' }}
      >
        {/* Top row: Stop/TR + Status */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`font-mono text-sm ${isNextDelivery ? 'font-bold text-blue-700' : 'text-slate-700'}`}>#{delivery.display_stop_order || delivery.stop_order || '—'}</span>
            <span className="font-mono text-[11px] text-slate-500">{delivery.tracking_number || '—'}</span>
            <span className={`font-medium truncate ${isPickup ? 'text-blue-600 dark:text-blue-300' : 'text-slate-900 dark:text-slate-100'}`}>
              {delivery.patient_name || (store?.name ? `${store.name} Pickup` : 'Store Pickup')}
            </span>
          </div>
          <div className="flex flex-col items-end">
            <div className="flex flex-col items-center gap-1">
              <div className="flex items-center gap-2">
                {store?.abbreviation && (
                  <Badge variant="outline" className="rounded-full text-[11px] px-2 py-0.5" style={{ background: 'var(--bg-white)', color: (store.color || 'var(--text-slate-600)'), borderColor: (store.color || 'var(--border-slate-300)') }}>
                    {store.abbreviation}
                  </Badge>
                )}
                {getStatusBadge(delivery.status)}
              </div>
              <div className="text-xs text-slate-600 dark:text-slate-300 text-center w-full">
                {getTimeDisplay(delivery)}
              </div>
            </div>
          </div>
        </div>

        {/* Time moved under badges on right */}

        {/* Patient/Pickup */}
        <div className="mt-1 min-w-0">
          <div className="flex flex-col min-w-0">
            {patient?.address && (
              <span className="text-xs text-slate-500 truncate">{patient.address}</span>
            )}
          </div>
        </div>

        {/* Media + COD */}
        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {delivery.signature_image_url ? (
              <img src={delivery.signature_image_url} alt="Signature" className="w-7 h-7 rounded-sm object-cover border" style={{ borderColor: 'var(--border-slate-200)' }} />
            ) : (
              <span className="text-slate-400 text-sm">—</span>
            )}
            {Array.isArray(delivery.proof_photo_urls) && delivery.proof_photo_urls.length > 0 ? (
              <div className="flex -space-x-2">
                {delivery.proof_photo_urls.slice(0,2).map((url, i) => (
                  <img key={i} src={url} alt={`POD ${i+1}`} className="w-7 h-7 rounded-md object-cover ring-2 ring-white" />
                ))}
                {delivery.proof_photo_urls.length > 2 && (
                  <div className="w-7 h-7 rounded-md bg-slate-200 text-slate-700 text-[10px] flex items-center justify-center ring-2 ring-white">+{delivery.proof_photo_urls.length - 2}</div>
                )}
              </div>
            ) : (
              <span className="text-slate-400 text-sm">—</span>
            )}
          </div>
          <div>{getCODDisplay(delivery)}</div>
        </div>
      </div>
    ) : (
      <div
        onClick={() => onSelect(delivery.id)}
        className={`grid grid-cols-[140px_120px_130px_1fr_90px_110px_140px] gap-3 px-4 py-3 border-b cursor-pointer transition-colors ${
          isNextDelivery ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-slate-50'
        } ${isSelected ? 'bg-slate-100' : ''}`}
        style={{ borderColor: 'var(--border-slate-200)' }}
      >
        <div className="flex items-center justify-center">
          <div className="flex flex-col leading-tight">
            <span className={`font-mono text-sm ${isNextDelivery ? 'font-bold text-blue-700' : 'text-slate-700'}`}>#{delivery.display_stop_order || delivery.stop_order || '—'}</span>
            <span className="font-mono text-[11px] text-slate-500">{delivery.tracking_number || '—'}</span>
          </div>
        </div>

        <div className="flex items-center justify-center">
          <div className="flex items-center gap-2">
            {store?.abbreviation && (
              <Badge variant="outline" className="rounded-full text-[11px] px-2 py-0.5" style={{ background: 'var(--bg-white)', color: (store.color || 'var(--text-slate-600)'), borderColor: (store.color || 'var(--border-slate-300)') }}>
                {store.abbreviation}
              </Badge>
            )}
            {getStatusBadge(delivery.status)}
          </div>
        </div>

        <div className="flex items-center justify-center">
          {getTimeDisplay(delivery)}
        </div>

        <div className="flex items-center min-w-0">
          <div className="flex flex-col min-w-0">
            <span className={`font-medium truncate ${isPickup ? 'text-blue-600 dark:text-blue-300' : 'text-slate-900 dark:text-slate-100'}`}>
              {delivery.patient_name || (store?.name ? `${store.name} Pickup` : 'Store Pickup')}
            </span>
            {patient?.address && (
              <span className="text-xs text-slate-500 truncate">{patient.address}</span>
            )}
          </div>
        </div>

        <div className="flex items-center justify-center">
          {delivery.signature_image_url ? (
            <img src={delivery.signature_image_url} alt="Signature" className="w-8 h-8 rounded-sm object-cover border" style={{ borderColor: 'var(--border-slate-200)' }} />
          ) : (
            <span className="text-slate-400">—</span>
          )}
        </div>

        <div className="flex items-center justify-center">
          {Array.isArray(delivery.proof_photo_urls) && delivery.proof_photo_urls.length > 0 ? (
            <div className="flex -space-x-2">
              {delivery.proof_photo_urls.slice(0,3).map((url, i) => (
                <img key={i} src={url} alt={`POD ${i+1}`} className="w-8 h-8 rounded-md object-cover ring-2 ring-white" />
              ))}
              {delivery.proof_photo_urls.length > 3 && (
                <div className="w-8 h-8 rounded-md bg-slate-200 text-slate-700 text-[11px] flex items-center justify-center ring-2 ring-white">+{delivery.proof_photo_urls.length - 3}</div>
              )}
            </div>
          ) : (
            <span className="text-slate-400">—</span>
          )}
        </div>

        <div className="flex items-center justify-center">
          {getCODDisplay(delivery)}
        </div>
      </div>
    )
  );
});

DeliveryRow.displayName = 'DeliveryRow';

const DeliveryListView = ({
  deliveries,
  patients,
  stores,
  drivers,
  currentUser,
  onEditDelivery,
  onEditPatient,
  onDeleteDelivery,
  onRestart,
  onStatusUpdate,
  onNotesUpdate,
  onCODUpdate,
  onCreateReturn,
  onStartDelivery,
  allDeliveries,
  selectedDate,
  onDriverStatusChange,
  isMobile
}) => {
  const [selectedDeliveryId, setSelectedDeliveryId] = useState(null);

  // Memoize patient lookup map for O(1) access
  const patientMap = useMemo(() => {
    const map = new Map();
    patients.forEach(p => { if (p?.id) map.set(p.id, p); });
    return map;
  }, [patients]);

  // Memoize store lookup map for O(1) access
  const storeMap = useMemo(() => {
    const map = new Map();
    stores.forEach(s => { if (s?.id) map.set(s.id, s); });
    return map;
  }, [stores]);

  const getStatusBadge = useCallback((status) => {
    const statusConfig = {
      completed: { color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300', label: 'Completed' },
      in_transit: { color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300', label: 'In Transit' },
      en_route: { color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300', label: 'En Route' },
      pending: { color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300', label: 'Pending' },
      failed: { color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300', label: 'Failed' },
      cancelled: { color: 'bg-slate-100 text-slate-800 dark:bg-slate-800/60 dark:text-slate-200', label: 'Cancelled' }
    };
    const config = statusConfig[status] || { color: 'bg-slate-100 text-slate-800 dark:bg-slate-800/60 dark:text-slate-200', label: String(status || '') };
    return <Badge className={config.color}>{config.label}</Badge>;
  }, []);

  const getCODDisplay = useCallback((delivery) => {
    if (!delivery.cod_total_amount_required || delivery.cod_total_amount_required === 0) {
      return <span className="text-slate-400">—</span>;
    }

    const hasPayments = delivery.cod_payments && delivery.cod_payments.length > 0;
    const totalCollected = hasPayments 
      ? delivery.cod_payments.reduce((sum, p) => sum + (p.amount || 0), 0)
      : 0;

    if (hasPayments && totalCollected > 0) {
      const types = Array.from(new Set((delivery.cod_payments || []).map(p => p.type).filter(Boolean)));
      return (
        <div className="flex flex-col items-end">
          <span className="font-semibold text-green-700">${totalCollected.toFixed(2)}</span>
          <span className="text-xs text-green-600">{types.join(' + ')}</span>
        </div>
      );
    }

    return (
      <div className="flex flex-col">
        <span className="font-semibold text-amber-700">${delivery.cod_total_amount_required.toFixed(2)}</span>
        <span className="text-xs text-amber-600">Required</span>
      </div>
    );
  }, []);

  const getTimeDisplay = useCallback((delivery) => {
    const finishedStatuses = ['completed', 'failed', 'cancelled'];
    
    if (finishedStatuses.includes(delivery.status) && delivery.actual_delivery_time) {
      return (
        <div className="flex items-center gap-1 text-green-700">
          <CheckCircle className="w-3.5 h-3.5" />
          <span className="font-medium">{format(new Date(delivery.actual_delivery_time), 'HH:mm')}</span>
        </div>
      );
    }

    const eta = delivery.delivery_time_eta || delivery.delivery_time_start;
    if (eta) {
      return (
        <div className="flex items-center gap-1 text-blue-700">
          <Clock className="w-3.5 h-3.5" />
          <span className="font-medium">{eta}</span>
        </div>
      );
    }

    return <span className="text-slate-400">—</span>;
  }, []);

  const handleSelect = useCallback((deliveryId) => {
    setSelectedDeliveryId(prev => prev === deliveryId ? null : deliveryId);
  }, []);

  const selectedDelivery = useMemo(() => 
    selectedDeliveryId ? deliveries.find(d => d?.id === selectedDeliveryId) : null
  , [selectedDeliveryId, deliveries]);
  
  const selectedPatient = useMemo(() => 
    selectedDelivery?.patient_id ? patientMap.get(selectedDelivery.patient_id) : null
  , [selectedDelivery?.patient_id, patientMap]);
  
  const selectedStore = useMemo(() => 
    selectedDelivery ? storeMap.get(selectedDelivery.store_id) : null
  , [selectedDelivery?.store_id, storeMap]);

  return (
    <>
      <div className="h-full flex flex-col relative" style={{ background: 'var(--bg-white)' }}>
        {/* Table Header */}
        <div className="flex-shrink-0 border-b sticky top-0 z-10" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
          {!isMobile && (
            <div className="grid grid-cols-[140px_120px_130px_1fr_90px_110px_140px] gap-3 px-4 py-3 text-sm font-semibold" style={{ color: 'var(--text-slate-700)' }}>
              <div className="text-center">Stop/TR</div>
              <div className="text-center">Status</div>
              <div className="text-center">Time</div>
              <div className="text-left">Patient/Pickup</div>
              <div className="text-center">Signature</div>
              <div className="text-center">Photos</div>
              <div className="text-center">COD</div>
            </div>
          )}
        </div>

        {/* Scrollable List */}
        <div className="flex-1 overflow-y-auto">
        {deliveries.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-slate-500">
            No deliveries found
          </div>
        ) : (
          <>
            {deliveries.map((delivery, idx) => {
              if (!delivery) return null;

              const patient = delivery.patient_id ? patientMap.get(delivery.patient_id) : null;
              const store = storeMap.get(delivery.store_id);

              return (
                <DeliveryRow
                  key={delivery.id || `${delivery.delivery_date||'unknown'}-${delivery.patient_id ?? 'pickup'}-${delivery.store_id ?? 'store'}-${delivery.tracking_number || idx}` }
                  delivery={delivery}
                  patient={patient}
                  store={store}
                  isSelected={selectedDeliveryId === delivery.id}
                  onSelect={handleSelect}
                  getStatusBadge={getStatusBadge}
                  getTimeDisplay={getTimeDisplay}
                  getCODDisplay={getCODDisplay}
                  isMobile={isMobile}
                />
              );
            })}
          </>
        )}
        </div>
      </div>

      {/* Slide-in Details Panel Overlay */}
      <AnimatePresence>
        {selectedDeliveryId && selectedDelivery && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className={`${isMobile ? 'fixed' : 'absolute'} inset-0 bg-black/50 z-[200]`}
              onClick={() => setSelectedDeliveryId(null)}
            />
            {isMobile ? (
              <motion.div
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className="fixed bottom-0 left-0 right-0 z-[201] max-h-[78vh] overflow-hidden rounded-t-2xl"
                style={{ background: 'var(--bg-white)' }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="overflow-y-auto max-h-[78vh]">
                  <StopDetailsPanel
                  delivery={selectedDelivery}
                  patient={selectedPatient}
                  store={selectedStore}
                  currentUser={currentUser}
                  onEdit={onEditDelivery}
                  onEditPatient={onEditPatient}
                  onDelete={onDeleteDelivery}
                  onRestart={onRestart}
                  onStatusUpdate={onStatusUpdate}
                  onNotesUpdate={onNotesUpdate}
                  onCODUpdate={onCODUpdate}
                  onCreateReturn={onCreateReturn}
                  onStartDelivery={onStartDelivery}
                  allDeliveries={allDeliveries}
                  selectedDate={selectedDate}
                  patients={patients}
                  stores={stores}
                  drivers={drivers}
                  onDriverStatusChange={onDriverStatusChange}
                  onClose={() => setSelectedDeliveryId(null)}
                />
              </div>
            </motion.div>
            ) : (
              <motion.div
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className="absolute right-0 w-[560px] shadow-xl z-[201] overflow-hidden"
                style={{ background: 'var(--bg-white)', top: 'var(--driver-info-offset, 88px)', height: 'calc(100% - var(--driver-info-offset, 88px))' }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="h-full overflow-y-auto">
                  <StopDetailsPanel
                    delivery={selectedDelivery}
                    patient={selectedPatient}
                    store={selectedStore}
                    currentUser={currentUser}
                    onEdit={onEditDelivery}
                    onEditPatient={onEditPatient}
                    onDelete={onDeleteDelivery}
                    onRestart={onRestart}
                    onStatusUpdate={onStatusUpdate}
                    onNotesUpdate={onNotesUpdate}
                    onCODUpdate={onCODUpdate}
                    onCreateReturn={onCreateReturn}
                    onStartDelivery={onStartDelivery}
                    allDeliveries={allDeliveries}
                    selectedDate={selectedDate}
                    patients={patients}
                    stores={stores}
                    drivers={drivers}
                    onDriverStatusChange={onDriverStatusChange}
                    onClose={() => setSelectedDeliveryId(null)}
                  />
                </div>
              </motion.div>
            )}
          </>
        )}
      </AnimatePresence>
    </>
  );
};

export default memo(DeliveryListView);