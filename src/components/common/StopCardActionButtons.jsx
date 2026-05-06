import React from "react";
import { Button } from "@/components/ui/button";
import { CheckCircle, Clock, Loader2, RotateCcw, Undo2 } from "lucide-react";
import StopCardPOD from "./StopCardPOD";
import StopCardFooterMenu from "./StopCardFooterMenu";

const stopCardButtonPress = (e) => {
  e.preventDefault();
  e.stopPropagation();
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
    onStartDelivery
  } = props;

  if (delivery.status === 'failed' && !isPickup) {
    return (
      <div className="flex items-center gap-2 w-full relative z-20">
        {onStatusUpdate && (
          <Button
            data-stopcard-action="retry"
            type="button"
            onPointerDown={stopCardButtonPress}
            onMouseDown={stopCardButtonPress}
            onTouchStart={stopCardButtonPress}
            onClick={handleRetryDelivery}
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 h-10 !text-white text-sm flex-1 relative z-30 pointer-events-auto"
            disabled={isRetrying || isProcessingBackground || !canRetry || hasFutureRetry || hasCompletedDelivery || isFailing}
          >
            {isRetrying || isProcessingBackground ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
            <span className="text-white">Retry</span>
          </Button>
        )}
        <Button data-stopcard-action="return" type="button" onClick={handleReturnClick} size="sm" className="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow rounded-md px-4 text-sm bg-orange-600 hover:bg-orange-700 !text-white h-10 flex-1 relative z-30 pointer-events-auto" disabled={isPreparingReturn || isCreatingReturn || hasFutureReturn || hasCompletedDelivery || isFailing}>
          {isPreparingReturn ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <Undo2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
          Return
        </Button>
        <div className="flex items-center ml-auto">
          {onRestart && ['completed', 'failed', 'cancelled'].includes(delivery.status) && !routeCompleted && !isPastDeliveryDate && (
            <Button
              data-stopcard-action="restart"
              type="button"
              onPointerDown={stopCardButtonPress}
              onMouseDown={stopCardButtonPress}
              onTouchStart={stopCardButtonPress}
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                await restartCurrentDelivery(false);
              }}
              size="sm"
              className="bg-[#ff0000] text-primary-foreground px-3 text-sm font-medium rounded-r-none inline-flex min-h-11 min-w-11 items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-blue-700 h-10 border-r border-blue-500 !text-white"
              disabled={isRestarting || isProcessingBackground || isFailing}
            >
              {isRestarting || isProcessingBackground ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
              <span className="text-white">Restart</span>
            </Button>
          )}
          <div className="relative z-[60] pointer-events-auto">
          <StopCardFooterMenu {...props} />
        </div>
        </div>
      </div>
    );
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
        currentUser={currentUser}
      />
      <div className="flex items-center ml-auto">
        {delivery.status !== 'completed' && delivery.status !== 'cancelled' && delivery.status !== 'failed' && (
          isNextDelivery ? (
            <Button data-stopcard-action="complete" type="button" onClickCapture={blockCardToggle} onPointerDownCapture={handleCompleteAction} onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }} onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }} onClick={(e) => { e.preventDefault(); e.stopPropagation(); }} size="sm" disabled={isCompleting || isProcessingBackground || isFailing || isGlobalCompleteLocked || isGlobalRestartLocked} className={`rounded-md px-4 text-sm font-medium rounded-r-none inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow h-10 border-r !text-white ${isFailing ? 'bg-red-600 hover:bg-red-700 border-red-500' : 'bg-emerald-600 hover:bg-emerald-700 border-emerald-500'}`}>
              {isCompleting || isProcessingBackground || isFailing || isGlobalCompleteLocked || isGlobalRestartLocked ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <CheckCircle className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
              <span className="text-white">Complete</span>
            </Button>
          ) : onStartDelivery && (
            <Button data-stopcard-action="start" type="button" onPointerDownCapture={handleStartAction} onClickCapture={blockCardToggle} onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }} onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }} onClick={(e) => { e.preventDefault(); e.stopPropagation(); }} size="sm" disabled={isCurrentCardStartLocked || isProcessingBackground || isCompleting || isFailing || isRetrying || isRestarting} className="bg-blue-600 px-4 text-sm font-medium rounded-r-none inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-blue-700 h-10 border-r border-blue-500 !text-white" title="Start this delivery">
              {isCurrentCardStartLocked ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <Clock className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
              <span className="text-white">Start</span>
            </Button>
          )
        )}
        {delivery.status !== 'failed' && ['completed', 'cancelled'].includes(delivery.status) && onRestart && !routeCompleted && (
          <Button
            data-stopcard-action="restart"
            type="button"
            onPointerDown={stopCardButtonPress}
            onMouseDown={stopCardButtonPress}
            onTouchStart={stopCardButtonPress}
            onClick={async (e) => {
              e.preventDefault();
              e.stopPropagation();
              if (isRestarting || isProcessingBackground || isFailing) return;
              await restartCurrentDelivery(false);
            }}
            size="sm"
            className="bg-[#ff0000] text-primary-foreground px-3 text-sm font-medium rounded-r-none inline-flex min-h-11 min-w-11 items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-blue-700 h-10 border-r border-blue-500 !text-white"
            disabled={isRestarting || isProcessingBackground || isFailing}
          >
            {isRestarting || isProcessingBackground || isFailing ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
            <span className="text-white">Restart</span>
          </Button>
        )}
        <div className="relative z-[60] pointer-events-auto">
          <StopCardFooterMenu {...props} />
        </div>
      </div>
    </>
  );
}