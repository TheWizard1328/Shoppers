import React from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator
} from "@/components/ui/dropdown-menu";
import { CheckCircle, Clock, Edit, Loader2, Locate, MoreVertical, RotateCcw, Trash2, Undo2, User, XCircle } from "lucide-react";
import StopCardPOD from "./StopCardPOD";

export default function StopCardFooter(props) {
  const {
    shouldAnchorExpandedCard,
    showCenteredIncompleteCollapsed,
    shouldCondenseCompletedRouteForDriver,
    isAppOwner,
    userHasRole,
    currentUser,
    isAssignedDriverOrAppOwner,
    canEdit,
    delivery,
    isPickup,
    patient,
    store,
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
    showDeleteConfirm,
    setShowDeleteConfirm,
    isStrippedForDispatcher,
    onEdit,
    onEditPatient,
    handleUpdateGPS,
    onStatusUpdate,
    blockCardToggle,
    setPendingFailureStatus,
    setShowFailureReasonDialog,
    routeCompleted,
    isPastDeliveryDate,
    onRestart,
    restartCurrentDelivery,
    isRestarting,
    isProcessingBackground,
    isFailing,
    isCompleting,
    isGlobalCompleteLocked,
    isGlobalRestartLocked,
    startTapLockRef,
    handleStartAction,
    isCurrentCardStartLocked,
    isStarting,
    isRetrying,
    handleRetryDelivery,
    canRetry,
    hasFutureRetry,
    hasCompletedDelivery,
    handleReturnClick,
    isPreparingReturn,
    isCreatingReturn,
    hasFutureReturn,
    onDelete,
    isExpanded,
    pendingPickups,
    appUsers,
    stores
  } = props;

  const shouldShowFooter = (() => {
    if (shouldCondenseCompletedRouteForDriver) return false;
    if (userHasRole(currentUser, 'dispatcher') && !isExpanded) return false;
    if (!isAppOwner(currentUser) && !userHasRole(currentUser, 'admin') && isStrippedForDispatcher) return false;
    if (isExpanded) return true;
    return isAppOwner(currentUser) || userHasRole(currentUser, 'admin') || isAssignedDriverOrAppOwner;
  })();

  if (!shouldShowFooter) return null;

  return (
    <div className={shouldAnchorExpandedCard ? 'sticky bottom-0 z-10' : ''} style={shouldAnchorExpandedCard ? { background: 'var(--bg-white)' } : undefined}>
      <div className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
        <div className={`mx-1 flex justify-between items-center ${showCenteredIncompleteCollapsed ? 'mt-1 mb-0' : 'my-1'}`}>
          {(isAppOwner(currentUser) || userHasRole(currentUser, 'admin') || isAssignedDriverOrAppOwner || canEdit) && (
            <>
              {delivery.status === 'failed' && !isPickup ? (
                <div className="flex items-center gap-2 w-full relative z-20">
                  {onStatusUpdate && (
                    <Button data-stopcard-action="retry" type="button" onPointerDownCapture={handleRetryDelivery} onMouseDown={blockCardToggle} onTouchStart={blockCardToggle} onClick={blockCardToggle} size="sm" className="bg-blue-600 hover:bg-blue-700 h-10 !text-white text-sm flex-1 relative z-30 pointer-events-auto" disabled={isRetrying || isProcessingBackground || !canRetry || hasFutureRetry || hasCompletedDelivery || isFailing}>
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
                      <Button onClick={async (e) => { e.stopPropagation(); await restartCurrentDelivery(false); }} size="sm" className="bg-[#ff0000] text-primary-foreground px-3 text-sm font-medium rounded-r-none inline-flex min-h-11 min-w-11 items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-blue-700 h-10 border-r border-blue-500 !text-white" disabled={isRestarting || isProcessingBackground || isFailing}>
                        {isRestarting || isProcessingBackground ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
                        <span className="text-white">Restart</span>
                      </Button>
                    )}
                    <FooterMenu {...props} />
                  </div>
                </div>
              ) : (
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
                        <Button data-stopcard-action="complete" type="button" onClickCapture={blockCardToggle} onPointerDownCapture={props.handleCompleteAction} onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }} onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }} onClick={(e) => { e.preventDefault(); e.stopPropagation(); }} size="sm" disabled={isCompleting || isProcessingBackground || isFailing || isGlobalCompleteLocked || isGlobalRestartLocked} className={`rounded-md px-4 text-sm font-medium rounded-r-none inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow h-10 border-r !text-white ${isFailing ? 'bg-red-600 hover:bg-red-700 border-red-500' : 'bg-emerald-600 hover:bg-emerald-700 border-emerald-500'}`}>
                          {isCompleting || isProcessingBackground || isFailing || isGlobalCompleteLocked || isGlobalRestartLocked ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <CheckCircle className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
                          <span className="text-white">Complete</span>
                        </Button>
                      ) : props.onStartDelivery && (
                        <Button data-stopcard-action="start" type="button" onPointerDownCapture={handleStartAction} onClickCapture={(e) => { e.preventDefault(); e.stopPropagation(); }} onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }} onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }} onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }} onClick={(e) => { e.preventDefault(); e.stopPropagation(); }} size="sm" disabled={isCurrentCardStartLocked || isProcessingBackground || isCompleting || isFailing || isRetrying || isRestarting} className="bg-blue-600 px-4 text-sm font-medium rounded-r-none inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-blue-700 h-10 border-r border-blue-500 !text-white" title="Start this delivery">
                          {isCurrentCardStartLocked ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <Clock className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
                          <span className="text-white">Start</span>
                        </Button>
                      )
                    )}
                    {delivery.status !== 'failed' && ['completed', 'cancelled'].includes(delivery.status) && onRestart && !routeCompleted && (
                      <Button data-stopcard-action="restart" type="button" onPointerDownCapture={async (e) => { blockCardToggle(e); if (isRestarting || isProcessingBackground || isFailing) return; await restartCurrentDelivery(false); }} onPointerDown={blockCardToggle} onMouseDown={blockCardToggle} onTouchStart={blockCardToggle} onClick={blockCardToggle} size="sm" className="bg-[#ff0000] text-primary-foreground px-3 text-sm font-medium rounded-r-none inline-flex min-h-11 min-w-11 items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-blue-700 h-10 border-r border-blue-500 !text-white" disabled={isRestarting || isProcessingBackground || isFailing}>
                        {isRestarting || isProcessingBackground || isFailing ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
                        <span className="text-white">Restart</span>
                      </Button>
                    )}
                    <FooterMenu {...props} />
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FooterMenu(props) {
  const {
    blockCardToggle,
    currentUser,
    isAppOwner,
    userHasRole,
    onEdit,
    isStrippedForDispatcher,
    delivery,
    onEditPatient,
    patient,
    isPickup,
    handleUpdateGPS,
    isNextDelivery,
    isFinishedDelivery,
    onStatusUpdate,
    setPendingFailureStatus,
    setShowFailureReasonDialog,
    onDelete,
    setShowDeleteConfirm,
    routeCompleted,
    onRestart,
    isPastDeliveryDate,
    isAssignedDriverOrAppOwner,
    canEdit
  } = props;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="bg-transparent text-sm font-medium rounded-md inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:text-accent-foreground h-10 w-10 border border-slate-300 hover:bg-slate-100 relative z-[10]" onClick={(e) => e.stopPropagation()}>
          <MoreVertical className="w-5 h-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="p-1 rounded-md min-w-[8rem] overflow-hidden border-2 shadow-md z-[9999]" sideOffset={5} onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
        {onEdit && !isStrippedForDispatcher && (isAppOwner(currentUser) || userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver') && delivery.driver_id === currentUser.id && !routeCompleted || canEdit) && (
          <DropdownMenuItem onClick={(e) => { blockCardToggle(e); e.stopPropagation(); onEdit(delivery); }} className="text-base py-2.5 md:py-1.5">
            <Edit className="w-5 h-5 mr-2" />{isPickup ? 'Edit Pickup' : 'Edit Delivery'}
          </DropdownMenuItem>
        )}
        {onEditPatient && patient && !isPickup && !isStrippedForDispatcher && isAppOwner(currentUser) && (
          <DropdownMenuItem onClick={(e) => { blockCardToggle(e); e.stopPropagation(); onEditPatient(patient); }} className="text-base py-2.5 md:py-1.5">
            <User className="w-5 h-5 mr-2" />Edit Patient
          </DropdownMenuItem>
        )}
        {(isNextDelivery || isFinishedDelivery) && !isPickup && patient && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (
          <DropdownMenuItem onClick={(e) => { blockCardToggle(e); handleUpdateGPS(e); }} className="text-base py-2.5 md:py-1.5">
            <Locate className="w-5 h-5 mr-2" />Update GPS
          </DropdownMenuItem>
        )}
        {delivery.status !== 'completed' && delivery.status !== 'cancelled' && delivery.status !== 'failed' && isNextDelivery && onStatusUpdate && (
          <>
            <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />
            <DropdownMenuItem onClick={(e) => { blockCardToggle(e); e.stopPropagation(); setPendingFailureStatus(isPickup ? 'cancelled' : 'failed'); setShowFailureReasonDialog(true); }} className="text-red-600 text-base py-2.5 md:py-1.5">
              <XCircle className="w-5 h-5 mr-2" />{isPickup ? 'Cancel Pickup' : 'Mark as Failed'}
            </DropdownMenuItem>
          </>
        )}
        {onDelete && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver')) && (
          <>
            <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />
            <DropdownMenuItem onClick={(e) => { blockCardToggle(e); e.stopPropagation(); setShowDeleteConfirm(true); }} className="text-red-600 text-base py-2.5 md:py-1.5" disabled={!userHasRole(currentUser, 'admin') && isPickup && routeCompleted}>
              <Trash2 className="w-5 h-5 mr-2" />Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}