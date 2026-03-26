import React from 'react';
import { Clock, Home, MapPin, Truck } from 'lucide-react';

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

const getStatusColor = (status) => {
  const statusColors = {
    pending: 'text-slate-600 bg-slate-100',
    'Ready For Pickup': 'text-amber-700 bg-amber-100',
    in_transit: 'text-blue-700 bg-blue-100',
    completed: 'text-emerald-700 bg-emerald-100',
    failed: 'text-red-700 bg-red-100',
    cancelled: 'text-red-700 bg-red-100',
    returned: 'text-orange-700 bg-orange-100'
  };
  return statusColors[status] || 'text-slate-600 bg-slate-100';
};

const getTimeColor = (status) => {
  if (status === 'completed') return 'text-emerald-600';
  if (status === 'failed' || status === 'cancelled') return 'text-red-600';
  if (status === 'returned') return 'text-orange-600';
  return '';
};

export default function MarkerInfoBalloon({
  delivery,
  store,
  patient,
  driver,
  isPickup = false,
  compact = false,
  onClick,
  onPatientClick,
  extraContent
}) {
  const isFinished = FINISHED_STATUSES.includes(delivery?.status);
  const stopNumber = delivery?.number || delivery?.stop_order || '?';

  const timeLabel = isFinished
    ? delivery?.actual_delivery_time ? new Date(delivery.actual_delivery_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : null
    : delivery?.delivery_time_eta ? delivery.delivery_time_eta : null;

  const patientLabel = isPickup ? 'Store Pickup' : (patient?.full_name || 'Patient');
  const wrapperClass = compact ? 'space-y-1' : 'space-y-1.5';

  return (
    <div
      className={`${wrapperClass}${onClick ? ' cursor-pointer hover:bg-slate-50 px-1 -mx-1 rounded' : ''}`}
      onClick={onClick}
    >
      {/* Row 1: Driver name */}
      <div className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-slate-900)' }}>
        <Truck className="w-3.5 h-3.5 flex-shrink-0" />
        <span className="truncate">{driver?.user_name || driver?.full_name || 'Unknown Driver'}</span>
      </div>

      {/* Row 2: Store name */}
      <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-slate-600)' }}>
        <Home className="w-3.5 h-3.5 flex-shrink-0" />
        <span className="truncate">{store?.name || 'Store'}</span>
      </div>

      {/* Row 3: Name, Stop#, Time */}
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <div className="flex min-w-0 items-center gap-1.5" style={{ color: 'var(--text-slate-900)' }}>
          <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
          {onPatientClick && !isPickup ? (
            <button
              onClick={(event) => { event.stopPropagation(); onPatientClick(); }}
              className="truncate text-left"
              style={{ color: 'var(--text-slate-900)' }}
            >
              {patientLabel}
            </button>
          ) : (
            <span className="truncate">{patientLabel}</span>
          )}
          <span className="shrink-0 font-medium" style={{ color: 'var(--text-slate-500)' }}>#{stopNumber}</span>
        </div>
        <div className={`shrink-0 text-right ${timeLabel ? 'flex items-center gap-1' : ''} ${getTimeColor(delivery?.status)}`}>
          {timeLabel ? <Clock className="w-3.5 h-3.5 flex-shrink-0" /> : null}
          <span>{timeLabel || ''}</span>
        </div>
      </div>

      {extraContent ? (
        <div className="border-t pt-1.5 mt-1.5" style={{ borderColor: 'var(--border-slate-200)' }}>
          {extraContent}
        </div>
      ) : null}
    </div>
  );
}