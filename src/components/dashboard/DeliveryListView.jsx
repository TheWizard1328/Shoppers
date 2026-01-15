import React, { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { CheckCircle, Clock, Package, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import StopDetailsPanel from '../deliveries/StopDetailsPanel';

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
  onDriverStatusChange
}) => {
  const [selectedDeliveryId, setSelectedDeliveryId] = useState(null);

  const getStatusBadge = (status) => {
    const statusConfig = {
      'completed': { color: 'bg-green-100 text-green-800', label: 'Completed' },
      'in_transit': { color: 'bg-blue-100 text-blue-800', label: 'In Transit' },
      'en_route': { color: 'bg-blue-100 text-blue-800', label: 'En Route' },
      'pending': { color: 'bg-yellow-100 text-yellow-800', label: 'Pending' },
      'failed': { color: 'bg-red-100 text-red-800', label: 'Failed' },
      'cancelled': { color: 'bg-slate-100 text-slate-800', label: 'Cancelled' }
    };
    const config = statusConfig[status] || { color: 'bg-slate-100 text-slate-800', label: status };
    return <Badge className={config.color}>{config.label}</Badge>;
  };

  const getCODDisplay = (delivery) => {
    if (!delivery.cod_total_amount_required || delivery.cod_total_amount_required === 0) {
      return <span className="text-slate-400">—</span>;
    }

    const hasPayments = delivery.cod_payments && delivery.cod_payments.length > 0;
    const totalCollected = hasPayments 
      ? delivery.cod_payments.reduce((sum, p) => sum + (p.amount || 0), 0)
      : 0;

    if (hasPayments && totalCollected > 0) {
      return (
        <div className="flex flex-col">
          <span className="font-semibold text-green-700">${totalCollected.toFixed(2)}</span>
          <span className="text-xs text-green-600">Collected</span>
        </div>
      );
    }

    return (
      <div className="flex flex-col">
        <span className="font-semibold text-amber-700">${delivery.cod_total_amount_required.toFixed(2)}</span>
        <span className="text-xs text-amber-600">Required</span>
      </div>
    );
  };

  const getTimeDisplay = (delivery) => {
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
  };

  const selectedDelivery = selectedDeliveryId ? deliveries.find(d => d?.id === selectedDeliveryId) : null;

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-white)' }}>
      {/* Table Header */}
      <div className="flex-shrink-0 border-b sticky top-0 z-10" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
        <div className="grid grid-cols-[80px_100px_120px_130px_1fr_140px] gap-3 px-4 py-3 text-sm font-semibold" style={{ color: 'var(--text-slate-700)' }}>
          <div>Stop #</div>
          <div>TR#</div>
          <div>Status</div>
          <div>Time</div>
          <div>Patient/Pickup</div>
          <div className="text-right">COD</div>
        </div>
      </div>

      {/* Scrollable List */}
      <div className="flex-1 overflow-y-auto">
        {deliveries.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-slate-500">
            No deliveries found
          </div>
        ) : (
          <>
            {deliveries.map((delivery) => {
              if (!delivery) return null;

              const patient = delivery.patient_id ? patients.find(p => p?.id === delivery.patient_id) : null;
              const store = stores.find(s => s?.id === delivery.store_id);
              const isPickup = !delivery.patient_id;
              const isSelected = selectedDeliveryId === delivery.id;
              const isNextDelivery = delivery.isNextDelivery === true;

              return (
                <React.Fragment key={delivery.id}>
                  <div
                    onClick={() => setSelectedDeliveryId(isSelected ? null : delivery.id)}
                    className={`grid grid-cols-[80px_100px_120px_130px_1fr_140px] gap-3 px-4 py-3 border-b cursor-pointer transition-colors ${
                      isNextDelivery ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-slate-50'
                    } ${isSelected ? 'bg-slate-100' : ''}`}
                    style={{ borderColor: 'var(--border-slate-200)' }}
                  >
                    <div className="flex items-center">
                      <span className={`font-mono text-sm ${isNextDelivery ? 'font-bold text-blue-700' : 'text-slate-700'}`}>
                        #{delivery.display_stop_order || delivery.stop_order || '—'}
                      </span>
                    </div>

                    <div className="flex items-center">
                      <span className="font-mono text-sm text-slate-600">{delivery.tracking_number || '—'}</span>
                    </div>

                    <div className="flex items-center">
                      {getStatusBadge(delivery.status)}
                    </div>

                    <div className="flex items-center">
                      {getTimeDisplay(delivery)}
                    </div>

                    <div className="flex items-center min-w-0">
                      <div className="flex flex-col min-w-0">
                        <span className={`font-medium truncate ${isPickup ? 'text-blue-600' : 'text-slate-900'}`}>
                          {delivery.patient_name || (store?.name ? `${store.name} Pickup` : 'Store Pickup')}
                        </span>
                        {patient?.address && (
                          <span className="text-xs text-slate-500 truncate">{patient.address}</span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center justify-end">
                      {getCODDisplay(delivery)}
                    </div>
                  </div>

                  {/* Expanded Details Panel */}
                  <AnimatePresence>
                    {isSelected && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden border-b-2"
                        style={{ borderColor: 'var(--border-slate-300)', background: 'var(--bg-slate-50)' }}
                      >
                        <div className="p-4">
                          <StopDetailsPanel
                            delivery={delivery}
                            patient={patient}
                            store={store}
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
                          />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </React.Fragment>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
};

export default DeliveryListView;