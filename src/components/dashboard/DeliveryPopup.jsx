import React from 'react';
import { Home, Package, Clock, Truck } from 'lucide-react';
import { format } from 'date-fns';
import SpecialSymbolsBadges from '../utils/SpecialSymbolsBadges';

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

export default function DeliveryPopup({ delivery, isPickup = false, stores, patients, users }) {
  const store = stores.find(s => s && s.id === delivery.store_id);
  const patient = !isPickup ? patients.find(p => p && p.id === delivery.patient_id) : null;
  const driver = users.find(u => u && u.id === delivery.driver_id);

  const getStatusColor = (status) => {
    const statusColors = {
      'pending': 'text-slate-600 bg-slate-100',
      'Ready For Pickup': 'text-amber-700 bg-amber-100',
      'in_transit': 'text-blue-700 bg-blue-100',
      'completed': 'text-emerald-700 bg-emerald-100',
      'failed': 'text-red-700 bg-red-100',
      'cancelled': 'text-red-700 bg-red-100',
      'returned': 'text-orange-700 bg-orange-100'
    };
    return statusColors[status] || 'text-slate-600 bg-slate-100';
  };

  return (
    <div className="min-w-[220px] max-w-[300px]" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5">
          {isPickup ? <Home className="w-4 h-4 text-emerald-600" /> : <Package className="w-4 h-4 text-blue-600" />}
          <h3 className="font-semibold text-sm">
            {isPickup ? store?.name : `Stop #${delivery.number || delivery.stop_order || '?'}`}
            {delivery.isFirstTime && <span className="ml-1 text-yellow-600">⭐</span>}
          </h3>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${getStatusColor(delivery.status)}`}>
          {delivery.status}
        </span>
      </div>

      <div className="space-y-1.5">
        {isPickup ? (
          <p className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
            {store?.address}
          </p>
        ) : (
          <button
            onClick={() => {
              const destination = `${patient?.address}${delivery.unit_number ? ' #' + delivery.unit_number : ''}`;
              const url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
              window.open(url, '_blank');
            }}
            className="text-sm font-semibold text-blue-600 hover:text-blue-700 underline transition-colors text-left"
          >
            📍 {patient?.full_name}
          </button>
        )}

        <p className="text-xs" style={{ color: 'var(--text-slate-600)' }}>
          {isPickup ? store?.address : patient?.address}
          {!isPickup && delivery.unit_number && <span className="ml-1">#{delivery.unit_number}</span>}
        </p>

        {(() => {
          const isFinished = FINISHED_STATUSES.includes(delivery.status);
          const finishedTime = delivery.actual_delivery_time ? format(new Date(delivery.actual_delivery_time), 'HH:mm') : null;
          
          if (isFinished && finishedTime) {
            return (
              <div className="flex items-center gap-1 text-xs text-emerald-600 font-medium">
                <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{finishedTime}</span>
              </div>
            );
          } else if (delivery.delivery_time_eta) {
            return (
              <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-slate-600)' }}>
                <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                <span>ETA: {delivery.delivery_time_eta}</span>
              </div>
            );
          }
          return null;
        })()}

        {driver && (
          <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-slate-600)' }}>
            <Truck className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{driver.user_name || driver.full_name}</span>
          </div>
        )}

        {delivery.prescription_number && (
          <div className="text-xs" style={{ color: 'var(--text-slate-600)' }}>
            <span className="font-medium">Rx#</span> {delivery.prescription_number}
          </div>
        )}

        {delivery.tracking_number && (
          <div className="text-xs" style={{ color: 'var(--text-slate-600)' }}>
            <span className="font-medium">TR#</span> {delivery.tracking_number}
          </div>
        )}

        {delivery.cod_total_amount_required > 0 && (
          <div className="flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded" style={{ color: '#059669', background: 'rgba(5, 150, 105, 0.1)' }}>
            {(() => {
              const hasCODPayments = delivery.cod_payments && 
                                    Array.isArray(delivery.cod_payments) && 
                                    delivery.cod_payments.length > 0 &&
                                    delivery.cod_payments.some(p => p?.amount > 0);
              
              if (hasCODPayments) {
                const primaryPayment = delivery.cod_payments.find(p => p?.amount > 0);
                if (primaryPayment) {
                  return <span>💵 {primaryPayment.type}: ${primaryPayment.amount.toFixed(2)}</span>;
                }
              }
              
              return <span>💵 COD: ${delivery.cod_total_amount_required.toFixed(2)}</span>;
            })()}
          </div>
        )}

        {!isPickup && delivery.delivery_instructions && (
          <div className="text-xs italic border-t pt-1.5 mt-1.5" style={{ color: 'var(--text-slate-500)', borderColor: 'var(--border-slate-200)' }}>
            {delivery.delivery_instructions}
          </div>
        )}

        {delivery.delivery_notes && (
          <div className="text-xs text-blue-600 border-t pt-1.5 mt-1.5" style={{ borderColor: 'var(--border-slate-200)' }}>
            <span className="font-medium">Notes:</span> {delivery.delivery_notes}
          </div>
        )}

        {!isPickup && (
          <div className="border-t pt-1.5 mt-1.5" style={{ borderColor: 'var(--border-slate-200)' }}>
            <SpecialSymbolsBadges delivery={delivery} patient={patient} size="sm" />
          </div>
        )}
      </div>
    </div>
  );
}