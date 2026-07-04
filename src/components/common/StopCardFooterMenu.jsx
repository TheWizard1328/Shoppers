import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator
} from "@/components/ui/dropdown-menu";
import { CheckCircle, Edit, History, Locate, MoreVertical, RotateCcw, Trash2, User, XCircle, ExternalLink } from "lucide-react";
import { isInterStoreDelivery } from '../utils/interStoreDisplayName';
import { activatePatientViewOverlay } from '../patient-portal/PatientViewOverlay';

export default function StopCardFooterMenu(props) {
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
    isAssignedDriverOrAppOwner,
    canEdit,
    allDeliveries = [],
    onRestart,
    restartCurrentDelivery,
    isRestarting,
    isProcessingBackground,
    isFailing,
    dispatchBleReconnect,
    handleCompleteAction,
    isCompleting,
    isGlobalCompleteLocked,
    isGlobalRestartLocked,
  } = props;

  const canManageStop = !!(!isStrippedForDispatcher && (
    isAppOwner?.(currentUser) ||
    userHasRole?.(currentUser, 'admin') ||
    userHasRole?.(currentUser, 'dispatcher') ||
    (userHasRole?.(currentUser, 'driver') && delivery?.driver_id === currentUser?.id) ||
    canEdit
  ));

  const isDispatcherOnly = !!(userHasRole?.(currentUser, 'dispatcher') && !userHasRole?.(currentUser, 'admin') && !isAppOwner?.(currentUser));
  // Inter-store deliveries are classified as pickups for layout but should show delivery menu options
  const isInterStore = isInterStoreDelivery(delivery?.delivery_id);
  const isPickupForMenu = isPickup && !isInterStore;
  const isActiveStop = !['completed', 'cancelled', 'failed'].includes(delivery?.status);
  const isActiveDelivery = !isPickupForMenu && isActiveStop;
  const isActivePickup = isPickupForMenu && isActiveStop;
  const isFinishedPickup = isPickupForMenu && isFinishedDelivery;
  const isFinishedRegularDelivery = !isPickupForMenu && isFinishedDelivery;

  const isAdminOrOwner = !!(isAppOwner?.(currentUser) || userHasRole?.(currentUser, 'admin'));
  const canShowEdit = !!(canManageStop && (!routeCompleted || isAdminOrOwner) && (isActiveDelivery || isActivePickup || isFinishedPickup || isFinishedRegularDelivery));

  const isDriverOnly = !!(userHasRole?.(currentUser, 'driver') && !userHasRole?.(currentUser, 'admin') && !isAppOwner?.(currentUser));
  const canShowEditPatient = !!(!isDispatcherOnly && !isDriverOnly && onEditPatient && patient && canManageStop && (isActiveDelivery || isFinishedRegularDelivery) && !isInterStore);

  const canShowUpdateGps = !!(!isDispatcherOnly && handleUpdateGPS && canManageStop && patient && !isPickupForMenu && !isInterStore && (isNextDelivery || isFinishedDelivery || delivery?.status === 'in_transit'));

  const canShowViewAsPatient = !!(isAppOwner?.(currentUser) && patient && delivery?.patient_id && !isInterStore);

  const canShowPatientHistory = !!(patient && delivery?.patient_id && !isInterStore && !isPickupForMenu && (
    isAdminOrOwner ||
    isDispatcherOnly ||
    (isDriverOnly && !routeCompleted && (isActiveDelivery || isFinishedRegularDelivery))
  ));

  const canShowComplete = !!(
    !isPickupForMenu &&
    !isFinishedDelivery &&
    !isNextDelivery &&
    isActiveDelivery &&
    handleCompleteAction &&
    canManageStop &&
    !isInterStore
  );

  const canShowFailCancel = !!(!isDispatcherOnly && onStatusUpdate && canManageStop && (
    isActivePickup || (isActiveDelivery && isNextDelivery)
  ) && !isInterStore);

  const canShowDelete = !!(!isDispatcherOnly && canManageStop && (isActiveDelivery || isActivePickup || isFinishedPickup || isFinishedRegularDelivery));

  const dispatcherStoreIds = Array.isArray(currentUser?.store_ids) ? currentUser.store_ids : [];
  const selectedDate = delivery?.delivery_date;
  const dispatcherStoreStops = isDispatcherOnly
    ? (allDeliveries || []).filter((item) => item && dispatcherStoreIds.includes(item.store_id) && item.delivery_date === selectedDate)
    : [];
  const finishedStatuses = ['completed', 'cancelled', 'failed', 'returned'];
  const isCurrentDispatcherStopFinished = isDispatcherOnly && finishedStatuses.includes(delivery?.status);
  const areAllDispatcherStoreStopsFinished = isDispatcherOnly && (dispatcherStoreStops.length === 0 || dispatcherStoreStops.every((item) => finishedStatuses.includes(item?.status)));

  const [open, setOpen] = useState(false);
  const closeMenu = () => setOpen(false);

  if (isCurrentDispatcherStopFinished && areAllDispatcherStoreStopsFinished) return null;

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="bg-transparent text-sm font-medium rounded-md inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:text-accent-foreground h-10 w-10 border border-slate-300 hover:bg-slate-100 relative z-[50] pointer-events-auto" onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <MoreVertical className="w-5 h-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="p-1 rounded-md min-w-[12rem] overflow-visible border-2 shadow-md z-[9999] bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 dark:border-slate-600" sideOffset={8} onClick={(e) => e.stopPropagation()} style={{ opacity: 1, visibility: 'visible' }}>
        {canShowEdit && (
          <DropdownMenuItem inset={false} onClick={(e) => { closeMenu(); dispatchBleReconnect?.(); blockCardToggle(e); e.stopPropagation(); onEdit?.(delivery); }} className="flex cursor-pointer items-center text-base py-2.5 md:py-1.5 text-slate-900 dark:text-slate-100 focus:bg-slate-100 dark:focus:bg-slate-700 focus:text-slate-900 dark:focus:text-slate-100">
            <Edit className="w-5 h-5 mr-2" />{isPickupForMenu ? 'Edit Pickup' : isInterStore ? 'Edit InterStore' : 'Edit Delivery'}
          </DropdownMenuItem>
        )}
        {canShowEditPatient && (
          <DropdownMenuItem inset={false} onClick={(e) => { closeMenu(); dispatchBleReconnect?.(); blockCardToggle(e); e.stopPropagation(); onEditPatient(patient); }} className="flex cursor-pointer items-center text-base py-2.5 md:py-1.5 text-slate-900 dark:text-slate-100 focus:bg-slate-100 dark:focus:bg-slate-700 focus:text-slate-900 dark:focus:text-slate-100">
            <User className="w-5 h-5 mr-2" />Edit Patient
          </DropdownMenuItem>
        )}
        {canShowPatientHistory && (
          <DropdownMenuItem inset={false} onClick={(e) => {
            closeMenu(); dispatchBleReconnect?.(); blockCardToggle(e); e.stopPropagation();
            window.dispatchEvent(new CustomEvent('openPatientHistoryPanel', {
              detail: { patientId: delivery.patient_id, patient }
            }));
          }} className="flex cursor-pointer items-center text-base py-2.5 md:py-1.5 text-slate-900 dark:text-slate-100 focus:bg-slate-100 dark:focus:bg-slate-700 focus:text-slate-900 dark:focus:text-slate-100">
            <History className="w-5 h-5 mr-2" />Patient History
          </DropdownMenuItem>
        )}
        {canShowViewAsPatient && (
          <DropdownMenuItem inset={false} onClick={(e) => { closeMenu(); dispatchBleReconnect?.(); blockCardToggle(e); e.stopPropagation(); activatePatientViewOverlay(patient); }}
 className="flex cursor-pointer items-center text-base py-2.5 md:py-1.5 text-indigo-600 dark:text-indigo-400 focus:bg-indigo-50 dark:focus:bg-indigo-950 focus:text-indigo-700 dark:focus:text-indigo-300">
            <ExternalLink className="w-5 h-5 mr-2" />View As Patient
          </DropdownMenuItem>
        )}
        {canShowUpdateGps && (
          <DropdownMenuItem inset={false} onClick={(e) => { closeMenu(); dispatchBleReconnect?.(); blockCardToggle(e); handleUpdateGPS(e); }} className="flex cursor-pointer items-center text-base py-2.5 md:py-1.5 text-slate-900 dark:text-slate-100 focus:bg-slate-100 dark:focus:bg-slate-700 focus:text-slate-900 dark:focus:text-slate-100">
            <Locate className="w-5 h-5 mr-2" />Update GPS
          </DropdownMenuItem>
        )}
        {canShowComplete && (
          <>
            <DropdownMenuSeparator className="dark:bg-slate-600" />
            <DropdownMenuItem inset={false} onClick={(e) => { closeMenu(); blockCardToggle(e); e.stopPropagation(); handleCompleteAction(e); }} disabled={isCompleting || isProcessingBackground || isFailing || isGlobalCompleteLocked || isGlobalRestartLocked} className="flex cursor-pointer items-center text-emerald-600 dark:text-emerald-400 text-base py-2.5 md:py-1.5 focus:bg-emerald-50 dark:focus:bg-emerald-950 focus:text-emerald-700 dark:focus:text-emerald-300">
              <CheckCircle className="w-5 h-5 mr-2" />Complete
            </DropdownMenuItem>
          </>
        )}
        {canShowFailCancel && (
          <>
            <DropdownMenuSeparator className="dark:bg-slate-600" />
            <DropdownMenuItem inset={false} onClick={(e) => { closeMenu(); dispatchBleReconnect?.(); blockCardToggle(e); e.stopPropagation(); setPendingFailureStatus(isPickup ? 'cancelled' : 'failed'); setShowFailureReasonDialog(true); }} className="flex cursor-pointer items-center text-red-500 dark:text-red-400 text-base py-2.5 md:py-1.5 focus:bg-red-50 dark:focus:bg-red-950 focus:text-red-700 dark:focus:text-red-300">
              <XCircle className="w-5 h-5 mr-2" />{isPickupForMenu ? 'Cancel Pickup' : 'Mark as Failed'}
            </DropdownMenuItem>
          </>
        )}
        {routeCompleted && onRestart && delivery?.status !== 'failed' && ['completed', 'cancelled'].includes(delivery?.status) && (
          <>
            <DropdownMenuSeparator className="dark:bg-slate-600" />
            <DropdownMenuItem inset={false} onClick={(e) => { closeMenu(); dispatchBleReconnect?.(); blockCardToggle(e); e.stopPropagation(); restartCurrentDelivery(false); }} disabled={isRestarting || isProcessingBackground || isFailing} className="flex cursor-pointer items-center text-blue-600 dark:text-blue-400 text-base py-2.5 md:py-1.5 focus:bg-blue-50 dark:focus:bg-blue-950 focus:text-blue-700 dark:focus:text-blue-300">
              <RotateCcw className="w-5 h-5 mr-2" />Restart
            </DropdownMenuItem>
          </>
        )}
        {canShowDelete && (
          <>
            <DropdownMenuSeparator className="dark:bg-slate-600" />
            <DropdownMenuItem inset={false} onClick={(e) => { closeMenu(); dispatchBleReconnect?.(); blockCardToggle(e); e.stopPropagation(); setShowDeleteConfirm(true); }} className="flex cursor-pointer items-center text-red-500 dark:text-red-400 text-base py-2.5 md:py-1.5 focus:bg-red-50 dark:focus:bg-red-950 focus:text-red-700 dark:focus:text-red-300">
              <Trash2 className="w-5 h-5 mr-2" />Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}