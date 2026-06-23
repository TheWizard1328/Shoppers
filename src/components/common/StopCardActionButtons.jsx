import React, { useMemo, useState, useRef, useCallback } from "react";
import { isMobileDevice } from '../utils/deviceUtils';
import { Button } from "@/components/ui/button";
import { CheckCircle, Clock, Loader2, RotateCcw, Undo2 } from "lucide-react";
import StopCardPOD from "./StopCardPOD";
import StopCardFooterMenu from "./StopCardFooterMenu";
import { _cachedSquareAppId as _sharedSquareAppIdCache } from "./StopCard";
import { toast } from "sonner";
import { createPortal } from "react-dom";
import { useAppData } from "../utils/AppDataContext";

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
  const squareIntentUrl = useMemo(() => {
    const effectiveAppId = squareAppId || _sharedSquareAppIdCache;
    if (!effectiveAppId) return null;
    const amountCents = Math.round(Number(delivery?.cod_total_amount_required || 0) * 100);
    if (amountCents <= 0) return null;
    const deliveryNote = generateSquareItemName(delivery, patient, store);
    const squareLocationConfigs = reactiveSquareLocationConfigs;
    const storeConfigId = store?.square_location_config_id || null;
    const matchedConfig = storeConfigId
      ? squareLocationConfigs.find((c) => c?.id === storeConfigId)
      : null;
    const squareLocationId = matchedConfig?.square_location_id ?? null;
    const isBase44Editor = window.location.hostname.includes('base44.com');
    const appCallbackUrl = isBase44Editor
      ? (window.location.origin + window.location.pathname)
      : (window.location.origin);
    const callbackUri = encodeURIComponent('https://play.google.com/store/apps/details?id=com.squareup'); // encodeURIComponent(appCallbackUrl);
    const fallbackUri = encodeURIComponent('https://play.google.com/store/apps/details?id=com.squareup');
    return [
      'intent:#Intent',
      'action=com.squareup.pos.action.CHARGE',
      'package=com.squareup',
      'S.com.squareup.pos.WEB_CALLBACK_URI=' + callbackUri,
      'S.com.squareup.pos.CLIENT_ID=' + effectiveAppId,
      'S.com.squareup.pos.API_VERSION=v2.0',
      ...(squareLocationId ? ['S.com.squareup.pos.LOCATION_ID=' + squareLocationId] : []),
      'i.com.squareup.pos.TOTAL_AMOUNT=' + amountCents,
      'S.com.squareup.pos.CURRENCY_CODE=CAD',
      'S.com.squareup.pos.TENDER_TYPES=com.squareup.pos.TENDER_CARD,com.squareup.pos.TENDER_CASH,com.squareup.pos.TENDER_OTHER',
      'S.com.squareup.pos.NOTE=' + encodeURIComponent(deliveryNote),
      'S.browser_fallback_url=' + fallbackUri,
      'end',
    ].join(';');
  }, [delivery, patient, store, squareAppId, reactiveSquareLocationConfigs]);
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

  // Find the store name of the last completed COD delivery that:
  // 1. Is from a different store than the current delivery
  // 2. That store has a valid Square location ID configured
  // Searches back through stop_order descending until it finds one that qualifies
  const lastCodStoreName = useMemo(() => {
    if (!allDeliveries || !delivery?.driver_id || !delivery?.delivery_date) return null;
    const configs = reactiveSquareLocationConfigs;
    const currentStoreName = squareLocationName || store?.name || null;

    const candidates = (allDeliveries || [])
      .filter((d) =>
        d &&
        d.id !== delivery.id &&
        d.driver_id === delivery.driver_id &&
        d.delivery_date === delivery.delivery_date &&
        d.status === 'completed' &&
        d.cod_total_amount_required > 0 &&
        Array.isArray(d.cod_payments) && d.cod_payments.length > 0 &&
        d.store_id !== delivery.store_id
      )
      .sort((a, b) => (b.stop_order || 0) - (a.stop_order || 0));

    for (const d of candidates) {
      const prevStore = (stores || []).find((s) => s?.id === d.store_id);
      if (!prevStore) continue;
      // Must have a valid Square location config
      const configId = prevStore.square_location_config_id;
      if (!configId) continue;
      const matched = configs.find((c) => c?.id === configId);
      if (!matched?.square_location_id) continue;
      // Must be a different location name than the current delivery's target
      const prevStoreName = matched?.store_name || matched?.name || prevStore.name;
      if (currentStoreName && prevStoreName === currentStoreName) continue;
      return prevStoreName || prevStore.name;
    }
    return null;
  }, [allDeliveries, delivery, stores, squareLocationName, store]);

  // Ref to the hidden anchor — clicked after user confirms location in modal
  const squareAnchorRef = useRef(null);
  const [showSquareConfirm, setShowSquareConfirm] = useState(false);

  // Tap on the visible button — just opens the confirmation modal
  const handleSquareButtonTap = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!squareIntentUrl) { toast.error('Square not ready yet. Please try again.'); return; }
    setShowSquareConfirm(true);
  }, [squareIntentUrl]);

  // User confirmed they are on the correct Square location — fire the anchor
  const handleSquareConfirmed = useCallback(() => {
    setShowSquareConfirm(false);
    // Register visibilitychange to handle return callback from Square
    let squareTookFocus = false;
    const onVisibilityChange = () => {
      if (document.hidden) {
        squareTookFocus = true;
      } else if (squareTookFocus) {
        squareTookFocus = false;
        document.removeEventListener('visibilitychange', onVisibilityChange);
        const params = new URLSearchParams(window.location.search);
        const status = params.get('status');
        const errorCode = params.get('error_code');
        const errorDescription = params.get('error_description');
        if (status) {
          const evt = status === 'ok' ? 'squarePaymentSuccess' : 'squarePaymentCancelled';
          window.dispatchEvent(new CustomEvent(evt, { detail: { deliveryId: delivery?.id, errorCode, errorDescription } }));
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    setTimeout(() => document.removeEventListener('visibilitychange', onVisibilityChange), 10 * 60 * 1000);
    // Click the real hidden anchor — native browser navigation
    if (squareAnchorRef.current) squareAnchorRef.current.click();
  }, [delivery]);

  // Opens Square POS with no transaction payload — driver switches location manually
  const handleSquareManual = useCallback((e) => {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    setShowSquareConfirm(false);
    const isNative = typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
    if (isNative) {
      window.open('square-commerce-v1://', '_system');
      return;
    }
    const fallbackUri = encodeURIComponent('https://play.google.com/store/apps/details?id=com.squareup');
    const openUri = 'intent:#Intent;action=android.intent.action.MAIN;package=com.squareup;S.browser_fallback_url=' + fallbackUri + ';end';
    window.location.href = openUri;
  }, [squareAppId]);

  const handleSquareLaunch = (e) => {
    // Capacitor APK only: intercept the anchor and use the native bridge
    const isNative = typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
    if (isNative) {
      e.preventDefault();
      e.stopPropagation();
      const effectiveAppId = squareAppId || _sharedSquareAppIdCache;
      if (!effectiveAppId) { toast.error('Square not ready yet.'); return; }
      const amountCents = Math.round(Number(delivery?.cod_total_amount_required || 0) * 100);
      if (amountCents <= 0) { toast.error('No COD amount set for this delivery.'); return; }
      const deliveryNote = generateSquareItemName(delivery, patient, store);
      const customUri = 'square-commerce-v1://payment/create?data=' +
        encodeURIComponent([
          'client_id=' + effectiveAppId,
          'version=1.3',
          'amount_money[amount]=' + amountCents,
          'amount_money[currency_code]=CAD',
          'notes=' + deliveryNote,
        ].join('&'));
      console.log('[Square] Native bridge launch:', customUri);
      window.open(customUri, '_system');
    }
    // PWA: do nothing — browser handles <a href> natively
  };


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
          {squareIntentUrl && (
            <a
              ref={squareAnchorRef}
              href={squareIntentUrl}
              onClick={(e) => handleSquareLaunch(e)}
              aria-hidden="true"
              tabIndex={-1}
              style={{ position: 'fixed', top: '-9999px', left: '-9999px', opacity: 0, pointerEvents: 'none' }}
            />
          )}
          <button
            type="button"
            disabled={!hasValidSquareLocation}
            onTouchEnd={(e) => { if (!hasValidSquareLocation) return; e.stopPropagation(); e.preventDefault(); handleSquareButtonTap(e); }}
            onClick={(e) => { if (!hasValidSquareLocation) return; e.stopPropagation(); e.preventDefault(); handleSquareButtonTap(e); }}
            style={{ WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation' }}
            className={`inline-flex items-center justify-center rounded-md border transition-colors mr-2 flex-shrink-0 relative z-30 min-h-11 min-w-11 h-10 md:h-8 w-10 md:w-8 pointer-events-auto ${hasValidSquareLocation ? 'border-slate-400 bg-slate-100 hover:bg-slate-200' : 'border-slate-300 bg-slate-50 opacity-40 cursor-not-allowed'}`}
            title={hasValidSquareLocation ? 'Collect COD with Square POS' : 'No Square location configured for this store'}>
            <img
              src="https://media.base44.com/images/public/68570f3cd01bfa2d2408a9d6/cc4cb3e37_Screenshot_20260605_155930_OneUIHome.png"
              alt="Square POS"
              className="w-6 h-6 md:w-5 md:h-5 rounded-md object-cover" />
          </button>
          {showSquareConfirm && createPortal(
            <div
              className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4"
              onTouchEnd={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}>
              <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl p-5 max-w-sm w-full border border-transparent dark:border-gray-700 relative">
                <button
                  type="button"
                  onTouchEnd={(e) => { e.stopPropagation(); e.preventDefault(); setShowSquareConfirm(false); }}
                  onClick={(e) => { e.stopPropagation(); setShowSquareConfirm(false); }}
                  className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-1">
                  ✕
                </button>
                <div className="flex items-start gap-3 mb-5">
                  <span className="text-2xl leading-none mt-0.5">⚠️</span>
                  <div>
                    <p className="font-semibold text-gray-900 dark:text-gray-100 text-base">Switch Square Location First</p>
                    <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">This delivery requires Square to be set to:</p>
                    <p className="font-bold text-gray-900 dark:text-white text-xl mt-1">
                      {squareLocationName || store?.name || 'the correct location'}
                    </p>
                    {lastCodStoreName && (
                      <p className="text-amber-600 dark:text-amber-400 text-sm mt-1 font-medium">
                        Last COD collected was from: <span className="font-bold">{lastCodStoreName}</span>
                      </p>
                    )}
                    <p className="text-gray-400 dark:text-gray-500 text-xs mt-2 leading-relaxed">
                      Square always processes under its active location — not the one passed by the app.
                    </p>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onTouchEnd={(e) => { e.stopPropagation(); e.preventDefault(); handleSquareConfirmed(); }}
                    onClick={(e) => { e.stopPropagation(); handleSquareConfirmed(); }}
                    className="w-full py-3 rounded-lg bg-emerald-600 active:bg-emerald-700 text-white font-semibold text-sm">
                    ✅ I'm on the right location — Charge
                  </button>
                  <button
                    type="button"
                    onTouchEnd={(e) => { e.stopPropagation(); e.preventDefault(); handleSquareManual(e); }}
                    onClick={(e) => { e.stopPropagation(); handleSquareManual(e); }}
                    className="w-full py-3 rounded-lg bg-blue-600 active:bg-blue-700 text-white font-medium text-sm">
                    🔀 Open Square — switch location &amp; select manually
                  </button>
                  <button
                    type="button"
                    onTouchEnd={(e) => { e.stopPropagation(); e.preventDefault(); setShowSquareConfirm(false); }}
                    onClick={(e) => { e.stopPropagation(); setShowSquareConfirm(false); }}
                    className="w-full py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 font-medium text-sm active:bg-gray-50 dark:active:bg-gray-800">
                    Dismiss
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )}
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
        {delivery.status !== 'failed' && ['completed', 'cancelled'].includes(delivery.status) && onRestart &&
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