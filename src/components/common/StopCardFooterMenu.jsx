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