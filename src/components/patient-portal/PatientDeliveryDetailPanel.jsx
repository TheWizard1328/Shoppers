import React from 'react';
import { format } from 'date-fns';
import { X, CheckCircle, XCircle, Clock, Truck, MapPin, Package, User, FileText, Camera } from 'lucide-react';
import { Button } from '@/components/ui/button';

const STATUS_CONFIG = {
  completed: { label: 'Delivered', color: 'text-green-700', bg: 'bg-green-50', border: 'border-green-200', Icon: CheckCircle },
  failed: { label: 'Attempted — Not Delivered', color: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200', Icon: XCircle },
  cancelled: { label: 'Cancelled', color: 'text-slate-600', bg: 'bg-slate-50', border: 'border-slate-200', Icon: XCircle },
  in_transit: { label: 'In Transit', color: 'text-blue-700', bg: 'bg-blue-50', border: 'border-blue-200', Icon: Truck },
  en_route: { label: 'En Route to You', color: 'text-blue-700', bg: 'bg-blue-50', border: 'border-blue-200', Icon: Truck },
  pending: { label: 'Scheduled', color: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200', Icon: Clock },
};

function InfoRow({ icon: Icon, label, value }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-slate-100 last:border-0">
      <div className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Icon className="w-4 h-4 text-slate-500" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">{label}</p>
        <p className="text-sm text-slate-800 font-medium mt-0.5">{value}</p>
      </div>
    </div>
  );
}

export default function PatientDeliveryDetailPanel({ delivery, storeName, onClose }) {
  if (!delivery) return null;

  const config = STATUS_CONFIG[delivery.status] || STATUS_CONFIG.pending;
  const { Icon } = config;

  const dateStr = delivery.delivery_date
    ? format(new Date(delivery.delivery_date + 'T00:00:00'), 'EEEE, MMMM d, yyyy')
    : '—';

  const timeWindow = delivery.delivery_time_start
    ? `${delivery.delivery_time_start}${delivery.delivery_time_end ? ` – ${delivery.delivery_time_end}` : ''}`
    : null;

  const actualTime = delivery.actual_delivery_time
    ? format(new Date(delivery.actual_delivery_time), 'h:mm a')
    : null;

  return (
    <div className="absolute inset-y-0 right-0 w-full bg-white flex flex-col z-10 shadow-xl">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-slate-200 bg-slate-50 flex-shrink-0">
        <div>
          <p className="text-xs text-slate-500 font-medium">{storeName || 'Pharmacy'}</p>
          <h3 className="text-base font-bold text-slate-900">{dateStr}</h3>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center hover:bg-slate-50 transition-colors"
        >
          <X className="w-4 h-4 text-slate-600" />
        </button>
      </div>

      {/* Status Badge */}
      <div className="px-4 pt-4 pb-2 flex-shrink-0">
        <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm font-semibold ${config.bg} ${config.border} ${config.color}`}>
          <Icon className="w-4 h-4" />
          {config.label}
        </div>
      </div>

      {/* Details */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <div className="mt-2">
          <InfoRow icon={MapPin} label="Pharmacy" value={storeName} />

          {actualTime && <InfoRow icon={CheckCircle} label="Delivered At" value={actualTime} />}
          {delivery.driver_name && <InfoRow icon={User} label="Driver" value={delivery.driver_name} />}
          {delivery.tracking_number && <InfoRow icon={Package} label="Tracking #" value={delivery.tracking_number} />}
          {delivery.prescription_number && <InfoRow icon={FileText} label="Prescription #" value={delivery.prescription_number} />}
          {delivery.delivery_notes && <InfoRow icon={FileText} label="Delivery Notes" value={delivery.delivery_notes} />}
        </div>

        {/* Proof of delivery photos */}
        {delivery.proof_photo_urls && delivery.proof_photo_urls.length > 0 && (
          <div className="mt-4">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <Camera className="w-3.5 h-3.5" /> Proof of Delivery
            </p>
            <div className="grid grid-cols-2 gap-2">
              {delivery.proof_photo_urls.map((url, i) => (
                <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                  <img
                    src={url}
                    alt={`Proof ${i + 1}`}
                    className="w-full h-28 object-cover rounded-lg border border-slate-200"
                  />
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Signature */}
        {delivery.signature_image_url && (
          <div className="mt-4">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Signature</p>
            <img
              src={delivery.signature_image_url}
              alt="Signature"
              className="w-full max-h-24 object-contain rounded-lg border border-slate-200 bg-slate-50 p-2"
            />
          </div>
        )}
      </div>
    </div>
  );
}