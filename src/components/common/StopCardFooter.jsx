import React from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { RotateCcw, MoreVertical, Edit, User, XCircle, Trash2, CheckCircle, Clock, Loader2, Undo2, Pen, Camera } from "lucide-react";
import { userHasRole } from '../utils/userRoles';

export default function StopCardFooter({
  delivery,
  isPickup,
  isNextDelivery,
  patient,
  currentUser,
  isStrippedForDispatcher,
  isRouteCompleted,
  onEditDelivery,
  onEditPatient,
  onDeleteDelivery,
  onStatusUpdate,
  setPendingFailureStatus,
  setShowFailureReasonDialog,
  setShowSignatureCapture,
  setShowPhotoCapture,
  isCompleting,
  isProcessingBackground,
  isStarting,
  isRetrying,
  isPreparingReturn,
  handleReturnClick,
  hasFutureReturn,
  hasCompletedDelivery,
  canRetry,
  hasFutureRetry,
  onRestart,
  onCompleteClick,
  onRetryClick,
  onRestartClick,
  onStartClick
}) {
  const todayStr = new Date().toISOString().split('T')[0];
  
  // Failed delivery: Return, Retry, Restart, Menu (all across bottom)
  if (delivery.status === 'failed' && !isPickup && delivery.delivery_date === todayStr) {
    return (
      <div className="flex items-center gap-2 w-full">
        <Button
          onClick={handleReturnClick}
          size="sm"
          className="bg-orange-600 hover:bg-orange-700 !text-white h-10 md:h-8 px-3 text-sm md:text-xs"
          disabled={isPreparingReturn || hasFutureReturn || hasCompletedDelivery}>
          {isPreparingReturn ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 animate-spin" /> : <Undo2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
          Return
        </Button>

        {onStatusUpdate && (
          <Button
            onClick={onRetryClick}
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 h-10 md:h-8 !text-white text-sm md:text-xs px-3"
            disabled={isRetrying || isProcessingBackground || !canRetry || hasFutureRetry || hasCompletedDelivery}>
            {isRetrying ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 animate-spin" /> : <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
            Retry
          </Button>
        )}

        {onRestart && (
          <Button
            onClick={onRestartClick}
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 h-10 md:h-8 !text-white text-sm md:text-xs px-3"
            disabled={isProcessingBackground}>
            <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />
            Restart
          </Button>
        )}
        
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="bg-transparent text-sm font-medium rounded-md inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:text-accent-foreground h-10 w-10 md:h-8 md:w-8 border border-slate-300 hover:bg-slate-100 relative z-[10]"
              onClick={(e) => e.stopPropagation()}>
              <MoreVertical className="w-5 h-5 md:w-4 md:h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="p-1 rounded-md min-w-[8rem] overflow-hidden border-2 shadow-md z-[200]" sideOffset={5} onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
            {onEditDelivery && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEditDelivery(delivery); }} className="text-base md:text-sm py-2.5 md:py-1.5">
                <Edit className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                {isPickup ? 'Edit Pickup' : 'Edit Delivery'}
              </DropdownMenuItem>
            )}

            {!isPickup && patient && onEditPatient && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) && (
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEditPatient(patient); }} className="text-base md:text-sm py-2.5 md:py-1.5">
                <User className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                Edit Patient
              </DropdownMenuItem>
            )}

            {onDeleteDelivery && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (onEditDelivery || !isPickup && patient && onEditPatient) && (
              <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />
            )}

            {onDeleteDelivery && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (
              <DropdownMenuItem
                onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(true); }}
                className="text-red-600 text-base md:text-sm py-2.5 md:py-1.5"
                disabled={!userHasRole(currentUser, 'admin') && isRouteCompleted}>
                <Trash2 className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }
  
  // Completed delivery: LEFT (Sig+Photo if captured), RIGHT (Restart + Menu)
  if (delivery.status === 'completed' && onRestart) {
    return (
      <>
        {/* LEFT: Signature + Photo (only if captured) */}
        {!isPickup && (
          <div className="flex items-center gap-2">
            {delivery.signature_image_url && (
              <Button
                onClick={(e) => e.stopPropagation()}
                size="sm"
                variant="outline"
                disabled
                className="h-10 md:h-8 w-10 md:w-8 p-0 bg-emerald-100 border-emerald-400">
                <Pen className="w-5 h-5 md:w-4 md:h-4 text-emerald-700" />
              </Button>
            )}

            {delivery.proof_photo_urls && delivery.proof_photo_urls.length > 0 && (
              <Button
                onClick={(e) => e.stopPropagation()}
                size="sm"
                variant="outline"
                disabled
                className="h-10 md:h-8 w-10 md:w-8 p-0 bg-emerald-100 border-emerald-400">
                <Camera className="w-5 h-5 md:w-4 md:h-4 text-emerald-700" />
              </Button>
            )}
          </div>
        )}

        {/* RIGHT: Restart + Menu */}
        <div className="flex items-center gap-2 ml-auto">
          <Button
            onClick={onRestartClick}
            size="sm"
            className="bg-blue-600 hover:bg-blue-700 h-10 md:h-8 !text-white text-sm md:text-xs px-3"
            disabled={isProcessingBackground}>
            <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />
            Restart
          </Button>
          
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="bg-transparent text-sm font-medium rounded-md inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:text-accent-foreground h-10 w-10 md:h-8 md:w-8 border border-slate-300 hover:bg-slate-100 relative z-[10]"
                onClick={(e) => e.stopPropagation()}>
                <MoreVertical className="w-5 h-5 md:w-4 md:h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="p-1 rounded-md min-w-[8rem] overflow-hidden border-2 shadow-md z-[200]" sideOffset={5} onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
              {onEditDelivery && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEditDelivery(delivery); }} className="text-base md:text-sm py-2.5 md:py-1.5">
                  <Edit className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                  {isPickup ? 'Edit Pickup' : 'Edit Delivery'}
                </DropdownMenuItem>
              )}

              {!isPickup && patient && onEditPatient && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) && (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEditPatient(patient); }} className="text-base md:text-sm py-2.5 md:py-1.5">
                  <User className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                  Edit Patient
                </DropdownMenuItem>
              )}

              {onDeleteDelivery && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (onEditDelivery || !isPickup && patient && onEditPatient) && (
                <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />
              )}

              {onDeleteDelivery && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (
                <DropdownMenuItem
                  onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(true); }}
                  className="text-red-600 text-base md:text-sm py-2.5 md:py-1.5"
                  disabled={!userHasRole(currentUser, 'admin') && isRouteCompleted}>
                  <Trash2 className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </>
    );
  }
  
  // Active delivery (isNextDelivery): LEFT (Sig+Photo), RIGHT (Complete+Menu)
  if (delivery.status !== 'completed' && delivery.status !== 'cancelled' && delivery.status !== 'failed' && isNextDelivery) {
    return (
      <>
        {/* LEFT: Signature + Photo */}
        {!isPickup && (
          <div className="flex items-center gap-2">
            <Button
              onClick={(e) => {
                e.stopPropagation();
                setShowSignatureCapture(true);
              }}
              size="sm"
              variant="outline"
              className={`h-10 md:h-8 w-10 md:w-8 p-0 ${
                delivery.signature_image_url ?
                  'bg-emerald-100 border-emerald-400 hover:bg-emerald-200' :
                  'border-white hover:bg-slate-100'}`
              }>
              <Pen className={`w-5 h-5 md:w-4 md:h-4 ${
                delivery.signature_image_url ? 'text-emerald-700' : 'text-white'}`
              } />
            </Button>

            <Button
              onClick={(e) => {
                e.stopPropagation();
                setShowPhotoCapture(true);
              }}
              size="sm"
              variant="outline"
              className={`h-10 md:h-8 w-10 md:w-8 p-0 ${
                delivery.proof_photo_urls && delivery.proof_photo_urls.length > 0 ?
                  'bg-emerald-100 border-emerald-400 hover:bg-emerald-200' :
                  'border-white hover:bg-slate-100'}`
              }>
              <Camera className={`w-5 h-5 md:w-4 md:h-4 ${
                delivery.proof_photo_urls && delivery.proof_photo_urls.length > 0 ? 'text-emerald-700' : 'text-white'}`
              } />
            </Button>
          </div>
        )}

        {/* RIGHT: Complete + Menu */}
        <div className="flex items-center gap-2 ml-auto">
          <Button
            onClick={onCompleteClick}
            size="sm"
            disabled={isCompleting || isProcessingBackground}
            className="rounded-md bg-emerald-600 px-4 md:px-3 text-sm md:text-xs font-medium rounded-r-none inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-emerald-700 h-10 md:h-8 border-r border-emerald-500 !text-white">
            {isCompleting ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <CheckCircle className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
            <span className="text-white">Complete</span>
          </Button>

          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="bg-transparent text-sm font-medium rounded-md inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:text-accent-foreground h-10 w-10 md:h-8 md:w-8 border border-slate-300 hover:bg-slate-100 relative z-[10]"
                onClick={(e) => e.stopPropagation()}>
                <MoreVertical className="w-5 h-5 md:w-4 md:h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="p-1 rounded-md min-w-[8rem] overflow-hidden border-2 shadow-md z-[200]" sideOffset={5} onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
              {onEditDelivery && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEditDelivery(delivery); }} className="text-base md:text-sm py-2.5 md:py-1.5">
                  <Edit className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                  {isPickup ? 'Edit Pickup' : 'Edit Delivery'}
                </DropdownMenuItem>
              )}

              {!isPickup && patient && onEditPatient && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) && (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEditPatient(patient); }} className="text-base md:text-sm py-2.5 md:py-1.5">
                  <User className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                  Edit Patient
                </DropdownMenuItem>
              )}

              {onStatusUpdate && (
                <>
                  <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingFailureStatus(isPickup ? 'cancelled' : 'failed');
                      setShowFailureReasonDialog(true);
                    }}
                    className="text-red-600 text-base md:text-sm py-2.5 md:py-1.5">
                    <XCircle className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                    {isPickup ? 'Cancel Pickup' : 'Mark as Failed'}
                  </DropdownMenuItem>
                </>
              )}

              {onDeleteDelivery && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (onEditDelivery || !isPickup && patient && onEditPatient || onStatusUpdate) && (
                <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />
              )}

              {onDeleteDelivery && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (
                <DropdownMenuItem
                  onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(true); }}
                  className="text-red-600 text-base md:text-sm py-2.5 md:py-1.5"
                  disabled={!userHasRole(currentUser, 'admin') && isRouteCompleted}>
                  <Trash2 className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </>
    );
  }
  
  // Active delivery (NOT isNextDelivery): RIGHT (Start + Menu only)
  if (delivery.status !== 'completed' && delivery.status !== 'cancelled' && delivery.status !== 'failed' && !isNextDelivery && onStartClick) {
    return (
      <div className="flex items-center gap-2 ml-auto">
        <Button
          onClick={onStartClick}
          size="sm"
          disabled={isStarting || isProcessingBackground}
          className="bg-blue-600 px-4 md:px-3 text-sm md:text-xs font-medium rounded-r-none inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-blue-700 h-10 md:h-8 border-r border-blue-500 !text-white"
          title="Start this delivery">
          {isStarting ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <Clock className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
          <span className="text-white">Start</span>
        </Button>

        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="bg-transparent text-sm font-medium rounded-md inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:text-accent-foreground h-10 w-10 md:h-8 md:w-8 border border-slate-300 hover:bg-slate-100 relative z-[10]"
              onClick={(e) => e.stopPropagation()}>
              <MoreVertical className="w-5 h-5 md:w-4 md:h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="p-1 rounded-md min-w-[8rem] overflow-hidden border-2 shadow-md z-[200]" sideOffset={5} onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
            {onEditDelivery && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEditDelivery(delivery); }} className="text-base md:text-sm py-2.5 md:py-1.5">
                <Edit className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                {isPickup ? 'Edit Pickup' : 'Edit Delivery'}
              </DropdownMenuItem>
            )}

            {!isPickup && patient && onEditPatient && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) && (
              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEditPatient(patient); }} className="text-base md:text-sm py-2.5 md:py-1.5">
                <User className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                Edit Patient
              </DropdownMenuItem>
            )}

            {onDeleteDelivery && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (onEditDelivery || !isPickup && patient && onEditPatient) && (
              <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />
            )}

            {onDeleteDelivery && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (
              <DropdownMenuItem
                onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(true); }}
                className="text-red-600 text-base md:text-sm py-2.5 md:py-1.5"
                disabled={!userHasRole(currentUser, 'admin') && isRouteCompleted}>
                <Trash2 className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }
  
  return null;
}