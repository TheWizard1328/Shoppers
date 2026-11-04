import React, { useState } from 'react';
import { format } from 'date-fns';
import { CheckCircle, XCircle, Clock, Truck, ChevronDown, ChevronUp, User, Package, FileText, Camera, DollarSign, MapPin } from 'lucide-react';

const STATUS_CONFIG = {
  completed: { label: 'Delivered', color: 'text-green-600', bg: 'bg-green-50 dark:bg-green-950', border: 'border-green-200', Icon: CheckCircle },
  failed: { label: 'Failed', color: 'text-red-600', bg: 'bg-red-50 dark:bg-red-950', border: 'border-red-200', Icon: XCircle },
  cancelled: { label: 'Cancelled', color: 'text-slate-500 dark:text-slate-400', bg: 'bg-slate-50 dark:bg-slate-800', border: 'border-slate-200 dark:border-slate-700', Icon: XCircle },
  in_transit: { label: 'In Transit', color: 'text-blue-600', bg: 'bg-blue-50 dark:bg-blue-950', border: 'border-blue-200', Icon: Truck },
  en_route: { label: 'En Route', color: 'text-blue-600', bg: 'bg-blue-50 dark:bg-blue-950', border: 'border-blue-200', Icon: Truck },
  pending: { label: 'Pending', color: 'text-amber-600', bg: 'bg-amber-50 dark:bg-amber-950', border: 'border-amber-200', Icon: Clock }
};

function InfoRow({ icon: Icon, label, value }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-slate-100 last:border-0">
      <Icon className="w-3.5 h-3.5 text-slate-400 dark:text-slate-400 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <span className="text-xs text-slate-400 dark:text-slate-400">{label}: </span>
        <span className="text-xs text-slate-700 dark:text-slate-300 font-medium">{value}</span>
      </div>
    </div>);

}

export default function PatientDeliveryCard({ delivery, storeName, pickupTime, pickupEta = null, pickupWindowStart = null, pickupWindowEnd = null, stopsBetween, pickupDriverName = null, deliveredBy = null, pickupByOtherDriver = false, transferred = false, transferredFrom = null, transferredOn = null, remainingStops = null, expandInline = false, belowDateSlot = null }) {
  const [expanded, setExpanded] = useState(false);
  const config = STATUS_CONFIG[delivery.status] || STATUS_CONFIG.pending;
  const { Icon } = config;

  const dateStr = delivery.delivery_date ?
  format(new Date(delivery.delivery_date + 'T00:00:00'), 'MMM d, yyyy') :
  '—';

  const actualTime = delivery.actual_delivery_time ?
  format(new Date(delivery.actual_delivery_time), 'h:mm a') :
  null;

  const arrivalTime = pickupTime ?
  format(new Date(pickupTime), 'h:mm a') :
  null;

  // Small timestamp shown under the status badge on the collapsed card:
  // current delivery → ETA, past deliveries → delivered / attempted time.
  let subBadge = null;
  // FINISHED STOPS (owner request Nov 3 2026): the sidebar card already says
  // Completed / Failed in the status pill, so the line beneath it is just the
  // TIME as a pill of its own — green for completed, red for failed. No second
  // "Delivered" / "Failed" wording.
  if (delivery.status === 'completed' && actualTime) {
    subBadge = {
      text: actualTime,
      pill: true,
      pillCls: expanded ?
      'bg-green-900/60 border-green-700 text-green-300' :
      'bg-green-50 border-green-200 text-green-700 dark:bg-green-950 dark:border-green-800 dark:text-green-300'
    };
  } else if (delivery.status === 'failed' && actualTime) {
    subBadge = {
      text: actualTime,
      pill: true,
      pillCls: expanded ?
      'bg-red-900/60 border-red-700 text-red-300' :
      'bg-red-50 border-red-200 text-red-700 dark:bg-red-950 dark:border-red-800 dark:text-red-300'
    };
  } else if (delivery.status === 'pending') {
    // OWNER REQUEST Nov 4 2026: while the parcel is still waiting to be picked
    // up there is no delivery ETA yet, so show the PICKUP ETA instead. Once it
    // is collected the status flips to en route / in transit and the branch
    // below takes over with the delivery ETA.
    const windowText = pickupWindowStart && pickupWindowEnd
      ? `${pickupWindowStart} – ${pickupWindowEnd}`
      : (pickupWindowStart || null);
    if (pickupEta) {
      subBadge = { text: `Pickup ETA ${pickupEta}`, color: 'text-amber-600 dark:text-amber-400' };
    } else if (windowText) {
      subBadge = { text: `Pickup ${windowText}`, color: 'text-amber-600 dark:text-amber-400' };
    }
  } else if (['in_transit', 'en_route'].includes(delivery.status) && delivery.delivery_time_eta) {
    // Owner request (Sep 29 2026): when the ETA equals the delivery window START
    // (the optimizer clamps arrival up to the window floor, e.g. 17:30), the
    // patient should see it as an approximate floor, not a projected arrival —
    // render "ETA: ~17:30" for the clamped case, plain "ETA 17:30" otherwise.
    const toMin = (t) => {
      const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})/);
      return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
    };
    const windowStart = delivery.delivery_time_start || delivery.time_window_start || null;
    const etaMin = toMin(delivery.delivery_time_eta);
    const winMin = toMin(windowStart);
    const isWindowClamped = etaMin != null && winMin != null && etaMin === winMin;
    subBadge = {
      text: isWindowClamped ?
      `ETA: ~${delivery.delivery_time_eta}` :
      `ETA ${delivery.delivery_time_eta}`,
      color: 'text-blue-600 dark:text-blue-400'
    };
  }

  // STOPS-LEFT PILL (owner request Nov 4 2026): moved out of the stack under
  // the ETA and onto the SAME ROW as the date and the ETA, sitting between them.
  // Content rules are unchanged: per-card count of stops prior to this patient's
  // own stop, plus "you're next" as a status suffix.
  const stopsPill = (['pending', 'en_route', 'in_transit'].includes(delivery.status) &&
    (stopsBetween != null || remainingStops != null)) ?
    (() => {
      const count = stopsBetween != null ? Number(stopsBetween) : Number(remainingStops);
      const isNext = delivery.isNextDelivery === true;
      const countLabel = count === 0 ? 'Direct delivery' : `${count} stop${count === 1 ? '' : 's'}`;
      const label = isNext ? `${countLabel} \u00b7 you're next` : countLabel;
      const cls = isNext ?
        expanded ?
          'bg-green-900/60 border-green-700 text-green-300' :
          'bg-green-50 border-green-200 text-green-700 dark:bg-green-950 dark:border-green-800 dark:text-green-300' :
        expanded ?
          'bg-slate-700 border-slate-600 text-slate-200' :
          'bg-slate-100 border-slate-200 text-slate-600 dark:bg-slate-800 dark:border-slate-600 dark:text-slate-300';
      return (
        <span className={`inline-flex items-center justify-center px-2 py-0.5 rounded-full border text-[10px] font-semibold leading-tight whitespace-nowrap flex-shrink-0 ${cls}`}>
          {label}
        </span>);
    })() : null;

  const codTotal = delivery.cod_total_amount_required || 0;
  const codPayments = delivery.cod_payments || [];
  const hasCod = codTotal > 0;

  return (
    <div className="relative">
      {/* Base card — always visible, keeps its layout space */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className={`w-full text-left border transition-all duration-150 rounded-[9px] pt-3 pr-3 pl-3 pb-1 ${
        transferred ?
        expanded
        // TRANSFERRED (owner request Nov 3 2026): the card itself carries
        // the amber highlight — no chip, no detail row.
        ? 'border-amber-500 bg-amber-950/40 text-white shadow-md' :
        'border-amber-400 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-600 hover:border-amber-500 hover:shadow-sm' :
        expanded ?
        'border-slate-700 bg-slate-900 text-white shadow-md' :
        'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-300 dark:border-slate-600 hover:shadow-sm'}`
        }>
        
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0 py-1">
            <p className={`text-xs font-medium truncate ${expanded ? 'text-slate-300' : 'text-slate-500 dark:text-slate-400'}`}>
              {storeName || 'Pharmacy'}
            </p>
            {/* Slot rendered immediately UNDER the date (owner request Nov 3
                            2026: the App-Owner "Exit Patient View" control belongs on the
                            floating today card here, in the space under the date). It uses
                            a span so it stays legal inside the card's toggle button. */}
            {belowDateSlot}
            {hasCod &&
            <p className={`text-xs mt-0.5 font-semibold ${expanded ? 'text-green-400' : 'text-green-600'}`}>
                COD: ${codTotal.toFixed(2)}
              </p>
            }
          </div>
          <div className="flex flex-col items-center flex-shrink-0">
            <div className="flex items-center gap-1">
              {/* Invisible chevron spacer (owner fix Nov 3 2026): the visible
                              chevron used to push the status badge off-centre, so the ETA /
                              delivered time, and the new stops-left line, sat under the
                              badge+chevron pair instead of under the badge itself. A
                              matching invisible chevron on the left keeps the badge dead
                              centre and the lines below it perfectly aligned. */}
              <ChevronDown className="w-3.5 h-3.5 opacity-0" aria-hidden="true" />
              <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${
              expanded ? 'bg-slate-700 border-slate-600 text-slate-200' : `${config.bg} ${config.border} ${config.color}`}`
              }>
                <Icon className="w-3 h-3" />
                {config.label}
              </span>
              {expanded ?
              <ChevronUp className="w-3.5 h-3.5 text-slate-400 dark:text-slate-400" /> :
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 dark:text-slate-400" />
              }
            </div>
                      </div>
        </div>
        {/* DATE / STOPS-LEFT / ETA ROW (owner request Nov 4 2026): the stop
            count belongs CENTRED between the date and the ETA. It was crammed
            against the ETA in the right column; now it owns the middle of its
            own row and the ETA sits flush right. */}
        <div className={`flex items-center gap-2 mt-1 ${expanded ? 'text-slate-300' : ''}`}>
          <span className={`font-semibold text-xs flex-shrink-0 ${expanded ? 'text-white' : 'text-slate-800 dark:text-slate-200'}`}>
            {dateStr}
          </span>
          <span className="flex-1 flex items-center justify-center min-w-0">
            {stopsPill}
          </span>
          {subBadge && (subBadge.pill ?
            <span className={`inline-flex items-center justify-center rounded-full border font-semibold leading-tight tabular-nums whitespace-nowrap text-xs px-3 flex-shrink-0 ${subBadge.pillCls}`}>
              {subBadge.text}
            </span> :
            <span className={`text-sm font-medium leading-tight text-right flex-shrink-0 ${expanded ? 'text-slate-300' : subBadge.color}`}>
              {subBadge.text}
            </span>)
          }
        </div>
      </button>

      {/* Expanded detail — floats over cards below, doesn't push them down */}
      {expanded &&
      <div className={`mt-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl overflow-hidden ${
      // Sidebar keeps the overlay behaviour (the list is scrollable, the detail
      // floats over the cards below). The floating today card sets expandInline
      // so the card GROWS and its container enlarges with it (owner report
      // Nov 2 2026: expanding looked stuck inside a fixed-height box).
      expandInline ? 'relative' : 'absolute left-0 right-0 top-full z-20'}`
      }>
          <div className="p-3 space-y-0.5">
            {/* TWO DRIVERS (owner request Nov 3 2026): when the parcel changed
            hands the card names both — who collected it and who delivered it. */}
            {pickupByOtherDriver ?
          <>
                <InfoRow icon={User} label="Picked up by" value={pickupDriverName} />
                <InfoRow icon={User} label="Delivered by" value={deliveredBy} />
              </> :

          delivery.driver_name && <InfoRow icon={User} label="Driver" value={delivery.driver_name} />
          }
            {arrivalTime && <InfoRow icon={Truck} label="Picked up at" value={arrivalTime} />}
            {/* STOPS BEFORE YOU (owner rule Nov 3 2026): this is the count of stops
            that sat BETWEEN the pickup that collected this patient's parcel and
            the patient's own stop — a fixed figure for the delivery. The live
            driver-remaining count belongs to the status pill, never here. */}
            {stopsBetween != null &&
          <InfoRow
            icon={MapPin}
            label="Stops before you"
            value={stopsBetween === 0 ? 'Direct delivery' : `${stopsBetween} stop${stopsBetween !== 1 ? 's' : ''}`} />

          }
            {actualTime && <InfoRow icon={delivery.status === 'failed' ? XCircle : CheckCircle} label={delivery.status === 'failed' ? 'Attempted at' : 'Delivered at'} value={actualTime} />}
            {delivery.tracking_number && <InfoRow icon={Package} label="Tracking #" value={delivery.tracking_number} />}
            {delivery.prescription_number && <InfoRow icon={FileText} label="Prescription #" value={delivery.prescription_number} />}
            {delivery.delivery_notes && <InfoRow icon={FileText} label="Driver Notes" value={delivery.delivery_notes} />}
          </div>

          {hasCod && codPayments.length > 0 &&
        <div className="px-3 pb-3">
              <p className="text-xs font-semibold text-slate-400 dark:text-slate-400 uppercase tracking-wide mb-1.5 flex items-center gap-1">
                <DollarSign className="w-3 h-3" /> COD Payments Collected
              </p>
              <div className="space-y-1">
                {codPayments.map((p, i) =>
            <div key={i} className="flex items-center justify-between text-xs bg-green-50 dark:bg-green-950 border border-green-100 rounded-lg px-2.5 py-1.5">
                    <span className="text-slate-600 dark:text-slate-400 font-medium">{p.type}</span>
                    <span className="text-green-700 font-semibold">${Number(p.amount).toFixed(2)}</span>
                  </div>
            )}
              </div>
            </div>
        }

          {delivery.proof_photo_urls?.length > 0 &&
        <div className="px-3 pb-3">
              <p className="text-xs font-semibold text-slate-400 dark:text-slate-400 uppercase tracking-wide mb-1.5 flex items-center gap-1">
                <Camera className="w-3 h-3" /> Proof of Delivery
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {delivery.proof_photo_urls.map((url, i) =>
            <a key={i} href={url} target="_blank" rel="noopener noreferrer">
                    <img src={url} alt={`Proof ${i + 1}`} className="w-full h-24 object-cover rounded-lg border border-slate-200 dark:border-slate-700" />
                  </a>
            )}
              </div>
            </div>
        }

          {delivery.signature_image_url &&
        <div className="px-3 pb-3">
              <p className="text-xs font-semibold text-slate-400 dark:text-slate-400 uppercase tracking-wide mb-1.5">Signature</p>
              <img src={delivery.signature_image_url} alt="Signature" className="w-full max-h-20 object-contain rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-2" />
            </div>
        }
        </div>
      }
    </div>);

}