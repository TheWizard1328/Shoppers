import React from 'react';
import { format } from 'date-fns';
import { CheckCircle, XCircle, Clock, Truck, Package, ChevronRight } from 'lucide-react';

const STATUS_CONFIG = {
  completed: { label: 'Delivered', color: 'text-green-600', bg: 'bg-green-50', border: 'border-green-200', Icon: CheckCircle },
  failed: { label: 'Failed', color: 'text-red-600', bg: 'bg-red-50', border: 'border-red-200', Icon: XCircle },
  cancelled: { label: 'Cancelled', color: 'text-slate-500', bg: 'bg-slate-50', border: 'border-slate-200', Icon: XCircle },
  in_transit: { label: 'In Transit', color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-200', Icon: Truck },
  en_route: { label: 'En Route', color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-200', Icon: Truck },
  pending: { label: 'Pending', color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200', Icon: Clock }
};

export default function PatientDeliveryCard({ delivery, storeName, isSelected, onClick }) {
  const config = STATUS_CONFIG[delivery.status] || STATUS_CONFIG.pending;
  const { Icon } = config;

  const dateStr = delivery.delivery_date ?
  format(new Date(delivery.delivery_date + 'T00:00:00'), 'MMM d, yyyy') :
  '—';

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-xl border p-3 transition-all duration-150 ${
      isSelected ?
      'border-slate-700 bg-slate-900 text-white shadow-md' :
      'border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm'}`
      }>
      
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className={`text-xs font-medium truncate ${isSelected ? 'text-slate-300' : 'text-slate-500'}`}>
            {storeName || 'Pharmacy'}
          </p>
          <p className={`text-sm font-semibold mt-0.5 ${isSelected ? 'text-white' : 'text-slate-800'}`}>
            {dateStr}
          </p>
          {delivery.delivery_time_start &&
          <p className={`text-xs mt-0.5 min-w-[17 ${isSelected ? 'text-slate-400' : 'text-slate-400'}`}>
              Window: {delivery.delivery_time_start}
              {delivery.delivery_time_end ? ` – ${delivery.delivery_time_end}` : ''}
            </p>
          }
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${
          isSelected ? 'bg-slate-700 border-slate-600 text-slate-200' : `${config.bg} ${config.border} ${config.color}`}`
          }>
            <Icon className="w-3 h-3" />
            {config.label}
          </span>
          <ChevronRight className={`w-3.5 h-3.5 ${isSelected ? 'text-slate-400' : 'text-slate-400'}`} />
        </div>
      </div>
    </button>);

}