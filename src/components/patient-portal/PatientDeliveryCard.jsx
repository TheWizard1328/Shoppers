import React, { useState } from 'react';
import { format } from 'date-fns';
import { CheckCircle, XCircle, Clock, Truck, ChevronDown, ChevronUp, User, Package, FileText, Camera, DollarSign } from 'lucide-react';

const STATUS_CONFIG = {
  completed: { label: 'Delivered', color: 'text-green-600', bg: 'bg-green-50', border: 'border-green-200', Icon: CheckCircle },
  failed: { label: 'Failed', color: 'text-red-600', bg: 'bg-red-50', border: 'border-red-200', Icon: XCircle },
  cancelled: { label: 'Cancelled', color: 'text-slate-500', bg: 'bg-slate-50', border: 'border-slate-200', Icon: XCircle },
  in_transit: { label: 'In Transit', color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-200', Icon: Truck },
  en_route: { label: 'En Route', color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-200', Icon: Truck },
  pending: { label: 'Pending', color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200', Icon: Clock },
};

function InfoRow({ icon: Icon, label, value }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-slate-100 last:border-0">
      <Icon className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <span className="text-xs text-slate-400">{label}: </span>
        <span className="text-xs text-slate-700 font-medium">{value}</span>
      </div>
    </div>
  );
}

export default function PatientDeliveryCard({ delivery, storeName }) {
  const [expanded, setExpanded] = useState(false);
  const config = STATUS_CONFIG[delivery.status] || STATUS_CONFIG.pending;
  const { Icon } = config;

  const dateStr = delivery.delivery_date
    ? format(new Date(delivery.delivery_date + 'T00:00:00'), 'MMM d, yyyy')
    : '—';

  const actualTime = delivery.actual_delivery_time
    ? format(new Date(delivery.actual_delivery_time), 'h:mm a')
    : null;

  const arrivalTime = delivery.arrival_time
    ? delivery.arrival_time.substring(11, 16)
    : null;

  const codTotal = delivery.cod_total_amount_required || 0;
  const codPayments = delivery.cod_payments || [];
  const hasCod = codTotal > 0;

  return (
    <div className="relative">
      {/* Base card — always visible, keeps its layout space */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className={`w-full text-left rounded-xl border p-3 transition-all duration-150 ${
          expanded
            ? 'border-slate-700 bg-slate-900 text-white shadow-md'
            : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm'
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className={`text-xs font-medium truncate ${expanded ? 'text-slate-300' : 'text-slate-500'}`}>
              {storeName || 'Pharmacy'}
            </p>
            <p className={`text-sm font-semibold mt-0.5 ${expanded ? 'text-white' : 'text-slate-800'}`}>
              {dateStr}
            </p>
            {hasCod && (
              <p className={`text-xs mt-0.5 font-semibold ${expanded ? 'text-green-400' : 'text-green-600'}`}>
                COD: ${codTotal.toFixed(2)}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${
              expanded ? 'bg-slate-700 border-slate-600 text-slate-200' : `${config.bg} ${config.border} ${config.color}`
            }`}>
              <Icon className="w-3 h-3" />
              {config.label}
            </span>
            {expanded
              ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
              : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            }
          </div>
        </div>
      </button>

      {/* Expanded detail — floats over cards below, doesn't push them down */}
      {expanded && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-xl border border-slate-200 bg-white shadow-xl overflow-hidden">
          <div className="p-3 space-y-0.5">
            {delivery.driver_name && <InfoRow icon={User} label="Driver" value={delivery.driver_name} />}
            {arrivalTime && <InfoRow icon={Truck} label="Picked up at" value={arrivalTime} />}
            {actualTime && <InfoRow icon={CheckCircle} label="Delivered at" value={actualTime} />}
            {delivery.tracking_number && <InfoRow icon={Package} label="Tracking #" value={delivery.tracking_number} />}
            {delivery.prescription_number && <InfoRow icon={FileText} label="Prescription #" value={delivery.prescription_number} />}
            {delivery.delivery_notes && <InfoRow icon={FileText} label="Driver Notes" value={delivery.delivery_notes} />}
          </div>

          {hasCod && codPayments.length > 0 && (
            <div className="px-3 pb-3">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1.5 flex items-center gap-1">
                <DollarSign className="w-3 h-3" /> COD Payments Collected
              </p>
              <div className="space-y-1">
                {codPayments.map((p, i) => (
                  <div key={i} className="flex items-center justify-between text-xs bg-green-50 border border-green-100 rounded-lg px-2.5 py-1.5">
                    <span className="text-slate-600 font-medium">{p.type}</span>
                    <span className="text-green-700 font-semibold">${Number(p.amount).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {delivery.proof_photo_urls?.length > 0 && (
            <div className="px-3 pb-3">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1.5 flex items-center gap-1">
                <Camera className="w-3 h-3" /> Proof of Delivery
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {delivery.proof_photo_urls.map((url, i) => (
                  <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                    <img src={url} alt={`Proof ${i + 1}`} className="w-full h-24 object-cover rounded-lg border border-slate-200" />
                  </a>
                ))}
              </div>
            </div>
          )}

          {delivery.signature_image_url && (
            <div className="px-3 pb-3">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Signature</p>
              <img src={delivery.signature_image_url} alt="Signature" className="w-full max-h-20 object-contain rounded-lg border border-slate-200 bg-slate-50 p-2" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}