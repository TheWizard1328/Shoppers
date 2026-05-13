import React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Package, Info, Loader2, Plus } from "lucide-react";
import TravelModeButton from "@/components/dashboard/TravelModeButton";
import { format, parseISO } from "date-fns";
import { formatPhoneNumber } from "../utils/phoneFormatter";
import HelpTooltip, { HELP_CONTENT } from "./HelpTooltip";
import SpecialSymbolsBadges from "../utils/SpecialSymbolsBadges";
import StopCardCODCollection from "./StopCardCODCollection";

export function StopCardPhoneRow({ isPickup, finalDisplayPhone, alternateDisplayPhone }) {
  if (isPickup || !finalDisplayPhone && !alternateDisplayPhone) return null;

  return (
    <div className="flex items-center gap-2 text-lg flex-wrap" style={{ color: 'var(--text-slate-600)' }}>
      {finalDisplayPhone && <span className="font-medium">{formatPhoneNumber(finalDisplayPhone)}</span>}
      {finalDisplayPhone && alternateDisplayPhone && <span>•</span>}
      {alternateDisplayPhone && <span className="font-medium text-blue-600">{formatPhoneNumber(alternateDisplayPhone)}</span>}
    </div>);

}

export function StopCardCodSection(props) {
  const {
    hasCODRequired,
    isPickup,
    codTotalRequired,
    currentUser,
    userHasRole,
    isStrippedForDriver,
    codPayments,
    setCodPayments,
    showCODCollection,
    setShowCODCollection,
    codTotalCollected,
    isFinishedDelivery,
    onCODUpdate,
    delivery,
    allDeliveries,
    FINISHED_STATUSES,
    forceRefreshDriverDeliveries,
    isCompleting,
    setIsCompleting,
    onSelectionChange,
    onClick,
    isCODComplete
  } = props;

  if (!hasCODRequired || isPickup) return null;

  return (
    <>
      <div className="flex items-center justify-between rounded-md px-2 py-1" style={{ background: '#e5e7eb', borderWidth: '1px', borderColor: '#d1d5db' }}>
        <span className="text-lg font-semibold" style={{ color: '#374151' }}>
          COD Required: ${codTotalRequired.toFixed(2)}
        </span>
        {(userHasRole(currentUser, 'driver') && !isStrippedForDriver || userHasRole(currentUser, 'admin') && !isStrippedForDriver) &&
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-sm hover:bg-gray-300"
          style={{ color: '#4b5563' }}
          onClick={(e) => {
            e.stopPropagation();
            setShowCODCollection(!showCODCollection);
            if (!showCODCollection && codPayments.length === 0) {
              setCodPayments([{ type: 'Debit', amount: Math.max(0, codTotalRequired - codTotalCollected) }]);
            }
          }}>
            {codPayments.length > 0 ? 'Edit' : 'Collect'}
          </Button>
        }
      </div>

      {codPayments.length > 0 &&
      <div className="flex items-center justify-between rounded-md px-2 py-1" style={{ background: '#10b981', borderWidth: '1px', borderColor: '#059669' }}>
          <span className="text-lg font-semibold" style={{ color: '#ffffff' }}>
            COD Collected:{' '}
            {codPayments.map((payment, index) =>
          <span key={index}>
                {payment.type}: ${payment.amount.toFixed(2)}
                {index < codPayments.length - 1 && ', '}
              </span>
          )}
          </span>
          {(!isStrippedForDriver && !isFinishedDelivery && userHasRole(currentUser, 'driver') || isFinishedDelivery && userHasRole(currentUser, 'admin')) &&
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-sm hover:bg-emerald-700"
          style={{ color: '#ffffff' }}
          onClick={(e) => {
            e.stopPropagation();
            setShowCODCollection(!showCODCollection);
          }}>
              Edit
            </Button>
        }
        </div>
      }

      <StopCardCODCollection
        delivery={delivery}
        codPayments={codPayments}
        setCodPayments={setCodPayments}
        showCODCollection={showCODCollection}
        setShowCODCollection={setShowCODCollection}
        codTotalRequired={codTotalRequired}
        codTotalCollected={codTotalCollected}
        isCODComplete={isCODComplete}
        isFinishedDelivery={isFinishedDelivery}
        isStrippedForDriver={isStrippedForDriver}
        currentUser={currentUser}
        onCODUpdate={onCODUpdate}
        allDeliveries={allDeliveries}
        FINISHED_STATUSES={FINISHED_STATUSES}
        forceRefreshDriverDeliveries={forceRefreshDriverDeliveries}
        isCompleting={isCompleting}
        setIsCompleting={setIsCompleting}
        onSelectionChange={onSelectionChange}
        onClick={onClick} />
      
    </>);

}

export function StopCardPatientInfoSection({ isStrippedForDriver, isFinishedDelivery, isPickup, isPastDate, patient, currentUser, appUsers = [], preferredTravelMode, onTravelModeChange, travelModeDisabled = false }) {
  if (isStrippedForDriver || isPickup || !patient) return null;

  if (isFinishedDelivery && !isPastDate && patient.notes) {
    return (
      <div className="flex items-start gap-2">
        <Info className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-base font-semibold mb-0.5" style={{ color: 'var(--text-slate-700)' }}>Patient Notes:</p>
          <div className="text-base rounded px-2 py-1.5" style={{ color: 'var(--text-slate-600)', background: 'var(--bg-slate-50)', borderWidth: '1px', borderColor: 'var(--border-slate-200)' }}>
            <p className="whitespace-pre-wrap break-words">{patient.notes}</p>
          </div>
        </div>
      </div>);

  }

  if (!isFinishedDelivery && !isPastDate) {
    return (
      <div className="flex items-start gap-2">
        <Info className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-base font-semibold mb-0.5" style={{ color: 'var(--text-slate-700)' }}>Patient Info:</p>
            <TravelModeButton
              currentUser={currentUser}
              appUsers={appUsers}
              value={preferredTravelMode}
              onChange={onTravelModeChange}
              disabled={travelModeDisabled} />
            
          </div>
          {(patient.notes || patient.mailbox_ok || patient.call_upon_arrival || patient.dont_ring_bell || patient.back_door || patient.recurring) &&
          <div className="text-base rounded px-2 py-1.5 space-y-1" style={{ color: 'var(--text-slate-600)', background: 'var(--bg-slate-50)', borderWidth: '1px', borderColor: 'var(--border-slate-200)' }}>
              {(patient.mailbox_ok || patient.call_upon_arrival || patient.dont_ring_bell || patient.back_door) &&
            <div className="flex flex-wrap gap-1">
                  {patient.mailbox_ok && <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 bg-blue-50 border-blue-200 text-blue-700">Mailbox OK</Badge>}
                  {patient.call_upon_arrival && <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 bg-amber-50 border-amber-200 text-amber-700">Call on Arrival</Badge>}
                  {patient.dont_ring_bell && <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 bg-red-50 border-red-200 text-red-700">Don't Ring Bell</Badge>}
                  {patient.back_door && <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 bg-purple-50 border-purple-200 text-purple-700">Back Door</Badge>}
                </div>
            }
              {patient.recurring &&
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 bg-green-50 border-green-200 text-green-700">
                  {(() => {
                if (patient.recurring_daily) return 'Daily';
                if (patient.recurring_monthly) return 'Monthly';
                if (patient.recurring_bimonthly) return 'Bi-Monthly';
                if (patient.recurring_biweekly) {
                  const days = [];
                  if (patient.recurring_weekly_mon) days.push('Mon');
                  if (patient.recurring_weekly_tue) days.push('Tue');
                  if (patient.recurring_weekly_wed) days.push('Wed');
                  if (patient.recurring_weekly_thu) days.push('Thu');
                  if (patient.recurring_weekly_fri) days.push('Fri');
                  if (patient.recurring_weekly_sat) days.push('Sat');
                  if (patient.recurring_weekly_sun) days.push('Sun');
                  return days.length > 0 ? `Bi-Weekly (${days.join(', ')})` : 'Bi-Weekly';
                }
                if (patient.recurring_weekly_x4) {
                  const dayAbbrevs = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
                  const day = dayAbbrevs[patient.recurring_weekly_x4_day] || patient.recurring_weekly_x4_day;
                  return day ? `4x Weekly (${day})` : '4x Weekly';
                }
                const days = [];
                if (patient.recurring_weekly_mon) days.push('Mon');
                if (patient.recurring_weekly_tue) days.push('Tue');
                if (patient.recurring_weekly_wed) days.push('Wed');
                if (patient.recurring_weekly_thu) days.push('Thu');
                if (patient.recurring_weekly_fri) days.push('Fri');
                if (patient.recurring_weekly_sat) days.push('Sat');
                if (patient.recurring_weekly_sun) days.push('Sun');
                return days.length > 0 ? `Weekly (${days.join(', ')})` : 'Recurring';
              })()}
                </Badge>
            }
              {patient.notes && <p className="whitespace-pre-wrap break-words">{patient.notes}</p>}
            </div>
          }
        </div>
      </div>);

  }

  return null;
}

export function StopCardPendingPickupsSection({ isFinishedDelivery, isPickup, delivery, pendingPickups, canAccessAcceptButtons, isAcceptingAll, handleAcceptAllStops, acceptButtonText, onEdit, patients, store, isAtStoreLocation = false }) {
  if (isFinishedDelivery || !isPickup || delivery.status !== 'en_route' || !pendingPickups || pendingPickups.length === 0) return null;

  return (
    <div className="pt-1 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
      <div className="mb-1 flex items-center justify-between">
         <h4 className="text-base font-bold flex items-center gap-2" style={{ color: 'var(--text-slate-700)' }}>
          <Package className="w-3.5 h-3.5" />
          Pending Pickup List ({pendingPickups.length})
          <HelpTooltip title={HELP_CONTENT.pendingPickups.title} content={HELP_CONTENT.pendingPickups.content} size="sm" />
        </h4>
         {canAccessAcceptButtons && !isAtStoreLocation &&
         <Button size="sm" variant="default" className="inline-flex items-center gap-2 h-6 px-2 text-xs !text-white bg-emerald-600 hover:bg-emerald-700" disabled={isAcceptingAll} onClick={async (e) => {e.stopPropagation();await handleAcceptAllStops();}}>
             {isAcceptingAll && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
             {acceptButtonText}
           </Button>
         }
      </div>

      <div className="space-y-0.5 overflow-y-auto custom-scrollbar max-h-[150px]" onWheel={(e) => {
        const el = e.currentTarget;
        if (el.scrollHeight <= el.clientHeight) return;
        if (e.deltaY < 0) {
          if (el.scrollTop > 0) e.stopPropagation();
        } else if (e.deltaY > 0) {
          if (el.scrollTop < el.scrollHeight - el.clientHeight - 1) e.stopPropagation();
        }
      }}>
        {[...pendingPickups].sort((a, b) => {
          const trA = parseInt(a.tracking_number || '999', 10);
          const trB = parseInt(b.tracking_number || '999', 10);
          return trA - trB;
        }).map((projectedDelivery, idx) => {
          if (!projectedDelivery) return null;
          const deliveryId = projectedDelivery.id || `projected-${delivery.id}-${idx}`;
          const projPatient = patients.find((p) => p?.id === projectedDelivery.patient_id || p?.patient_id === projectedDelivery.patient_id);
          return (
            <div key={deliveryId} className="flex items-center justify-between gap-1 border px-2.5 py-1.0 rounded-md cursor-pointer transition-colors" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }} onMouseEnter={(e) => {e.currentTarget.style.background = 'var(--bg-slate-50)';}} onMouseLeave={(e) => {e.currentTarget.style.background = 'var(--bg-white)';}} onClick={(e) => {e.stopPropagation();if (onEdit && projectedDelivery.id) onEdit(projectedDelivery);}}>
              <span className="text-base font-medium truncate flex-1" style={{ color: 'var(--text-slate-900)' }}>
                {projPatient?.full_name || projectedDelivery.patient_name || 'Unknown Patient'}
              </span>
              <div className="flex items-center gap-1 flex-shrink-0">
                <SpecialSymbolsBadges delivery={projectedDelivery} patient={projPatient} isPickup={false} size="sm" />
                <span className="text-base font-semibold" style={{ color: 'var(--text-slate-600)' }}>
                  {(() => {
                    const storeAbbr = store?.abbreviation?.slice(0, 2).toUpperCase() || 'XX';
                    const trackingNum = parseInt(projectedDelivery.tracking_number) || 0;
                    const formattedNum = trackingNum > 99 ? trackingNum.toString().padStart(3, '0') : trackingNum.toString().padStart(2, '0');
                    return `${storeAbbr}${formattedNum}`;
                  })()}
                </span>
                {canAccessAcceptButtons &&
                <Button size="sm" variant="ghost" className="inline-flex min-h-9 min-w-9 items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:text-accent-foreground rounded-md text-xs h-5 w-5 p-0 ml-1 bg-emerald-100 hover:bg-emerald-200 text-emerald-700" onClick={(e) => {e.stopPropagation();if (onEdit && projectedDelivery.id) onEdit(projectedDelivery);}}>
                    <Plus className="w-3 h-3" />
                  </Button>
                }
              </div>
            </div>);

        })}
      </div>
    </div>);

}

export function StopCardNotesSection({ lastDeliveryBadgeDate, notesInput, setNotesInput, handleNotesBlur, handleNotesKeyDown, delivery, onNotesUpdate, Textarea }) {
  return (
    <div className="space-y-1 mt-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-base font-medium flex items-center gap-1" style={{ color: 'var(--text-slate-700)' }}>Driver Notes</Label>
        {lastDeliveryBadgeDate &&
        <Badge variant="outline" className="text-[11px] px-2 py-1 h-auto bg-slate-50 border-slate-300 text-slate-700 font-semibold whitespace-nowrap">
            LD: {format(parseISO(`${lastDeliveryBadgeDate}T00:00:00`), 'MMM dd, yy')}
          </Badge>
        }
      </div>
      <Textarea
        value={notesInput}
        onChange={(e) => setNotesInput(e.target.value)}
        onFocus={(e) => {
          e.stopPropagation();
          if (notesInput === 'No driver notes') setNotesInput('');
        }}
        onBlur={handleNotesBlur}
        onKeyDown={handleNotesKeyDown}
        onClick={(e) => e.stopPropagation()}
        placeholder=""
        className="text-base resize-none h-24"
        style={{
          background: 'var(--bg-white)',
          borderColor: 'var(--border-slate-200)',
          color: notesInput === 'No driver notes' ? 'var(--text-slate-400)' : 'var(--text-slate-900)',
          fontStyle: notesInput === 'No driver notes' ? 'italic' : 'normal'
        }} />
      
    </div>);

}