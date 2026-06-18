import React, { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Phone, MapPin, Hash, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import SpecialSymbolsBadges from '@/components/utils/SpecialSymbolsBadges';
import { formatPhoneNumber } from '@/components/utils/phoneFormatter';
import FailureReasonDialog from '../deliveries/FailureReasonDialog';

const GPS_MATCH_THRESHOLD = 0.025; // ~25 metres tolerance

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];

/**
 * MultiDeliveryArrivalDialog
 *
 * Shows all active deliveries at the same physical address when a driver arrives.
 * Each card has Complete and Fail buttons so the driver can act on any stop.
 *
 * Props:
 *  open              – boolean
 *  onClose           – () => void
 *  currentDelivery   – the delivery the driver just arrived at
 *  allDeliveries     – full list of deliveries in memory
 *  patients          – full patients list
 *  onCompleteDelivery – async (delivery) => void  — called when driver taps Complete
 *  onFailDelivery    – async (delivery, reason) => void — called after failure reason confirmed
 */
export default function MultiDeliveryArrivalDialog({
  open,
  onClose,
  currentDelivery,
  allDeliveries = [],
  patients = [],
  onCompleteDelivery,
  onFailDelivery,
}) {
  const [loadingId, setLoadingId] = useState(null); // deliveryId currently being actioned
  const [failTarget, setFailTarget] = useState(null); // delivery to fail after reason dialog

  // Resolve GPS for any delivery (patient address)
  const getCoords = (delivery) => {
    if (!delivery?.patient_id) return null;
    const p = patients.find((x) => x?.id === delivery.patient_id);
    if (!p?.latitude || !p?.longitude) return null;
    return { lat: Number(p.latitude), lon: Number(p.longitude) };
  };

  const sameLocationDeliveries = useMemo(() => {
    if (!currentDelivery?.patient_id) return [];
    const origin = getCoords(currentDelivery);
    if (!origin) return [];

    return allDeliveries.filter((d) => {
      if (!d || d.id === currentDelivery.id) return false;
      if (FINISHED_STATUSES.includes(d.status)) return false;
      if (d.driver_id !== currentDelivery.driver_id) return false;
      if (d.delivery_date !== currentDelivery.delivery_date) return false;
      if (!d.patient_id) return false;
      const coords = getCoords(d);
      if (!coords) return false;
      return haversineKm(origin.lat, origin.lon, coords.lat, coords.lon) <= GPS_MATCH_THRESHOLD;
    }).sort((a, b) => (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0));
  }, [currentDelivery, allDeliveries, patients]);

  if (!open || sameLocationDeliveries.length === 0) return null;

  const allAtLocation = [currentDelivery, ...sameLocationDeliveries];

  const handleComplete = async (delivery) => {
    if (loadingId) return;
    setLoadingId(delivery.id);
    try {
      await onCompleteDelivery?.(delivery);
    } finally {
      setLoadingId(null);
    }
  };

  const handleFailClick = (delivery) => {
    if (loadingId) return;
    setFailTarget(delivery);
  };

  const handleFailureConfirmed = async (reason) => {
    const target = failTarget;
    setFailTarget(null);
    if (!target) return;
    setLoadingId(target.id);
    try {
      await onFailDelivery?.(target, reason);
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto overflow-x-hidden" style={{ zIndex: 99999, width: '95vw', maxWidth: '95vw' }}>
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              <MapPin className="w-4 h-4 text-blue-600" />
              {allAtLocation.length} Deliveries at This Address
            </DialogTitle>
            <p className="text-sm text-slate-500 font-normal mt-0.5">
              {patients.find((p) => p?.id === currentDelivery?.patient_id)?.address || 'Same location'}
            </p>
          </DialogHeader>

          <div className="space-y-3 mt-2 w-full min-w-0">
            {allAtLocation.map((delivery) => {
              const patient = patients.find((p) => p?.id === delivery.patient_id);
              const isCurrent = delivery.id === currentDelivery.id;
              const isFinished = FINISHED_STATUSES.includes(delivery.status);
              const isLoading = loadingId === delivery.id;

              return (
                <div
                  key={delivery.id}
                  className={`rounded-xl border p-3 space-y-1.5 w-full min-w-0 ${
                    isCurrent
                      ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/20'
                      : 'border-slate-200 bg-white dark:bg-slate-900'
                  }`}
                >
                  {/* Row 1: Stop # + Name + Status */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {delivery.stop_order != null && (
                      <Badge
                        className="text-white text-xs px-2 py-0.5 rounded-full font-bold"
                        style={{ backgroundColor: (delivery.fridge_item && delivery.status === 'in_transit') ? '#2563eb' : '#10B981' }}
                      >
                        #{delivery.stop_order}
                      </Badge>
                    )}
                    <span className="font-semibold text-sm text-slate-900 dark:text-slate-100 flex-1 min-w-0 truncate">
                      {patient?.full_name || delivery.patient_name || '—'}
                    </span>
                    {isCurrent && (
                      <Badge className="bg-blue-500 text-white text-xs px-2 py-0.5 rounded-full">Current</Badge>
                    )}
                    <Badge
                      className={`text-xs px-2 py-0.5 rounded-full capitalize ${
                        delivery.status === 'completed' ? 'bg-green-100 text-green-800' :
                        delivery.status === 'in_transit' || delivery.status === 'en_route' ? 'bg-amber-100 text-amber-800' :
                        'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {delivery.status?.replace('_', ' ')}
                    </Badge>
                  </div>

                  {/* Row 2: Address + Unit + Tracking # */}
                  <div className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
                    <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="truncate">{patient?.address || '—'}</span>
                    {(delivery.unit_number || patient?.unit_number) && (
                      <span className="font-medium text-slate-800 dark:text-slate-200 flex-shrink-0">
                        #{delivery.unit_number || patient?.unit_number}
                      </span>
                    )}
                    {delivery.tracking_number && (
                      <span className="ml-auto flex-shrink-0 flex items-center gap-1 text-xs text-slate-400">
                        <Hash className="w-3 h-3" />TR#{delivery.tracking_number}
                      </span>
                    )}
                  </div>

                  {/* Row 3: Phone */}
                  {(patient?.phone || delivery.phone) && (
                    <div className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
                      <Phone className="w-3.5 h-3.5 flex-shrink-0" />
                      <a
                        href={`tel:${String(patient?.phone || delivery.phone).replace(/\D/g, '')}`}
                        onClick={(e) => e.stopPropagation()}
                        className="text-blue-600 hover:underline"
                      >
                        {formatPhoneNumber(patient?.phone || delivery.phone)}
                      </a>
                      {patient?.phone_secondary && (
                        <>
                          <span className="text-slate-400">·</span>
                          <a
                            href={`tel:${String(patient.phone_secondary).replace(/\D/g, '')}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-blue-600 hover:underline"
                          >
                            {formatPhoneNumber(patient.phone_secondary)}
                          </a>
                        </>
                      )}
                    </div>
                  )}

                  {/* Row 4: Special symbols */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <SpecialSymbolsBadges
                      delivery={delivery}
                      patient={patient}
                      isPickup={false}
                      size="md"
                    />
                  </div>

                  {/* Row 5: Driver notes */}
                  {delivery.delivery_notes && (
                    <div className="text-xs text-violet-700 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/20 rounded-md px-2 py-1 leading-snug">
                      {delivery.delivery_notes}
                    </div>
                  )}

                  {/* Row 6: Action buttons — only for non-finished stops */}
                  {!isFinished && (
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        type="button"
                        disabled={!!loadingId}
                        onClick={() => handleComplete(delivery)}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                      >
                        {isLoading ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <CheckCircle className="w-3.5 h-3.5" />
                        )}
                        {isLoading ? 'Processing…' : 'Complete'}
                      </button>
                      <button
                        type="button"
                        disabled={!!loadingId}
                        onClick={() => handleFailClick(delivery)}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg text-xs font-semibold bg-red-100 text-red-700 hover:bg-red-200 disabled:opacity-50 transition-colors"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        Fail
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      {/* Failure reason dialog — shown on top of the arrival dialog */}
      {failTarget && (
        <FailureReasonDialog
          isOpen={!!failTarget}
          onClose={() => setFailTarget(null)}
          onConfirm={handleFailureConfirmed}
          deliveryName={patients.find((p) => p?.id === failTarget?.patient_id)?.full_name || failTarget?.patient_name || 'Delivery'}
          isPickup={false}
          statusType="failed"
        />
      )}
    </>
  );
}