import React from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator
} from "@/components/ui/dropdown-menu";
import { Edit, Locate, MoreVertical, Trash2, User, XCircle } from "lucide-react";

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
    canEdit
  } = props;

  const canShowEdit = !!(onEdit && !isStrippedForDispatcher && (
    isAppOwner?.(currentUser) ||
    userHasRole?.(currentUser, 'admin') ||
    userHasRole?.(currentUser, 'dispatcher') ||
    (userHasRole?.(currentUser, 'driver') && delivery?.driver_id === currentUser?.id && !routeCompleted) ||
    canEdit
  ));

  const canShowEditPatient = !!(onEditPatient && patient && !isPickup && !isStrippedForDispatcher && isAppOwner?.(currentUser));

  const canShowUpdateGps = !!((isNextDelivery || isFinishedDelivery) && !isPickup && patient && !isStrippedForDispatcher && (
    userHasRole?.(currentUser, 'admin') ||
    userHasRole?.(currentUser, 'dispatcher') ||
    userHasRole?.(currentUser, 'driver')
  ));

  const canShowFailCancel = !!(delivery?.status !== 'completed' && delivery?.status !== 'cancelled' && delivery?.status !== 'failed' && isNextDelivery && onStatusUpdate);

  const canShowDelete = !!(onDelete && !isStrippedForDispatcher && (
    userHasRole?.(currentUser, 'admin') || userHasRole?.(currentUser, 'driver')
  ));

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="bg-transparent text-sm font-medium rounded-md inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:text-accent-foreground h-10 w-10 border border-slate-300 hover:bg-slate-100 relative z-[10]" onClick={(e) => e.stopPropagation()}>
          <MoreVertical className="w-5 h-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="p-1 rounded-md min-w-[12rem] overflow-visible border-2 shadow-md z-[9999] bg-white text-slate-900" sideOffset={8} onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)', opacity: 1, visibility: 'visible' }}>
        {canShowEdit && (
          <DropdownMenuItem inset={false} onClick={(e) => { blockCardToggle(e); e.stopPropagation(); onEdit(delivery); }} className="flex cursor-pointer items-center text-base py-2.5 md:py-1.5 text-slate-900 focus:bg-slate-100 focus:text-slate-900">
            <Edit className="w-5 h-5 mr-2" />{isPickup ? 'Edit Pickup' : 'Edit Delivery'}
          </DropdownMenuItem>
        )}
        {canShowEditPatient && (
          <DropdownMenuItem inset={false} onClick={(e) => { blockCardToggle(e); e.stopPropagation(); onEditPatient(patient); }} className="flex cursor-pointer items-center text-base py-2.5 md:py-1.5 text-slate-900 focus:bg-slate-100 focus:text-slate-900">
            <User className="w-5 h-5 mr-2" />Edit Patient
          </DropdownMenuItem>
        )}
        {canShowUpdateGps && (
          <DropdownMenuItem inset={false} onClick={(e) => { blockCardToggle(e); handleUpdateGPS(e); }} className="flex cursor-pointer items-center text-base py-2.5 md:py-1.5 text-slate-900 focus:bg-slate-100 focus:text-slate-900">
            <Locate className="w-5 h-5 mr-2" />Update GPS
          </DropdownMenuItem>
        )}
        {canShowFailCancel && (
          <>
            <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />
            <DropdownMenuItem inset={false} onClick={(e) => { blockCardToggle(e); e.stopPropagation(); setPendingFailureStatus(isPickup ? 'cancelled' : 'failed'); setShowFailureReasonDialog(true); }} className="flex cursor-pointer items-center text-red-600 text-base py-2.5 md:py-1.5 focus:bg-red-50 focus:text-red-700">
              <XCircle className="w-5 h-5 mr-2" />{isPickup ? 'Cancel Pickup' : 'Mark as Failed'}
            </DropdownMenuItem>
          </>
        )}
        {canShowDelete && (
          <>
            <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />
            <DropdownMenuItem inset={false} onClick={(e) => { blockCardToggle(e); e.stopPropagation(); setShowDeleteConfirm(true); }} className="flex cursor-pointer items-center text-red-600 text-base py-2.5 md:py-1.5 focus:bg-red-50 focus:text-red-700" disabled={!userHasRole(currentUser, 'admin') && isPickup && routeCompleted}>
              <Trash2 className="w-5 h-5 mr-2" />Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}