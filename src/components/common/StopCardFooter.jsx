import React from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Edit, MoreVertical, RotateCcw, Undo2, XCircle, CheckCircle, Clock, Loader2, Trash2, User } from "lucide-react";
import { format } from "date-fns";
import { base44 } from "@/api/base44Client";
import { toast } from "sonner";
import { userHasRole } from "../utils/userRoles";
import { updateDeliveryLocal } from "../utils/offlineMutations";
import { invalidate } from "../utils/dataManager";
import { triggerRouteOptimization } from "../utils/realTimeRouteOptimizer";
import { fabControlEvents } from "../utils/fabControlEvents";
import { locationTracker } from "../utils/locationTracker";

export default function StopCardFooter({
  // visibility
  isStrippedForDriver,
  isStrippedForDispatcher,
  isFinishedDelivery,
  isExpanded,
  isRouteCompleted,
  isAssignedDriverOrAppOwner,
  canEdit,
  // entities and data
  delivery,
  patient,
  store,
  currentUser,
  appUsers = [],
  allDeliveries = [],
  // computed flags
  canRetry,
  hasFutureRetry,
  hasCompletedDelivery,
  hasFutureReturn,
  isPickup,
  isNextDelivery,
  isRestarting,
  isProcessingBackground,
  isStarting,
  isCompleting,
  isFailing,
  // state setters
  setIsRestarting,
  setIsEntityUpdating,
  setIsProcessingBackground,
  setIsStarting,
  setIsCompleting,
  setIsFailing,
  setPendingFailureStatus,
  setShowFailureReasonDialog,
  // callbacks
  onEditDelivery,
  onEditPatient,
  onDeleteDelivery,
  onStatusUpdate,
  onStartDelivery,
  onRestart,
  handleReturnClick,
  ensureDriverOnline,
  // others
  isRouteCompletedFlag,
}) {
  // Show/hide footer logic
  if (isStrippedForDispatcher) return null;
  const shouldShowFooter = !isFinishedDelivery || isExpanded || (isFinishedDelivery && !isRouteCompleted);
  if (!isAssignedDriverOrAppOwner || !shouldShowFooter) return null;

  return (
    <div className="space-y-3 mt-2">
      <div className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
        <div className="mt-2 mx-auto pb-1 flex justify-between items-center">
          {(isAssignedDriverOrAppOwner || canEdit) && (
            <>
              {/* FAILED DELIVERY FOOTER */}
              {delivery.status === 'failed' && !isPickup ? (
                <div className="flex items-center gap-2 w-full">
                  {/* Retry button */}
                  {onStatusUpdate && (
                    <Button
                      onClick={async (e) => {
                        e.stopPropagation();
                        fabControlEvents.deactivateFAB();
                        setIsRestarting(true);
                        setIsProcessingBackground(true);
                        const { driverLocationPoller } = await import('../utils/driverLocationPoller');
                        driverLocationPoller.pause();
                        await new Promise((resolve) => setTimeout(resolve, 50));
                        try {
                          const deliveryExists = await base44.entities.Delivery.filter({ id: delivery.id });
                          if (!deliveryExists || deliveryExists.length === 0) {
                            console.warn('⚠️ [RETRY] Delivery no longer exists - aborting');
                            throw new Error('This delivery has been deleted. Please refresh the page.');
                          }
                          await ensureDriverOnline();
                          const originalTR = parseInt(delivery.tracking_number, 10);
                          const groupStart = Math.floor(originalTR / 20) * 20;
                          const groupEnd = groupStart + 19;
                          const driverDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
                          const existingTRsInGroup = driverDeliveries.map((d) => parseInt(d.tracking_number, 10)).filter((tr) => !isNaN(tr) && tr >= groupStart && tr <= groupEnd);
                          const nextTR = existingTRsInGroup.length > 0 ? Math.max(...existingTRsInGroup) + 1 : groupStart;
                          const retryDelivery = {
                            ...delivery,
                            status: 'in_transit',
                            tracking_number: String(nextTR),
                            delivery_notes: '[Redelivered]',
                            actual_delivery_time: null,
                            isNextDelivery: false,
                            signature_image_url: null,
                            proof_photo_urls: [],
                            cod_payments: [],
                          };
                          delete retryDelivery.id;
                          delete retryDelivery.created_date;
                          delete retryDelivery.updated_date;
                          delete retryDelivery.created_by;
                          const newDelivery = await base44.entities.Delivery.create(retryDelivery);
                          try {
                            const now = new Date();
                            const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                            await base44.functions.invoke('optimizeRouteRealTime', {
                              driverId: delivery.driver_id,
                              deliveryDate: delivery.delivery_date,
                              currentLocalTime,
                              generatePolyline: false,
                            });
                            invalidate('Delivery');
                          } catch (optimizeError) {
                            console.warn('⚠️ [Retry] Route optimizer failed:', optimizeError);
                          }
                          window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'retry', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
                          if (userHasRole(currentUser, 'driver')) {
                            const { notifyDriverRetry } = await import('../utils/deliveryMessaging');
                            await notifyDriverRetry({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name, delivery, store, appUsers });
                          }
                        } finally {
                          const { driverLocationPoller } = await import('../utils/driverLocationPoller');
                          driverLocationPoller.resume();
                          setIsRestarting(false);
                          setIsProcessingBackground(false);
                          fabControlEvents.reactivateFAB(true);
                        }
                      }}
                      size="sm"
                      className="bg-blue-600 hover:bg-blue-700 h-10 md:h-8 !text-white text-sm md:text-xs flex-1"
                      disabled={isRestarting || isProcessingBackground || !canRetry || hasFutureRetry || hasCompletedDelivery}
                    >
                      {isRestarting || isProcessingBackground ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
                      <span className="text-white">Retry</span>
                    </Button>
                  )}

                  {/* Return button */}
                  <Button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleReturnClick(e);
                    }}
                    size="sm"
                    className="inline-flex items-center gap-2 px-4 md:px-3 text-sm md:text-xs bg-orange-600 hover:bg-orange-700 !text-white h-10 md:h-8 flex-1"
                  >
                    <Undo2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />
                    Return
                  </Button>
                </div>
              ) : (
                // NON-FAILED FOOTER
                <>
                  {onStartDelivery ? null : null}
                </>
              )}

              {/* Right menu and actions for non-failed footer are kept in parent for now to minimize prop sprawl */}
            </>
          )}
        </div>
      </div>
    </div>
  );
}