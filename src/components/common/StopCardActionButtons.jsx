import React, { useMemo, useCallback } from "react";
import { isMobileDevice } from '../utils/deviceUtils';
import { Button } from "@/components/ui/button";
import { CheckCircle, Clock, Loader2, RotateCcw, Undo2 } from "lucide-react";
import StopCardPOD from "./StopCardPOD";
import StopCardFooterMenu from "./StopCardFooterMenu";
import { _cachedSquareAppId as _sharedSquareAppIdCache } from "./StopCard";
import { toast } from "sonner";
import { useAppData } from "../utils/AppDataContext";
import { launchSquarePOS } from "../utils/squarePOSLauncher";
import { remoteLogger } from "../utils/remoteLogger";
import { useSquareLocationCheck } from "../dashboard/useSquareLocationCheck";

// Generate the Square item name: "MM/DD(StoreAbbr)-PatientName"
const generateSquareItemName = (delivery, patient, store) => {
  const dateStr = delivery?.delivery_date || '';
  const [, month, day] = dateStr.split('-');
  const datePart = month && day ? `${month}/${day}` : dateStr;
  const storeAbbr = store?.abbreviation || store?.name?.substring(0, 2).toUpperCase() || '??';
  const patientName = patient?.full_name || delivery?.patient_name || 'Unknown';
  return `${datePart}(${storeAbbr})-${patientName}`;
};

export default function StopCardActionButtons(props) {
  const {
    delivery,
    isPickup,
    onStatusUpdate,
    handleRetryDelivery,
    blockCardToggle,
    isRetrying,
    isProcessingBackground,
    canRetry,
    hasFutureRetry,
    hasCompletedDelivery,
    isFailing,
    handleReturnClick,
    isPreparingReturn,
    isCreatingReturn,
    hasFutureReturn,
    onRestart,
    routeCompleted,
    isPastDeliveryDate,
    restartCurrentDelivery,
    isRestarting,
    patient,
    displayName,
    isNextDelivery,
    isFinishedDelivery,
    viewingImageUrl,
    setViewingImageUrl,
    showSignatureCapture,
    setShowSignatureCapture,
    showPhotoCapture,
    setShowPhotoCapture,
    forceRefreshDriverDeliveries,
    currentUser,
    handleCompleteAction,
    isCompleting,
    isGlobalCompleteLocked,
    isGlobalRestartLocked,
    handleStartAction,
    isCurrentCardStartLocked,
    onStartDelivery,
    hasCODRequired,
    isCODComplete,
    squareAppId,
    store,
    allDeliveries,
    stores,
  } = props;

  // Reactive Square location configs — from AppDataContext (avoids stale window cache)
  const appData = useAppData();
  const reactiveSquareLocationConfigs = useMemo(() => {
    // Prefer AppDataContext value (reactive), fall back to window cache for SSR/test compatibility
    const ctxConfigs = appData?.squareLocationConfigs;
    if (Array.isArray(ctxConfigs) && ctxConfigs.length > 0) return ctxConfigs;
    return window.__squareLocationConfigCache || [];
  }, [appData?.squareLocationConfigs]);

  // Square POS launcher — builds intent URL synchronously and fires it.
  // CRITICAL: Must remain synchronous so the anchor .click() stays within the user gesture
  // context on both mouse and touch (async functions lose gesture trust on Android WebView).
  // CRITICAL: Never call alert() inside touch handlers on Android — it crashes the WebView.
  // Build the Square POS intent URL at render time so the <a href> is a real,
  // browser-native link. When the user taps it, the browser handles navigation
  // directly — no programmatic JS navigation, no location.href, no window.open.
  // Chrome Android only allows intent:// to reach the Activity Manager from a
  // genuine user-gesture anchor click; this is the most reliable way to do that.

  // Human-readable Square location name for the confirmation modal
  const squareLocationName = useMemo(() => {
    const configs = reactiveSquareLocationConfigs;
    const storeConfigId = store?.square_location_config_id || null;
    if (!storeConfigId) return store?.name || null;
    const matched = configs.find((c) => c?.id === storeConfigId);
    return matched?.store_name || matched?.name || store?.name || null;
  }, [store, reactiveSquareLocationConfigs]);

  // Only enable Square button if the delivery's store has a square_location_config_id
  // that maps to a SquareLocationConfig record with a valid square_location_id.
  const hasValidSquareLocation = useMemo(() => {
    const storeConfigId = store?.square_location_config_id || null;
    if (!storeConfigId) return false;
    const configs = reactiveSquareLocationConfigs;
    if (configs.length === 0) return false; // not loaded yet — keep disabled
    const matched = configs.find((c) => c?.id === storeConfigId);
    return !!(matched?.square_location_id);
  }, [store, reactiveSquareLocationConfigs]);

  // Current delivery's Square location_id (the one the driver needs to be on)
  const currentSquareLocationId = useMemo(() => {
    const storeConfigId = store?.square_location_config_id || null;
    if (!storeConfigId) return null;
    const matched = reactiveSquareLocationConfigs.find((c) => c?.id === storeConfigId);
    return matched?.square_location_id || null;
  }, [store, reactiveSquareLocationConfigs]);

  // Live Square location check — queries the Square API for the most recent transaction
  // on the expected location to verify the driver's reader is active there.
  // Resolve driver name for Square team member matching — use the AppUser record's
  // user_name (the name set inside the app, matching what Square team members use),
  // NOT the platform full_name which may be an email or platform display name.
  const driverNameForPeek = useMemo(() => {
    const appUsers = appData?.appUsers || [];
    const myAppUser = appUsers.find((u) => u?.user_id === currentUser?.id);
    return myAppUser?.user_name || null;
  }, [appData?.appUsers, currentUser?.id]);

  const squareLocationStatus = useSquareLocationCheck({
    isNextDelivery,
    hasCODRequired,
    isCODComplete,
    expectedLocationId: currentSquareLocationId,
    driverName: driverNameForPeek,
  });

  // True if this is the first COD delivery the driver has attempted today.
  // "Attempted" = a prior COD stop for the same driver/date already has cod_payments recorded.
  // If no prior COD payments exist, the reader hasn't been used yet today → launch bare.
  const isFirstCodOfDay = useMemo(() => {
    if (!delivery?.driver_id || !delivery?.delivery_date) return true;
    const priorWithPayment = (allDeliveries || []).some(
      (d) =>
        d &&
        d.id !== delivery.id &&
        d.driver_id === delivery.driver_id &&
        d.delivery_date === delivery.delivery_date &&
        d.cod_total_amount_required > 0 &&
        Array.isArray(d.cod_payments) && d.cod_payments.length > 0
    );
    return !priorWithPayment;
  }, [allDeliveries, delivery]);

  // Direct synchronous Square POS launch — no modal, no state change before dispatch.
  // CRITICAL: Must stay synchronous within the gesture handler to preserve gesture trust
  // on Android WebView. Any React state update before launchSquarePOS breaks the chain.
  const handleSquareButtonTap = useCallback((e) => {
    e.stopPropagation();
    const effectiveAppId = squareAppId || _sharedSquareAppIdCache;
    const codAmount = delivery?.cod_total_amount_required;
    remoteLogger.info('[Square] Button tapped (direct launch)', JSON.stringify({
      hasAppId: !!effectiveAppId, codAmount, deliveryId: delivery?.id, storeId: store?.id,
      squareLocationStatus, isFirstCodOfDay,
    }));
    if (!effectiveAppId) {
      toast.error('Square not ready yet — App ID missing.');
      return;
    }

    const callbackUrl = window.location.origin + window.location.pathname;

    // Bare launch (no amount) on first COD of day or location mismatch —
    // opens Square POS so driver can confirm/set their location before the real charge.
    const launchBare = squareLocationStatus === 'mismatch' || isFirstCodOfDay;
    if (launchBare) {
      launchSquarePOS({ squareAppId: effectiveAppId, callbackUrl });
      return;
    }

    const amountCents = Math.round(Number(codAmount || 0) * 100);
    if (amountCents <= 0) {
      toast.error('No COD amount set for this delivery.');
      return;
    }
    const notes = generateSquareItemName(delivery, patient, store);
    launchSquarePOS({ squareAppId: effectiveAppId, amountCents, currencyCode: 'CAD', callbackUrl, notes, locationId: currentSquareLocationId });
  }, [delivery, patient, store, squareAppId, currentSquareLocationId, squareLocationStatus, isFirstCodOfDay]);




  if (delivery.status === 'failed' && !isPickup) {
    return (
      <div className="flex items-center gap-2 w-full relative z-20">
        {onStatusUpdate &&
        <Button data-stopcard-action="retry" type="button" onPointerDownCapture={handleRetryDelivery} onMouseDown={blockCardToggle} onTouchStart={blockCardToggle} onClick={blockCardToggle} size="sm" className="bg-blue-600 hover:bg-blue-700 h-10 !text-white text-sm flex-1 relative z-30 pointer-events-auto" disabled={isRetrying || isProcessingBackground || !canRetry || hasFutureRetry || hasCompletedDelivery || isFailing}>
            {isRetrying || isProcessingBackground ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
            <span className="text-white">Retry</span>
          </Button>
        }
        <Button data-stopcard-action="return" type="button" onPointerDownCapture={handleReturnClick} onMouseDown={blockCardToggle} onTouchStart={blockCardToggle} onClick={blockCardToggle} size="sm" className="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow rounded-md px-4 text-sm bg-orange-600 hover:bg-orange-700 !text-white h-10 flex-1 relative z-30 pointer-events-auto" disabled={isPreparingReturn || isCreatingReturn || hasFutureReturn || hasCompletedDelivery || isFailing}>
          {isPreparingReturn ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <Undo2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
          Return
        </Button>
        <div className="flex items-center ml-auto">
          {onRestart && ['completed', 'failed', 'cancelled'].includes(delivery.status) && !routeCompleted && !isPastDeliveryDate &&
          <Button onClick={async (e) => {e.stopPropagation();await restartCurrentDelivery(false);}} size="sm" className="bg-[#ff0000] text-primary-foreground px-3 text-sm font-medium rounded-r-none inline-flex min-h-11 min-w-11 items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-blue-700 h-10 border-r border-blue-500 !text-white" disabled={isRestarting || isProcessingBackground || isFailing}>
              {isRestarting || isProcessingBackground ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
              <span className="text-white">Restart</span>
            </Button>
          }
          <div className="relative z-[60] pointer-events-auto">
          <StopCardFooterMenu {...props} />
        </div>
        </div>
      </div>);

  }

  return (
    <>
      <StopCardPOD
        delivery={delivery}
        patient={patient}
        displayName={displayName}
        isNextDelivery={isNextDelivery}
        isFinishedDelivery={isFinishedDelivery}
        isPickup={isPickup}
        viewingImageUrl={viewingImageUrl}
        setViewingImageUrl={setViewingImageUrl}
        showSignatureCapture={showSignatureCapture}
        setShowSignatureCapture={setShowSignatureCapture}
        showPhotoCapture={showPhotoCapture}
        setShowPhotoCapture={setShowPhotoCapture}
        forceRefreshDriverDeliveries={forceRefreshDriverDeliveries}
        currentUser={currentUser} />
      
      <div className="flex items-center ml-auto">
        {!isPickup &&
         hasCODRequired &&
         !isCODComplete &&
         Array.isArray(currentUser?.app_roles) && currentUser.app_roles.includes('driver') &&
         isMobileDevice() &&
        <>

          <div className="relative mr-2 flex-shrink-0">
            <button
              type="button"
              disabled={!hasValidSquareLocation}
              onPointerDown={(e) => { e.stopPropagation(); }}
              onTouchStart={(e) => { e.stopPropagation(); }}
              onClick={(e) => { e.stopPropagation(); if (!hasValidSquareLocation) return; handleSquareButtonTap(e); }}
              style={{ WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation' }}
              className={`inline-flex items-center justify-center rounded-md border transition-colors flex-shrink-0 relative z-30 min-h-11 min-w-11 h-10 md:h-8 w-10 md:w-8 pointer-events-auto ${hasValidSquareLocation ? 'border-slate-400 bg-slate-100 hover:bg-slate-200' : 'border-slate-300 bg-slate-50 opacity-40 cursor-not-allowed'}`}
              title={hasValidSquareLocation ? 'Collect COD with Square POS' : 'No Square location configured for this store'}>
              <img
                src="https://media.base44.com/images/public/68570f3cd01bfa2d2408a9d6/cc4cb3e37_Screenshot_20260605_155930_OneUIHome.png"
                alt="Square POS"
                className="w-6 h-6 md:w-5 md:h-5 rounded-md object-cover" />
            </button>
            {squareLocationStatus === 'loading' ? (
              <span className="absolute -top-1.5 -left-1.5 flex items-center justify-center w-4 h-4 rounded-full bg-slate-400 z-40 pointer-events-none">
                <Loader2 className="w-2.5 h-2.5 text-white animate-spin" />
              </span>
            ) : squareLocationStatus === 'mismatch' ? (
              <span className="absolute -top-1.5 -left-1.5 flex items-center justify-center w-4 h-4 rounded-full bg-amber-500 text-white text-[9px] font-bold leading-none z-40 pointer-events-none">
                ⚠
              </span>
            ) : squareLocationStatus === 'verified' ? (
              <span className="absolute -top-1.5 -left-1.5 flex items-center justify-center w-4 h-4 rounded-full bg-emerald-500 text-white text-[9px] font-bold leading-none z-40 pointer-events-none">
                ✓
              </span>
            ) : null}
          </div>
        </>
        }
        {delivery.status !== 'completed' && delivery.status !== 'cancelled' && delivery.status !== 'failed' && (
        isNextDelivery ?
        <Button data-stopcard-action="complete" type="button" onClickCapture={blockCardToggle} onPointerDownCapture={handleCompleteAction} onPointerDown={(e) => {e.preventDefault();e.stopPropagation();}} onMouseDown={(e) => {e.preventDefault();e.stopPropagation();}} onTouchStart={(e) => {e.preventDefault();e.stopPropagation();}} onClick={(e) => {e.preventDefault();e.stopPropagation();}} size="sm" disabled={isCompleting || isProcessingBackground || isFailing || isGlobalCompleteLocked || isGlobalRestartLocked} className={`rounded-md px-4 text-sm font-medium rounded-r-none inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow h-10 border-r !text-white ${isFailing ? 'bg-red-600 hover:bg-red-700 border-red-500' : 'bg-emerald-600 hover:bg-emerald-700 border-emerald-500'}`}>
              {isCompleting || isProcessingBackground || isFailing || isGlobalCompleteLocked || isGlobalRestartLocked ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <CheckCircle className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
              <span className="text-white">Complete</span>
            </Button> :
        onStartDelivery &&
        <Button data-stopcard-action="start" type="button" onPointerDownCapture={handleStartAction} onClickCapture={blockCardToggle} onPointerDown={(e) => {e.preventDefault();e.stopPropagation();}} onMouseDown={(e) => {e.preventDefault();e.stopPropagation();}} onTouchStart={(e) => {e.preventDefault();e.stopPropagation();}} onClick={(e) => {e.preventDefault();e.stopPropagation();}} size="sm" disabled={isCurrentCardStartLocked || isProcessingBackground || isCompleting || isFailing || isRetrying || isRestarting} className="bg-blue-600 px-4 text-sm font-medium rounded-r-none inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-blue-700 h-10 border-r border-blue-500 !text-white" title="Start this delivery">
              {isCurrentCardStartLocked ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <Clock className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
              <span className="text-white">Start</span>
            </Button>)

        }
        {delivery.status !== 'failed' && ['completed', 'cancelled'].includes(delivery.status) && onRestart && !routeCompleted &&
        <Button data-stopcard-action="restart" type="button" onPointerDownCapture={async (e) => {blockCardToggle(e);if (isRestarting || isProcessingBackground || isFailing) return;await restartCurrentDelivery(false);}} onPointerDown={blockCardToggle} onMouseDown={blockCardToggle} onTouchStart={blockCardToggle} onClick={blockCardToggle} size="sm" className="bg-[#ff0000] text-primary-foreground px-3 text-sm font-medium rounded-r-none inline-flex min-h-11 min-w-11 items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-blue-700 h-10 border-r border-blue-500 !text-white" disabled={isRestarting || isProcessingBackground || isFailing}>
            {isRestarting || isProcessingBackground || isFailing ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
            <span className="text-white">Restart</span>
          </Button>
        }
        <div className="relative z-[60] pointer-events-auto">
          <StopCardFooterMenu {...props} />
        </div>
      </div>
    </>);

}